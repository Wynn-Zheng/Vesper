/**
 * Electron 主进程。
 *
 * 职责只有三件：
 *   1. 探测后端在不在（7788 通了就直接连，不通才自己拉一个）
 *   2. 拉起的后端自己管生命周期（退出时杀掉；只有"我拉的"才杀）
 *   3. 开窗口加载控制台
 *
 * 为什么最先探测而不是直接 spawn：
 *   开发时你可能已经手动 `npm start` 了。这时候 Electron 再拉一个会
 *   端口冲突（EADDRINUSE），后端起来就崩，界面白屏。
 *
 * 断网也能启动：
 *   前端零 CDN（系统字体 + emoji/SVG），后端只连 DeepSeek。
 *   断网时界面照常打开，只是体检会报"API 连不上"。
 *
 * ── 打包后的三个关键差异（都在这文件里处理）────────────────────
 *   1. 后端用 Electron 自带的 Node 跑，不用系统 node
 *      用户机器不一定装了 Node；process.execPath + ELECTRON_RUN_AS_NODE=1
 *      就等于一个 node。
 *   2. 后端入口是编译产物 build/index.js，不是 src/index.ts
 *      Electron 33 内置 Node 20.18，不支持直接跑 TypeScript。
 *   3. .env 自己读，不靠 node --env-file
 *      Node 20 没有 --env-file-if-exists（22.9 才有），--env-file 缺文件会直接退出。
 */
/**
 * 崩溃诊断：Windows 下 GUI 程序的 stdout/stderr 会被丢掉，看不到任何错误。
 * 所以早期日志直接写文件 —— 注意不能写 %TEMP%，这个环境（DSH 沙箱）会 EPERM。
 */
const _traceFile = require('node:path').join(
  process.env.APPDATA || require('node:os').homedir(),
  'qqbot-main.log',
)
function trace(msg) {
  try {
    require('node:fs').appendFileSync(_traceFile, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 写不了就算了 */
  }
}
trace('=== main.cjs 启动 ===')
process.on('uncaughtException', (e) => {
  trace('uncaughtException: ' + (e && e.stack ? e.stack : String(e)))
})
process.on('unhandledRejection', (e) => {
  trace('unhandledRejection: ' + (e && e.stack ? e.stack : String(e)))
})

const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require('electron')
trace('electron 模块已加载')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } = require('node:fs')
const { randomBytes } = require('node:crypto')
const path = require('node:path')
const http = require('node:http')

/* ============================================================
 * 路径
 * ============================================================ */

// 打包后源码在 resources/app（或 app.asar）里；开发时就是项目根。
// 两种都支持：这台机器上 Electron 加载 app.asar 会 0xC0000005 崩溃，
// 所以默认用裸目录，asar 只作为备选。
const APP_ROOT = app.isPackaged
  ? (() => {
      const asar = path.join(process.resourcesPath, 'app.asar')
      return existsSync(asar) ? asar : path.join(process.resourcesPath, 'app')
    })()
  : path.join(__dirname, '..')

// 数据目录：打包后必须是用户可写的地方（Program Files 是只读的）
// 开发时用项目目录，保持和 npm start 一样
const DATA_ROOT = app.isPackaged
  ? path.join(app.getPath('userData'), 'data-root')
  : APP_ROOT

const CONSOLE_PORT = 7788
const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}`

let backend = null // 我拉起的后端进程（null = 复用了别人的）
let win = null
let tray = null

/* ============================================================
 * 读 .env
 * ============================================================ */

/**
 * 把 .env 读成对象。
 *
 * 为什么不用 node --env-file：
 *   打包后跑的是 Electron 自带的 Node 20，它没有 --env-file-if-exists（22.9 才加）；
 *   --env-file（20.6+）虽然有，但文件缺失会直接报错退出。
 *   所以自己读，文件不存在就当空。
 */
function readDotEnv() {
  const out = {}
  try {
    const text = readFileSync(path.join(DATA_ROOT, '.env'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // 去掉两端引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
    }
  } catch {
    /* 没有 .env 就返回空 */
  }
  return out
}

/** 取控制台 token（先看环境变量，再看 .env） */
function consoleToken() {
  const fromEnv = process.env.CONSOLE_TOKEN
  if (fromEnv) return fromEnv
  return readDotEnv().CONSOLE_TOKEN || ''
}

/* ============================================================
 * 首次启动：初始化数据目录
 * ============================================================ */

/**
 * 打包后 DATA_ROOT = %APPDATA%/QQBot/data-root，第一次是空的。
 *
 * 不初始化的话两个后果：
 *   - 没有 .env → CONSOLE_TOKEN 和 DEEPSEEK_API_KEY 全空 → 控制台白屏、模型不可用
 *   - 没有 persona/ → 机器人没有规则和记忆
 */
function ensureDataRoot() {
  if (!app.isPackaged) return

  try {
    mkdirSync(DATA_ROOT, { recursive: true })
  } catch {
    /* 建不出来后面也会报，不用在这拦 */
  }

  // 1. .env：没有就生成一份（随机 token；API key 留空，让用户在设置页填）
  const envPath = path.join(DATA_ROOT, '.env')
  if (!existsSync(envPath)) {
    const token = randomBytes(16).toString('hex')
    writeFileSync(
      envPath,
      [
        '# 首次启动自动生成。',
        '# DEEPSEEK_API_KEY 可以在控制台「设置 → 模型」里填，也可以直接改这里。',
        `CONSOLE_TOKEN=${token}`,
        'DEEPSEEK_API_KEY=',
        'DEEPSEEK_MODEL=deepseek-chat',
        '',
      ].join('\n'),
      'utf8',
    )
    console.log('[main] 首次启动：已生成 .env')
  }

  // 2. persona/：从模板复制（模板在有 resources/persona-template）
  const personaDir = path.join(DATA_ROOT, 'persona')
  if (!existsSync(personaDir)) {
    const template = path.join(process.resourcesPath, 'persona-template')
    if (existsSync(template)) {
      try {
        cpSync(template, personaDir, { recursive: true })
        console.log('[main] 首次启动：已从模板初始化 persona/')
      } catch (e) {
        console.error('[main] 初始化 persona/ 失败：', e && e.message)
      }
    } else {
      console.warn('[main] 没有 persona-template，跳过 persona 初始化')
    }
  }
}

/* ============================================================
 * 探测后端
 * ============================================================ */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(`${CONSOLE_URL}/api/status`, { timeout: 1500 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 || res.statusCode === 401)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitReady(timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/* ============================================================
 * 拉起后端
 * ============================================================ */
async function ensureBackend() {
  // 1. 已经在跑？直接连（可能是你手动 npm start 的）
  if (await probe()) {
    console.log('[main] 检测到已有后端，直接复用')
    return true
  }

  // 2. 没在跑，自己拉一个
  //
  // 打包后跑编译产物：Electron 33 内置 Node 20.18，不支持直接跑 .ts。
  const entry = app.isPackaged
    ? path.join(APP_ROOT, 'build', 'index.js')
    : path.join(APP_ROOT, 'src', 'index.ts')

  if (!existsSync(entry)) {
    console.error('[main] 找不到入口：', entry)
    return false
  }

  // 打包后用 Electron 自带的 Node —— 用户机器不一定装了 Node。
  const nodeCmd = app.isPackaged ? process.execPath : 'node'

  console.log(`[main] 启动后端：${entry}（用 ${nodeCmd}）`)

  backend = spawn(nodeCmd, [entry], {
    cwd: DATA_ROOT, // 关键：数据目录由 cwd 决定（源码里全是相对路径）
    env: {
      ...process.env,
      ...readDotEnv(), // .env 手动注入（不能靠 --env-file，见文件头注释）
      ELECTRON_RUN_AS_NODE: '1', // 让 electron.exe 以 Node 模式跑，而不是再开一个 Electron
      DESKTOP_MODE: '1',
      // 程序资源目录（console/ 等）在哪 —— 打包后 cwd 是用户数据目录，
      // 后端不能再用 resolve('console') 找前端文件
      QQBOT_ROOT: APP_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  backend.stdout?.on('data', (d) => process.stdout.write('[backend] ' + d))
  backend.stderr?.on('data', (d) => process.stderr.write('[backend] ' + d))

  backend.on('exit', (code) => {
    console.log('[main] 后端退出，code =', code)
    backend = null
    // 后端崩了要提示，不能静默白屏
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        `document.body.insertAdjacentHTML('afterbegin','<div style="background:#f85149;color:#fff;padding:10px;font:14px system-ui;z-index:99999">后端已退出（code ${code}）。关掉重开试试。</div>')`,
      )
    }
  })

  const ok = await waitReady()
  if (!ok) console.error('[main] 后端 25 秒没起来')
  return ok
}

/* ============================================================
 * 窗口
 * ============================================================ */
function createWindow() {
  // 打包时 preload 会被改名成 .cjs（app/manifest 里是 type:module，
  // .js 会被当 ESM 解析，而 preload 必须是 CJS）。开发时还是 preload.js。
  const preloadName = existsSync(path.join(__dirname, 'preload.cjs')) ? 'preload.cjs' : 'preload.js'

  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'QQ Bot 控制台',
    // 窗口/任务栏图标。exe 本身的图标是 PE 资源，改名改不了（要 rcedit），
    // 但运行时图标用这个就够看了。
    icon: path.join(__dirname, 'icon.png'),
    // 断网/白屏时至少有个背景色，不是刺眼的纯白
    show: false,
    webPreferences: {
      preload: path.join(__dirname, preloadName),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const token = consoleToken()
  const url = token ? `${CONSOLE_URL}/?token=${encodeURIComponent(token)}` : CONSOLE_URL
  win.loadURL(url)

  win.once('ready-to-show', () => win.show())

  // 外链（比如 NapCat WebUI 的"在浏览器打开"）走系统浏览器，不要在应用里开
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u)
    return { action: 'deny' }
  })

  // 加载失败时给一句人话，不是 Chromium 的 ERR_CONNECTION_REFUSED
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return // 用户主动中断
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="background:#0d1117;color:#e6edf3;font:15px/1.8 system-ui;padding:60px">
           <h2>连不上后端</h2>
           <p style="color:#8b949e">${desc}（${code}）</p>
           <p style="color:#8b949e">后端可能没起来。看这个窗口的终端输出，或者关掉重开。</p>
           </body>`,
        ),
    )
  })

  win.on('close', (e) => {
    // 关窗口不退出（留托盘）
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

/* ============================================================
 * 托盘
 * ============================================================ */
function createTray() {
  // 没有图标文件时用空图，至少不崩
  let img = nativeImage.createEmpty()
  const iconPath = path.join(__dirname, 'icon.png')
  if (existsSync(iconPath)) img = nativeImage.createFromPath(iconPath)

  tray = new Tray(img)
  tray.setToolTip('QQ Bot')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制台', click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => (win ? win.show() : createWindow()))
}

/* ============================================================
 * 生命周期
 * ============================================================ */
app.whenReady().then(async () => {
  trace('app ready；isPackaged=' + app.isPackaged + ' resources=' + process.resourcesPath)
  trace('APP_ROOT=' + APP_ROOT)
  trace('DATA_ROOT=' + DATA_ROOT)
  ensureDataRoot()
  trace('ensureDataRoot 完成')
  await ensureBackend()
  trace('ensureBackend 完成')
  createWindow()
  trace('createWindow 完成')
  try {
    createTray()
    trace('createTray 完成')
  } catch {
    /* 没有托盘也不影响主功能 */
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 只有"我拉起的"后端才杀。复用别人的不能杀（那是用户手动开的）
app.on('before-quit', () => {
  app.isQuitting = true
  if (backend && !backend.killed) {
    try {
      backend.kill()
    } catch {
      /* ignore */
    }
  }
})

app.on('window-all-closed', () => {
  // macOS 上关窗口不退出是常规做法；Windows 上走托盘
  if (process.platform !== 'darwin' && !tray) app.quit()
})
