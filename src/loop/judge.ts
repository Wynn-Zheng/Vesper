import { info } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'

/**
 * 发完之后给自己这条回复打个分。
 * 目的不是"追求高分"，是拿到一个信号：
 * 什么样的回法在什么场景下有效——这是后面学"应对策略"的基础。
 */
export interface JudgeResult {
  /** 0-10 */
  score: number
  /** 有什么问题，空字符串表示没明显问题 */
  issue: string
}

const SYSTEM = `你在评估一条刚发出去的聊天回复好不好。只输出 JSON，不要解释。

评分标准（0-10）：
- 像不像人说话：不是客服腔、不端着、不总结陈词
- 长短合不合适：太长了扣分，几个字能说清却写一段也扣分
- 有没有接住对方：答非所问、自说自话扣分
- 自然度：有没有生硬转折、不必要的解释

只输出：{"分": 7, "问题": "简短说说哪里不好，没问题就空字符串"}`

function parse(text: string): JudgeResult | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { 分?: number; 问题?: string }
    const raw = Number(o.分 ?? 0)
    // 模型偶尔会给出 "abc" 这种，NaN 会一路渗进经验库，这里掐掉
    const score = Number.isFinite(raw) ? Math.min(10, Math.max(0, raw)) : 0
    return { score, issue: String(o.问题 ?? '').trim().slice(0, 80) }
  } catch {
    return null
  }
}

export interface JudgeOptions {
  llm: LlmOptions
  userText: string
  selfText: string
  /** 只用于日志 */
  who?: string
}

export async function judgeReply(opts: JudgeOptions): Promise<JudgeResult | null> {
  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `他：${opts.userText}\n我：${opts.selfText}` },
      ],
      { ...opts.llm, maxTokens: 120, temperature: 0.2 },
    )
    const r = parse(res.text)
    if (r) {
      info(`自评 ${r.score}/10${r.issue ? `：${r.issue}` : ''}`, { 对象: opts.who })
    }
    return r
  } catch {
    return null
  }
}
