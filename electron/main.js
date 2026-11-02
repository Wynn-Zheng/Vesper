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
  'vesper-main.log',
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

const { app, BrowserWindow, shell, Menu, Tray, nativeImage, dialog } = require('electron')
trace('electron 模块已加载')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, appendFileSync, rmSync } = require('node:fs')
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

// 端口跟着 .env 走（后端从 .env 读）：写死 7788 的话，用户改端口后永远"后端起不来"。
//
// ⚠ 必须**现算**，不能在模块加载时定成常量：老用户升级上来时 .env 是在
// ensureDataRoot() 里才被迁移过来的，而模块加载早于它。定成常量就会用迁移前的
// 空配置（=7788），后端却按老 .env 里的端口监听 —— 窗口显示"后端 25 秒内没响应"，
// 其实后端好好跑着，关掉重开又正常。
function consolePort() {
  return Number(readDotEnv().CONSOLE_PORT || process.env.CONSOLE_PORT || 7788) || 7788
}
function consoleUrl() {
  return `http://127.0.0.1:${consolePort()}`
}

let backend = null
/** 后端异常退出的自动重启次数（防崩溃循环） */
let crashRestarts = 0
// 我拉起的后端进程（null = 复用了别人的）
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

/** 取控制台 token：子进程用 {…process.env, …readDotEnv()}，.env 优先，这里同优先级 */
function consoleToken() {
  const fromFile = readDotEnv().CONSOLE_TOKEN
  if (fromFile) return fromFile
  return process.env.CONSOLE_TOKEN || ''
}

/* ============================================================
 * 首次启动：初始化数据目录
 * ============================================================ */

/**
 * 从旧数据目录迁移过来。
 *
 * **为什么需要**：Electron 的 `app.getPath('userData')` 是按 package.json 的 `name`
 * 算的。项目从 `qqbot` 改名成 `vesper` 之后，数据目录就从
 *   %APPDATA%\qqbot\data-root  →  %APPDATA%\vesper\data-root
 * 新版去新目录找，自然"数据全没了"（角色卡、API Key、记忆都在旧目录里）。
 *
 * 策略：**只在新目录还没有数据时复制**，复制完**不删旧的**（留作备份）。
 * 旧目录名按可能性排：先小写 `qqbot`（Electron 按 name 生成的就是小写），
 * 再 `QQBot`（productName 大写时代可能产生过），再 `Vesper`（中间改名那一版的残留）。
 */
function migrateLegacyDataRoot() {
  if (!app.isPackaged) return
  const has = (d) => existsSync(path.join(d, '.env')) || existsSync(path.join(d, 'persona'))
  if (has(DATA_ROOT)) return // 新目录已经有东西了，不动

  const roaming = path.dirname(path.dirname(DATA_ROOT)) // %APPDATA%
  const candidates = ['qqbot', 'QQBot', 'Vesper', 'qqbot-desktop']
  for (const name of candidates) {
    const oldRoot = path.join(roaming, name, 'data-root')
    if (oldRoot === DATA_ROOT) continue
    if (!has(oldRoot)) continue
    try {
      cpSync(oldRoot, DATA_ROOT, { recursive: true, errorOnExist: false, force: false })
      console.log(`[main] 已从旧数据目录迁移：${oldRoot} → ${DATA_ROOT}`)
      trace(`已从旧数据目录迁移：${oldRoot}`)
    } catch (e) {
      console.error('[main] 迁移旧数据失败：', e && e.message)
      trace('迁移旧数据失败：' + (e && e.message))
    }
    return // 迁一个就够
  }
}

/**
 * .env 每一项的说明。写进生成的文件里，用户打开就知道这行是干什么的。
 * 键必须和 ENV_DEFAULTS 对齐（缺的项不写说明，不影响功能）。
 */
const ENV_NOTE = {
  CONSOLE_TOKEN: '控制台口令。打开控制台时用，别外传。',
  DEEPSEEK_API_KEY: '在控制台「设置 → 模型」里填，也可以直接改这里。',
  DEEPSEEK_MODEL: '默认 deepseek-chat。',
  ONEBOT_TOKEN: '要和你 NapCat 里填的 token 一致；两边都空也能连。',
  ONEBOT_HOST: 'NapCat 的反向 WS 地址，一般不用改。',
  ONEBOT_PORT: 'NapCat 的反向 WS 端口。',
  ONEBOT_PATH: 'NapCat 的反向 WS 路径。',
  OWNER_QQ: '你的 QQ 号。填了它只认你；留空则谁私聊都回。',
  ALLOW_GROUP: '群聊总开关。true = 能在群里说话，false = 群里完全不理。',
  GROUP_ALLOW: '只理这些群（逗号分隔）；留空 = 所有群。',
  GROUP_REQUIRE_AT: '群里必须 @ 它或叫它名字才回。',
  UPDATE_URL: '在线更新地址，留空则不检查。',
  UPDATE_TOKEN: '在线更新口令，留空则不检查。',
}

/**
 * 打包后 DATA_ROOT = %APPDATA%/vesper/data-root，第一次是空的。
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

  // 0. 先把旧数据目录（qqbot/QQBot/Vesper）的东西搬过来，否则改名后老用户会以为数据丢了
  migrateLegacyDataRoot()

  // 1. .env：没有就生成一份（随机 token；API key 留空，让用户在设置页填）
  //
  // 这里必须把「跑起来需要的配置」都写出来，不能只写 5 行。
  // 之前只有 CONSOLE_TOKEN / DEEPSEEK_* / UPDATE_*，于是：
  //   - ALLOW_GROUP 缺失 → 群聊总开关默认关 → 群里 @ 它一条都不回
  //     （日志还会说"群聊总开关没开"，但界面上没有任何地方能打开）
  //   - OWNER_QQ 缺失 → 私聊不认人，任何陌生人私聊它都会回
  //   - ONEBOT_TOKEN 缺失 → 用户在 NapCat 里设了 token 就连不上
  // 这些全都写出来，用户改的时候至少看得见。
  const envPath = path.join(DATA_ROOT, '.env')
  const ENV_DEFAULTS = [
    ['CONSOLE_TOKEN', randomBytes(16).toString('hex')],
    ['DEEPSEEK_API_KEY', ''],
    ['DEEPSEEK_MODEL', 'deepseek-chat'],
    ['ONEBOT_TOKEN', ''],
    ['ONEBOT_HOST', '127.0.0.1'],
    ['ONEBOT_PORT', '8765'],
    ['ONEBOT_PATH', '/onebot/v11/ws'],
    ['OWNER_QQ', ''],
    ['ALLOW_GROUP', 'true'],
    ['GROUP_ALLOW', ''],
    ['GROUP_REQUIRE_AT', 'true'],
    ['UPDATE_URL', ''],
    ['UPDATE_TOKEN', ''],
  ]
  if (!existsSync(envPath)) {
    const lines = ['# 首次启动自动生成，改完重启生效。']
    for (const [k, v] of ENV_DEFAULTS) {
      lines.push(ENV_NOTE[k] ? `# ${ENV_NOTE[k]}` : '', `${k}=${v}`)
    }
    writeFileSync(envPath, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n', 'utf8')
    console.log('[main] 首次启动：已生成 .env')
  } else {
    // 老 .env：只补**缺失或为空**的键，不动用户已有的值。
    // 之前只补 UPDATE_* 两项，所以老用户升级上来 ALLOW_GROUP 仍然是缺的。
    try {
      const text = readFileSync(envPath, 'utf8')
      const add = []
      for (const [k, v] of ENV_DEFAULTS) {
        const re = new RegExp('^\\s*' + k + '\\s*=(.*)$', 'm')
        const m = re.exec(text)
        // CONSOLE_TOKEN 特殊：只有**为空**时才补随机值（没有这一行也一样补）。
        // 跳过它的话，`.env` 里写 `CONSOLE_TOKEN=` 就等于控制台不鉴权 ——
        // 同一网段谁都能进来改配置。
        if (!m) {
          add.push([k, v])
          continue
        }
        if (k === 'CONSOLE_TOKEN' && !m[1].trim()) add.push([k, randomBytes(16).toString('hex')])
      }
      if (add.length) {
        appendFileSync(
          envPath,
          '\n# 下面这些是升级时自动补上的（原来缺了会导致对应功能不可用），可以改\n' +
            add.map(([k, v]) => `${k}=${v}`).join('\n') +
            '\n',
          'utf8',
        )
        console.log('[main] 已给 .env 补上缺失的 ' + add.length + ' 项')
      }
    } catch {
      /* 补不上也不影响启动，用户可手动加 */
    }
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
    const req = http.get(`${consoleUrl()}/api/status`, { timeout: 1500 }, (res) => {
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

async function waitReady(timeoutMs = 25000, checkAbort = () => '') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await probe()) return true
    // 后端已经明确失败了就别干等
    if (checkAbort()) return false
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/* ============================================================
 * 拉起后端
 * ============================================================ */
/**
 * 应用"已下载、等重启"的更新。
 *
 * 为什么放在这里：后端正跑在 resources/app 里，在它运行中覆盖自己的 js 会失败；
 * 而 ensureBackend 是在后端启动**之前**调用的，此时文件没被占用。
 *
 * 做法：先把新包逐文件覆盖进 app（不删旧文件，避免正在加载的模块消失），
 * 失败就整目录回滚。
 */
function applyPendingUpdate() {
  const upd = path.join(DATA_ROOT, 'update')
  const pending = path.join(upd, 'pending.json')
  if (!existsSync(pending)) return
  const newApp = path.join(upd, 'unpacked', 'app')
  const appDir = __dirname
  if (!existsSync(path.join(newApp, 'main.js'))) {
    trace('[main] 更新包不完整，已丢弃')
    try { rmSync(upd, { recursive: true, force: true }) } catch { /* ignore */ }
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(DATA_ROOT, 'app-backup-' + stamp)
  try {
    let info = {}
    try { info = JSON.parse(readFileSync(pending, 'utf8')) } catch { /* ignore */ }
    cpSync(appDir, backup, { recursive: true })
    cpSync(newApp, appDir, { recursive: true, force: true })
    rmSync(upd, { recursive: true, force: true })
    trace('[main] 更新已应用：' + (info.version || '') + '（旧版备份在 ' + backup + '）')
  } catch (e) {
    trace('[main] 应用更新失败，回滚：' + (e && e.message))
    try { cpSync(backup, appDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

async function ensureBackend() {
  // 0. 有待应用的更新？在后端启动前换掉它（这时 app 里的文件没被占用）
  applyPendingUpdate()
  // 1. 已经在跑？直接连（可能是你手动 npm start 的）
  if (await probe()) {
    trace('[main] 检测到已有后端，直接复用')
    return { ok: true, reason: '复用已在运行的后端', log: '' }
  }

  // 2. 没在跑，自己拉一个
  //
  // 打包后跑编译产物：Electron 33 内置 Node 20.18，不支持直接跑 .ts。
  const entry = app.isPackaged
    ? path.join(APP_ROOT, 'build', 'index.js')
    : path.join(APP_ROOT, 'src', 'index.ts')

  if (!existsSync(entry)) {
    trace('[main] 找不到入口：' + entry)
    return { ok: false, reason: `找不到后端入口：${entry}`, log: '' }
  }

  // 打包后用 Electron 自带的 Node —— 用户机器不一定装了 Node。
  const nodeCmd = app.isPackaged ? process.execPath : 'node'

  trace(`[main] 启动后端：${entry}（用 ${nodeCmd}），cwd=${DATA_ROOT}`)

  // 收集后端输出，失败时显示到窗口里（用户找不到日志文件，这是最直接的）
  const collected = []
  const collect = (prefix, d) => {
    const text = prefix + String(d)
    collected.push(text)
    if (collected.length > 40) collected.shift()
    process.stdout.write(text)
  }

  try {
    backend = spawn(nodeCmd, [entry], {
      cwd: DATA_ROOT, // 关键：数据目录由 cwd 决定（源码里全是相对路径）
      env: {
        ...process.env,
        ...readDotEnv(), // .env 手动注入（不能靠 --env-file，见文件头注释）
        ELECTRON_RUN_AS_NODE: '1', // 让 electron.exe 以 Node 模式跑，而不是再开一个 Electron
        // 关掉 Electron 的 asar 补丁：后端要复制 NapCat（里面含 QQ 的 application.asar），
        // 开着的话 fs 会把 .asar 当包解析，直接抛 "Invalid package"。
        ELECTRON_NO_ASAR: '1',
        DESKTOP_MODE: '1',
        // 程序资源目录（console/ 等）在哪 —— 打包后 cwd 是用户数据目录，
        // 后端不能再用 resolve('console') 找前端文件
        QQBOT_ROOT: APP_ROOT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    // spawn 同步抛错（参数不合法之类）
    const reason = `拉起后端失败：${e && e.message ? e.message : String(e)}`
    trace(reason)
    return { ok: false, reason, log: collected.join('') }
  }

  // spawn 失败（cwd 不存在、exe 不可执行）是异步 error 事件，不监听就抓不住
  let spawnError = ''
  backend.on('error', (e) => {
    spawnError = e && e.message ? e.message : String(e)
    trace('[main] 后端 spawn 出错：' + spawnError)
  })

  backend.stdout?.on('data', (d) => collect('[backend] ', d))
  backend.stderr?.on('data', (d) => collect('[backend:err] ', d))

  backend.on('exit', (code) => {
    trace('[main] 后端退出，code = ' + code)
    backend = null

    // 42 = 后端主动要求重启（控制台点了「重启」）。
    // 常见于刚改完 API Key —— 那个值启动时才读，所以必须换进程才生效。
    if (code === 42 && !app.isQuitting) {
      trace('[main] 后端要求重启，1 秒后拉起')
      setTimeout(() => {
        ensureBackend()
          .then((r) => {
            trace('[main] 重启结果 ok=' + r.ok)
            if (r.ok && win && !win.isDestroyed()) {
              // 重启完重新加载一次，让页面拿到新状态
              win.webContents.reload()
            } else if (!r.ok) {
              trace('[main] 重启失败：' + r.reason)
            }
          })
          .catch((e) => trace('[main] 重启异常：' + (e && e.stack)))
      }, 1000)
      return
    }

// 其它情况：真崩了，自动拉起（最多 3 次），别让窗口继续显示旧数据、用户还以为 bot 在跑
    if (!app.isQuitting) {
      crashRestarts += 1
      if (crashRestarts <= 3) {
        trace('[main] 后端异常退出 code=' + code + '，第 ' + crashRestarts + ' 次自动重启')
        setTimeout(() => {
          ensureBackend()
            .then((r) => {
              if (r.ok && win && !win.isDestroyed()) win.webContents.reload()
              else if (!r.ok) trace('[main] 自动重启失败：' + r.reason)
            })
            .catch((e) => trace('[main] 自动重启异常：' + (e && e.stack)))
        }, 1500)
        return
      }
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          `document.body.insertAdjacentHTML('afterbegin','<div style="background:#c46a63;color:#fff;padding:10px;font:14px system-ui;z-index:99999">后端反复异常退出（已重试 3 次）。请查看数据目录下的日志。</div>')`,
        )
      }
    }
  })

  // 等就绪的同时盯着 spawn 错误，别干等 25 秒
  const ok = await waitReady(25000, () => (spawnError ? spawnError : ''))
  if (!ok) {
    const reason = spawnError
      ? `后端起不来：${spawnError}`
      : '后端 25 秒内没响应（没报错，可能启动很慢或端口被占）'
    trace('[main] ' + reason)
    return { ok: false, reason, log: collected.join('') }
  }
  // 后端起来了就把崩溃计数清零。
  // 不清零的话它是"进程生命周期内累计"：今天崩 3 次、明天再崩 1 次，
  // 第 4 次就不会自动拉起了，而且用户完全不知道为什么 —— 明明之前一直好好的。
  if (crashRestarts > 0) trace('[main] 后端已就绪，崩溃计数清零（原来是 ' + crashRestarts + '）')
  crashRestarts = 0
  return { ok: true, reason: '', log: '' }
}

/* ============================================================
 * 窗口
 * ============================================================ */

/**
 * 后端起不来时显示的错误页。
 *
 * 为什么不用一句 ERR_CONNECTION_REFUSED：
 *   用户看不到终端，也不知道日志在哪。把「为什么没起来」直接画在窗口里，
 *   截图发过来就能定位，不用教人找文件。
 */
function failPage(info) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const logText = info.log ? esc(String(info.log).slice(-4000)) : ''
  const logFile = path.join(process.env.APPDATA || '', 'vesper-main.log')

  return `<body style="background:#0d1117;color:#e6edf3;font:14px/1.7 system-ui;padding:40px;margin:0">
    <h2 style="color:#f85149;margin:0 0 6px">后端起不来</h2>
    <p style="color:#8b949e;margin:0 0 20px;word-break:break-all">${esc(info.reason)}</p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:18px">
      <div style="color:#8b949e;font-size:12px;margin-bottom:8px">后端输出</div>
      <div style="font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all">${logText || '（后端没有任何输出）'}</div>
    </div>
    <div style="color:#8b949e;font-size:12px;line-height:1.9">
      <div>日志文件：<code style="color:#79c0ff">${esc(logFile)}</code></div>
      <div>数据目录：<code style="color:#79c0ff">${esc(DATA_ROOT)}</code></div>
      <div>后端入口：<code style="color:#79c0ff">${esc(APP_ROOT)}\\build\\index.js</code></div>
      <div style="margin-top:14px">把这一屏截图发出来就能定位。</div>
    </div>
  </body>`
}

function createWindow(failInfo = null) {
  // 打包时 preload 会被改名成 .cjs（app/manifest 里是 type:module，
  // .js 会被当 ESM 解析，而 preload 必须是 CJS）。开发时还是 preload.js。
  const preloadName = existsSync(path.join(__dirname, 'preload.cjs')) ? 'preload.cjs' : 'preload.js'

  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'Vesper 控制台 · 小暮',
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

  // 后端没起来：直接把原因和日志画在窗口里，别让用户对着 ERR_CONNECTION_REFUSED 猜
  if (failInfo && !failInfo.ok) {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(failPage(failInfo)))
  } else {
    const token = consoleToken()
    const url = token ? `${consoleUrl()}/?token=${encodeURIComponent(token)}` : consoleUrl()
    win.loadURL(url)
  }

  win.once('ready-to-show', () => win.show())

  // 外链（比如 NapCat WebUI 的"在浏览器打开"）走系统浏览器，不要在应用里开
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    // 相对路径要先按当前页解析成绝对地址：shell.openExternal 只认绝对 URL。
    // 之前导出用的就是 /api/export?token=…，交给系统浏览器后 query 丢了，
    // 用户看到的就是"链接里没有 token"。这里做一层兜底。
    let abs = u
    try {
      abs = new URL(u, win.webContents.getURL()).toString()
    } catch {
      /* 解析不了就按原样 */
    }
    if (/^https?:/i.test(abs)) shell.openExternal(abs)
    return { action: 'deny' }
  })

  // 加载失败时给一句人话，不是 Chromium 的 ERR_CONNECTION_REFUSED
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return // 用户主动中断
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          failPage({
            ok: false,
            reason: `窗口打不开后端：${desc}（${code}）`,
            log: failInfo && failInfo.log ? failInfo.log : '',
          }),
        ),
    )
  })

  win.on('close', (e) => {
    // 关窗口不退出（留托盘）。但托盘没建起来时不能再 hide：
    // 那会变成窗口永久消失、没有入口，只能杀进程。
    if (!app.isQuitting && tray) {
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
  tray.setToolTip('Vesper')
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
// 单实例锁：允许双开的话会各拉一个后端，第二个必然 EADDRINUSE 白屏。
// 第二个实例直接退出，并尝试把已有窗口拉到前面。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.whenReady().then(async () => {
  // 去掉默认的 File/Edit/View/Window/Help 菜单栏 —— 这是个控制台窗口，
  // 没有任何一项对用户有用，反而占了 24px 还显得像半成品。
  Menu.setApplicationMenu(null)
  trace('app ready；isPackaged=' + app.isPackaged + ' resources=' + process.resourcesPath)
  trace('APP_ROOT=' + APP_ROOT)
  trace('DATA_ROOT=' + DATA_ROOT)

  // 启动期的任何异常都必须落到"用户看得见的地方"。
  //
  // 以前这一整段没有 try/catch：`%APPDATA%` 不可写（域账户 / 漫游配置 /
  // 杀软锁目录 / 磁盘满）时 ensureDataRoot() 一抛，后面的 createWindow /
  // createTray 全部跳过 —— 用户双击图标后**什么都没有**，
  // 任务管理器里却有个进程。那是最难自查的一种"坏了"。
  let backendResult
  try {
    ensureDataRoot()
    trace('ensureDataRoot 完成')
    backendResult = await ensureBackend()
    trace('ensureBackend 完成，ok=' + backendResult.ok + (backendResult.ok ? '' : ' 原因=' + backendResult.reason))
  } catch (e) {
    const reason = `启动失败：${e && e.message ? e.message : String(e)}`
    trace('[main] ' + reason + '\n' + (e && e.stack ? e.stack : ''))
    backendResult = { ok: false, reason, log: String((e && e.stack) || '') }
  }

  // 后端没起来就把原因画在窗口里，而不是让用户看 ERR_CONNECTION_REFUSED
  try {
    createWindow(backendResult)
    trace('createWindow 完成')
  } catch (e) {
    trace('[main] 开窗口失败：' + (e && e.stack))
    // 连窗口都开不了，至少给一个系统弹窗，别静默
    try {
      dialog.showErrorBox('Vesper 打不开界面', String((e && e.message) || e))
    } catch {
      /* 连弹窗都不行，就只能靠日志了 */
    }
  }
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
