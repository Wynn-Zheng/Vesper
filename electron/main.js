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
 */
const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const http = require('node:http')

/* ============================================================
 * 路径
 * ============================================================ */

// 打包后，源码在 resources/app；开发时就是当前目录
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..')

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
 * 读 token
 * ============================================================ */
function consoleToken() {
  try {
    const env = readFileSync(path.join(DATA_ROOT, '.env'), 'utf8')
    const m = /CONSOLE_TOKEN\s*=\s*(\S+)/.exec(env)
    return m ? m[1] : ''
  } catch {
    return ''
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

  // 2. 没有，自己拉一个
  const entry = path.join(APP_ROOT, 'src', 'index.ts')
  if (!existsSync(entry)) {
    console.error('[main] 找不到入口：', entry)
    return false
  }

  console.log('[main] 启动后端：', entry)

  backend = spawn(process.execPath === '' ? 'node' : 'node', [entry], {
    cwd: DATA_ROOT, // 关键：数据目录由 cwd 决定（源码里全是相对路径）
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DESKTOP_MODE: '1' },
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
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'QQ Bot 控制台',
    // 断网/白屏时至少有个背景色，不是刺眼的纯白
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
  await ensureBackend()
  createWindow()
  try {
    createTray()
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
