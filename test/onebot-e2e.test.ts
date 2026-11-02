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
async function harness(
  mode: '只听' | '熟人续话' | '自己判断' = '熟人续话',
  rulesOverride?: () => Rules,
  replyFn?: (m: { text: string; from: { kind: string; id: string } }) => Promise<string> | string,
) {
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
  boot(transport, { getRules: rulesOverride ?? rules, reply: replyFn ?? (() => '收到') })
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

/* ---------------- 边界：畸形消息、@全体、纯图、去重、限速、合批 ---------------- */

test('边界：群消息没有 group_id 也不崩，且不发消息', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'group',
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [{ type: 'text', data: { text: '没有群号的消息' } }],
    })
    await tick(400)
    assert.deepEqual(h.sent(), [], '坏数据不该触发发送')
    // 关键：进程还活着、还能正常处理下一条
    h.push(groupAt('还活着吗'))
    await tick(400)
    assert.equal(h.sent().length, 1, '一条坏消息不能把整条链路弄坏')
  } finally {
    await h.close()
  }
})

test('边界：@全体成员 不算叫它', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9001,
      sender: { nickname: '群主' },
      message: [
        { type: 'at', data: { qq: 'all' } },
        { type: 'text', data: { text: ' 所有人开会' } },
      ],
    })
    await tick(400)
    assert.deepEqual(h.sent(), [], '@全体 是群公告，不是叫它')
  } finally {
    await h.close()
  }
})

test('边界：纯图片消息不触发回复', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [{ type: 'image', data: { file: 'a.jpg', url: 'http://127.0.0.1:9/x.jpg' } }],
    })
    await tick(500)
    assert.deepEqual(h.sent(), [], '群里有人发图不等于在叫它')
  } finally {
    await h.close()
  }
})

test('边界：同一条消息重复推送只处理一次', async () => {
  clearSessions()
  const h = await harness()
  try {
    const ev = { message_id: 777001, ...groupAt('重复') }
    h.push(ev)
    h.push(ev)
    await tick(500)
    assert.equal(h.sent().length, 1, '去重按 message_id，不能回两遍')
  } finally {
    await h.close()
  }
})

test('边界：群每分钟上限 1 → 第二条 @ 不再回', async () => {
  clearSessions()
  // 用独立群号 556：限流表是模块级的，前面用例已经吃过 555 的额度了
  const inG = (text: string, userId = 9001): Record<string, unknown> => ({
    ...groupAt(text, userId),
    group_id: 556,
  })
  const sends556 = (h: { seen: Array<{ action: string; params: Record<string, unknown> }> }): number =>
    h.seen.filter(
      (s) => s.action === 'send_group_msg' && Number(s.params['group_id']) === 556,
    ).length
  const h = await harness('熟人续话', () => ({
    ...rules(),
    行为: { ...rules().行为, 群每分钟上限: 1 },
  }))
  try {
    h.push(inG('第一条'))
    await tick(350)
    h.push(inG('第二条', 9002))
    await tick(350)
    assert.equal(sends556(h), 1, '限速应该真的挡住第二条')
  } finally {
    await h.close()
  }
})

test('边界：防抖开着时两人先后说话，合成一轮只回一次', async () => {
  clearSessions()
  const h = await harness('熟人续话', () => ({
    ...rules(),
    行为: {
      ...rules().行为,
      防抖: { 档位: '自定义', 安静: 0.4, 活跃: 0.4, 同人续发: 0.4, 换人: 0.4, 被at最多: 0.4, 批次上限: 2 },
    },
  }))
  try {
    h.push(groupAt('我先说', 9001))
    await tick(60)
    h.push(groupAt('我接一句', 9002))
    await tick(900)
    assert.equal(h.sent().length, 1, '一批只该走一次生成、发一次')
  } finally {
    await h.close()
  }
})

/* ---------------- 并发：它正在回话时又来了新消息 ---------------- */

test('并发：同一会话两轮不交叠，按顺序回', async () => {
  clearSessions()
  const order: string[] = []
  const h = await harness('熟人续话', undefined, async (m) => {
    order.push('start:' + m.text)
    await tick(250)
    order.push('end:' + m.text)
    return 'R:' + m.text
  })
  try {
    h.push(groupAt('第一句'))
    await tick(80) // 第一句还在"想"，第二句就到了
    h.push(groupAt('第二句', 9002))
    await tick(1200)

    // 不能交叠：必须是 start→end→start→end，不能 start→start→end→end
    // 注意 m.text 里带着 @ 段解析出来的前缀（@3），所以用 endsWith 比。
    assert.equal(order.length, 4, JSON.stringify(order))
    assert.ok(order[0]!.startsWith('start:') && order[0]!.endsWith('第一句'), JSON.stringify(order))
    assert.ok(order[1]!.startsWith('end:') && order[1]!.endsWith('第一句'), '第一轮要先结束')
    assert.ok(order[2]!.startsWith('start:') && order[2]!.endsWith('第二句'), '第二轮才能开始')
    assert.ok(order[3]!.startsWith('end:') && order[3]!.endsWith('第二句'))
    const out = h.sent()
    assert.equal(out.length, 2, '两句都要回')
    assert.ok(out[0]!.includes('第一句'), '先回先到的')
    assert.ok(out[1]!.includes('第二句'))
  } finally {
    await h.close()
  }
})

test('并发：群聊在慢慢回的时候，私聊不被堵住', async () => {
  clearSessions()
  const h = await harness('熟人续话', undefined, async (m) => {
    // 群里那条故意慢，私聊那条快
    if (m.from.kind === 'group') await tick(600)
    return 'R:' + m.text
  })
  try {
    h.push(groupAt('群里的话'))
    await tick(60)
    h.push({
      message_type: 'private',
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [{ type: 'text', data: { text: '私聊的话' } }],
    })
    await tick(400)

    const privateSends = h.seen.filter((s) => s.action === 'send_private_msg')
    assert.equal(privateSends.length, 1, '私聊不该等群聊那条慢回复')
    assert.equal(h.seen.filter((s) => s.action === 'send_group_msg').length, 0, '群里那条还在想')
  } finally {
    await h.close()
  }
})

test('并发：三条一起进来，最终三条都回、且顺序不乱', async () => {
  clearSessions()
  const h = await harness('熟人续话', undefined, async (m) => {
    await tick(120)
    return 'R:' + m.text
  })
  try {
    // 防抖关着，所以每条各成一轮，但要走同一条发送链
    for (const [i, t] of ['一', '二', '三'].entries()) {
      h.push(groupAt(t + '号', 9001 + i))
      await tick(20)
    }
    await tick(2000)
    const out = h.sent()
    assert.equal(out.length, 3, `三条都要回，实际 ${JSON.stringify(out)}`)
    assert.ok(out[0]!.includes('一号') && out[1]!.includes('二号') && out[2]!.includes('三号'))
  } finally {
    await h.close()
  }
})

test('真链路：图片 + 文字混发 → 照常回（有文字就是在说话）', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'image', data: { file: 'a.jpg', url: 'http://127.0.0.1:9/x.jpg' } },
        { type: 'text', data: { text: ' 看这个' } },
      ],
    })
    await tick(600)
    assert.equal(h.sent().length, 1)
  } finally {
    await h.close()
  }
})

test('真链路：同时 @ 它和别人 → 仍然回（它自己被叫到了）', async () => {
  clearSessions()
  const h = await harness()
  try {
    h.push({
      message_type: 'group',
      group_id: 555,
      user_id: 9001,
      sender: { nickname: '小明' },
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'at', data: { qq: '777' } },
        { type: 'text', data: { text: ' 你们俩看看' } },
      ],
    })
    await tick(500)
    assert.equal(h.sent().length, 1)
  } finally {
    await h.close()
  }
})
