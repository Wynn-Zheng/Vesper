import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boot } from '../src/boot.ts'
import { DEFAULTS, type Rules } from '../src/core/config.ts'
import { initLog } from '../src/core/log.ts'
import { setMemoryRoot } from '../src/memory/store.ts'
import { setPeopleRoot } from '../src/people/store.ts'
import { clearSessions, getHeard, getTurns, popLastAssistant, pushTurn, setSessionRoot } from '../src/loop/session.ts'
import type { Transport } from '../src/core/transport.ts'
import type { Incoming, Target } from '../src/core/types.ts'

/**
 * 群聊整条链路的集成测试。
 *
 * 为什么需要：原来 boot.test.ts 里全是私聊消息，群聊这条路
 * （合批逐条归属 / 旁听记录 / 观察模式 / 退避 / 群限速 / 撤回权限）
 * 一条都没被端到端跑过 —— QA 报告把这块列为最大测试盲区。
 */

initLog('', false)
const dir = mkdtempSync(join(tmpdir(), 'qqbot-group-boot-'))
setMemoryRoot(join(dir, 'memory'))
setPeopleRoot(join(dir, 'people'))
setSessionRoot(join(dir, 'sessions'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

class FakeTransport implements Transport {
  readonly kind = 'fake'
  readonly sent: string[] = []
  recalled = 0
  private h: ((m: Incoming) => void) | null = null

  onMessage(fn: (m: Incoming) => void): void {
    this.h = fn
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_to: Target, text: string): Promise<{ messageId?: string }> {
    this.sent.push(text)
    return { messageId: 'mid-' + this.sent.length }
  }
  async recall(): Promise<boolean> {
    this.recalled++
    return true
  }
  push(m: Incoming): void {
    this.h?.(m)
  }
}

/** 防抖 0：每条立刻处理，方便断言 */
const fastRules = (patch?: Partial<Rules>): Rules => ({
  ...DEFAULTS,
  ...patch,
  说话: { ...DEFAULTS.说话, 回复前延迟: [0, 0], 条间延迟: [0, 0], ...patch?.说话 },
  行为: {
    ...DEFAULTS.行为,
    防抖: { 档位: '自定义', 安静: 0, 活跃: 0, 同人续发: 0, 换人: 0, 被at最多: 0, 批次上限: 0 },
    发言频率: 1,
    偶尔不回概率: 0,
    已读不回概率: 0,
    ...patch?.行为,
  },
})

/** 防抖 200ms：用来测合批 */
const batchRules = (patch?: Partial<Rules>): Rules => ({
  ...fastRules(patch),
  行为: {
    ...fastRules(patch).行为,
    防抖: { 档位: '自定义', 安静: 0.2, 活跃: 0.2, 同人续发: 0.2, 换人: 0.2, 被at最多: 0.2, 批次上限: 2 },
    ...patch?.行为,
  },
})

const groupMsg = (
  id: string,
  text: string,
  opts: { senderId?: string; name?: string; passive?: boolean; observeOnly?: boolean; groupId?: string } = {},
): Incoming => ({
  id,
  // 每个用例用不同群号：限流表、session 文件都是跨用例共享的，
  // 同一个群号会让上一个用例的额度/旁听漏到下一个。
  from: { kind: 'group', id: opts.groupId ?? '777', name: '测试群' },
  selfId: '10000',
  text,
  at: Date.now(),
  senderId: opts.senderId ?? '9001',
  senderName: opts.name ?? '小明',
  ...(opts.passive ? { passive: true } : {}),
  ...(opts.observeOnly ? { observeOnly: true } : {}),
})

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 旁听：没叫它的话要记下来，但不能回 ---------------- */

test('群里没叫它：不回，但进旁听', async () => {
  clearSessions()
  const t = new FakeTransport()
  boot(t, { getRules: () => fastRules(), reply: () => '不该出现' })
  t.push(groupMsg('o1', '今天好热', { observeOnly: true, groupId: 'g1' }))
  await tick()
  assert.deepEqual(t.sent, [], 'observeOnly 不该回复')
  const heard = getHeard('group:g1')
  assert.equal(heard.length, 1)
  assert.equal(heard[0]!.content, '小明：今天好热')
})

test('旁听不会冒充成对话历史', async () => {
  clearSessions()
  const t = new FakeTransport()
  boot(t, { getRules: () => fastRules(), reply: () => '嗯' })
  t.push(groupMsg('o2', '随便说说', { observeOnly: true, groupId: 'g2' }))
  await tick()
  assert.equal(getTurns('group:g2').length, 0)
})

/* ---------------- 合批：谁说的要分清楚 ---------------- */

test('合批：两个人先后 @ 它，模型看到的是逐条带名字', async () => {
  clearSessions()
  const t = new FakeTransport()
  const seen: Array<Array<{ name: string; text: string }> | undefined> = []
  boot(t, {
    getRules: () => batchRules(),
    reply: (m) => {
      seen.push(m.batchLines)
      return '好'
    },
  })
  t.push(groupMsg('b1', '你先说', { senderId: '9001', name: '小明', groupId: 'g3' }))
  await tick(30)
  t.push(groupMsg('b2', '我说完了', { senderId: '9002', name: '小红', groupId: 'g3' }))
  await tick(400)

  assert.equal(seen.length, 1, '一批应该只走一次生成')
  const lines = seen[0]
  assert.ok(lines, '合批应该带上 batchLines')
  assert.deepEqual(lines, [
    { name: '小明', text: '你先说' },
    { name: '小红', text: '我说完了' },
  ])
})

test('合批：同一个人连发两条也要逐条带名字', async () => {
  clearSessions()
  const t = new FakeTransport()
  let lines: Array<{ name: string; text: string }> | undefined
  boot(t, {
    getRules: () => batchRules(),
    reply: (m) => {
      lines = m.batchLines
      return '嗯'
    },
  })
  t.push(groupMsg('s1', '在吗', { senderId: '9001', name: '小明', groupId: 'g4' }))
  await tick(30)
  t.push(groupMsg('s2', '在忙', { senderId: '9001', name: '小明', groupId: 'g4' }))
  await tick(400)

  assert.equal(lines?.length, 2, '同人连发也要拆开，否则第二句会被当成它自己说的')
})

/* ---------------- 没被选中的话也要进旁听 ---------------- */

test('「偶尔不回」出口也记旁听（否则开了就失忆）', async () => {
  clearSessions()
  const t = new FakeTransport()
  const r = fastRules({ 行为: { ...fastRules().行为, 偶尔不回概率: 1 } })
  boot(t, { getRules: () => r, reply: () => '不该出现' })
  t.push(groupMsg('k1', '嗯', { groupId: 'g5' }))
  await tick()
  assert.deepEqual(t.sent, [])
  assert.equal(getHeard('group:g5').length, 1, '选择不回的也要留下背景')
})

/* ---------------- 群限速：不该花钱生成 ---------------- */

test('群每分钟上限：超了就不再生成，也不往历史里写', async () => {
  clearSessions()
  const t = new FakeTransport()
  let calls = 0
  const r = fastRules({ 行为: { ...fastRules().行为, 群每分钟上限: 1 } })
  boot(t, {
    getRules: () => r,
    reply: () => {
      calls++
      return '收到'
    },
  })
  t.push(groupMsg('r1', '第一条', { groupId: 'g6' }))
  await tick(200)
  t.push(groupMsg('r2', '第二条', { senderId: '9002', name: '小红', groupId: 'g6' }))
  await tick(200)

  assert.equal(calls, 1, '第二次应该在生成前就被拦下（省一次模型调用）')
  assert.equal(t.sent.length, 1)
  // 说明：历史是在 generateReply 里 pushTurn 的，这里用的是假 reply，
  // 所以不断言 turns —— 真实链路的"失败回复不留历史"由 popLastAssistant
  // 的单元测试 + 代码路径保证。
})

/* ---------------- 撤回：群里只有主人能撤回 ---------------- */

test('群里非主人说「撤回」不生效', async () => {
  clearSessions()
  const t = new FakeTransport()
  boot(t, { getRules: () => fastRules(), reply: () => '好的' })
  t.push(groupMsg('c1', '你好', { senderId: '9001', groupId: 'g7' }))
  await tick(200)
  assert.equal(t.sent.length, 1)

  t.push(groupMsg('c2', '撤回', { senderId: '9999', name: '路人', groupId: 'g7' }))
  await tick(200)
  assert.equal(t.recalled, 0, '路人不能替它收话')
})

test('群里主人说「撤回」会真的撤回', async () => {  clearSessions()
  const t = new FakeTransport()
  const prev = process.env['OWNER_QQ']
  process.env['OWNER_QQ'] = '5555'
  try {
    boot(t, { getRules: () => fastRules(), reply: () => '好的' })
    t.push(groupMsg('d1', '你好', { senderId: '5555', name: '主人', groupId: 'g8' }))
    await tick(200)
    t.push(groupMsg('d2', '撤回', { senderId: '5555', name: '主人', groupId: 'g8' }))
    await tick(200)
    assert.ok(t.recalled > 0, '主人应该能撤回')
  } finally {
    if (prev === undefined) delete process.env['OWNER_QQ']
    else process.env['OWNER_QQ'] = prev
  }
})

/* ---------------- 没发出去的回复不能留在历史里 ---------------- */

test('popLastAssistant：只撤最后一条它说过的话', async () => {
  clearSessions()
  const key = 'group:g9'
  pushTurn(key, { role: 'user', content: '小明：在吗', at: Date.now() - 1000 })
  pushTurn(key, { role: 'assistant', content: '在', at: Date.now() })
  assert.equal(popLastAssistant(key), true)
  const turns = getTurns(key)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.role, 'user')
})

test('popLastAssistant：最后一条不是它说的就什么都不做', async () => {
  clearSessions()
  const key = 'group:g10'
  pushTurn(key, { role: 'user', content: '小明：在吗', at: Date.now() })
  assert.equal(popLastAssistant(key), false)
  assert.equal(getTurns(key).length, 1)
})

test('popLastAssistant：空会话也安全', async () => {
  clearSessions()
  assert.equal(popLastAssistant('group:empty'), false)
})

/* ---------------- 刷屏保护：攒满一批要先冲，且不能丢消息 ---------------- */

test('攒满 20 条先冲一批，第 21 条不能丢', async () => {
  clearSessions()
  const t = new FakeTransport()
  const batches: number[] = []
  // 防抖 350ms：只要消息不断来就会一直重置定时器，所以能攒到 20 条触发溢出；
  // 溢出后第 21 条落到新的一批，350ms 后自己会冲出来。
  boot(t, {
    getRules: () =>
      batchRules({
        行为: {
          ...batchRules().行为,
          防抖: { 档位: '自定义', 安静: 0.35, 活跃: 0.35, 同人续发: 0.35, 换人: 0.35, 被at最多: 0.35, 批次上限: 8 },
        },
      }),
    reply: (m) => {
      batches.push(m.batchLines?.length ?? 1)
      return '嗯'
    },
  })
  // 21 条刷屏
  for (let i = 0; i < 21; i++) {
    t.push(groupMsg(`sp${i}`, `第${i}条`, { senderId: '9001', name: '小明', groupId: 'g11' }))
    await tick(3)
  }
  await tick(1500)

  // 第 20 条到达时触发"先冲一批"，第 21 条要落到新的一批里，一条都不能丢
  assert.equal(batches.length, 2, `应该冲成两批，实际 ${JSON.stringify(batches)}`)
  assert.equal(batches[0], 20, '第一批应该是攒满的 20 条')
  assert.equal(batches.reduce((a, b) => a + b, 0), 21, '一条都不能丢')
})
