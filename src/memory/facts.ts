import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { similarity } from '../core/text.ts'
import { warnAt } from '../core/log.ts'
import { personDir } from '../people/store.ts'
import { appendJsonl, writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'

/** 三档：能说 / 不能说 / 我也拿不准，得问问他 */
export type Visibility = 'public' | 'private' | 'unsure'

/**
 * 事实的档位。
 *
 * 不是"重要程度"的连续分数，是**保留策略**：
 *   major  → 衰减极慢（139 天半衰期）
 *   normal → 正常衰减（35 天）
 *
 * 核心档（core）不在这里——它在 persona/core.md，只有人能改。
 */
export type FactTier = 'major' | 'normal'

export interface PersonFact {
  text: string
  date: string
  confidence: number
  visibility: Visibility
  /**
   * 这条是谁确认的：
   *   it → 它从聊天里提炼的（默认）
   *   me → 用户确认过的，模型整理时不许覆盖/删除
   */
  by?: 'it' | 'me'
  /** 从哪句话来的 */
  source?: string
  /** 最后一次被提起/确认的日期；没有就是首次记录的日期 */
  lastConfirmed?: string
  /**
   * 档位。老数据没有这个字段 → 一律当 normal（保守：正常衰减）。
   *
   * 为什么不用 1-10 的 importance：
   * 实测模型打分区分度极低（24 条经验全给 8 分），二选一反而判断得准。
   */
  tier?: FactTier
  /**
   * 这条被新说法取代的日期。
   *
   * 为什么保留而不删：模型可能判错、人也可能改主意。留着能恢复，删了就没。
   * 失效的事实**不再注入 prompt**，但文件里还在（人可读、可手改回来）。
   *
   * 判据看 distill 的 sameFact：只有模型明确说"互相矛盾"才标这个，
   * 单纯"两件不同的事"不会（那只是两条并存）。
   */
  supersededAt?: string
  /**
   * 只在召回时用：这条是很久没提、置信度掉到 0.2 以下的，
   * 靠话题相关性才被捞回来的。
   *
   * **不写盘**（formatFact 不输出它）。依据是 Bjork 的「新失用理论」：
   * 遗忘是取不出来，不是痕迹消失，所以内容该留着。
   */
  faint?: boolean
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

  // 括号里除了可见性，还可能有「你确认」。两种顺序都认：
  //   公开，你确认 / 你确认，公开
  // 老行没有这个记号 → 默认 it。
  const extras = (m[5] ?? '')
    .split('，')
    .map((s) => s.trim())
    .filter(Boolean)
  const by: 'it' | 'me' = extras.includes('你确认') ? 'me' : 'it'
  const label = extras.find((x) => x === '公开' || x === '私密' || x === '待确认')
  const visibility: Visibility = label === '公开' ? 'public' : label === '私密' ? 'private' : label === '待确认' ? 'unsure' : 'private'
  const date = m[2]!
  const lastConfirmed = m[4]?.trim()
  const source = m[6]?.trim()

  // 「已失效 2026-10-28」：被新说法取代的旧事实。格式坏了就当没失效（保守：继续用它）。
  const supRaw = extras.find((x) => x.startsWith('已失效'))
  const supDate = supRaw ? supRaw.replace(/^已失效\s*/, '').trim() : ''
  const supersededAt = /^\d{4}-\d{2}-\d{2}$/.test(supDate) ? supDate : undefined

  return {
    text: m[1]!,
    date,
    confidence: Math.min(1, Math.max(0, confidence)),
    lastConfirmed: lastConfirmed || date,
    visibility,
    by,
    ...(source ? { source } : {}),
    ...(supersededAt ? { supersededAt } : {}),
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
  // 跟踪当前在哪一段。老文件没有 ## 标题，就一直是 normal。
  let curTier: FactTier = 'normal'

  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim()

    // 段落标题：认「重要」和「平常」，别的 # 不算（可能是人写的注释）
    if (s.startsWith('#')) {
      const m = /^#+\s*(重要|平常)/.exec(s)
      if (m) curTier = m[1] === '重要' ? 'major' : 'normal'
      continue
    }

    const fact = parseFactLine(s)
    if (!fact) continue
    // 文件里写死的段落优先；没分段就用 normal
    out.push({ ...fact, tier: curTier })
  }
  return out
}

/**
 * 写盘前的转义。
 *
 * **只转两样**，因为只有它们会破坏行格式：
 *   换行 → 空格（会把一条拆成两行）
 *   ｜   → |   （它是 source 的分隔符）
 *
 * **括号不转**。之前这里把全角括号转成半角，实测发现：
 *   解析本身完全能处理正文里的括号（包括多层嵌套），
 *   但转换会让"读 → 写 → 再读"改变原文。
 *   一条"他作息很乱（他自称睡得早）"存一次就变成"他作息很乱(他自称睡得早)"。
 */
function safe(s: string): string {
  return s.replace(/\｜/g, '|').replace(/\r?\n/g, ' ')
}

const TIER_LABEL: Record<FactTier, string> = { major: '重要', normal: '平常' }

/**
 * 把一组事实施渲染成 markdown。
 *
 * 分两段：重要 / 平常。某一档为空就不写那段的标题。
 * **所有写文件的路径都必须走这里**——不然分段会乱。
 */
export function renderFacts(facts: PersonFact[]): string {
  const lines: string[] = ['# 关于这个人的事实', '']

  for (const tier of ['major', 'normal'] as FactTier[]) {
    const list = facts.filter((f) => (f.tier ?? 'normal') === tier)
    if (!list.length) continue
    lines.push(`## ${TIER_LABEL[tier]}`, '')
    for (const f of list) lines.push(formatFact(f))
    lines.push('')
  }

  // 一条都没有时也留个空段落，方便人手工加
  if (!facts.length) lines.push('## 平常', '')

  return lines.join('\n')
}

function formatFact(x: PersonFact): string {
  const confirmed = x.lastConfirmed && x.lastConfirmed !== x.date ? `，确认 ${x.lastConfirmed}` : ''
  // 只有用户确认过的才写记号；默认 it 不写，老行的格式保持不变。
  const byMe = x.by === 'me' ? '，你确认' : ''
  const superseded = x.supersededAt ? `，已失效 ${x.supersededAt}` : ''
  return `- ${safe(x.text)}（${x.date}，置信 ${x.confidence}${confirmed}，${LABEL[x.visibility]}${byMe}${superseded}）${x.source ? `｜${safe(x.source)}` : ''}`
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
    const existing = existsSync(f) ? readFileSync(f, 'utf8') : ''

    // ⚠️ 关键保护：重写前先确认解析没丢东西。
    // 原来是"原文追加"，最坏只是多一行；现在是"读-合并-重写"，
    // 解析错了会把老数据覆盖掉。所以宁可不写。
    const parsed = loadFacts(personId)
    const rawDashes = (existing.match(/^-\s+/gm) ?? []).length
    if (parsed.length < rawDashes) {
      warnAt('facts 解析条数少于原文行数，拒绝重写（怕丢数据）', {
        person: personId,
        解析出: parsed.length,
        原文行数: rawDashes,
      })
      return
    }

    // 合并：同一条（文字完全一样）就更新，新的追加。
    // 用户确认过的条目是锁定的：模型再怎么提炼也不覆盖。
    const merged = [...parsed]
    for (const item of allowed) {
      const i = merged.findIndex((x) => x.text === item.text)
      if (i >= 0) {
        if (merged[i]!.by === 'me') continue
        // 重新听到一条曾失效的事实 = 它又成立了，清掉失效标记
        merged[i] = { ...merged[i]!, ...item, supersededAt: item.supersededAt }
      } else merged.push(item)
    }

    writeAtomic(f, renderFacts(merged))
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
  // 用户确认过的事实，连确认日期也不让模型改
  if (best.f.by === 'me') return false
  return rewrite(personId, (f) => (f.text === best.f.text ? { ...f, lastConfirmed: date } : f))
}

/**
 * 把一条旧事实标记为「已被新说法取代」。
 *
 * 只在模型明确判出「矛盾」（contradict）时调用。
 * 标记后不再注入 prompt，但文件里还留着——模型判错、人改主意，都能手改回来。
 * 依据：人不是把旧认知删掉，而是让它不再被取用（Bjork 的新失用理论）。
 */
export function supersedeFact(personId: string, text: string, date: string): boolean {
  return rewrite(personId, (f) => (f.text === text ? { ...f, supersededAt: date } : f))
}

/**
 * 用户确认 / 取消确认一条事实（按 facts.md 里的顺序，0 开始）。
 * confirmed 对应 by=me；取消后回到 by=it，模型才能继续更新它。
 */
export function setFactBy(personId: string, index: number, by: 'it' | 'me'): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  if (!Number.isInteger(index) || index < 0 || index >= facts.length) return false
  if (facts[index]!.by === by) return true
  const next = facts.map((x, i) => (i === index ? { ...x, by } : x))
  writeAtomic(f, renderFacts(next))
  return true
}

function rewrite(personId: string, fn: (f: PersonFact) => PersonFact): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  const next = facts.map(fn)
  const changed = JSON.stringify(next) !== JSON.stringify(facts)
  if (!changed) return false

  writeAtomic(f, renderFacts(next))
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
export function effectiveConfidence(f: PersonFact, now = Date.now(), decay = 0.023): number {
  // 置信度只该在 0-1 之间；坏值按 0 处理，别让 NaN 一路传下去
  const raw = Number(f.confidence)
  const base = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0

  // 确认日期坏了就退回首次记录日期。都解析不了才按"今天"算，不做无意义的衰减。
  const ref = dayStart(f.lastConfirmed) ?? dayStart(f.date)
  if (ref === null) return base

  const at = Number.isFinite(now) ? now : Date.now()
  const days = Math.max(0, (at - ref) / 86_400_000)
  return base * Math.exp(-decay * days)
}

/**
 * 还有效的事实条数：不算淡忘的（faint），也不算被新说法取代的（supersededAt）。
 *
 * 两个页面以前各写一份过滤条件，一个滤 faint+superseded、一个只滤 faint，
 * 同一个人在两处显示的"事实数"对不上。
 */
export function countFacts(personId: string): number {
  return loadFacts(personId).filter((f) => !f.faint && !f.supersededAt).length
}

export function factsFilePath(personId: string): string {
  return factsFile(personId)
}

/**
 * 删掉一条事实（记错的就删，不留着误导）。
 *
 * 这是用户操作，by=me 也允许删；防模型覆盖/删除的锁在 distill 和 appendFacts 里。
 */
export function deleteFact(personId: string, text: string): boolean {
  const f = factsFile(personId)
  if (!existsSync(f)) return false
  const facts = loadFacts(personId)
  const next = facts.filter((x) => x.text !== text && similarity(x.text, text) < 0.95)
  if (next.length === facts.length) return false
  writeAtomic(f, renderFacts(next))
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
  writeAtomic(f, renderFacts(next))
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