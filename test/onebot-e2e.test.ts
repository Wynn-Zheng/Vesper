import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { OnebotTransport, type OnebotOptions } from '../src/channel/onebot.ts'
import { boot } from '../src/boot.ts'
import { DEFAULTS, type Rules } from '../src/core/config.ts'
import { initLog } from '../src/core/log.ts'
import { setMemoryRoot } from '../src/memory/store.ts'
import { setPeopleRoot } from '../src/people/store.ts'
import { clearSessions, setSessionRoot } from '../src/loop/session.ts'
import type { AccessPolicy } from '../src/core/access.ts'

/**
 * 传输层端到端：用**假的 NapCat 客户端**驱动真的 OnebotTransport。
 *
 * 为什么值得写：前面所有测试都是直接调函数（isAddressed、shouldHandle…），
 * 但真实链路是 NapCat 通过 WebSocket 把 OneBot 事件推进来，
 * 中间还有鉴权、消息段解析、去重、聚合、发送回包。
 * 这一段以前完全没有测试 —— 只要它接错一根线，用户看到的就是"@ 了不理"。
 *
 * 这里不碰模型：reply 用固定字符串，验证的是"该不该回、发到哪、发什么"。
 */

initLog('', false)
const dir = mkdtempSync(join(tmpdir(), 'qqbot-ws-'))
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

/** 找一个空闲端口给假的 WS 服务端 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const rules = (): Rules => ({
  ...DEFAULTS,
  说话: { ...DEFAULTS.说话, 回复前延迟: [0, 0], 条间延迟: [0, 0] },
  行为: {
    ...DEFAULTS.行为,
    // 关掉聚合：一条一条立刻处理，断言才好写
    防抖: { 档位: '关闭', 安静: 0, 活跃: 0, 同人续发: 0, 换人: 0, 被at最多: 0, 批次上限: 0 },
    发言频率: 1,
    偶尔不回概率: 0,
    已读不回概率: 0,
    每分钟上限: 100,
    群每分钟上限: 100,
  },
})

const policy: AccessPolicy = {
  allowGroup: true,
  groupAllow: [],
  groupDeny: [],
  memberAllow: [],
  memberDeny: [],
  requireAt: true,
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))

/** 起一套"通道 + 业务 + 假 NapCat"，返回操作句柄 */
async function harness(mode: '只听' | '熟人续话' | '自己判断' = '熟人续话') {
  const port = await freePort()
  const opts: OnebotOptions = {
    host: '127.0.0.1',
    port,
    path: '/onebot/v11/ws',
    token: 'test-token',
    allowGroup: true,
    botNames: ['小满'],
    getPolicy: () => policy,
    getGroupMode: () => mode,
    recentTalkers: new Map(),
    followUpWindowMs: 120_000,
    timeoutMs: 3000,
  }
  const transport = new OnebotTransport(opts)
  boot(transport, { getRules: rules, reply: () => '收到' })
  await transport.start()

  // 假的 NapCat：连上来，把收到的 action 都记下来，并一律回 ok
  const seen: Array<{ action: string; params: Record<string, unknown>; id: number }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=test-token`)
  let seq = 1000
  ws.on('message', (raw) => {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    const action = String(obj['action'] ?? '')
    if (!action) return
    // 每个 action 都分配一个 message_id：测试要靠它模拟"引用它刚说的话"。
    // 注意连接时 loadSelfInfo 也会发一个 action，所以不能假设第一个就是发送。
    const id = ++seq
    seen.push({ action, params: (obj['params'] ?? {}) as Record<string, unknown>, id })
    ws.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { message_id: id, nickname: '小满', user_id: 3 },
        echo: obj['echo'],
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await tick(120)

  const push = (ev: Record<string, unknown>): void => {
    ws.send(JSON.stringify({ post_type: 'message', self_id: 3, ...ev }))
  }
  const sent = (): string[] =>
    seen
      .filter((s) => s.action === 'send_group_msg' || s.action === 'send_private_msg')
      .map((s) => String(s.params['message'] ?? ''))
  /** 最近一条群消息的 id（用来模拟"引用它刚说的话"） */
  const lastGroupMsgId = (): string => {
    const arr = seen.filter((s) => s.action === 'send_group_msg')
    return String(arr[arr.length - 1]?.id ?? '')
  }

  return {
    push,
    sent,
    seen,
    lastGroupMsgId,
    close: async () => {
      ws.close()
      await transport.stop()
    },
  }
}

const groupAt = (text: string, userId = 9001): Record<string, unknown> => ({
  message_type: 'group',
  group_id: 555,
  user_id: userId,
  sender: { nickname: '小明', card: '小明' },
  message: [
    { type: 'at', data: { qq: '3' } },
    { type: 'text', data: { text: ' ' + text } },
  ],
})

const groupPlain = (text: string, userId = 9001): Record<string, unknown> => ({
  message_type: 'group',
  group_id: 555,
  user_id: userId,
  sender: { nickname: '小明', card: '小明' },
  message: [{ type: 'text', data: { text } }],
})

test('真链路：群里 @ 它 → 真的调用了 send_group_msg', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push(groupAt('在吗'))
    await tick(400)
    const out = h.sent()
    assert.equal(out.length, 1, `应该发一条，实际发: ${JSON.stringify(out)}`)
    assert.ok(out[0]!.includes('收到'))
  } finally {
    await h.close()
  }
})

test('真链路：没叫它 → 一个字都不发', async () => {
  clearSessions()
  const h = await harness('熟人续话')
  try {
    h.push(groupPlain('今天好热'))
    await tick(400)
    assert.deepEqual(h.sent(), [])
  } finally {
    await h.close()
  }
})

test('真链路：「只听」档下，刚聊过也不回', async () => {
  clearSessions()
  const h = await harness('只听')
  try {
    // 先 @ 一次，让它成为"刚聊过的人"
    h.push(groupAt('在吗'))
    await tick(350)
    const first = h.sent().length
    assert.equal(first, 1)
    // 接着说一句不 @ 的话：只听档不该接
    h.push(groupPlain('那你呢'))
    await tick(350)
    assert.equal(h.sent().length, 1, '「只听」不该接非 @ 的消息')
  } finally {
    await h.close()
  }
})

test('真链路：引用它刚说的话（不 @）也算在跟它说话', async () => {
  clearSessions()
  const h = await harness('熟人续话')
  try {
    h.push(groupAt('说个事'))
    await tick(350)
    const ownId = h.lastGroupMsgId()
    assert.ok(ownId, '第一条得先发出去，才有能引用的话')
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9002,
      sender: { nickname: '小红', card: '小红' },
      message: [
        { type: 'reply', data: { id: ownId } },
        { type: 'text', data: { text: '你说的那个是什么意思' } },
      ],
    })
    await tick(400)
    assert.equal(h.sent().length, 2, '引用它说的话，应该回')
  } finally {
    await h.close()
  }
})

test('真链路：引用别人的话 → 不乱接', async () => {
  clearSessions()
  const h = await harness('熟人续话')
  try {
    h.push(groupAt('说个事'))
    await tick(350)
    const before = h.sent().length
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9002,
      sender: { nickname: '小红', card: '小红' },
      message: [
        { type: 'reply', data: { id: '555555' } },
        { type: 'text', data: { text: '你这个怎么弄的' } },
      ],
    })
    await tick(400)
    assert.equal(h.sent().length, before, '引用别人的话不该抢答')
  } finally {
    await h.close()
  }
})

test('真链路：私聊照常回', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'private',
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [{ type: 'text', data: { text: '在吗' } }],
    })
    await tick(400)
    const actions = h.seen.filter((s) => s.action === 'send_private_msg')
    assert.equal(actions.length, 1)
  } finally {
    await h.close()
  }
})
