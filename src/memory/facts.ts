import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { similarity } from '../core/text.ts'
import { personDir } from '../people/store.ts'
import { appendJsonl, writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'

/** 三档：能说 / 不能说 / 我也拿不准，得问问他 */
export type Visibility = 'public' | 'private' | 'unsure'

export interface PersonFact {
  text: string
  date: string
  confidence: number
  visibility: Visibility
  /** 从哪句话来的 */
  source?: string
  /** 最后一次被提起/确认的日期；没有就是首次记录的日期 */
  lastConfirmed?: string
}

const LABEL: Record<Visibility, string> = { public: '公开', private: '私密', unsure: '待确认' }

function factsFile(personId: string): string {
  return join(personDir(personId), 'facts.md')
}

/**
 * 解析一行事实。兼容新格式（带可见性/确认日期）、老格式（没有可见性）和来源。
 *
 * 手工改坏的数据不能整份作废：
 * - 空行、缺日期/置信、置信不是数字：跳过这一行
 * - 可见性写错：按最保守的「私密」收下，别把文字也丢掉
 */
function parseFactLine(line: string): PersonFact | null {
  const m =
    /^-\s+(.+?)（(\d{4}-\d{2}-\d{2})，置信\s*([\d.]+)(?:，确认\s*(\d{4}-\d{2}-\d{2}))?(?:，([^）]*))?）(?:\｜(.*))?\s*$/.exec(
      line,
    )
  if (!m) return null

  const confidence = Number(m[3])
  if (!Number.isFinite(confidence)) return null

  const label = m[5]?.trim()
  const visibility: Visibility =
    label === '公开' ? 'public' : label === '私密' ? 'private' : label === '待确认' ? 'unsure' : 'private'
  const date = m[2]!
  const lastConfirmed = m[4]?.trim()
  const source = m[6]?.trim()

  return {
    text: m[1]!,
    date,
    confidence: Math.min(1, Math.max(0, confidence)),
    lastConfirmed: lastConfirmed || date,
    visibility,
    ...(source ? { source } : {}),
  }
}

export function loadFacts(personId: string): PersonFact[] {
  const f = factsFile(personId)
  if (!existsSync(f)) return []

  let raw: string
  try {
    raw = readFileSync(f, 'utf8')
  } catch {
    // 文件被占用 / 变成了目录：当作没有事实，别让一次读取失败炸掉整条链路
    return []
  }

  const out: PersonFact[] = []
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const fact = parseFactLine(line.trim())
    if (fact) out.push(fact)
  }
  return out
}

/** 文本里出现全角括号会破坏行格式，统一换成半角 */
function safe(s: string): string {
  return s.replace(/（/g, '(').replace(/）/g, ')').replace(/\｜/g, '|').replace(/\r?\n/g, ' ')
}

function formatFact(x: PersonFact): string {
  const confirmed = x.lastConfirmed && x.lastConfirmed !== x.date ? `，确认 ${x.lastConfirmed}` : ''
  return `- ${safe(x.text)}（${x.date}，置信 ${x.confidence}${confirmed}，${LABEL[x.visibility]}）${x.source ? `｜${safe(x.source)}` : ''}`
}

export function appendFacts(personId: string, facts: PersonFact[]): void {
  if (!facts.length) return
  // 双保险：调用方忘了过滤，这里再挡一次
  const blocked = loadDeleted(personId)
  const allowed = blocked.length
    ? facts.filter((f) => !blocked.some((b) => b === f.text || similarity(b, f.text) > BlacklistThreshold))
    : facts
  if (!allowed.length) return
  // 读-改-写排队：并发时后写的会把先写的吃掉
  serialized(`facts:${personId}`, () => {
    const f = factsFile(personId)
    const existing = existsSync(f) ? readFileSync(f, 'utf8') : '# 关于这个人的事实\n\n'
    const lines = allowed.map(formatFact).join('\n')
    writeAtomic(f, `${existing.trimEnd()}\n${lines}\n`)
  })
}

/** 改一条事实的可见性（用户说"这个可以讲"之后用） */
export function setVisibility(personId: string, text: string, visibility: Visibility): boolean {
  return rewrite(personId, (f) => (f.text === text ? { ...f, visibility } : f))
}

/** 这条事实又被提到了：刷新确认日期。用相似度匹配，别因一个空格就失效 */
export function touchFact(personId: string, text: string, date: string): boolean {
  const facts = loadFacts(personId)
  const best = facts
    .map((f) => ({ f, sim: similarity(f.text, text) }))
    .sort((a, b) => b.sim - a.sim)[0]
  if (!best || best.sim < 0.85) return false
  return rewrite(personId, (f) => (f.text === best.f.text ? { ...f, lastConfirmed: date } : f))
}

function rewrite(personId: string, fn: (f: PersonFact) => PersonFact): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  const next = facts.map(fn)
  const changed = JSON.stringify(next) !== JSON.stringify(facts)
  if (!changed) return false

  const head = '# 关于这个人的事实\n\n'
  writeAtomic(f, `${head}${next.map(formatFact).join('\n')}\n`)
  return true
}

function dayStart(s: string | undefined): number | null {
  if (!s) return null
  const t = Date.parse(`${s}T00:00:00`)
  return Number.isNaN(t) ? null : t
}

/**
 * 有效置信度：越久没被提起，越不可信。
 * 30 天没提掉一半，90 天掉到 10%。
 */
export function effectiveConfidence(f: PersonFact, now = Date.now()): number {
  // 置信度只该在 0-1 之间；坏值按 0 处理，别让 NaN 一路传下去
  const raw = Number(f.confidence)
  const base = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0

  // 确认日期坏了就退回首次记录日期。都解析不了才按"今天"算，不做无意义的衰减。
  const ref = dayStart(f.lastConfirmed) ?? dayStart(f.date)
  if (ref === null) return base

  const at = Number.isFinite(now) ? now : Date.now()
  const days = Math.max(0, (at - ref) / 86_400_000)
  return base * Math.exp(-0.023 * days)
}

export function factsFilePath(personId: string): string {
  return factsFile(personId)
}

/** 删掉一条事实（记错的就删，不留着误导） */
export function deleteFact(personId: string, text: string): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  const next = facts.filter((x) => x.text !== text && similarity(x.text, text) < 0.95)
  if (next.length === facts.length) return false
  writeAtomic(f, `# 关于这个人的事实\n\n${next.map(formatFact).join('\n')}\n`)
  // 记下来，免得整理时又被提炼回来
  recordDeleted(personId, text)
  return true
}

/** 改一条事实的文字和置信度 */
export function editFact(personId: string, oldText: string, patch: { text?: string; confidence?: number }): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  let changed = false
  const next = facts.map((x) => {
    if (x.text !== oldText) return x
    changed = true
    const conf = patch.confidence != null && Number.isFinite(patch.confidence) ? Math.min(1, Math.max(0, patch.confidence)) : x.confidence
    return { ...x, text: (patch.text ?? x.text).trim() || x.text, confidence: conf }
  })
  if (!changed) return false
  writeAtomic(f, `# 关于这个人的事实\n\n${next.map(formatFact).join('\n')}\n`)
  return true
}
/**
 * 用户删掉的事实的黑名单。
 *
 * 不加这个的话：你删了一条，"整理"下次又从聊天里把它提炼出来加回来，
 * 删了个寂寞。相似度超过阈值视为同一条（措辞变一点也认）。
 */
function deletedFile(personId: string): string {
  return join(personDir(personId), 'deleted.jsonl')
}

export function loadDeleted(personId: string): string[] {
  const f = deletedFile(personId)
  if (!existsSync(f)) return []

  let raw: string
  try {
    raw = readFileSync(f, 'utf8')
  } catch {
    // 黑名单坏了最多是少挡一条，不能让整个整理流程炸掉
    return []
  }

  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as unknown
      if (rec && typeof rec === 'object' && typeof (rec as { text?: unknown }).text === 'string') {
        const text = (rec as { text: string }).text
        if (text) out.push(text)
      }
    } catch {
      /* 坏行跳过：不是 JSONL 也能继续读后面的行 */
    }
  }
  return out
}

function recordDeleted(personId: string, text: string): void {
  const f = deletedFile(personId)
  mkdirSync(personDir(personId), { recursive: true })
  appendJsonl(f, { at: Date.now(), text })
}

/** 这条是不是被用户删过 */
/** 黑名单匹配阈值：差一个字的「12月」vs「12月份」相似度约 0.73，所以不能设太高 */
const BlacklistThreshold = 0.7

export function isDeleted(personId: string, text: string): boolean {
  return loadDeleted(personId).some((x) => x === text || similarity(x, text) > BlacklistThreshold)
}