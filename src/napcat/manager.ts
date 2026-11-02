/**
 * NapCat 管理器：启动 / 停止 / 状态查询。
 *
 * 所有路径都从 locate.ts 推导（配置里的 Shell目录 → 自动探测），
 * **不再写死盘符和版本号**。
 *
 * 两种装法都支持：
 *   注入型（OneKey）—— spawn NapCatWinBootMain.exe，注入到 QQ.exe
 *   Shell 型（官方 zip）—— node napcat.mjs
 *
 * 不依赖任何 .cmd 启动脚本：别人装 NapCat 不一定有我们改过的那个。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { loadRules } from '../core/config.ts'
import { autoLocate, resolvePaths, type NapcatPaths } from './locate.ts'
import { hideQqConsole } from './win.ts'
import { info, warnAt } from '../core/log.ts'

/* ============================================================
 * 定位
 * ============================================================ */

/** 按配置定位；配置为空就自动探测。返回错误原因字符串 */
export function locate(override?: string): NapcatPaths | { error: string } {
  let configured = ''
  try {
    configured = (loadRules().rules.NapCat?.Shell目录 ?? '').trim()
  } catch {
    configured = ''
  }

  const want = (override ?? configured).trim()

  // 1. 配置里填了 → 用它
  if (want) {
    const r = resolvePaths(want)
    if ('error' in r) return { error: `配置的 Shell目录 用不了：${r.error}` }
    return r
  }

  // 2. 自动探测
  const found = autoLocate()
  if (found.length) return found[0]!

  return {
    error:
      '找不到 NapCat。请在控制台「日志 → NapCat → 安装目录」里填一个，' +
      '或者装一个 OneKey 版的 NapCat（下载地址见 docs/NapCat安装.md）。',
  }
}

/* ============================================================
 * 进程存活判断（看门狗用）
 * ============================================================ */

/**
 * 我们自己 spawn 的 NapCat 进程 pid。
 *
 * 注入型是 NapCatWinBootMain（注入完可能自己就退了），Shell 型是 `node napcat.mjs`。
 * `spawnedGone` 由子进程的 exit 事件置位：进程真退了就别再拿这个 pid 去 kill，
 * 否则 pid 被系统复用之后会误杀别人的进程。
 */
let spawnedPid: number | null = null
let spawnedGone = false

/** pid 还活着吗。EPERM = 进程存在但没权限动它，也算活着。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Windows 上某个进程名在不在跑。
 *
 * 返回 null = 查不了（非 Windows / tasklist 不可用），**不要猜**：
 * 猜"在"会让看门狗永远不重启，猜"不在"会重启风暴。
 */
function imageRunning(image: string): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    import('node:child_process')
      .then(({ execFile }) => {
        execFile(
          'tasklist',
          ['/FI', `IMAGENAME eq ${image}`, '/NH'],
          { timeout: 8000, windowsHide: true },
          (err, stdout) => {
            if (err) return resolve(null)
            const re = new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
            resolve(re.test(String(stdout)))
          },
        )
      })
      .catch(() => resolve(null))
  })
}

/**
 * NapCat 进程还活着吗？
 *
 * true  = 确认在跑
 * false = 确认没跑
 * null  = 判断不了
 *
 * 为什么 Shell 型经常是 null：它也是 node.exe，和我们本进程同名，
 * 按名字查只会永远查到"自己"，所以只信自己 spawn 的那个 pid。
 */
async function napcatProcessAlive(p: NapcatPaths | null): Promise<boolean | null> {
  if (spawnedPid !== null && !spawnedGone && pidAlive(spawnedPid)) return true
  if (process.platform !== 'win32') return null
  if (!p) return null

  if (p.mode === 'inject') {
    // 注入型：NapCat 跑在 QQ.exe 里；NapCatWinBootMain 注入完可能已经退了
    const qq = await imageRunning('QQ.exe')
    if (qq === true) return true
    const boot = await imageRunning('NapCatWinBootMain.exe')
    if (boot === true) return true
    return qq === false && boot === false ? false : null
  }

  // Shell 型：进程名是 node.exe，只能信我们自己 spawn 的那个
  if (spawnedPid === null) return null
  return spawnedGone ? false : pidAlive(spawnedPid)
}

/* ============================================================
 * 启动
 * ============================================================ */

/**
 * 启动 NapCat。
 *
 * 记录日志 = false（默认）：stdio 忽略，完全无窗口
 * 记录日志 = true：捕获输出写到 napcat-console.log
 *                   （注入型的输出很少，但至少能看到启动失败的原因）
 */
export function start(): { ok: boolean; detail: string } {
  const p = locate()
  if ('error' in p) return { ok: false, detail: p.error }

  // 用户手动启动 = 撤销「手动停止」留下的看门狗冷却
  manualStopAt = 0

  let wantLog = false
  try {
    wantLog = loadRules().rules.NapCat?.记录日志 === true
  } catch {
    wantLog = false
  }

  const logFile = p.shellDir + '/napcat-console.log'
  if (wantLog) {
    try {
      mkdirSync(p.shellDir, { recursive: true })
      appendFileSync(logFile, `\n===== 启动于 ${new Date().toLocaleString('zh-CN')} =====\n`, 'utf8')
    } catch {
      /* 写不了就算了 */
    }
  }

  // ---- 注入型 ----
  if (p.mode === 'inject') {
    if (!p.qqExe || !p.launcher || !p.hook) {
      return { ok: false, detail: '注入型缺少 QQ.exe / NapCatWinBootMain.exe / 注入 DLL' }
    }

    // 先清掉上次的二维码，免得控制台显示一张过期的
    try {
      if (p.qrcode && existsSync(p.qrcode)) unlinkSync(p.qrcode)
    } catch {
      /* 删不掉不影响启动 */
    }

    try {
      const child = spawn(p.launcher, [p.qqExe, p.hook], {
        cwd: p.napcatDir,
        env: {
          ...process.env,
          NAPCAT_PATCH_PACKAGE: p.napcatDir + '/qqnt.json',
          NAPCAT_LOAD_PATH: p.napcatDir + '/loadNapCat.js',
          NAPCAT_INJECT_PATH: p.hook,
          NAPCAT_LAUNCHER_PATH: p.launcher,
          NAPCAT_MAIN_PATH: p.napcatDir + '/napcat.mjs',
        },
        detached: true,
        stdio: wantLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        // 关键：不弹任何窗口
        windowsHide: true,
      })
      // spawn 失败是异步的（ENOENT 等），没有 error 监听会被当成未捕获异常把进程崩掉。
      child.on('error', (err) => warnAt('NapCat 启动进程出错', { err: String(err) }))
      // 记住 pid 给看门狗/停止用；exit 时置 gone，避免之后 pid 复用误杀
      spawnedPid = child.pid ?? null
      spawnedGone = false
      child.on('exit', () => {
        if (child.pid === spawnedPid) spawnedGone = true
      })

      if (wantLog) {
        const w = (d: Buffer): void => {
          try {
            appendFileSync(logFile, d.toString('utf8'), 'utf8')
          } catch {
            /* ignore */
          }
        }
        child.stdout?.on('data', w)
        child.stderr?.on('data', w)
        child.on('exit', (code) => {
          try {
            appendFileSync(logFile, `\n===== 退出，code = ${code} =====\n`, 'utf8')
          } catch {
            /* ignore */
          }
        })
      }

      child.unref()

      // QQ 起来之后会多出一个控制台窗口（NapCatWinBootMain 启动 QQ 时没加
      // CREATE_NO_WINDOW，QQ 就继承到一个）。Node 的 windowsHide 管不到孙进程，
      // 只能等它出现后用 Win32 藏起来。
      //
      // 为什么要试好几次：QQ 起得有快有慢，5 秒时窗口可能还没建好；
      // 后台还会补开新的（实测有 3 个 QQ 进程各带一个控制台）。
      //
      // 第一次 1.5 秒就开始找：QQ 起来后窗口几乎立刻出现，
      // 等 5 秒才藏的话用户会看到"弹一下就没了"的闪屏。
      for (const delay of [1_500, 3_000, 5_000, 8_000, 12_000, 20_000, 35_000]) {
        setTimeout(() => {
          hideQqConsole().catch(() => {})
        }, delay)
      }

      return {
        ok: true,
        detail: wantLog ? '已启动（无窗口）。日志会写到 napcat-console.log。' : '已启动（无窗口）。',
      }
    } catch (e) {
      return { ok: false, detail: String(e).slice(0, 150) }
    }
  }

  // ---- Shell 型 ----
  if (!p.shellMjs) return { ok: false, detail: 'Shell 型缺少 napcat.mjs' }

  try {
    const child = spawn('node', [p.shellMjs], {
      cwd: p.shellDir,
      detached: true,
      stdio: wantLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    })
    // Shell 型靠 PATH 里的 node：打包后常常不存在，ENOENT 必须有监听，
    // 否则未捕获异常直接崩进程。
    child.on('error', (err) => warnAt('NapCat Shell 启动失败', { err: String(err) }))
    // Shell 型的进程名也是 node.exe，只能靠这个 pid 认出我们的 NapCat
    spawnedPid = child.pid ?? null
    spawnedGone = false
    child.on('exit', () => {
      if (child.pid === spawnedPid) spawnedGone = true
    })

    if (wantLog) {
      const w = (d: Buffer): void => {
        try {
          appendFileSync(logFile, d.toString('utf8'), 'utf8')
        } catch {
          /* ignore */
        }
      }
      child.stdout?.on('data', w)
      child.stderr?.on('data', w)
    }

    child.unref()
    return { ok: true, detail: '已启动（Shell 型，用 node 跑 napcat.mjs）' }
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 150) }
  }
}

/* ============================================================
 * 停止
 * ============================================================ */

/**
 * 停掉 NapCat（控制台「停止」按钮走这里）。
 *
 * 只杀 NapCatWinBootMain（注入型）—— 不动 QQ.exe：
 * 那可能是你日常用的 QQ，杀掉太粗暴。注入的那个 QQ 会跟着一起退。
 *
 * 会记一笔「用户手动停过」：看门狗 30 分钟内不自动拉起，
 * 否则刚点完停止 3 分钟它又自己开了，看着像闹鬼。
 */
export async function stop(): Promise<{ ok: boolean; detail: string }> {
  manualStopAt = Date.now()
  return stopNow()
}

/** 真正的停止逻辑。restart() 也走这里：那不算“用户手动停”，不该进看门狗的冷却。 */
async function stopNow(): Promise<{ ok: boolean; detail: string }> {
  const { execFile } = await import('node:child_process')

  /**
   * 杀掉 NapCatWinBootMain.exe。
   *
   * 两个坑：
   *  1. taskkill 在进程不存在时会失败，但这不是"停止失败"——本来就没在跑，是成功。
   *     以前靠 `/找不到/` 正则判，可 Windows 中文版 taskkill 的输出是 **GBK**，
   *     Node 按 UTF-8 解出来是乱码，正则永远匹配不上 → 用户点"停止"看到
   *     「停止失败：?????? ü????? "NapCatWinBootMain.exe"???"」。
   *  2. 所以改成**先查进程在不在**（tasklist 的输出是 ASCII，不受编码影响），
   *     不在就直接算成功；真失败时也不把 stderr 原文抛给用户，只给一句能看懂的话。
   */
  const kill = async (): Promise<{ ok: boolean; msg: string }> => {
    const running = await imageRunning('NapCatWinBootMain.exe')
    if (running === false) return { ok: true, msg: '' } // 本来就没在跑
    return new Promise((resolve) => {
      execFile('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/F'], (err) => {
        if (!err) return resolve({ ok: true, msg: '' })
        // 不转发 stderr（GBK 乱码）；再查一次，进程确实没了就当成功
        void imageRunning('NapCatWinBootMain.exe').then((still) => {
          resolve(still === false ? { ok: true, msg: '' } : { ok: false, msg: '进程还在，可能被别的程序占用或权限不够' })
        })
      })
    })
  }

  // 先停我们自己 spawn 的进程。
  // Shell 型只能这么停：它的进程名也是 node.exe，taskkill /IM 会连本进程一起杀。
  let killedOwn = false
  if (spawnedPid !== null && !spawnedGone && pidAlive(spawnedPid)) {
    try {
      process.kill(spawnedPid)
      killedOwn = true
    } catch {
      /* 杀不掉的话，下面按模式再决定要不要 taskkill */
    }
    for (let i = 0; i < 15 && pidAlive(spawnedPid); i++) {
      await new Promise((r) => setTimeout(r, 200))
    }
    spawnedGone = !pidAlive(spawnedPid)
  }

  // Shell 型：它的进程名是 node.exe，taskkill NapCatWinBootMain.exe 根本停不了它，
  // 反而会误杀本机另一个注入型 NapCat（同一台机器装两种的情况真有）。
  // 所以 Shell 型只认我们自己 spawn 的 pid，停不掉就明说。
  const located = locate()
  if (!('error' in located) && located.mode === 'shell') {
    if (killedOwn) return { ok: true, detail: '已停止（Shell 型，已结束自己拉起的进程）' }
    if (spawnedPid === null) {
      return {
        ok: false,
        detail: 'Shell 型的 NapCat 不是本进程启动的，没有可安全停止的 pid（请手动关掉那个 node 进程）',
      }
    }
    return { ok: false, detail: 'Shell 型的 NapCat 进程没停掉（可能已经退出或没有权限）' }
  }

  const first = await kill()
  if (first.ok) return { ok: true, detail: killedOwn ? '已停止（含自己拉起的进程）' : '已停止' }

  if (/access is denied|拒绝访问|could not be terminated/i.test(first.msg)) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "Start-Process -FilePath 'taskkill' -ArgumentList '/IM','NapCatWinBootMain.exe','/F' -Verb RunAs -WindowStyle Hidden",
          ],
          (err) => (err ? reject(err) : resolve()),
        )
      })
      await new Promise((r) => setTimeout(r, 2500))
      return { ok: true, detail: '已尝试停止（弹了 UAC 的话要点「是」）' }
    } catch (e) {
      return { ok: false, detail: '需要管理员权限才能停：' + String(e).slice(0, 100) }
    }
  }

  return { ok: false, detail: first.msg.slice(0, 150) }
}

/**
 * 重启 NapCat：停 → 等进程真退出 → 起。
 *
 * 为什么必须等：taskkill / 进程退出都是异步的，立刻 start 会撞上还在退的旧进程
 * （注入型表现为新 QQ 起不来，Shell 型表现为端口冲突）。
 */
export async function restart(): Promise<{ ok: boolean; detail: string }> {
  const stopped = await stopNow()
  await new Promise((r) => setTimeout(r, 2500))
  const started = start()
  if (!started.ok) return { ok: false, detail: started.detail }
  return {
    ok: true,
    detail: stopped.ok ? started.detail : `停止旧进程时报错（仍尝试启动）：${stopped.detail}；${started.detail}`,
  }
}

/* ============================================================
 * 二维码文件
 * ============================================================ */

/** 二维码图片路径（不存在返回 null）*/
export function qrcodeFile(override?: string): string | null {
  const p = locate(override)
  if ('error' in p) return null
  if (p.qrcode && existsSync(p.qrcode)) return p.qrcode
  return null
}

/* ============================================================
 * 日志文件
 * ============================================================ */

/** 日志路径（不存在返回 null）*/
export function logFile(): string | null {
  const p = locate()
  if ('error' in p) return null
  const f = p.shellDir + '/napcat-console.log'
  return existsSync(f) ? f : null
}



/* ============================================================
 * 掉线看门狗
 *
 * 判定「掉线」的依据只有一条硬信号：OnebotTransport.connected 为 false，
 * 也就是 NapCat 的 WS 连接不在了。这是唯一直接对应"收不到消息"的状态：
 *   - 有连接   → 一定没掉线（哪怕 QQ 进程名查不到）
 *   - 没连接   → 可能是 NapCat 没起来、QQ 被登出、WS 客户端地址配错，
 *                这几种都能靠"重启 NapCat"救回来
 * 进程检查只用来加速/分类，不作为唯一依据：
 *   - 进程确认没了 → 2 次检查（约 2 分钟）就重启
 *   - 进程在 / 判断不了 → 3 次检查（约 3 分钟）才重启，避开启动、扫码登录的慢窗口
 * 另外两种情况绝不重启（重启没用，还会把用户的操作打断）：
 *   - WS 服务端自己没起来（端口被占用 / 权限）→ 那是本进程的问题
 *   - 控制台刚手动点过「停止」→ 30 分钟内不碰
 *
 * 防重启风暴：两次自动重启至少隔 5 分钟，连续失败翻倍，上限 30 分钟。
 * ============================================================ */

/** 检查间隔 */
const WATCHDOG_INTERVAL = 60_000
/** 连续几次检查都没连上才算掉线（NapCat 启动/扫码登录本来就要一会儿） */
const WATCHDOG_STRIKES = 3
/** 进程确认不在：不用等那么久 */
const WATCHDOG_STRIKES_PROC_GONE = 2
/** 两次自动重启之间的最短间隔，连续失败翻倍 */
const WATCHDOG_COOLDOWN = 5 * 60_000
const WATCHDOG_MAX_COOLDOWN = 30 * 60_000
/** 控制台手动点过「停止」之后，这段时间内不自动拉起 */
const WATCHDOG_MANUAL_GRACE = 30 * 60_000
/** 同一类"重启也没用"的告警最多这么久一条，别刷屏 */
const WATCHDOG_WARN_GAP = 30 * 60_000

export interface WatchdogDeps {
  /** WS 是否连着（传 transport.connected === true） */
  isConnected: () => boolean
  /** 通道服务端启动失败的原因（端口占用等）。有值说明重启 NapCat 没用 */
  startError?: () => string | null
}

export interface WatchdogStatus {
  /** 看门狗是否在工作（配置关掉时是 false） */
  enabled: boolean
  connected: boolean
  /** NapCat 进程：true 在 / false 不在 / null 判断不了 */
  processAlive: boolean | null
  /** 连续几次检查没连上 */
  strikes: number
  /** 当前需要几次才判定掉线 */
  strikesNeeded: number
  restarts: number
  lastRestartAt: number
  /** 最早什么时候允许下一次自动重启 */
  nextAttemptAt: number
  lastCheckAt: number
  /** 现在压着不重启的原因（给人看的） */
  holdReason: string | null
}

let watchdogTimer: NodeJS.Timeout | null = null
let watchdogEnabled = false
let watchdogConfigOn = true
let watchdogConnected = false
let watchdogProcAlive: boolean | null = null
let watchdogStrikes = 0
let watchdogStrikesNeeded = WATCHDOG_STRIKES
let watchdogRestarts = 0
let watchdogLastRestartAt = 0
let watchdogNextAttemptAt = 0
let watchdogLastCheckAt = 0
let watchdogFailures = 0
let watchdogHoldReason: string | null = null
let watchdogLastWarnAt = 0
let watchdogBusy = false
/** 控制台手动停止的时间点（0 = 没手动停过）。start() 会清掉 */
let manualStopAt = 0

/** 看门狗当前状态（给 /api/status 之类的状态上报用） */
export function watchdogStatus(): WatchdogStatus {
  return {
    enabled: watchdogEnabled,
    connected: watchdogConnected,
    processAlive: watchdogProcAlive,
    strikes: watchdogStrikes,
    strikesNeeded: watchdogStrikesNeeded,
    restarts: watchdogRestarts,
    lastRestartAt: watchdogLastRestartAt,
    nextAttemptAt: watchdogNextAttemptAt,
    lastCheckAt: watchdogLastCheckAt,
    holdReason: watchdogHoldReason,
  }
}

/** 现读配置：控制台改完 NapCat.掉线重启 不重启进程也能生效 */
function readWatchdogEnabled(): boolean {
  try {
    return loadRules().rules.NapCat?.掉线重启 !== false
  } catch {
    // 配置坏了按默认（开）走：宁可多管一点，也别静默失效
    return true
  }
}

function describeProc(v: boolean | null): string {
  return v === true ? '在' : v === false ? '不在' : '判断不了'
}

/**
 * 启动看门狗。只应由 index.ts 在 transport.start() 之后调一次。
 *
 * 第一次检查在一个完整周期之后（60 秒），再连续几次才动作，
 * 所以启动时 NapCat 还在登录也不会被误判。
 */
export function startWatchdog(deps: WatchdogDeps): void {
  if (watchdogTimer) return

  watchdogConfigOn = readWatchdogEnabled()
  watchdogEnabled = watchdogConfigOn
  if (!watchdogConfigOn) {
    info('NapCat 掉线看门狗未启用（rules.yaml 的 NapCat.掉线重启 = false）')
  } else {
    info(
      `NapCat 掉线看门狗已启动：每 ${WATCHDOG_INTERVAL / 1000} 秒检查一次，` +
        `WS 连续 ${WATCHDOG_STRIKES} 次没连上就自动重启；` +
        `两次重启至少隔 ${WATCHDOG_COOLDOWN / 60_000} 分钟（连续失败翻倍，上限 ${WATCHDOG_MAX_COOLDOWN / 60_000} 分钟）`,
    )
  }

  watchdogTimer = setInterval(() => {
    void watchdogTick(deps)
  }, WATCHDOG_INTERVAL)
  watchdogTimer.unref?.()
}

/** 停掉看门狗（测试/退出时用） */
export function stopWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer)
  watchdogTimer = null
  watchdogEnabled = false
}

async function watchdogTick(deps: WatchdogDeps): Promise<void> {
  // 上一次检查还没跑完（restart 里有 await）就跳过，别叠着来
  if (watchdogBusy) return
  watchdogBusy = true
  try {
    watchdogLastCheckAt = Date.now()

    // 1. 配置开关：每次现读，控制台改完不用重启进程
    const want = readWatchdogEnabled()
    if (want !== watchdogConfigOn) {
      watchdogConfigOn = want
      watchdogEnabled = want
      if (want) info('NapCat 掉线看门狗已启用')
      else warnAt('NapCat 掉线看门狗已关闭（NapCat.掉线重启 = false），掉线不会自动重启')
    }
    watchdogEnabled = want
    if (!want) {
      watchdogHoldReason = '配置关闭（NapCat.掉线重启 = false）'
      return
    }

    // 2. 采样：WS 连接 + NapCat 进程
    watchdogConnected = deps.isConnected() === true
    const located = locate()
    watchdogProcAlive = 'error' in located ? null : await napcatProcessAlive(located)

    if (watchdogConnected) {
      const wasDown = watchdogStrikes > 0 || watchdogFailures > 0
      watchdogStrikes = 0
      watchdogStrikesNeeded = WATCHDOG_STRIKES
      watchdogFailures = 0
      watchdogNextAttemptAt = 0
      watchdogHoldReason = null
      if (wasDown) info('NapCat 已连上，看门狗计数清零')
      return
    }

    // 3. WS 服务端本身没起来（端口被占用 / 权限）：重启 NapCat 解决不了
    const startErr = deps.startError?.() ?? null
    if (startErr) {
      watchdogStrikes = 0
      watchdogHoldReason = '通道服务端启动失败（端口占用？）'
      if (Date.now() - watchdogLastWarnAt > WATCHDOG_WARN_GAP) {
        watchdogLastWarnAt = Date.now()
        warnAt('NapCat 没连上，但 WS 服务端自己起不来，看门狗不重启 NapCat（重启没用）', {
          err: startErr.slice(0, 160),
        })
      }
      return
    }

    // 4. 用户刚在控制台点了「停止」：给 30 分钟安静时间
    if (manualStopAt > 0 && Date.now() - manualStopAt < WATCHDOG_MANUAL_GRACE) {
      watchdogStrikes = 0
      watchdogHoldReason = `控制台手动停止过，${Math.ceil((WATCHDOG_MANUAL_GRACE - (Date.now() - manualStopAt)) / 60_000)} 分钟内不自动拉起`
      return
    }

    // 5. 定位不到 NapCat：起不来，别每 60 秒白试
    if ('error' in located) {
      watchdogStrikes = 0
      watchdogHoldReason = '定位不到 NapCat（检查 NapCat.Shell目录）'
      if (Date.now() - watchdogLastWarnAt > WATCHDOG_WARN_GAP) {
        watchdogLastWarnAt = Date.now()
        warnAt('NapCat 没连上，但定位不到安装目录，看门狗无法重启', { err: located.error.slice(0, 160) })
      }
      return
    }

    // 6. 连续计数
    watchdogStrikes += 1
    watchdogStrikesNeeded = watchdogProcAlive === false ? WATCHDOG_STRIKES_PROC_GONE : WATCHDOG_STRIKES
    watchdogHoldReason = `掉线计时中（${watchdogStrikes}/${watchdogStrikesNeeded}）`
    if (watchdogStrikes === 1 && Date.now() >= watchdogNextAttemptAt) {
      warnAt('NapCat 没连上，看门狗开始计时', {
        判定阈值: `${watchdogStrikesNeeded} 次检查（约 ${(watchdogStrikesNeeded * WATCHDOG_INTERVAL) / 60_000} 分钟）`,
        进程: describeProc(watchdogProcAlive),
      })
    }
    if (watchdogStrikes < watchdogStrikesNeeded) return

    // 7. 冷却：距上次自动重启太近就先等
    if (Date.now() < watchdogNextAttemptAt) {
      watchdogHoldReason = `重启冷却中（还剩约 ${Math.ceil((watchdogNextAttemptAt - Date.now()) / 60_000)} 分钟）`
      return
    }

    // 8. 重启
    const r = await restart()
    watchdogRestarts += 1
    watchdogLastRestartAt = Date.now()
    watchdogFailures += 1
    watchdogNextAttemptAt =
      Date.now() + Math.min(WATCHDOG_COOLDOWN * 2 ** (watchdogFailures - 1), WATCHDOG_MAX_COOLDOWN)
    // 重启后重新计时：给 NapCat 启动 + QQ 登录留时间
    watchdogStrikes = 0
    watchdogStrikesNeeded = WATCHDOG_STRIKES
    watchdogHoldReason = null
    const next = new Date(watchdogNextAttemptAt).toLocaleTimeString('zh-CN')
    if (r.ok) {
      info('NapCat 掉线，已自动重启', {
        第几次: watchdogRestarts,
        进程: describeProc(watchdogProcAlive),
        下次最早: next,
      })
    } else {
      warnAt('NapCat 掉线，自动重启失败（会退避重试）', {
        第几次: watchdogRestarts,
        原因: r.detail.slice(0, 200),
        下次最早: next,
      })
    }
  } catch (err) {
    warnAt('NapCat 看门狗检查出错（本轮跳过）', { err: String(err).slice(0, 200) })
  } finally {
    watchdogBusy = false
  }
}
