import { renderConsoleForPrompt } from '../console/activity.ts'
import type { Rules } from '../core/config.ts'
import { loadCard } from '../persona/card.ts'
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
  // 静默时段配错形状（只写一个、写成数字）时不能让 split 抛错：
  // phaseOf 每轮都要调，抛了就是整轮回复失败。
  const span = rules.行为.静默时段
  const okSpan = Array.isArray(span) && span.length === 2 && typeof span[0] === 'string' && typeof span[1] === 'string'
  const startS = okSpan ? (span[0] as string) : '00:00'
  const endS = okSpan ? (span[1] as string) : '00:00'
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

  // 名字有三个来源：self.md（它自己取的）→ 当前角色卡（你设定的人）→ rules.yaml 里的旧配置。
  // 之前漏了卡名，新建卡后 prompt 会同时出现"你还没有名字"和"你的名字是「新卡名」"，自相矛盾。
  let cardName = ''
  try {
    cardName = loadCard()?.name || ''
  } catch {
    cardName = ''
  }
  // 名字分两层：
  //   本名 = 当前角色卡的「名字」（你给他定的），它不能改；
  //   称呼 = self.md 的 name（它自己取的，或你在控制台填的）—— 平时自居用这个。
  // 以前只有一个 name，且 self.md 优先，导致"卡名"永远不生效。
  const realName = cardName || (rules.人格.名字 !== '未定' ? rules.人格.名字 : '')
  const callName = self.name
  if (callName) {
    const why = self.nameReason ? `，是你自己取的（${self.nameReason}）` : ''
    if (realName && realName !== callName) {
      lines.push(
        `- 你的本名是「${realName}」（主人给你定的）。平时大家叫你「${callName}」${why}，你也用这个称呼自己。`,
      )
    } else {
      lines.push(`- 你叫「${callName}」${why}`)
    }
  } else if (realName) {
    lines.push(`- 你的本名是「${realName}」，大家平时就这么叫你。`)
    lines.push('- 相处久了如果想要一个自己的叫法，可以在合适的时候给自己取一个。')
  } else {
    lines.push('- 你还没有名字。这件事你一直放在心里，合适的时候可以给自己取一个。')
  }

  if (self.about && self.about !== '（还没想清楚。）') {
    lines.push(`- 你对自己的认识：${self.about.replace(/\s+/g, ' ').trim()}`)
  }
  // 「我写」模式下，它补充的那一段也要进 prompt：之前只读 about，
  // 用户在「它补充的」里写的内容对聊天完全没有影响。
  if (self.aboutExtra && self.aboutExtra !== '（还没补充。）') {
    lines.push(`- 你自己补的：${self.aboutExtra.replace(/\s+/g, ' ').trim()}`)
  }
  if (self.thinking) {
    lines.push(`- 你最近在想：${self.thinking.replace(/\s+/g, ' ').trim()}`)
  }

  if (personId) {
    const imp = impressionOf(personId)
    if (imp) lines.push(`- 你对${personName || '他'}的印象：${imp}`)
  }

  // 还没跟人提过的确定问题：给一次说话的机会
  try {
    const pending = unmentionedIssues()
    if (pending.length) {
      lines.push('')
      // 只说"哪里在报错"，不贴技术分析。
      // 详细诊断在控制台能看，每轮往 prompt 里塞 400 字技术细节会把它变成运维机器人。
      lines.push('- 你这套程序有地方在报错（扫日志扫出来的，不是你感觉出来的）：')
      for (const i of pending) {
        lines.push(`  · ${i.message}（${i.where || '没定位到'}，${i.count} 次）`)
      }
      lines.push('  · 这是程序层面的问题，不是你的性格，别说成"我有个毛病"。')
      lines.push('  · 聊天顺的时候可以提一句「我这边有个地方老报错，你有空看看」；不顺就别硬插。')
    }
  } catch {
    /* 扫日志失败不影响组装 */
  }

  // 它自己总结的能力：这是它的自我认知，不是我们写的
  if (self.abilities) {
    lines.push(`- 你觉得自己能做什么：${self.abilities.replace(/\s+/g, ' ').trim()}`)
  }

  // 性格 / 语言风格 / 喜好 / 讨厌 由角色卡提供（buildSystem 里在 self 段之前已经塞进去了），
  // self.md 不再重复一份 —— 两套并存时经常互相打架。

  if (life.length) {
    lines.push('- 你自己那边最近的事：')
    for (const l of life) lines.push(`  ${l}`)
  }

  // 控制台访问记录：只告诉他"聊过几次"，内容在别处，QQ 这边看不到
  try {
    const consoleLine = renderConsoleForPrompt()
    if (consoleLine) lines.push(consoleLine)
  } catch {
    /* 读不到不影响组装 */
  }

  return lines.length ? `关于你自己：\n${lines.join('\n')}` : ''
}

/** 当下的状态，易变，单独拼在 prompt 末尾 */
export function buildPhaseBlock(rules: Rules, now = new Date()): string {
  return PHASE_TEXT[phaseOf(rules, now)]
}
