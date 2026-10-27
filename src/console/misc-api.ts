/**
 * 杂项接口：NapCat 状态、余额。
 *
 * 单独一个文件——server.ts 已经 1200 行，往里加东西风险太大（改坏过两次）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRules } from '../core/config.ts'
// NapCat 的定位和启停交给这个模块：它从配置的 Shell目录 推导所有路径，
// 不写死盘符和版本号。misc-api 只做 HTTP → 它的转发。
import * as NC from '../napcat/manager.ts'

type Json = (res: ServerResponse, code: number, body: unknown) => void

/** 纯文本响应（二维码 404 之类用） */
function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/** NapCat WebUI 的 API 根（不带路径） */
const NAPCAT_WEBUI = 'http://127.0.0.1:6099'
/** WebUI 页面地址。注意必须带 /webui/，根路径 / 只是个空壳 */
const NAPCAT_WEBUI_PAGE = 'http://127.0.0.1:6099/webui/'

export async function handleMiscApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  _url: URL,
  json: Json,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  /* ============ NapCat ============ */
  if (method === 'GET' && path === '/api/napcat') {
    let running = false
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 1500)
      const r = await fetch(NAPCAT_WEBUI, { signal: ctrl.signal })
      clearTimeout(timer)
      running = r.ok || r.status === 401 || r.status === 403
    } catch {
      running = false
    }

    // 顺手把定位结果带上，前端能显示"装在哪、什么模式"
    const loc = NC.locate()
    const where =
      'error' in loc
        ? { locateError: loc.error }
        : { shellDir: loc.shellDir, mode: loc.mode, napcatDir: loc.napcatDir }

    json(res, 200, { running, webui: NAPCAT_WEBUI, webuiPage: NAPCAT_WEBUI_PAGE, ...where })
    return true
  }

  /* ============ NapCat 安装目录（读 / 改） ============ */
  if (method === 'GET' && path === '/api/napcat/shelldir') {
    let configured = ''
    try {
      configured = loadRules().rules.NapCat?.Shell目录 ?? ''
    } catch {
      configured = ''
    }
    const loc = NC.locate()
    if ('error' in loc) {
      json(res, 200, { configured, ok: false, error: loc.error })
      return true
    }
    json(res, 200, { configured, ok: true, shellDir: loc.shellDir, mode: loc.mode })
    return true
  }

  if (method === 'PUT' && path === '/api/napcat/shelldir') {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { shellDir?: string }
    const want = String(body.shellDir ?? '').trim()

    // 先验证这个目录能不能用（空字符串 = 恢复自动探测）
    if (want) {
      const test = NC.locate(want)
      if ('error' in test) {
        json(res, 400, { error: test.error })
        return true
      }
    }

    const { setConfigPath } = await import('./config-write.ts')
    const raw = readFileSync('persona/rules.yaml', 'utf8')
    const r = setConfigPath(raw, 'NapCat.Shell目录', want)
    if (!r.ok) {
      json(res, 400, { error: r.error ?? '改不了' })
      return true
    }
    writeFileSync('persona/rules.yaml', r.text, 'utf8')

    const after = NC.locate()
    json(res, 200, {
      ok: true,
      shelldir: want,
      resolved: 'error' in after ? null : { shellDir: after.shellDir, mode: after.mode },
    })
    return true
  }

  /* ============ NapCat 二维码图片 ============ */
  // NapCat 自己会把二维码存成 <napcat>/cache/qrcode.png（启动脚本里也是这么用的）。
  // 直接读它就行，不用拿 qrcodeurl 自己画。
  if (method === 'GET' && path === '/api/napcat/qrcode.png') {
    const f = NC.qrcodeFile()
    if (!f) {
      text(res, 404, '没有二维码文件')
      return true
    }
    try {
      const buf = readFileSync(f)
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(buf.length),
        // 关键：不许缓存。二维码会变，缓存了扫不动
        'cache-control': 'no-store, no-cache, must-revalidate',
      })
      res.end(buf)
    } catch {
      text(res, 500, '读不了二维码文件')
    }
    return true
  }

  /* ============ NapCat 日志开关 ============ */
  // 关着（默认）：无窗口启动，状态/二维码在控制台里
  // 打开：走 .cmd 启动，多一个最小化窗口，但能拿到 NapCat 的原始日志
  if (method === 'GET' && path === '/api/napcat/logsetting') {
    try {
      json(res, 200, { 记录日志: loadRules().rules.NapCat?.记录日志 === true })
    } catch (e) {
      json(res, 200, { 记录日志: false, error: String(e).slice(0, 100) })
    }
    return true
  }

  if (method === 'PUT' && path === '/api/napcat/logsetting') {
    // 自己读 body（handleMiscApi 的签名里没有 readBody，不想改所有调用方）
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(rawBody || '{}') as { 记录日志?: boolean }
    const { setConfigPath } = await import('./config-write.ts')
    const raw = readFileSync('persona/rules.yaml', 'utf8')
    const r = setConfigPath(raw, 'NapCat.记录日志', body.记录日志 === true)
    if (!r.ok) {
      json(res, 400, { error: r.error ?? '改不了' })
      return true
    }
    writeFileSync('persona/rules.yaml', r.text, 'utf8')
    json(res, 200, { ok: true, 记录日志: body.记录日志 === true })
    return true
  }

  /* ============ NapCat 启动 / 停止 / 重启 ============ */
  // 为什么能做：NapCat 是独立进程，不是我们服务的一部分。
  // 启动脚本自己会处理提权（net session 判断 + Start-Process -Verb RunAs）。
  if (method === 'POST' && path === '/api/napcat/start') {
    const r = NC.start()
    json(res, 200, r)
    return true
  }

  if (method === 'POST' && path === '/api/napcat/stop') {
    const r = await NC.stop()
    json(res, 200, r)
    return true
  }

  if (method === 'POST' && path === '/api/napcat/restart') {
    const stopped = await NC.stop()
    // 等进程真退干净再启动，不然会抢端口
    await new Promise((r) => setTimeout(r, 2500))
    const started = NC.start()
    json(res, 200, { ok: started.ok, stopped: stopped.detail, started: started.detail })
    return true
  }

  /* ============ NapCat 控制台输出 ============ */
  // NapCat 自己不写日志文件（logs/ 目录一直是空的），cmd 窗口的输出只在屏幕上。
  // 启动脚本里加了 Tee-Object，会同时写一份到 <NapCat目录>/napcat-console.log。
  if (method === 'GET' && path === '/api/napcat/console') {
    const limit = Math.min(2000, Math.max(1, Number(_url.searchParams.get('lines') ?? 200)))
    const f = NC.logFile()

    if (!f) {
      json(res, 200, {
        available: false,
        reason: '还没有日志文件。用改过的启动脚本重启一次 NapCat 就会生成。',
        lines: [],
      })
      return true
    }

    try {
      // 直接读，和运行日志（/api/logs/recent）一样的写法。
      //
      // 为什么现在能直接读：以前这个文件是 .cmd 里 PowerShell 的 Tee-Object 写的
      // （UTF-16LE），readFileSync(f,'utf8') 读出来全是乱码，只能让 PowerShell 自己读。
      // 现在 manager.ts 捕获子进程 stdout 后自己 appendFileSync('utf8')，
      // 文件已经是纯 UTF-8，直接读即可。
      //
      // 下面按 BOM 判断是为了兼容老版 .cmd 留下的 UTF-16LE 文件。
      const buf = readFileSync(f)
      let text: string
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.subarray(2).toString('utf16le')
      } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        text = buf.subarray(3).toString('utf8')
      } else {
        text = buf.toString('utf8')
      }

      // 去掉 ANSI 颜色码（NapCat 输出里有 \u001b[33m 这种）
      const cleaned = text.replace(/\u001b\[[0-9;]*m/g, '')
      const all = cleaned.split(/\r?\n/).filter((l) => l.trim())
      json(res, 200, {
        available: true,
        path: f,
        total: all.length,
        lines: all.slice(-limit),
        // 文件大小和最后修改时间，方便判断"是不是新的"
        bytes: (() => {
          try {
            return statSync(f).size
          } catch {
            return 0
          }
        })(),
        mtime: (() => {
          try {
            const st = statSync(f)
            return st.mtimeMs
          } catch {
            return 0
          }
        })(),
      })
    } catch (e) {
      json(res, 200, { available: false, reason: String(e).slice(0, 100), lines: [] })
    }
    return true
  }

  /* ============ NapCat 登录状态 + 二维码 ============ */
  // 为什么这么绕：NapCat 的 WebUI 不是公开 API，要先换 Credential 才能查。
  // 换的算法是从它的前端 bundle 里挖出来的：sha256(token + ".napcat")。
  if (method === 'GET' && path === '/api/napcat/login') {
    const r = await napcatLoginStatus()
    json(res, 200, r)
    return true
  }

  /* ============ 余额 ============ */
  if (method === 'GET' && path === '/api/balance') {
    const key = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
    const base = (process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com').replace(/\/v1\/?$/, '')

    let total: number | null = null
    let currency = 'CNY'
    let available = false
    if (key) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 3000)
        const r = await fetch(`${base}/user/balance`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        if (r.ok) {
          const j = (await r.json()) as {
            is_available?: boolean
            balance_infos?: Array<{ currency?: string; total_balance?: string }>
          }
          available = j.is_available === true
          const info = j.balance_infos?.[0]
          if (info) {
            currency = info.currency ?? 'CNY'
            const n = Number(info.total_balance)
            if (Number.isFinite(n)) total = n
          }
        }
      } catch {
        /* 查不到就返回 null */
      }
    }

    // 今日/本周/本月的花费：从今日日志里的 token 用量估
    const spent = estimateSpend()

    json(res, 200, { total, currency, available, ...spent })
    return true
  }

  return false
}

/**
 * 从 data/logs 里估花费。
 *
 * 为什么要估：DeepSeek 没有"按天查花费"的接口，只有总余额。
 * 那就用 token 用量 × 单价算。单价按 ¥1/百万 输入、¥2/百万 输出（和 cost 接口一致）。
 */
function estimateSpend(): { today: number; week: number; month: number } {
  const out = { today: 0, week: 0, month: 0 }
  try {
    const dir = 'data/logs'
    if (!existsSync(dir)) return out

    const now = Date.now()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const weekStart = new Date(dayStart)
    weekStart.setDate(weekStart.getDate() - 7)
    const monthStart = new Date(dayStart)
    monthStart.setDate(monthStart.getDate() - 30)

    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      let raw = ''
      try {
        raw = readFileSync(`${dir}/${f}`, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.includes('token 用量')) continue
        try {
          // 两种格式都存在（log.ts 改过）：
          //   老：{"t":...,"prompt":217,"completion":10}            字段在顶层
          //   新：{"ts":...,"extra":{"prompt":4138,"completion":9}}  字段在 extra 里
          const j = JSON.parse(line) as {
            t?: number
            ts?: number
            prompt?: number
            completion?: number
            extra?: { prompt?: number; completion?: number }
          }
          const ts = j.t ?? j.ts ?? 0
          const p = Number(j.prompt ?? j.extra?.prompt ?? 0)
          const c = Number(j.completion ?? j.extra?.completion ?? 0)
          if (!Number.isFinite(p) || !Number.isFinite(c)) continue
          // ¥1/百万输入，¥2/百万输出
          const cost = (p / 1_000_000) * 1 + (c / 1_000_000) * 2

          if (now - ts <= 86_400_000 && ts >= dayStart.getTime()) out.today += cost
          if (ts >= weekStart.getTime()) out.week += cost
          if (ts >= monthStart.getTime()) out.month += cost
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  } catch {
    /* 读不到就返回 0 */
  }
  // 保留 4 位小数（小额也有意义）
  return {
    today: Math.round(out.today * 10000) / 10000,
    week: Math.round(out.week * 10000) / 10000,
    month: Math.round(out.month * 10000) / 10000,
  }
}

/**
 * 查 NapCat 的登录状态和二维码链接。
 *
 * 拿不到就返回 available:false + reason，前端据此决定要不要显示二维码。
 * 不抛错 —— 这个功能挂了不该影响整个页面。
 */
async function napcatLoginStatus(): Promise<{
  available: boolean
  reason?: string
  isLogin?: boolean
  phase?: string
  account?: string
  nick?: string
  webui?: string
  /** 带 token 的 WebUI 地址（iframe 用，可以免登录） */
  webuiAuto?: string
  hasQrcode?: boolean
}> {
  // 走 napcat/manager 的定位：它从配置的 Shell目录 推导，不写死版本号。
  // 以前这里硬编码 E:/NapCat/NapCat.52230.Shell，NapCat 一升级就读不到 webui.json。
  const located = NC.locate()
  if ('error' in located) return { available: false, reason: located.error }
  const cfgPath = located.webuiConfig
  if (!cfgPath) return { available: false, reason: '找不到 NapCat 的 webui.json' }

  let token = ''
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { token?: string }
    token = raw.token ?? ''
  } catch {
    return { available: false, reason: 'webui.json 读不了' }
  }
  if (!token) return { available: false, reason: 'webui.json 里没有 token' }

  const got = await getCredential(token)
  if (!got.cred) return { available: false, reason: got.error ?? '登录 NapCat 失败' }

  try {
    const H = { 'content-type': 'application/json', Authorization: 'Bearer ' + got.cred }

    const sr = await fetch(NAPCAT_WEBUI + '/api/QQLogin/CheckLoginStatus', {
      method: 'POST',
      headers: H,
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    const sj = (await sr.json()) as {
      code?: number
      data?: {
        isLogin?: boolean
        loginPhase?: string
        isOffline?: boolean
      }
    }
    const d = sj.data ?? {}

    // 已登录的话顺便把账号和昵称也带上（显示"当前登录的是 xxx"）
    let account = ''
    let nick = ''
    if (d.isLogin) {
      try {
        const ir = await fetch(NAPCAT_WEBUI + '/api/QQLogin/GetQQLoginInfo', {
          method: 'POST',
          headers: H,
          body: '{}',
          signal: AbortSignal.timeout(3000),
        })
        const ij = (await ir.json()) as { data?: { uin?: string; nick?: string } }
        account = ij.data?.uin ?? ''
        nick = ij.data?.nick ?? ''
      } catch {
        /* 拿不到就不显示 */
      }
    }

    const qrFile = NC.qrcodeFile()
    return {
      available: true,
      isLogin: d.isLogin === true,
      // 有图才显示；图可能过期（NapCat 登录后不一定删），
      // 所以前端只在未登录时才用它
      hasQrcode: Boolean(qrFile),
      webui: NAPCAT_WEBUI_PAGE,
      // 带 token 的 WebUI 地址 —— 它的前端认 ?token=，会自己登录。
      // 不带的话 iframe 里永远是登录页。
      webuiAuto: NAPCAT_WEBUI_PAGE + '?token=' + encodeURIComponent(token),
      phase: d.loginPhase ?? '',
      account,
      nick,
    }
  } catch (e) {
    return { available: false, reason: String(e).slice(0, 120) }
  }
}

/**
 * NapCat 的 Credential 缓存。
 *
 * 为什么必须缓存：NapCat 的 webui.json 里有 loginRate（默认 10 次/分钟）。
 * 之前每次查状态都登录一次，前端 3 秒轮询 → 十几秒就超限，
 * 表现为"突然查不到登录状态了"（login rate limit）。
 *
 * Credential 本身是 JWT，10 分钟换一次足够。
 */
let cachedCred = ''
let cachedAt = 0
const CRED_TTL = 10 * 60_000

/**
 * 拿一个能用的 Credential。
 * 有缓存就用缓存；缓存过期或没有才真登录一次。
 */
async function getCredential(token: string): Promise<{ cred: string; error?: string }> {
  if (cachedCred && Date.now() - cachedAt < CRED_TTL) return { cred: cachedCred }

  const hash = createHash('sha256').update(token + '.napcat').digest('hex')
  try {
    const r = await fetch(NAPCAT_WEBUI + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(3000),
    })
    const j = (await r.json()) as { code?: number; message?: string; data?: { Credential?: string } }
    const cred = j.data?.Credential
    if (cred) {
      cachedCred = cred
      cachedAt = Date.now()
      return { cred }
    }
    // 限流的话，如果手里还有旧的就先用旧的（总比没有强）
    if (j.message?.includes('rate limit')) {
      if (cachedCred) return { cred: cachedCred }
      return { cred: '', error: 'NapCat 登录被限流了（loginRate），等一分钟再试' }
    }
    return { cred: '', error: '登录 NapCat 失败：' + (j.message ?? '没拿到 Credential') }
  } catch (e) {
    if (cachedCred) return { cred: cachedCred }
    return { cred: '', error: String(e).slice(0, 100) }
  }
}
