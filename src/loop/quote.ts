/**
 * 这一轮要不要引用对方那句。
 *
 * 依据：Yajing Yang《Quote-and-Reply in WeChat: A Conversation Analytic Study》
 * （Studies in Applied Linguistics & TESOL 25(1), 50-61, 2025）分析了 7 段
 * 自然微信对话，归纳出引用的 3 类动机：
 *
 *   1. sequence-jumping   —— 回的是"不相邻的话轮"，中间隔着别的消息或隔了很久
 *   2. response facilitation —— 不引用就说不清在回什么（澄清、指代不清）
 *   3. spotlighting prior text —— 要强调某一条（认同、玩梗、把某句拎出来）
 *
 * 总纲是"解决多人 + 异步带来的指代困难"。换句话说：
 *
 *   **引用是功能性的，不是礼貌性的。没有指代困难就不该引。**
 *
 * 所以这里用打分而不是概率：每个信号对应一个具体的困难，累加到阈值才引。
 * 被 @ 和私聊是"指代零困难"的情况，给负分 —— 之前那版恰好把它们设成 100%，
 * 是反的。
 *
 * 阈值和权重的调参记录见 docs/引用判定.md。
 */

export interface QuoteContext {
  /** 私聊还是群 */
  kind: 'private' | 'group'
  /** 这一轮合并了几条消息（>=2 说明不是紧挨着上一条） */
  textsCount: number
  /** 这一轮有几个人在说话（>=2 说明多人穿插） */
  sendersCount: number
  /** 第一条到当前的时间跨度，毫秒 */
  spanMs: number
  /** 要引用那条（本轮最后一条）的字数 */
  targetLen: number
  /** 它准备回的内容 */
  reply: string
  /** 是不是被点名（@ 或者私聊） */
  addressed: boolean
  /** 自己当前情绪强度 0~1 */
  moodIntensity: number
  /** 距上次引用过了多久（毫秒）；没引过传 Infinity */
  sinceLastQuoteMs: number
}

export interface QuoteDecision {
  quote: boolean
  score: number
  /** 每一项的明细，调试日志用 */
  reasons: string[]
}

/** 到这么多分才引用 */
export const QUOTE_THRESHOLD = 3

/** 刚引过就别再引：上一轮已经把指代问题解决了，再引只剩排版感 */
export const QUOTE_COOLDOWN_MS = 60_000

/** 澄清类：不引用对方会不知道在纠正哪一句 */
const CLARIFY =
  /不是[^，。！？!?]{1,12}(而是|是)|我是说|我刚才说|我的意思是|你理解(错|成|反)|说反了|记反了|听错|准确地说|更准确/

/** 强调类：把对方某句拎出来表示认同或玩梗 */
const EMPHASIS = /^(对|嗯对|没错)[，,。！!]|就是(这个|那个|这条|这句)|重点(是|在)|关键(是|在)/

/**
 * 判定。
 *
 * 纯函数，不读配置不读文件 —— 好测，也好在调试日志里复现。
 */
export function decideQuote(ctx: QuoteContext): QuoteDecision {
  const reasons: string[] = []
  let score = 0

  const add = (n: number, why: string): void => {
    score += n
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`)
  }

  // 先判断它在不在澄清 —— 这个结论会影响后面好几项
  const clarifying = CLARIFY.test(ctx.reply)

  // ---------- 加分：确实存在指代困难 ----------

  // sequence-jumping：回的不是紧挨着的那条
  if (ctx.textsCount >= 2) add(2, `隔了${ctx.textsCount}条`)

  // multi-party：好几个人在说，不引看不出在回谁
  if (ctx.sendersCount >= 2) add(2, `${ctx.sendersCount}人穿插`)

  // temporal gap：隔了一会儿才接上，对方可能已经换话题了
  if (ctx.spanMs > 60_000) add(1, '隔了一分钟以上')

  // response facilitation：对方那条很长，它只回其中一点
  if (ctx.targetLen >= 60) add(2, '对方那条很长')

  // response facilitation 的极端情况。
  //
  // 给 +5 而不是 +3，是因为"它在澄清"本身就说明**它回的不是最新那句** ——
  // 否则没什么可澄清的。所以这一条要能单独压过 -2(紧挨着) 甚至 -2(被@)。
  if (clarifying) add(5, '在澄清')

  // spotlighting：把某一句拎出来强调
  if (EMPHASIS.test(ctx.reply)) add(2, '在强调')

  // spotlighting 的另一种：这句话把它情绪挑起来了，它想指着这句说
  // 权重给低，因为情绪强度经常常驻偏高
  if (ctx.moodIntensity >= 0.85) add(1, '情绪强')

  // ---------- 减分：指代已经很明确 ----------

  // 紧挨着上一条：默认就是回它，引用纯属多余。
  // 但它要是在澄清，说明它回的不是紧挨着那条 —— 这项扣分就不成立了。
  if (ctx.textsCount <= 1 && !clarifying) add(-2, '紧挨着上一条')

  // 被点名：@ 已经把对象指出来了，再引用是双重指认。
  // 同样，澄清的时候例外（"你说的那个"和"我指的"可能不是一个）。
  if (ctx.addressed && !clarifying) add(-2, '被点名')

  // 私聊：只有两个人，引用没有任何消歧作用
  if (ctx.kind === 'private') add(-3, '私聊')

  // 刚引过：上一轮已经解决过了
  if (ctx.sinceLastQuoteMs < QUOTE_COOLDOWN_MS) add(-3, '刚引过')

  return { quote: score >= QUOTE_THRESHOLD, score, reasons }
}
