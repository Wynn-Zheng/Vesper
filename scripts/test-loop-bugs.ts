/**
 * 上下文循环体检：compress.ts 的纯函数 + session.ts 的内存状态。
 *
 * 全部在临时目录里跑，不碰 data/ 和 persona/。
 * 跑法：node scripts/test-loop-bugs.ts
 * 退出码 0 = 全过，非 0 = 有失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '../src/llm/types.ts'
import { buildSummaryPrompt, mergeSummary, shouldCompress, takeOldest } from '../src/loop/compress.ts'
import { buildPrompt } from '../src/loop/prompt.ts'
import {
  clearSessions,
  getSession,
  getSummary,
  getTurns,
  historyMessages,
  pushTurn,
  sessionCount,
  setSessionRoot,
  setSummary,
} from '../src/loop/session.ts'

const root = mkdtempSync(join(tmpdir(), 'qqbot-loop-bugs-'))
setSessionRoot(root)

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let pass = 0
let fail = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

function msg(role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage {
  return { role, content }
}

/** 字符串里有没有落单的代理项（被切成半个的 emoji） */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

function turn(role: 'user' | 'assistant', content: string, at: number): { role: 'user' | 'assistant'; content: string; at: number } {
  return { role, content, at }
}

/* ---------- 1. buildSummaryPrompt 的三种输入 ---------- */

console.log('=== 1. buildSummaryPrompt ===')

check('prevSummary 为空：旧摘要位置写「（无）」', () => {
  const prompt = buildSummaryPrompt(null, [msg('user', '在吗')])
  assert.ok(prompt.includes('已有的旧摘要：\n（无）'), prompt)
  assert.ok(prompt.includes('对方：在吗'), prompt)
})

check('prevSummary 只有空白也按空处理', () => {
  const prompt = buildSummaryPrompt('  \n\t ', [msg('assistant', '在')])
  assert.ok(prompt.includes('已有的旧摘要：\n（无）'), prompt)
  assert.ok(prompt.includes('我：在'), prompt)
})

check('turns 为空：对话位置写「（无）」且旧摘要还在', () => {
  const prompt = buildSummaryPrompt('上次聊到复试', [])
  assert.ok(prompt.includes('需要并入的对话：\n（无）'), prompt)
  assert.ok(prompt.includes('上次聊到复试'), prompt)
})

check('多模态 content：文字保留、图片只留占位符、不输出 URL', () => {
  const prompt = buildSummaryPrompt(null, [
    msg('user', [
      { type: 'text', text: '看这张' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'text', text: '好笑吗' },
    ]),
    msg('assistant', [{ type: 'image_url', image_url: { url: 'https://example.com/b.png' } }]),
  ])
  assert.ok(prompt.includes('对方：看这张 [图片] 好笑吗'), prompt)
  assert.ok(prompt.includes('我：[图片]'), prompt)
  assert.ok(!prompt.includes('https://'), '图片 URL 不该进摘要 prompt')
})

check('多模态里的空文本段被跳过，不会留下空行', () => {
  const prompt = buildSummaryPrompt(null, [
    msg('user', [
      { type: 'text', text: '   ' },
      { type: 'text', text: '正文' },
    ]),
    msg('user', []),
  ])
  assert.ok(prompt.includes('对方：正文'), prompt)
  assert.ok(!prompt.includes('需要并入的对话：\n\n'), prompt)
})

/* ---------- 2. mergeSummary 的截断边界 ---------- */

console.log('\n=== 2. mergeSummary ===')

check('旧摘要为空时直接使用新摘要并去掉多余空白', () => {
  assert.equal(mergeSummary(null, '  新的摘要  '), '新的摘要')
  assert.equal(mergeSummary('   ', '新的摘要'), '新的摘要')
})

check('旧摘要接近上限：新摘要完整保留，旧摘要从尾部让位，总长不超过 400', () => {
  const prev = '旧'.repeat(350)
  const digest = '新'.repeat(100)
  const merged = mergeSummary(prev, digest)
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.ok(merged.endsWith(`；${digest}`), '新摘要必须完整保留')
  assert.ok(merged.startsWith('旧'.repeat(299)), '旧摘要应从头保留，从尾部让位')
})

check('旧摘要已经塞满时也绝不丢新摘要', () => {
  const digest = '这次刚压掉的重要内容'
  const merged = mergeSummary('旧'.repeat(400), digest)
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.ok(merged.endsWith(`；${digest}`), '旧摘要再满也不能把新摘要挤掉')
})

check('旧摘要让位时截断点落在 emoji 中间，不会留下半个代理对', () => {
  // 新摘要 1 字 + 「；」占 2 格，旧摘要只有 398 格；
  // 397 个「旧」之后放 emoji，正好会跨过截断点。
  const prev = `${'旧'.repeat(397)}😀${'尾巴'.repeat(10)}`
  const merged = mergeSummary(prev, '新')
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.ok(merged.endsWith('；新'), '新摘要仍应完整保留')
  assert.equal(hasLoneSurrogate(merged), false, 'emoji 被切成了半个')
  assert.equal(merged.includes('😀'), false, '整颗放不下时应整颗丢掉')
})

check('旧摘要让位时不会切碎 ZWJ 组合 emoji', () => {
  const family = '👨‍👩‍👧‍👦'
  // 新摘要 2 字 + 「；」占 3 格，旧摘要只有 397 格；
  // 395 个「旧」之后放 family（7 个码元），会跨过截断点。
  const prev = `${'旧'.repeat(395)}${family}${'尾巴'.repeat(10)}`
  const merged = mergeSummary(prev, '新新')
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.ok(merged.endsWith('；新新'), '新摘要仍应完整保留')
  assert.equal(merged.includes('👨'), false, '组合 emoji 被切掉了一半')
  assert.equal(merged.includes('\u200D'), false, '不该留下半个 ZWJ 组合')
})

check('新摘要自己就超长时才截新摘要，且按字截断', () => {
  const merged = mergeSummary(null, `${'旧'.repeat(399)}😀`)
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.equal(hasLoneSurrogate(merged), false, '超长新摘要被切出了半个 emoji')
})

check('旧摘要本身就超长时也按字截断', () => {
  const merged = mergeSummary(`${'旧'.repeat(399)}😀`, '')
  assert.ok(merged.length <= 400, `长度 ${merged.length} 超过 400`)
  assert.equal(hasLoneSurrogate(merged), false, '超长旧摘要被切出了半个 emoji')
})

/* ---------- 3. takeOldest 的 keepRecent 边界 ---------- */

console.log('\n=== 3. takeOldest ===')

const history = Array.from({ length: 6 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))

check('keepRecent 大于 history 长度：oldest 为空、recent 是全部且顺序不变', () => {
  const { oldest, recent } = takeOldest(history, 3, 10)
  assert.deepEqual(oldest, [])
  assert.deepEqual(recent, history)
})

check('keepRecent 等于 history 长度：全部保留', () => {
  const { oldest, recent } = takeOldest(history, 3, history.length)
  assert.deepEqual(oldest, [])
  assert.deepEqual(recent, history)
})

check('常规切分：oldest 前段 + recent 后段，不重不漏', () => {
  const { oldest, recent } = takeOldest(history, 3, 2)
  assert.deepEqual(oldest, history.slice(0, 4))
  assert.deepEqual(recent, history.slice(4))
  assert.deepEqual([...oldest, ...recent], history)
})

check('keepRecent 为 0：全部进 oldest', () => {
  const { oldest, recent } = takeOldest(history, 3, 0)
  assert.deepEqual(oldest, history)
  assert.deepEqual(recent, [])
})

check('takeOldest 不修改入参数组', () => {
  const snapshot = JSON.stringify(history)
  const { oldest, recent } = takeOldest(history, 3, 2)
  oldest.push(msg('user', '污染'))
  recent.push(msg('user', '污染'))
  assert.equal(JSON.stringify(history), snapshot)
})

/* ---------- 4. shouldCompress 的阈值边界 ---------- */

console.log('\n=== 4. shouldCompress ===')

check('history.length === threshold 时不压', () => {
  assert.equal(shouldCompress(history.slice(0, 5), 5, 2), false)
})

check('history.length === threshold + 1 时压', () => {
  assert.equal(shouldCompress(history.slice(0, 6), 5, 2), true)
})

check('history.length 小于 threshold 时不压', () => {
  assert.equal(shouldCompress(history.slice(0, 4), 5, 2), false)
})

check('threshold 为 0：空历史不压、有一条就压', () => {
  assert.equal(shouldCompress([], 0, 2), false)
  assert.equal(shouldCompress(history.slice(0, 1), 0, 2), true)
})

/* ---------- 5. pushTurn 的 MAX 上限与顺序 ---------- */

console.log('\n=== 5. pushTurn 上限 40 ===')

const MAX = 40

check(`超过 ${MAX} 条后最早的被丢掉，其余顺序不乱`, () => {
  clearSessions()
  const key = 'private:max'
  for (let i = 0; i < MAX; i++) {
    pushTurn(key, turn('user', `m${i}`, 1_700_000_000_000 + i))
  }
  let turns = getTurns(key)
  assert.equal(turns.length, MAX, `刚满 ${MAX} 条不该丢`)
  assert.equal(turns[0]!.content, 'm0')
  assert.equal(turns[turns.length - 1]!.content, `m${MAX - 1}`)

  pushTurn(key, turn('assistant', `m${MAX}`, 1_700_000_000_000 + MAX))
  turns = getTurns(key)
  assert.equal(turns.length, MAX, `超过 ${MAX} 条后仍应只有 ${MAX} 条`)
  assert.equal(turns[0]!.content, 'm1', '最早的一条应被丢掉')
  assert.equal(turns[turns.length - 1]!.content, `m${MAX}`, '最新的一条应在末尾')
  assert.deepEqual(
    turns.map((t) => t.content),
    Array.from({ length: MAX }, (_, i) => `m${i + 1}`),
    '丢头之后顺序不能乱',
  )
  assert.deepEqual(
    turns.map((t) => t.at),
    Array.from({ length: MAX }, (_, i) => 1_700_000_000_001 + i),
    '时间戳顺序也不能乱',
  )
})

/* ---------- 6. summary 字段与 historyMessages ---------- */

console.log('\n=== 6. summary 字段 ===')

check('没设置 summary 时 historyMessages 只返回原文', () => {
  clearSessions()
  const key = 'private:summary'
  pushTurn(key, turn('user', '今天面试完了', 1))
  pushTurn(key, turn('assistant', '怎么样', 2))

  const session = getSession(key)
  assert.equal(session.summary, '')
  assert.deepEqual(getSummary(session), { summary: '', summaryCursor: 0 })
  assert.deepEqual(historyMessages(key), [
    { role: 'user', content: '今天面试完了' },
    { role: 'assistant', content: '怎么样' },
  ])
})

check('设置 summary 后能带出来，且不会混进 historyMessages 的原文', () => {
  const key = 'private:summary'
  const session = getSession(key)
  const baseline = historyMessages(key)

  setSummary(session, '对方刚面试完，还在等结果', 2)
  assert.deepEqual(getSummary(session), { summary: '对方刚面试完，还在等结果', summaryCursor: 2 })

  // 摘要由 buildPrompt 单独作为【前情摘要】注入，原文条数/顺序不变
  const messages = buildPrompt('系统提示', historyMessages(key), '结果怎么样', session.summary)
  assert.deepEqual(messages[0], { role: 'system', content: '系统提示' })
  assert.deepEqual(messages[1], { role: 'user', content: '【前情摘要】对方刚面试完，还在等结果' })
  assert.deepEqual(messages.slice(2, -1), baseline)
  assert.deepEqual(historyMessages(key), baseline, 'summary 不该改变历史原文')
})

check('summary 写盘后清空内存还能读回来', () => {
  const key = 'private:summary'
  clearSessions()
  const back = getSession(key)
  assert.deepEqual(getSummary(back), { summary: '对方刚面试完，还在等结果', summaryCursor: 2 })
})

/* ---------- 7. historyMessages 的字数预算 ---------- */

console.log('\n=== 7. historyMessages 预算 ===')

check('中间一条超长时只跳过它，更早的短消息仍能进来', () => {
  clearSessions()
  const key = 'private:budget'
  const oldest = '老'.repeat(5)
  const huge = '长'.repeat(50)
  const newest = '新'.repeat(5)
  pushTurn(key, turn('user', oldest, 1))
  pushTurn(key, turn('assistant', huge, 2))
  pushTurn(key, turn('user', newest, 3))

  const msgs = historyMessages(key, 20)
  assert.deepEqual(msgs, [
    { role: 'user', content: oldest },
    { role: 'user', content: newest },
  ])
  assert.equal(msgs.reduce((n, m) => n + String(m.content).length, 0) <= 20, true)
  for (const m of msgs) {
    assert.ok([oldest, huge, newest].includes(String(m.content)), '返回的只能是完整原文，不能是截断的半个')
  }
})

check('最新一条超长时也不会连累更早的短消息', () => {
  clearSessions()
  const key = 'private:budget-2'
  const short = '短'
  pushTurn(key, turn('user', short, 1))
  pushTurn(key, turn('assistant', '长'.repeat(30), 2))

  assert.deepEqual(historyMessages(key, 10), [{ role: 'user', content: short }])
})

check('刚好装得下时整条保留，不截断', () => {
  clearSessions()
  const key = 'private:budget-3'
  const exact = 'x'.repeat(10)
  pushTurn(key, turn('user', exact, 1))
  assert.deepEqual(historyMessages(key, 10), [{ role: 'user', content: exact }])
})

/* ---------- 8. clearSessions ---------- */

console.log('\n=== 8. clearSessions ===')

check('clearSessions 之后 getTurns 返回空数组', () => {
  clearSessions()
  const key = 'private:clear'
  pushTurn(key, turn('user', '清空前', 1))
  pushTurn(key, turn('assistant', '清空前回复', 2))
  assert.equal(getTurns(key).length, 2)

  clearSessions()
  assert.deepEqual(getTurns(key), [])
  assert.equal(sessionCount(), 0)
  assert.deepEqual(getTurns('private:never-existed'), [])
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
