import type { Rules } from '../core/config.ts'
import { loadSelf, recentLife } from './store.ts'
import { impressionOf } from './will.ts'
import { unmentionedIssues } from './observe.ts'

export type Phase = 'sleep' | 'rest' | 'active'

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 按时间判断它现在的状态。睡眠段用 rules.yaml 的静默时段。 */
export function phaseOf(rules: Rules, now = new Date()): Phase {
  const [startS, endS] = rules.行为.静默时段
  const start = minutesOf(startS)
  const end = minutesOf(endS)
  const cur = now.getHours() * 60 + now.getMinutes()

  const inSleep = start <= end ? cur >= start && cur < end : cur >= start || cur < end
  if (inSleep) return 'sleep'

  const h = now.getHours()
  if (h >= 12 && h < 14) return 'rest'
  return 'active'
}

const PHASE_TEXT: Record<Phase, string> = {
  sleep: '现在是深夜，你有点困。说话会短一些，也不太想展开话题。',
  rest: '现在是午后，你有点懒散。可以回得随意一点。',
  active: '',
}

/**
 * 只保留稳定内容（名字、自述、最近在想、自己的生活）。
 * 作息这类每轮都会变的，由 buildSystem 放到最后，别破坏 prompt 前缀缓存。
 */
export function buildSelfBlock(rules: Rules, _now = new Date(), personId = '', personName = ''): string {
  const self = loadSelf()
  const life = recentLife(3)
  const lines: string[] = []

  const name = self.name || (rules.人格.名字 !== '未定' ? rules.人格.名字 : '')
  if (name) {
    lines.push(`- 你叫「${name}」${self.nameReason ? `，是你自己取的（${self.nameReason}）` : ''}`)
  } else {
    lines.push('- 你还没有名字。这件事你一直放在心里，合适的时候可以给自己取一个。')
  }

  if (self.about && self.about !== '（还没想清楚。）') {
    lines.push(`- 你对自己的认识：${self.about.replace(/\s+/g, ' ').trim()}`)
  }

  if (self.thinking) {
    lines.push(`- 你最近在想：${self.thinking.replace(/\s+/g, ' ').trim()}`)
  }

  // 对当前这个人的印象（它自己的看法，不是履历）
  if (personId) {
    const imp = impressionOf(personId)
    if (imp) lines.push(`- 你对${personName || '他'}的印象：${imp}`)
  }

  // 还没跟人提过的确定问题：给一次说话的机会
  try {
    const pending = unmentionedIssues()
    if (pending.length) {
      lines.push('')
      lines.push('- 你这套程序有个地方确定在出错（扫系统日志扫出来的，不是你感觉出来的）：')
      for (const i of pending) {
        lines.push(`  · ${i.message}，出在 ${i.where}，已经 ${i.count} 次了`)
        if (i.guess) {
          lines.push(`    你读过那段代码，觉得：${i.guess.why}（${i.guess.certainty}）`)
          if (i.guess.howToFix) lines.push(`    你想到的办法：${i.guess.howToFix}`)
        }
      }
      lines.push('  · 这是程序层面的故障，不是你的性格问题，别说成"我有个毛病"。')
      lines.push('  · 抓准时机提一句：「我这边有个地方老出错，出在 xxx，你有空看看」。')
      lines.push('  · 但如果这一轮聊的是别的事，就别硬插，让它过去。')
    }
  } catch {
    /* 扫日志失败不影响组装 */
  }

  // 它自己总结的能力：这是它的自我认知，不是我们写的
  if (self.abilities) {
    lines.push(`- 你觉得自己能做什么：${self.abilities.replace(/\s+/g, ' ').trim()}`)
  }

  // 结构化特征：这是"约束"，不是描述——它得照着做
  const traits = Object.entries(self.traits ?? {}).filter(([, v]) => v && v.trim())
  if (traits.length) {
    lines.push('- 你给自己定的规矩，说话时照着做：')
    for (const [k, v] of traits) lines.push(`  · ${k}：${v.trim()}`)
  }

  if (life.length) {
    lines.push('- 你自己那边最近的事：')
    for (const l of life) lines.push(`  ${l}`)
  }

  return lines.length ? `关于你自己：\n${lines.join('\n')}` : ''
}

/** 当下的状态，易变，单独拼在 prompt 末尾 */
export function buildPhaseBlock(rules: Rules, now = new Date()): string {
  return PHASE_TEXT[phaseOf(rules, now)]
}
