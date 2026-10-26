import { existsSync, readFileSync } from 'node:fs'
import { warnAt } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'

/** 心情是全局的：它这一刻对所有人都是这个情绪 */
const FILE = 'persona/mood.yaml'

export interface MoodEntry {
  emotion: string
  /** 0-1 */
  intensity: number
  /**
   * 效价：-1 很难受 ~ +1 很好受，0 平淡。
   *
   * 为什么加这个：光有「强度」表达不了"好受/难受"。
   * 强度 0.6 的"担心"和强度 0.6 的"高兴"，渲染出来是一样的。
   *
   * 依据 Russell (1980) 的环形模型（被引 12,616 次）：
   * 情绪是二维的 —— valence（效价）× arousal（唤醒）。
   * 我们用一个 emotion 词表达唤醒/类别，用这个字段表达效价。
   *
   * 老数据没有这个字段 → undefined，按 0 处理。
   */
  valence?: number
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
      // 兼容三种写法：
      //   老：{ 情绪: x, 强度: y, 时间: z, 因为: w }
      //   新：{ 情绪: x, 强度: y, 效价: v, 时间: z, 因为: w }
      //   （效价可省，省了就是 undefined）
      const body = line.trim().replace(/^[-\s]*\{?]?\s*/, '').replace(/\s*\}?$/, '')
      const get = (k: string): string | undefined => {
        const mm = new RegExp('(?:^|,)\\s*' + k + '\\s*:\\s*([^,}]*)').exec(body)
        return mm?.[1]?.trim()
      }
      const emo = get('情绪')
      if (emo) {
        const entry: MoodEntry = {
          emotion: emo,
          intensity: Number(get('强度') ?? 0.3),
          at: Date.parse(get('时间') ?? '') || Date.now(),
        }
        const v = Number(get('效价'))
        if (Number.isFinite(v)) entry.valence = Math.min(1, Math.max(-1, v))
        const why = get('因为')
        if (why) entry.reason = why
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

  const v = Number(out['效价'])
  const rawIntensity = Number(out['强度'] ?? 0.3)
  return {
    emotion,
    // 强度写成 abc 时 Number() 给 NaN，Math.max(0, NaN) 还是 NaN ——
    // 要显式判有限，不然 NaN 会一路传进 prompt。
    intensity: Number.isFinite(rawIntensity) ? Math.min(1, Math.max(0, rawIntensity)) : 0.3,
    // 老文件没有效价 → undefined，decayedMood 会按 0（平淡）处理
    ...(Number.isFinite(v) ? { valence: Math.min(1, Math.max(-1, v)) } : {}),
    at: Date.parse(out['时间'] ?? '') || Date.now(),
    ...(recent.length ? { recent: recent.slice(-5) } : {}),
  }
}

export function saveMood(m: Mood): void {
  const lines = [
    `情绪: ${m.emotion}`,
    `强度: ${m.intensity}`,
    // 有效价才写这一行：老机器/老脚本读到的还是原来的三行
    ...(Number.isFinite(m.valence) ? [`效价: ${m.valence}`] : []),
    `时间: ${new Date(m.at).toISOString()}`,
    ...(m.recent?.length
      ? [
          '最近:',
          ...m.recent.map((r) => {
            const v = Number.isFinite(r.valence) ? `, 效价: ${r.valence}` : ''
            const base = `- { 情绪: ${r.emotion}, 强度: ${r.intensity}${v}, 时间: ${new Date(r.at).toISOString()}`
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

  // 按效价分两档衰减。
  //
  // 依据：
  //   - Frijda (1988) 情绪法则：情绪会习惯化，但不是两小时就消失
  //   - 负面偏差（negativity bias）：坏情绪比好情绪持续更久
  //
  // 原来一律 exp(-0.35 * hours)，半衰期约 2 小时 —— 太短。
  // 现在：负面 11 小时、其余 6 小时。
  const valence = Number.isFinite(m.valence) ? m.valence! : 0
  const lambda = valence < -0.2 ? 0.06 : 0.12
  const intensity = Math.min(1, m.intensity * Math.exp(-lambda * hours))

  // 阈值从 0.05 提到 0.1：衰减慢了，太小的残留会让"心情"一直挂着不走
  if (intensity < 0.1) return null
  return { ...m, intensity }
}
