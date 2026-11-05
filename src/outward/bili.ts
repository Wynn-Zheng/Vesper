/**
 * B站只读接口。
 *
 * 为什么只用排行榜和热门榜：
 * 推荐流要走 wbi 签名 + 登录 cookie，一旦 cookie 过期整个功能就哑了。
 * 排行榜是公开的，稳定得多——而且"它自己挑一个看"比"算法推什么它看什么"更像有主见。
 */
import { warnAt } from '../core/log.ts'
import type { VideoBrief, VideoDetail } from './types.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 上次请求时间，用来限速 */
let lastAt = 0

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** 相邻两次请求至少隔 400ms，别把 B站当靶子练 */
// 以前是"读 lastAt → 差值不够就 sleep → 写 lastAt"，并发调用时每个请求
// 都读到同一个旧 lastAt、sleep 同样的时长，然后**一起**发出去 —— 限速形同虚设。
// 现在用一条 promise 链排队：每次调用排在上一次之后，间隔才真的成立。
let chain: Promise<void> = Promise.resolve()
function throttle(): Promise<void> {
  const next = chain.then(async () => {
    const gap = Date.now() - lastAt
    if (gap < 400) await sleep(400 - gap)
    lastAt = Date.now()
  })
  // 出错不能把链污染成 rejected，否则后续请求全部直接失败
  chain = next.catch(() => {})
  return next
}

async function getJson<T>(url: string): Promise<T | null> {
  await throttle()
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      warnAt(`B站接口 ${res.status}`, { url: url.slice(0, 80) })
      return null
    }
    const j = (await res.json()) as { code?: number; message?: string; data?: unknown }
    if (j.code !== 0) {
      warnAt('B站接口返回错误', { code: j.code, msg: j.message })
      return null
    }
    return j.data as T
  } catch (err) {
    warnAt('B站请求失败', { err: String(err).slice(0, 80) })
    return null
  }
}

/** 分区 id → 名字。只列常用的，其余走热门榜 */
export const ZONES: Record<string, number> = {
  科技: 188,
  数码: 95,
  动物: 75,
  音乐: 3,
  美食: 76,
  生活: 160,
  知识: 36,
  影视: 181,
}

interface RawVideo {
  bvid?: string
  title?: string
  owner?: { name?: string }
  stat?: { view?: number }
  duration?: number
}

/** 已经提醒过的未知分区名，避免每次请求都刷一条 warn */
const warnedZones = new Set<string>()

export interface HotOptions {
  /** 分区名；不传就走总热门 */
  zone?: string
  /** 最多拿几个 */
  limit?: number
}

/** 拿一批候选视频（只读公开榜） */
export async function hot(opts: HotOptions = {}): Promise<VideoBrief[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20))
  const rid = opts.zone ? ZONES[opts.zone] : undefined
  // 分区名写错时会静默回落成总热门，用户以为自己看的是美食区。
  // 每个写错的名字只提醒一次，避免每次刷视频都刷日志。
  if (opts.zone && rid === undefined && !warnedZones.has(opts.zone)) {
    warnedZones.add(opts.zone)
    warnAt('配置里的 B站分区不认识，改用总热门', {
      zone: opts.zone,
      可选: Object.keys(ZONES).join(' / '),
    })
  }
  const url = rid
    ? `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`
    : `https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1`

  const data = await getJson<{ list?: RawVideo[] }>(url)
  const list = data?.list ?? []
  return list
    .filter((v) => v.bvid && v.title)
    .slice(0, limit)
    .map((v) => ({
      bvid: v.bvid!,
      title: String(v.title).trim(),
      up: String(v.owner?.name ?? '').trim(),
      play: Number(v.stat?.view ?? 0),
      duration: Number(v.duration ?? 0),
    }))
}

/** 视频详情：简介 + 字幕（有的话） */
export async function detail(bvid: string): Promise<VideoDetail | null> {
  if (!/^BV[A-Za-z0-9]{8,12}$/.test(bvid)) return null

  const info = await getJson<{
    bvid?: string
    title?: string
    desc?: string
    duration?: number
    owner?: { name?: string }
    stat?: { view?: number }
    tname?: string
    pages?: Array<{ cid?: number }>
  }>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)

  if (!info?.title) return null

  const cid = info.pages?.[0]?.cid
  const sub = cid ? await subtitleOf(bvid, cid) : ''

  return {
    bvid,
    title: String(info.title).trim(),
    up: String(info.owner?.name ?? '').trim(),
    play: Number(info.stat?.view ?? 0),
    duration: Number(info.duration ?? 0),
    desc: String(info.desc ?? '').trim().slice(0, 500),
    subtitle: sub,
    zone: String(info.tname ?? '').trim(),
  }
}

/**
 * 拿字幕。
 * B站的 AI 字幕要登录才给，所以经常是空的——空就空着，靠简介也能聊。
 */
async function subtitleOf(bvid: string, cid: number): Promise<string> {
  const data = await getJson<{
    subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> }
  }>(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`)

  const tracks = data?.subtitle?.subtitles ?? []
  if (!tracks.length) return ''

  const picked = tracks.find((t) => t.lan?.startsWith('zh')) ?? tracks[0]
  const url = picked?.subtitle_url
  if (!url) return ''

  const full = url.startsWith('//') ? `https:${url}` : url
  try {
    const res = await fetch(full, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return ''
    const body = (await res.json()) as { body?: Array<{ content?: string }> }
    const text = (body.body ?? []).map((x) => x.content ?? '').join('')
    return text.slice(0, 2000)
  } catch {
    return ''
  }
}

/** 时长格式化：3474 → 58 分钟 */
export function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0 秒'
  if (sec < 60) return `${Math.round(sec)} 秒`
  // 一小时以内一律用分钟报：3599 秒四舍五入会变成「60 分钟」，
  // 而不是「1 小时 0 分」——后者会让人以为是整整一小时。
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  const m = Math.floor(sec / 60)
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
