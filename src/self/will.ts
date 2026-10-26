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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'

const FILE = 'persona/will.json'

export interface WillState {
  /** 什么时候盘的 */
  at: number
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

export function loadWill(): WillState {
  if (!existsSync(FILE)) return { ...EMPTY }
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<WillState>
    return {
      at: Number(data.at ?? 0),
      talk: Boolean(data.talk),
      talkReason: String(data.talkReason ?? ''),
      watch: Boolean(data.watch),
      watchReason: String(data.watchReason ?? ''),
      impressions: (data.impressions ?? {}) as Record<string, string>,
    }
  } catch {
    return { ...EMPTY }
  }
}

export function saveWill(w: WillState): void {
  writeAtomic(FILE, JSON.stringify(w, null, 2))
}

/** 这份盘点了多久（小时）；超过 30 小时算过期，别拿昨天的意愿当今天的 */
export function willAgeHours(w: WillState = loadWill()): number {
  if (!w.at) return Number.POSITIVE_INFINITY
  return (Date.now() - w.at) / 3_600_000
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
  w.at = Date.now()
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

/** 印象文件路径（给控制台显示用） */
export function willFile(): string {
  return FILE
}

export function impressionFileOf(personId: string): string {
  return join('persona', 'people', personId, 'impression.md')
}
