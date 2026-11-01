/**
 * 历史压缩的自测：纯函数 + 注入的 callLLM，不联网。
 * 跑法：node scripts/test-compress.ts
 * 退出码 0 = 全过，非 0 = 有失败。
 */
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/llm/types.ts'
import {
  buildSummaryPrompt,
  compressHistory,
  DIGEST_LIMIT,
  mergeSummary,
  shouldCompress,
  SUMMARY_LIMIT,
  takeOldest,
} from '../src/loop/compress.ts'

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

async function checkAsync(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

/** 8 条历史：u1/a1 … u4/a4 */
function makeHistory(): ChatMessage[] {
  return [
    msg('user', '我最近在准备考研复试'),
    msg('assistant', '复试什么时候？'),
    msg('user', '下周三，我有点慌'),
    msg('assistant', '别慌，你初试分不低'),
    msg('user', '导师还没回我邮件'),
    msg('assistant', '再等等，也许明天就回了'),
    msg('user', '晚上一起去吃火锅吗'),
    msg('assistant', '行，七点老地方'),
  ]
}

const THRESHOLD = 4
const KEEP = 3

console.log('=== 1. 未超阈值 ===')
await checkAsync('history 未超阈值时 compressed=false 且 recent 与入参一致', async () => {
  const history = makeHistory().slice(0, 4)
  let calls = 0
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: '之前的摘要',
    callLLM: async () => {
      calls++
      return '不该被调用'
    },
  })
  assert.equal(res.compressed, false)
  assert.equal(calls, 0, 'callLLM 不该被调用')
  assert.equal(res.summary, '之前的摘要')
  assert.deepStrictEqual(res.recent, history)
})

check('shouldCompress：等于阈值不算超', () => {
  assert.equal(shouldCompress(makeHistory().slice(0, THRESHOLD), THRESHOLD, KEEP), false)
  assert.equal(shouldCompress(makeHistory(), THRESHOLD, KEEP), true)
})

console.log('\n=== 2. takeOldest 切分 ===')
check('超阈值时 oldest 长度正确', () => {
  const history = makeHistory()
  const { oldest } = takeOldest(history, THRESHOLD, KEEP)
  assert.equal(oldest.length, history.length - KEEP)
})

check('recent 恰好是最后 keepRecent 条', () => {
  const history = makeHistory()
  const { oldest, recent } = takeOldest(history, THRESHOLD, KEEP)
  assert.deepStrictEqual(recent, history.slice(-KEEP))
  assert.deepStrictEqual(oldest, history.slice(0, history.length - KEEP))
})

check('takeOldest 不修改入参', () => {
  const history = makeHistory()
  const snapshot = JSON.stringify(history)
  const { oldest, recent } = takeOldest(history, THRESHOLD, KEEP)
  oldest.push(msg('user', '污染'))
  recent.push(msg('user', '污染'))
  assert.equal(JSON.stringify(history), snapshot)
})

check('keepRecent 大于长度时全留、oldest 为空', () => {
  const history = makeHistory().slice(0, 2)
  const { oldest, recent } = takeOldest(history, 0, 10)
  assert.equal(oldest.length, 0)
  assert.deepStrictEqual(recent, history)
})

console.log('\n=== 3. 超阈值压缩：callLLM 只调一次 ===')
await checkAsync('callLLM 被调用一次，prompt 含 turns 里的关键文本', async () => {
  const history = makeHistory()
  const prompts: string[] = []
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: null,
    callLLM: async (prompt) => {
      prompts.push(prompt)
      return '对方在准备考研复试，有点慌；约了晚上七点吃火锅。'
    },
  })
  assert.equal(prompts.length, 1, 'callLLM 应恰好调用一次')
  const prompt = prompts[0]!
  assert.ok(prompt.includes('考研复试'), 'prompt 应含关键文本「考研复试」')
  assert.ok(prompt.includes('导师还没回我邮件'), 'prompt 应含被压掉的那段里的话')
  assert.ok(!prompt.includes('七点老地方'), 'prompt 不该含保留的最近一条')
  assert.equal(res.compressed, true)
  assert.equal(res.summary, '对方在准备考研复试，有点慌；约了晚上七点吃火锅。')
  assert.deepStrictEqual(res.recent, history.slice(-KEEP))
})

await checkAsync('buildSummaryPrompt 带上了旧摘要和中文要求', () => {
  const prompt = buildSummaryPrompt('旧：上次聊到四级', makeHistory().slice(0, 3))
  assert.ok(prompt.includes('旧：上次聊到四级'))
  assert.ok(prompt.includes(String(DIGEST_LIMIT)))
  assert.ok(prompt.includes('人物身份与关系'))
  assert.ok(prompt.includes('未完成的话题'))
  assert.ok(prompt.includes('不要原句重复'))
  assert.ok(prompt.includes('只输出摘要正文'))
})

console.log('\n=== 4. mergeSummary ===')
check('prevSummary 为空时直接用 digest', () => {
  assert.equal(mergeSummary(null, '  新的摘要  '), '新的摘要')
  assert.equal(mergeSummary('', '新的摘要'), '新的摘要')
  assert.equal(mergeSummary('   ', '新的摘要'), '新的摘要')
})

check('短旧摘要不再拼接（模型已经合并过，拼一次就会重复）', () => {
  // prev 只有 6 个字：正常情况下模型会把旧摘要并进输出
  assert.equal(mergeSummary('  旧摘要\n第一段  ', ' 新摘要\n第二段 '), '新摘要 第二段')
})

check('安全网：长旧摘要 + 完全不含它的新摘要 → 拼接保底', () => {
  const merged = mergeSummary('旧'.repeat(50), '新摘要 第二段')
  assert.ok(merged.endsWith('；新摘要 第二段'), merged)
  assert.ok(merged.startsWith('旧'.repeat(50)), merged)
})

check('模型合并后的摘要不重复旧内容', () => {
  const prev = '他说最近工作压力很大，晚上总失眠，劝他早点睡。'
  const digest = `${prev}他还说周末想去爬山。`
  assert.equal(mergeSummary(prev, digest), digest, '不该把旧摘要再拼一遍')
})

check(`合并结果裁到 ${SUMMARY_LIMIT} 字以内，且保留较新的尾部`, () => {
  const merged = mergeSummary('旧'.repeat(300), '新'.repeat(300))
  assert.ok(merged.length <= SUMMARY_LIMIT, `长度 ${merged.length} 超过 ${SUMMARY_LIMIT}`)
  assert.ok(merged.endsWith('新'.repeat(300)), '新摘要必须完整保留')
})

await checkAsync('compressHistory 在短旧摘要时采用模型合并结果', async () => {
  const history = makeHistory()
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: '之前聊过复试',
    callLLM: async () => '今天又提了导师和火锅',
  })
  assert.equal(res.compressed, true)
  // 模型拿到的 prompt 里已经有旧摘要，输出就是合并结果——不能再拼一次
  assert.equal(res.summary, '今天又提了导师和火锅')
})

await checkAsync('compressHistory 在长旧摘要被模型漏掉时保底拼接', async () => {
  const history = makeHistory()
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: '之前聊过复试'.repeat(12),
    callLLM: async () => '今天又提了导师和火锅',
  })
  assert.equal(res.compressed, true)
  assert.ok(res.summary.includes('之前聊过复试'), '旧摘要不能整段消失')
  assert.ok(res.summary.includes('今天又提了导师和火锅'))
  assert.ok(res.summary.includes('；'))
})

console.log('\n=== 5. 模型失败不炸 ===')
await checkAsync('callLLM reject 时 summary 保持 prevSummary 且不抛', async () => {
  const history = makeHistory()
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: '保底摘要',
    callLLM: async () => {
      throw new Error('网络挂了')
    },
  })
  assert.equal(res.compressed, false)
  assert.equal(res.summary, '保底摘要')
  assert.deepStrictEqual(res.recent, history.slice(-KEEP))
})

await checkAsync('callLLM 返回空串时 compressed=false', async () => {
  const history = makeHistory()
  const res = await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: '保底摘要',
    callLLM: async () => '   \n ',
  })
  assert.equal(res.compressed, false)
  assert.equal(res.summary, '保底摘要')
  assert.deepStrictEqual(res.recent, history.slice(-KEEP))
})

await checkAsync('compressHistory 不修改入参 history', async () => {
  const history = makeHistory()
  const snapshot = JSON.stringify(history)
  await compressHistory(history, {
    threshold: THRESHOLD,
    keepRecent: KEEP,
    prevSummary: null,
    callLLM: async () => '摘要',
  })
  assert.equal(JSON.stringify(history), snapshot)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
