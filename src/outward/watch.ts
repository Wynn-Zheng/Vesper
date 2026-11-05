import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { info, warnAt } from '../core/log.ts'
import type { Rules } from '../core/config.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { effectiveWill } from '../self/will.ts'
import { appendJsonl, writeAtomic } from '../store/fs.ts'
import { detail, hot, humanDuration, type HotOptions } from './bili.ts'
import type { VideoBrief, WatchResult, Watched } from './types.ts'

let ROOT = 'persona/outward'

/** 仅供测试/检查脚本：把「刷视频」的落盘根指到临时目录 */
export function setWatchRoot(p: string): void {
  ROOT = p
}

function watchedFile(): string {
  return join(ROOT, 'watched.json')
}

export function loadWatched(): Watched[] {
  const f = watchedFile()
  if (!existsSync(f)) return []
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as Watched[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function saveWatched(list: Watched[]): void {
  // 只留最近 200 条，不然文件会一直长
  const trimmed = list.slice(-200)
  writeAtomic(watchedFile(), JSON.stringify(trimmed, null, 2))
}

/** 今天看过几个 */
export function watchedToday(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return loadWatched().filter((w) => w.at >= start.getTime()).length
}

const PICK_SYSTEM = `你在决定"现在想看哪个视频"。只输出一个编号，不要解释。

从给的列表里挑一个你真的会点开的。
- 不要挑标题最夸张的，那种通常没内容。
- 挑那种你看了标题会想"这说的是什么"的。
- 不要每次都挑第一个。`

const THINK_SYSTEM = `你刚翻到一个视频——只看到标题、UP 主和简介，没看画面。写一句你自己想到的话。规则：

- **不要总结视频讲了什么**。写你自己的想法、联想、疑问、或者不同意的地方。
- 一句话，不超过 40 个字。
- 像随手记的，不是观后感。
- 如果你看完没什么感觉，就只输出：没感觉`


/** 从标题里挑一个（让模型挑，不是随机） */
async function pickOne(llm: LlmOptions, list: VideoBrief[]): Promise<VideoBrief | null> {
  if (!list.length) return null
  if (list.length === 1) return list[0]!
  const lines = list.map((v, i) => `${i + 1}. ${v.title}（${v.up}）`).join('\n')
  try {
    const res = await chat(
      [
        { role: 'system', content: PICK_SYSTEM },
        { role: 'user', content: lines },
      ],
      { ...llm, maxTokens: 8, temperature: 0.9 },
    )
    const n = Number.parseInt(res.text.trim().replace(/[^\d]/g, ''), 10)
    if (Number.isFinite(n) && n >= 1 && n <= list.length) return list[n - 1]!
  } catch {
    /* 挑失败就随机 */
  }
  return list[Math.floor(Math.random() * list.length)]!
}

/** 看完之后写一句自己的想法 */
async function think(llm: LlmOptions, v: { title: string; up: string; desc: string; subtitle: string; zone: string }): Promise<string> {
  const material = [
    `标题：${v.title}`,
    `UP主：${v.up}`,
    v.zone ? `分区：${v.zone}` : '',
    v.desc ? `简介：${v.desc}` : '',
    v.subtitle ? `字幕节选：${v.subtitle}` : '',
    '',
    '写一句你自己的想法。',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const res = await chat(
      [
        { role: 'system', content: THINK_SYSTEM },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 120, temperature: 0.9 },
    )
    const t = res.text.trim()
    // 只认「整句就是没感觉」或「以它开头」。
    // 以前用 includes：一句"对抽象梗没感觉，但猫可以"会被整条丢掉，
    // 而它其实是有内容的感想。
    if (!t || t === '没感觉' || t.startsWith('没感觉')) return ''
    return t.split('\n')[0]!.slice(0, 60)
  } catch (err) {
    warnAt('看完想感想失败', { err: String(err).slice(0, 60) })
    return ''
  }
}

export interface WatchOptions {
  llm: LlmOptions
  rules: Rules
  /** 不传就用配置里的分区 */
  zone?: string
  /** 强制跳过每日上限（手动触发时用） */
  force?: boolean
}

/**
 * 出去看一个视频。
 *
 * 它自己挑，看完写一句自己的想法，写进 life.md。
 * 没感觉就不写——不硬挤。
 */
export async function watchOne(opts: WatchOptions): Promise<WatchResult> {
  const conf = opts.rules.外部?.刷视频
  if (!conf) return { ok: false, reason: '没有配置' }
  if (!conf.开启 && !opts.force) return { ok: false, reason: '刷视频没开' }
  if (opts.force !== true && watchedToday() >= conf.每天最多) {
    return { ok: false, reason: `今天已经翻了 ${watchedToday()} 个` }
  }

  const zones = opts.zone ? [opts.zone] : conf.分区
  const zone = zones.length ? zones[Math.floor(Math.random() * zones.length)] : undefined

  const hotOpts: HotOptions = { limit: 30 }
  if (zone) hotOpts.zone = zone

  // 它今天想不想看。意愿过期就不管，照常挑。
  const will = effectiveWill()
  if (will && !will.watch && opts.force !== true) {
    return { ok: false, reason: `今天不想看：${will.watchReason || '没说什么理由'}` }
  }

  const candidates = await hot(hotOpts)
  if (!candidates.length) return { ok: false, reason: '没拿到候选' }

  // 跳过看过的
  const seen = new Set(loadWatched().map((w) => w.bvid))
  const fresh = candidates.filter((v) => !seen.has(v.bvid))
  if (!fresh.length) return { ok: false, reason: '榜单上全看过了' }

  const picked = await pickOne(opts.llm, fresh.slice(0, 20))
  if (!picked) return { ok: false, reason: '没挑出来' }

  const d = await detail(picked.bvid)
  if (!d) return { ok: false, reason: '拿不到视频详情' }

  info(`它翻到「${d.title}」（${d.up} · ${humanDuration(d.duration)}）`)

  const thought = await think(opts.llm, {
    title: d.title,
    up: d.up,
    desc: d.desc,
    subtitle: d.subtitle,
    zone: d.zone,
  })

  const rec: Watched = { bvid: d.bvid, title: d.title, at: Date.now(), thought }
  const all = loadWatched()
  all.push(rec)
  saveWatched(all)
  appendJsonl(join(ROOT, 'log.jsonl'), { at: rec.at, bvid: d.bvid, title: d.title, zone: d.zone, thought })

  if (thought) {
    // 不再写进 life.md：视频观感是"今天看了什么"，不是"我自己那边的生活"。
    // 记录已经在 watched.json + log.jsonl 里，控制台能看；塞进 life 会让
    // 生活线变成"工作日志"（实测连续几天都是《标题》，我想到：……）。
    info(`它想到：${thought}`)
  } else {
    info('它翻到没什么感觉，没写')
  }

  return { ok: true, bvid: d.bvid, title: d.title, thought }
}


/** 每 N 小时看一个；启动后先等 10 分钟，别一开机就抢网络 */
export function startWatching(llm: LlmOptions | (() => LlmOptions), rules: () => Rules, intervalMs = 6 * 3600_000): () => void {
  const getLlm = typeof llm === 'function' ? llm : () => llm
  // 这里有两个一次性 setTimeout（首次延迟、jitter），以前它们的句柄没保存，
  // stop() 只清了 interval —— 停掉调度之后，已经排队的那个仍会到点跑，
  // 表现就是「关掉刷视频，十分钟后它还是发了一条」。
  const pending = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      pending.delete(t)
      fn()
    }, ms)
    t.unref?.()
    pending.add(t)
  }
  const run = () => {
    const r = rules()
    const conf = r.外部?.刷视频
    if (!conf?.开启) return
    if (watchedToday() >= conf.每天最多) return
    // 随机再等一下，看起来不像定时任务
    const jitter = Math.floor(Math.random() * 20 * 60_000)
    later(() => {
      void watchOne({ llm: getLlm(), rules: rules() }).catch(() => {})
    }, jitter)
  }
  later(run, 10 * 60_000)
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    for (const t of pending) clearTimeout(t)
    pending.clear()
  }
}
