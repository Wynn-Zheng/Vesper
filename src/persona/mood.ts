import { existsSync, readFileSync } from 'node:fs'
import { warnAt } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'

/** 心情是全局的：它这一刻对所有人都是这个情绪 */
const FILE = 'persona/mood.yaml'

export interface MoodEntry {
  emotion: string
  /** 0-1 */
  intensity: number
  at: number
  /**
   * 为什么变成这个情绪（一句话）。
   * 有了它，模型才能理解"从很开心掉到很低落"是怎么回事，
   * 而不是只看到两个词。
   */
  reason?: string
}

export interface Mood extends MoodEntry {
  /** 最近几轮的情绪序列，最多 5 条 */
  recent?: MoodEntry[]
}

export function moodFile(): string {
  return FILE
}

function parseLine(line: string): { k: string; v: string } | null {
  const i = line.indexOf(':')
  if (i <= 0) return null
  return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() }
}

/** 用极简 YAML 手写/手读，避免为几行数据引依赖 */
export function loadMood(): Mood | null {
  if (!existsSync(FILE)) return null
  let text: string
  try {
    text = readFileSync(FILE, 'utf8')
  } catch {
    return null
  }

  const out: Record<string, string> = {}
  const recent: MoodEntry[] = []
  let inRecent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^最近:/.test(line.trim())) {
      inRecent = true
      continue
    }
    if (inRecent) {
      // 现在多了可选的「因为: ...」段，老格式仍然要能读
      const m = /^-\s*\{?\s*情绪:\s*([^,}]+),?\s*强度:\s*([\d.]+),?\s*时间:\s*([^,}]+?),?\s*(?:因为:\s*(.+?))?\s*\}?$/.exec(
        line.trim(),
      )
      if (m) {
        const entry: MoodEntry = {
          emotion: m[1]!.trim(),
          intensity: Number(m[2]),
          at: Date.parse(m[3]!.trim()) || Date.now(),
        }
        const reason = m[4]?.trim()
        if (reason) entry.reason = reason
        recent.push(entry)
      }
      continue
    }
    const kv = parseLine(line)
    if (kv) out[kv.k] = kv.v
  }

  const emotion = out['情绪']
  if (!emotion) {
    // 文件在但读不出情绪：多半是被外部编辑坏了，说一声，别静默当成没心情
    warnAt('mood.yaml 解析失败（缺少「情绪」字段），已按无心情处理')
    return null
  }

  return {
    emotion,
    intensity: Math.min(1, Math.max(0, Number(out['强度'] ?? 0.3))),
    at: Date.parse(out['时间'] ?? '') || Date.now(),
    ...(recent.length ? { recent: recent.slice(-5) } : {}),
  }
}

export function saveMood(m: Mood): void {
  const lines = [
    `情绪: ${m.emotion}`,
    `强度: ${m.intensity}`,
    `时间: ${new Date(m.at).toISOString()}`,
    ...(m.recent?.length
      ? [
          '最近:',
          ...m.recent.map((r) => {
            const base = `- { 情绪: ${r.emotion}, 强度: ${r.intensity}, 时间: ${new Date(r.at).toISOString()}`
            // reason 里可能有逗号/花括号，落盘前把会破坏解析的字符换掉
            const why = r.reason?.replace(/[,}{]/g, ' ').trim().slice(0, 40)
            return why ? `${base}, 因为: ${why} }` : `${base} }`
          }),
        ]
      : []),
  ]
  writeAtomic(FILE, `${lines.join('\n')}\n`)
}

/** 心情随时间回落到平静 */
export function decayedMood(m: Mood | null, now = Date.now()): Mood | null {
  if (!m) return null
  // 手工改坏的文件可能写着 intensity: abc / 空值 —— 那不是"有情绪"，
  // 当成没有心情处理，别把 NaN 传下去污染 prompt。
  if (!Number.isFinite(m.intensity) || m.intensity <= 0) return null
  const hours = (now - m.at) / 3_600_000
  if (hours < 0) return m
  const intensity = Math.min(1, m.intensity * Math.exp(-0.35 * hours))
  if (intensity < 0.05) return null
  return { ...m, intensity }
}
