/**
 * 说话习惯：从它自己说过的话里统计，再写回 prompt。
 *
 * 为什么要有这个：
 *   人说话有自己的习惯——爱用哪个开头、句子多长、问不问句。
 *   现在它每次都是从零开始，所以风格飘。
 *
 * 和「表达学习」（plays.md）的区别：
 *   plays 学的是**别人怎么说话**（好的说法）；
 *   这个统计的是**它自己怎么说话**（它的口音）。
 *
 * 数据来源：当前角色卡记忆目录下 raw/*.jsonl 里 role=assistant 的行。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRoot } from '../memory/store.ts'

/**
 * 与 appendRaw 写的位置保持一致：`<memoryRoot>/raw`。
 *
 * 这里原来写死 `persona/memory/raw`；卡片化之后 raw 已改写到
 * `persona/cards/<卡>/memory/raw`，于是统计冻结在老数据上了。
 * 用函数延迟求值，避免模块加载时卡片还没确定。
 */
function rawDir(): string {
  return join(memoryRoot(), 'raw')
}

export interface SpeechStats {
  /** 统计了几条 */
  samples: number
  /** 平均字数 */
  avgLen: number
  /** 中位字数 */
  medianLen: number
  /** 超过 30 字的比例 */
  longRatio: number
  /** 问句比例 */
  questionRatio: number
  /** 最常用的开头两个字符 */
  topOpeners: Array<{ text: string; count: number }>
}

/**
 * 哪些开头才算"口音"。
 *
 * 只认语气词和连接词：嗯、那、行吧、其实、不过……
 * 不认实词——「能看」出现 4 次不是口音，是那几天一直在聊"能不能看代码"，
 * 统计成口音会误导（它下次就会莫名其妙以"能看"开头）。
 */
const OPENER_WHITELIST = new Set([
  '嗯', '嗯，', '哦', '噢', '啊', '诶', '哎',
  '那', '这', '行', '行吧', '好吧', '是', '对',
  '其实', '不过', '所以', '反正', '就是', '然后', '而且',
  '我觉', '你说', '你这', '不是', '没有', '有点',
])

/** 这些开头不算"口音"，是对话里的通用词 */
const OPENER_STOP = new Set(['答:', '第一', '一次', '的是', '不上', '还没'])

export function analyzeSpeech(): SpeechStats | null {
  const dir = rawDir()
  if (!existsSync(dir)) return null

  const texts: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line) as { role?: string; text?: string }
          if (j.role === 'assistant' && j.text?.trim()) texts.push(j.text.trim())
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  } catch {
    return null
  }

  // 样本太少不统计——三五句话总结不出习惯，反而会给出误导性的结论
  if (texts.length < 20) return null

  const lens = texts.map((t) => t.length).sort((a, b) => a - b)
  const avgLen = lens.reduce((a, b) => a + b, 0) / lens.length
  const medianLen = lens[Math.floor(lens.length / 2)]!

  const longRatio = texts.filter((t) => t.length > 30).length / texts.length
  const questionRatio = texts.filter((t) => /[?？]|吗|呢/.test(t)).length / texts.length

  const openers = new Map<string, number>()
  for (const t of texts) {
    const p = t.slice(0, 2)
    if (p.length < 2 || OPENER_STOP.has(p)) continue
    // 只认语气词/连接词。实词片段（"能看""代码"）不算口音
    if (!OPENER_WHITELIST.has(p)) continue
    if (!/^[\u4e00-\u9fa5]+$/.test(p)) continue
    openers.set(p, (openers.get(p) ?? 0) + 1)
  }
  const topOpeners = [...openers]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }))

  return { samples: texts.length, avgLen, medianLen, longRatio, questionRatio, topOpeners }
}

/**
 * 渲染成 prompt 里的一段。
 *
 * 只在**确实有信号**时才说：样本太少、或者各项都正常，就不占 prompt 空间。
 */
export function renderSpeechHabit(): string {
  const s = analyzeSpeech()
  if (!s) return ''

  const lines: string[] = ['【你说话的习惯】']

  // 长度：只在明显偏长/偏短时提醒
  if (s.medianLen > 25) {
    lines.push(`- 你平时一句话 ${Math.round(s.medianLen)} 个字，有点长。能短的尽量短。`)
  } else if (s.medianLen < 8) {
    lines.push(`- 你平时一句话只有 ${Math.round(s.medianLen)} 个字，可以稍微说完整点。`)
  } else {
    lines.push(`- 你平时一句话 ${Math.round(s.medianLen)} 个字左右，保持这个长度就行。`)
  }

  // 问句：超过 20% 就明确提醒——这是"追问感"最直接的来源
  if (s.questionRatio > 0.2) {
    lines.push(
      `- 你最近 ${Math.round(s.questionRatio * 100)}% 的话里带问句，太多了。` +
        '对方说一句你接一句问一句，像在查户口。这轮尽量别问。',
    )
  }

  // 口头禅：只说最明显的那个
  if (s.topOpeners.length && s.topOpeners[0]!.count >= 4) {
    lines.push(`- 你常以「${s.topOpeners[0]!.text}」开头。这算你的口音，不是毛病，不用刻意改。`)
  }

  // 只有一条"保持这个长度"的话就没必要占篇幅
  if (lines.length <= 2 && !lines[1]!.includes('太多')) return ''

  return lines.join('\n')
}
