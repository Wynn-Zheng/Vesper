/**
 * 杂项接口：NapCat 状态、余额。
 *
 * 单独一个文件——server.ts 已经 1200 行，往里加东西风险太大（改坏过两次）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
    json(res, 200, { running, webui: NAPCAT_WEBUI, webuiPage: NAPCAT_WEBUI_PAGE })
    return true
  }

  /* ============ NapCat 二维码图片 ============ */
  // NapCat 自己会把二维码存成 <napcat>/cache/qrcode.png（启动脚本里也是这么用的）。
  // 直接读它就行，不用拿 qrcodeurl 自己画。
  if (method === 'GET' && path === '/api/napcat/qrcode.png') {
    const f = findQrcodeFile()
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

  /* ============ NapCat 控制台输出 ============ */
  // NapCat 自己不写日志文件（logs/ 目录一直是空的），cmd 窗口的输出只在屏幕上。
  // 启动脚本里加了 Tee-Object，会同时写一份到 <NapCat目录>/napcat-console.log。
  if (method === 'GET' && path === '/api/napcat/console') {
    const limit = Math.min(2000, Math.max(1, Number(_url.searchParams.get('lines') ?? 200)))
    const f = findConsoleLog()

    if (!f) {
      json(res, 200, {
        available: false,
        reason: '还没有日志文件。用改过的启动脚本重启一次 NapCat 就会生成。',
        lines: [],
      })
      return true
    }

    try {
      const raw = readFileSync(f, 'utf8')
      const all = raw.split('\n').filter((l) => l.trim())
      json(res, 200, {
        available: true,
        path: f,
        total: all.length,
        lines: all.slice(-limit),
        // 文件大小和最后修改时间，方便判断"是不是新的"
        bytes: raw.length,
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
  hasQrcode?: boolean
}> {
  const cfgPath = findWebuiConfig()
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

    const qrFile = findQrcodeFile()
    return {
      available: true,
      isLogin: d.isLogin === true,
      // 有图才显示；图可能过期（NapCat 登录后不一定删），
      // 所以前端只在未登录时才用它
      hasQrcode: Boolean(qrFile),
      webui: NAPCAT_WEBUI_PAGE,
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

/** 找 NapCat 的 webui.json。按常见安装位置试，找不到就 null。 */
function findWebuiConfig(): string | null {
  const candidates = [
    'E:/NapCat/NapCat.52230.Shell/versions/9.9.33-52230/resources/app/napcat/config/webui.json',
    'C:/NapCat/config/webui.json',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // 退一步：从 NapCat 目录名猜（版本号会变）
  try {
    const base = 'E:/NapCat/NapCat.52230.Shell/versions'
    if (existsSync(base)) {
      for (const ver of readdirSync(base)) {
        const p = `${base}/${ver}/resources/app/napcat/config/webui.json`
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

/** 找 NapCat 存的二维码图片。启动脚本里用的是 <napcat>/cache/qrcode.png */
function findQrcodeFile(): string | null {
  const base = 'E:/NapCat/NapCat.52230.Shell/versions'
  try {
    if (existsSync(base)) {
      for (const ver of readdirSync(base)) {
        const p = `${base}/${ver}/resources/app/napcat/cache/qrcode.png`
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

/** 找启动脚本写的控制台日志。位置在 NapCat 目录根部。 */
function findConsoleLog(): string | null {
  const candidates = [
    'E:/NapCat/napcat-console.log',
    // 万一脚本放别处
    'E:/NapCat/NapCat.52230.Shell/napcat-console.log',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}
