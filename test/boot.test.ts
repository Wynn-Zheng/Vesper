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
import type { Transport } from '../src/core/transport.ts'
import type { Incoming, Target } from '../src/core/types.ts'

// 测试不写日志、不碰真实数据
initLog('', false)
const dir = mkdtempSync(join(tmpdir(), 'qqbot-boot-'))
setMemoryRoot(join(dir, 'memory'))
setPeopleRoot(join(dir, 'people'))
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
  private h: ((m: Incoming) => void) | null = null

  onMessage(fn: (m: Incoming) => void): void {
    this.h = fn
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_to: Target, text: string): Promise<void> {
    this.sent.push(text)
  }
  push(m: Incoming): void {
    this.h?.(m)
  }
}

const rules = (patch?: Partial<Rules>): Rules => ({
  ...DEFAULTS,
  ...patch,
  说话: { ...DEFAULTS.说话, 回复前延迟: [0, 0], 条间延迟: [0, 0], ...patch?.说话 },
  // 测试里把防抖压到 0（档位设「自定义」才用下面这几个数），
  // "偶尔不回"关掉，否则断言时序不可控
  行为: {
    ...DEFAULTS.行为,
    防抖: { 档位: '自定义', 安静: 0, 活跃: 0, 同人续发: 0, 换人: 0, 被at最多: 0, 批次上限: 0 },
    发言频率: 1,
    偶尔不回概率: 0,
    ...patch?.行为,
  },
})

const msg = (id: string, text: string): Incoming => ({
  id,
  from: { kind: 'private', id: '20000', name: '测试者' },
  selfId: '10000',
  text,
  at: Date.now(),
})

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

test('一条消息 → 一条回复', async () => {
  const t = new FakeTransport()
  boot(t, { getRules: () => rules(), reply: (m) => `答:${m.text}` })
  t.push(msg('1', '你好'))
  await tick()
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0], '答:你好')
})

test('重复 message_id 只处理一次', async () => {
  const t = new FakeTransport()
  boot(t, { getRules: () => rules(), reply: (m) => m.text })
  t.push(msg('dup', '一次'))
  t.push(msg('dup', '一次'))
  await tick()
  assert.equal(t.sent.length, 1)
})

test('长回复按语义切条，不超过每轮上限', async () => {
  const t = new FakeTransport()
  const long = '第一句话。第二句话。第三句话。第四句话。'
  boot(t, { getRules: () => rules(), reply: () => long })
  t.push(msg('2', '说点什么'))
  await tick()
  assert.equal(t.sent.length, 3, '超过 3 条应被合并')
  assert.ok(t.sent.every((s) => s.length > 0))
})

test('回复为空时保持沉默', async () => {
  const t = new FakeTransport()
  boot(t, { getRules: () => rules(), reply: () => '   ' })
  t.push(msg('3', '嗯'))
  await tick()
  assert.equal(t.sent.length, 0)
})

test('reply 抛错不会让进程崩', async () => {
  const t = new FakeTransport()
  boot(t, {
    getRules: () => rules(),
    reply: () => {
      throw new Error('模型挂了')
    },
  })
  t.push(msg('4', '在吗'))
  await tick()
  assert.equal(t.sent.length, 0)
})

/* ---------------- 防抖档位 ---------------- */

/** 换防抖档位用：其它行为参数保持测试用的那套（不回退、必回） */
const withDebounce = (防抖: Partial<Rules['行为']['防抖']>): Rules =>
  rules({
    行为: {
      ...DEFAULTS.行为,
      防抖: { ...DEFAULTS.行为.防抖, ...防抖 },
      发言频率: 1,
      偶尔不回概率: 0,
    },
  })

test('防抖关闭时，连发的两条各自成一轮（不合并）', async () => {
  const t = new FakeTransport()
  let calls = 0
  boot(t, {
    getRules: () => withDebounce({ 档位: '关闭' }),
    reply: () => {
      calls++
      return '好的'
    },
  })
  t.push(msg('a', '第一句'))
  t.push(msg('b', '第二句'))
  await tick(200)
  assert.equal(calls, 2, '关掉防抖后不该合并成一轮')
})

test('防抖开着时，同一人连发会被合并成一轮', async () => {
  const t = new FakeTransport()
  let calls = 0
  // 所有等待都压到 0.05 秒：够两条消息落进同一批，又快到测试不用等太久。
  // 注意 安静 也要给——第一条消息没有历史，"上一条距今"算无穷远，走的是安静档。
  boot(t, {
    getRules: () =>
      withDebounce({
        档位: '自定义',
        安静: 0.05,
        活跃: 0.05,
        同人续发: 0.05,
        换人: 0.05,
        被at最多: 0.05,
        批次上限: 1,
      }),
    reply: () => {
      calls++
      return '好的'
    },
  })
  t.push(msg('c', '第一句'))
  t.push(msg('d', '第二句'))
  await tick(300)
  assert.equal(calls, 1, '两条连发应该合成一轮')
  assert.equal(t.sent.length, 1)
})
