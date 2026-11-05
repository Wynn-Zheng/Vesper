/**
 * 意愿。
 *
 * 之前所有"它要不要做某事"都是规则算出来的：
 * 到点了、额度还有、间隔够了 → 做。
 *
 * 这份文件存的是它自己的判断：
 * 今天想不想说话、想不想看视频、对每个人什么印象。
 * 由自我反思生成（一天两次），定时器读它。
 *
 * 为什么不当场问模型：
 * 每次要决策都调一次模型太贵，而且"想不想"本来就该是慢慢形成的，
 * 不该在触发的那一秒现想。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { cardScopedPath, personScopedPath } from '../persona/card.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'

// 按角色卡隔离
const FILE_LEGACY = 'persona/will.json'
function FILE(): string {
  return cardScopedPath('will.json', FILE_LEGACY)
}

export interface WillState {
  /** 什么时候盘的 */
  at: number
  /** 印象最后一次被改的时间（改印象不该刷新 at，否则"今天的意愿"永不过期） */
  editedAt?: number
  /** 今天想不想主动找人说话 */
  talk: boolean
  talkReason: string
  /** 今天想不想看视频 */
  watch: boolean
  watchReason: string
  /** 对每个人的印象，一句话 */
  impressions: Record<string, string>
}

const EMPTY: WillState = {
  at: 0,
  talk: false,
  talkReason: '',
  watch: false,
  watchReason: '',
  impressions: {},
}

/** 每次都给一份新的 impressions，别让调用方改到 EMPTY 里的共享对象 */
function emptyWill(): WillState {
  return { ...EMPTY, impressions: {} }
}

export function loadWill(): WillState {
  if (!existsSync(FILE())) return emptyWill()
  try {
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as unknown
    // 能解析成 null / 数组 / 字符串的"坏 JSON"也会走到这里，先挡掉
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyWill()
    const data = parsed as Partial<WillState>

    const impressions: Record<string, string> = {}
    if (data.impressions && typeof data.impressions === 'object' && !Array.isArray(data.impressions)) {
      for (const [pid, text] of Object.entries(data.impressions)) {
        if (typeof text === 'string') impressions[pid] = text
      }
    }

    return {
      at: Number(data.at ?? 0) || 0,
      // 老文件没有这个字段；缺了就沿用 at，至少不是 0
      editedAt: Number(data.editedAt ?? 0) || Number(data.at ?? 0) || 0,
      talk: Boolean(data.talk),
      talkReason: String(data.talkReason ?? ''),
      watch: Boolean(data.watch),
      watchReason: String(data.watchReason ?? ''),
      impressions,
    }
  } catch {
    return emptyWill()
  }
}

export function saveWill(w: WillState): void {
  writeAtomic(FILE(), JSON.stringify(w, null, 2))
}

/** 这份盘点了多久（小时）；超过 30 小时算过期，别拿昨天的意愿当今天的 */
export function willAgeHours(w: WillState = loadWill()): number {
  if (!w.at || !Number.isFinite(w.at)) return Number.POSITIVE_INFINITY
  const age = (Date.now() - w.at) / 3_600_000
  // 时间戳在未来（时钟回拨/手改 will.json）时按"已过期"处理：
  // 否则负年龄永远 <= 30，它会一直切不动"今天想不想说话"，直到真实时间追上去。
  return age < 0 ? Number.POSITIVE_INFINITY : age
}

/** 拿到一个能用的意愿：过期就当没盘过 */
export function effectiveWill(): WillState | null {
  const w = loadWill()
  return willAgeHours(w) <= 30 ? w : null
}

/**
 * 对某个人的印象。
 * 优先读 impression.md——如果你手动改过，以文件为准，不是以 json 为准。
 */
export function impressionOf(personId: string): string {
  const fromFile = impressionFromFile(personId)
  if (fromFile) return fromFile
  return effectiveWill()?.impressions[personId] ?? ''
}

/**
 * 写印象（反思时调）。
 * 同时写两份：will.json（程序读）和 impression.md（人读、人改）。
 */
export function setImpression(personId: string, text: string): void {
  const w = loadWill()
  const trimmed = text.slice(0, 120)
  w.impressions[personId] = trimmed
  // 不碰 at：at 是"今天这份意愿是什么时候定的"，衰减/过期都看它。
  // 以前每写一次印象就把它刷成当下，于是只要还在聊天、还在反思，
  // 意愿就永远不会过期。改印象只记 editedAt。
  w.editedAt = Date.now()
  saveWill(w)

  // 人能直接读写的版本。下次反思前如果被手改过，会被覆盖——这是有意的：
  // 它以为什么，该由它自己决定。
  try {
    const f = impressionFileOf(personId)
    mkdirSync(dirname(f), { recursive: true })
    writeAtomic(
      f,
      `---\n更新时间: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n---\n\n# 我对他的印象\n\n${trimmed}\n`,
    )
  } catch {
    /* 写不进去不影响主流程 */
  }
}

/** 读 impression.md（如果人改过，以文件为准） */
export function impressionFromFile(personId: string): string {
  try {
    const text = readFileSync(impressionFileOf(personId), 'utf8')
    const m = /# 我对他的印象\s*\n+([\s\S]*)$/.exec(text)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}


export function impressionFileOf(personId: string): string {
  // 印象也按角色卡分：同一个好友，不同角色眼里的印象不一样
  return personScopedPath(personId, 'impression.md', join('persona', 'people', personId, 'impression.md'))
}
