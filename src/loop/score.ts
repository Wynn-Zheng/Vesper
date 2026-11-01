/**
 * 「要不要接这个话」的规则打分。
 *
 * 之前是纯粹掷骰子（Math.random() > 0.3），不看待内容——
 * 所以它可能对「嗯」长篇大论、对「在吗」装没看见。
 * 这里按内容 + 时机 + 刚说过多少话算一个分，再换成概率。
 *
 * 全程不需要模型调用。
 */

export interface ScoreParts {
  /** 被 @ 或被叫了名字 */
  addressed: boolean
  isPrivate: boolean
  /** 刚才正在跟它说话（连续对话窗口内） */
  followUp: boolean
  text: string
  /** 距上次说话多少分钟 */
  idleMinutes: number
  /** 最近 5 分钟它自己回了几次 */
  recentReplies: number
  /** 距它上一次回复多少秒；没回过就是 undefined。用于"刚说完别追"的硬闸 */
  lastReplyAgoSec?: number
  /** 当前时段的活跃度 0~1 */
  talkValue: number
}

export interface ScoreResult {
  score: number
  probability: number
  /** 命中了哪些规则，方便看日志和调参 */
  reasons: string[]
}

const QUESTION = /[?？]|吗|呢|怎么|为什么|什么|哪|多少|多久/
const REQUEST = /帮我|能不能|可以吗|可不可以|要不要|来一下|看看这个|给我|求/
const OPINION = /你觉得|你怎么看|你怎么想|是不是|会不会|好不好/
const SHORT_ACK = /^(嗯+|哦+|噢+|好+|行|收到|哈哈+|呵+|笑死|草|6+)[。！？~～. ]*$/

/** 分数 → 概率。@ 和私聊直接放行。 */
export function scoreReply(p: ScoreParts): ScoreResult {
  if (p.isPrivate || p.addressed) {
    return { score: 100, probability: 1, reasons: ['直接找它'] }
  }

  // 刚说完 20 秒内不追话：群聊里连发两条会像刷屏。
  // 之前只有"最近 5 分钟回了 ≥2 次扣分"的软抑制，挡不住"两句挨着发"。
  if (p.lastReplyAgoSec !== undefined && p.lastReplyAgoSec < 20) {
    return { score: 0, probability: 0, reasons: ['刚说完，先别追'] }
  }

  const reasons: string[] = []
  let score = 0

  if (p.followUp) {
    score += 35
    reasons.push('接着刚才的话')
  }

  if (SHORT_ACK.test(p.text.trim())) {
    score -= 25
    reasons.push('只是应一声')
  } else {
    if (QUESTION.test(p.text)) {
      score += 20
      reasons.push('在问它')
    }
    if (REQUEST.test(p.text)) {
      score += 25
      reasons.push('在求它')
    }
    if (OPINION.test(p.text)) {
      score += 20
      reasons.push('在问它意见')
    }
  }

  // 第一次说话时 lastTalk 是 0，"多久没说话"会算成几千万分钟，这里封顶
  const idle = Math.min(24 * 60, Math.max(0, Number.isFinite(p.idleMinutes) ? p.idleMinutes : 0))
  if (idle > 120) {
    score += 35
    reasons.push('很久没说话了')
  } else if (idle > 30) {
    score += 20
    reasons.push('有一阵没说话')
  }

  // 活跃度直接进分：深夜 0.15 只加 4.5，晚上 0.6 加 18
  const talk = Number.isFinite(p.talkValue) ? Math.min(1, Math.max(0, p.talkValue)) : 0.4
  score += talk * 30

  // 刚说太多就压住，别在群里刷屏
  if (p.recentReplies >= 4) {
    score -= 50
    reasons.push('刚说太多了')
  } else if (p.recentReplies >= 3) {
    score -= 30
    reasons.push('刚说了几句')
  } else if (p.recentReplies >= 2) {
    score -= 15
    reasons.push('刚回过')
  }

  const clamped = Math.max(0, Math.min(100, score))
  return { score: clamped, probability: clamped / 100, reasons }
}
