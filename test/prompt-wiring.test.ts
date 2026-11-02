import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateReply } from '../src/loop/chat.ts'
import { DEFAULTS } from '../src/core/config.ts'
import { initLog } from '../src/core/log.ts'
import { setMemoryRoot } from '../src/memory/store.ts'
import { setPeopleRoot } from '../src/people/store.ts'
import { clearSessions, pushHeard, setSessionRoot } from '../src/loop/session.ts'
import type { Incoming } from '../src/core/types.ts'

/**
 * 端到端验证「模型实际收到的 prompt」。
 *
 * 为什么需要这一层：前面那些测试都是"函数返回了什么"，
 * 而真正决定它表现的是**拼出来的那段 prompt**。
 * 比如 batchLines 拆得再对，如果 chat.ts 忘了往 prompt 里写，等于没修。
 * 这里起一个假模型服务，把请求体抓下来直接断言。
 */

initLog('', false)
const dir = mkdtempSync(join(tmpdir(), 'qqbot-wiring-'))
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

/** 起一个假模型：把请求体记下来，回一句固定的话 */
function fakeLlm(): Promise<{ url: string; bodies: () => string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const bodies: string[] = []
    const srv = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        bodies.push(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '知道了' } }] }))
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies: () => bodies,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      })
    })
  })
}

/** 把请求体里的所有文本拼起来，方便断言（不管它放在 system 还是 user） */
const allText = (body: string): string => {
  try {
    const j = JSON.parse(body) as { messages?: Array<{ content?: unknown }> }
    return (j.messages ?? [])
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
  } catch {
    return body
  }
}

const groupMsg = (over: Partial<Incoming> = {}): Incoming => ({
  id: 'm' + Math.random(),
  from: { kind: 'group', id: '555', name: '测试群' },
  selfId: '10000',
  text: '在吗',
  at: Date.now(),
  senderId: '9001',
  senderName: '小明',
  ...over,
})

test('群聊合批：prompt 里是逐条「名字：内容」', async () => {
  clearSessions()
  const llm = await fakeLlm()
  try {
    await generateReply(
      groupMsg({
        batchLines: [
          { name: '小红', text: '他刚才是不是说了什么' },
          { name: '小明', text: '我说了' },
        ],
      }),
      { rules: DEFAULTS, llm: { apiKey: 'k', baseUrl: llm.url, model: 'm' } },
    )
    const text = allText(llm.bodies()[0] ?? '')
    assert.ok(text.includes('小红：他刚才是不是说了什么'), '要有小红那句、带名字')
    assert.ok(text.includes('小明：我说了'), '要有小明那句、带名字')
    // 不能出现"小明：小红：..."这种双前缀
    assert.equal(text.includes('小明：小红：'), false)
  } finally {
    await llm.close()
  }
})

test('群聊：prompt 里有【群里刚才在聊】（旁听真的送到了模型面前）', async () => {
  clearSessions()
  pushHeard('group:555', { role: 'user', content: '小红：今天好热', at: Date.now() })
  const llm = await fakeLlm()
  try {
    await generateReply(groupMsg(), {
      rules: DEFAULTS,
      llm: { apiKey: 'k', baseUrl: llm.url, model: 'm' },
    })
    const text = allText(llm.bodies()[0] ?? '')
    assert.ok(text.includes('群里刚才在聊'), '要有旁听段落')
    assert.ok(text.includes('小红：今天好热'), '旁听内容要真的在里面')
  } finally {
    await llm.close()
  }
})

test('群聊：prompt 里给了「这次可以不说话」和「不要 @ 人」', async () => {
  clearSessions()
  const llm = await fakeLlm()
  try {
    await generateReply(groupMsg(), {
      rules: DEFAULTS,
      llm: { apiKey: 'k', baseUrl: llm.url, model: 'm' },
    })
    const text = allText(llm.bodies()[0] ?? '')
    assert.ok(text.includes('可以选择这次不说话'))
    assert.ok(text.includes('不要 @ 任何人'))
  } finally {
    await llm.close()
  }
})

test('私聊：prompt 里没有群聊那两条，也没有旁听段落', async () => {
  clearSessions()
  const llm = await fakeLlm()
  try {
    await generateReply(
      {
        id: 'p1',
        from: { kind: 'private', id: '9001', name: '小明' },
        selfId: '10000',
        text: '在吗',
        at: Date.now(),
        senderId: '9001',
        senderName: '小明',
      },
      { rules: DEFAULTS, llm: { apiKey: 'k', baseUrl: llm.url, model: 'm' } },
    )
    const text = allText(llm.bodies()[0] ?? '')
    assert.equal(text.includes('可以选择这次不说话'), false)
    assert.equal(text.includes('不要 @ 任何人'), false)
    assert.equal(text.includes('群里刚才在聊'), false)
  } finally {
    await llm.close()
  }
})

test('群聊：这条消息会被记进对话历史（下次能接上）', async () => {
  clearSessions()
  const llm = await fakeLlm()
  try {
    await generateReply(groupMsg(), {
      rules: DEFAULTS,
      llm: { apiKey: 'k', baseUrl: llm.url, model: 'm' },
    })
    const { getTurns } = await import('../src/loop/session.ts')
    const turns = getTurns('group:555')
    assert.ok(turns.some((t) => t.role === 'user' && t.content.includes('小明')), '用户那句话要在历史里')
    assert.ok(turns.some((t) => t.role === 'assistant'), '它的回复也要在历史里')
  } finally {
    await llm.close()
  }
})
