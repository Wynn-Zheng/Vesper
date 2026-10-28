/**
 * 引用判定的行为测试。
 *
 * 每个 case 是一段真实场景，断言"该引"或"不该引"。
 * 加了新信号或者调权重之后跑这个，别把某类场景调坏。
 */
import { decideQuote, QUOTE_COOLDOWN_MS, QUOTE_THRESHOLD, type QuoteContext } from '../src/loop/quote.ts'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

/** 一个"什么都没发生"的基准：群里被 @，紧跟着回一句短的 */
function base(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    kind: 'group',
    textsCount: 1,
    sendersCount: 1,
    spanMs: 500,
    targetLen: 10,
    reply: '行啊',
    addressed: true,
    moodIntensity: 0.3,
    sinceLastQuoteMs: Number.POSITIVE_INFINITY,
    ...over,
  }
}

console.log('=== 1. 不该引用（指代已经很清楚）===')
{
  const d = decideQuote(base())
  check('群里被 @、紧跟着回一句 → 不引', !d.quote, `分数 ${d.score}`)
}
{
  const d = decideQuote(base({ kind: 'private' }))
  check('私聊紧跟着回 → 不引', !d.quote, `分数 ${d.score}`)
}
{
  // 私聊就算隔了几条，也只有两个人
  const d = decideQuote(base({ kind: 'private', textsCount: 3 }))
  check('私聊隔了 3 条 → 仍不引', !d.quote, `分数 ${d.score}`)
}
{
  const d = decideQuote(base({ addressed: false, moodIntensity: 0.2 }))
  check('群里潜水插一句（没被 @）→ 不引', !d.quote, `分数 ${d.score}`)
}

console.log('\n=== 2. 该引用（确实有指代困难）===')
{
  // 群聊、3 条消息、两个人说话
  const d = decideQuote(base({ addressed: false, textsCount: 3, sendersCount: 2, reply: '哈哈' }))
  check('群里 3 条 + 2 人穿插 → 引', d.quote, `分数 ${d.score}`)
}
{
  // 澄清：最强信号
  const d = decideQuote(base({ addressed: true, reply: '不是那个，我是说下午那场' }))
  check('在澄清（"不是…我是说"）→ 引', d.quote, `分数 ${d.score}`)
}
{
  // 隔了很久才接上
  const d = decideQuote(base({ addressed: false, spanMs: 3 * 60_000, textsCount: 2 }))
  check('隔了 3 分钟 + 2 条 → 引', d.quote, `分数 ${d.score}`)
}
{
  // 对方发了一大段，但它只回其中一点；配合"隔了 2 条"才成立
  // （单独一条长消息不引用也没问题 —— 紧挨着，对方知道在回什么）
  const d = decideQuote(base({ addressed: false, targetLen: 120, textsCount: 2 }))
  check('长消息 + 隔了 2 条 → 引', d.quote, `分数 ${d.score}`)
}
{
  // 强调：要把某条拎出来，那条得不是最新的
  const d = decideQuote(base({ addressed: false, reply: '对，就是这个', textsCount: 3 }))
  check('强调 + 隔了 3 条 → 引', d.quote, `分数 ${d.score}`)
}
{
  // 紧挨着说"对，就是这样" —— 不需要引用，对方知道你同意的是上一句
  const d = decideQuote(base({ addressed: false, reply: '对，就是这个' }))
  check('紧挨着强调 → 不引', !d.quote, `分数 ${d.score}`)
}

console.log('\n=== 3. 冷却 ===')
{
  const d = decideQuote(base({ addressed: false, textsCount: 3, sendersCount: 2, sinceLastQuoteMs: 10_000 }))
  check('相同场景但 10 秒内刚引过 → 不引', !d.quote, `分数 ${d.score}`)
}
{
  const d = decideQuote(base({ addressed: false, textsCount: 3, sendersCount: 2, sinceLastQuoteMs: QUOTE_COOLDOWN_MS + 1000 }))
  check('超过冷却时间 → 恢复引', d.quote, `分数 ${d.score}`)
}

console.log('\n=== 4. 阈值本身 ===')
{
  const d = decideQuote(base({ addressed: false, targetLen: 100 }))
  check(`单个 +2 不够（阈值 ${QUOTE_THRESHOLD}）`, d.score < QUOTE_THRESHOLD && !d.quote, `分数 ${d.score}`)
}
{
  const d = decideQuote(base({ addressed: false, targetLen: 100, textsCount: 2 }))
  check('+2 +2 够了', d.quote, `分数 ${d.score}`)
}

console.log('\n=== 5. 明细可读（调试日志靠它）===')
{
  const d = decideQuote(base({ addressed: false, textsCount: 3, sendersCount: 2 }))
  const hasDetail = d.reasons.some((r) => r.includes('隔了')) && d.reasons.some((r) => r.includes('穿插'))
  check('reasons 里能看到每项来源', hasDetail, d.reasons.join(' / '))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
