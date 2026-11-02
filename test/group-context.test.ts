import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatUserText } from '../src/loop/chat.ts'
import { renderHeard } from '../src/loop/prompt.ts'
import {
  clearSessions,
  getHeard,
  getSession,
  pushHeard,
  pushTurn,
  setSessionRoot,
} from '../src/loop/session.ts'
import { batchLines } from '../src/boot.ts'

/**
 * 群聊的「谁在说」与「旁听」。
 *
 * 这两件事以前都断着：
 *   - 一批里多个人说话，合并后整段只挂最后一个人的名字；
 *   - 群里没叫它的消息只进 raw，不进 session，所以它接不上前文。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-group-ctx-'))
setSessionRoot(dir)
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- 合批：谁说的要写清楚 ---------------- */

test('群聊：单人发言时仍由下游加一次名字前缀', () => {
  // boot 在单发送人时不动 text，交给 formatUserText 加前缀
  const text = '在吗\n在忙'
  assert.equal(formatUserText('group:1', '小明', text), '小明：在吗\n在忙')
})

test('群聊：多人合批时逐条带名字', () => {
  const lines = batchLines('group', ['他刚才说话了', '我知道'], ['小红', '小明'])
  assert.deepEqual(lines, [
    { name: '小红', text: '他刚才说话了' },
    { name: '小明', text: '我知道' },
  ])
})

test('私聊：永远不拆（那边只有一个人，前缀名字会很怪）', () => {
  assert.equal(batchLines('private', ['在吗', '在忙'], ['小明', '小明']), null)
})

test('群聊：同一个人连发多条也要逐条带名字', () => {
  // 这是最高频的批次（同人续发）。只加一次前缀的话，第二句在
  // group.ts 的规则里（无前缀 = 你自己说的）会被读成它自己说的。
  const lines = batchLines('group', ['在吗', '在忙'], ['小明', '小明'])
  assert.equal(lines?.length, 2)
  assert.deepEqual(lines?.[1], { name: '小明', text: '在忙' })
})

test('群聊：单条消息不拆（走单前缀路径）', () => {
  assert.equal(batchLines('group', ['在吗'], ['小明']), null)
  assert.equal(formatUserText('group:1', '小明', '在吗'), '小明：在吗')
})

test('群聊：两个人重名也要按条拆开', () => {
  // QQ 允许同群同名片。按"不同名字数"判会当成单人，等于没修。
  const lines = batchLines('group', ['我是小明A', '我是小明B'], ['小明', '小明'])
  assert.equal(lines?.length, 2, '按条数判，不是按名字数')
})

test('群聊：私聊不加名字前缀', () => {
  assert.equal(formatUserText('private:1', '小明', '在吗'), '在吗')
})

/* ---------------- 旁听：群里没叫它的话也要能看见 ---------------- */

test('旁听：记进去、按顺序取出来', () => {
  clearSessions()
  pushHeard('group:9', { role: 'user', content: '小红：今天好热', at: 1 })
  pushHeard('group:9', { role: 'user', content: '小明：是啊', at: 2 })
  const heard = getHeard('group:9')
  assert.equal(heard.length, 2)
  assert.equal(heard[0]!.content, '小红：今天好热')
  assert.equal(heard[1]!.content, '小明：是啊')
})

test('旁听：只留最近 12 条，老的挤掉', () => {
  clearSessions()
  for (let i = 0; i < 20; i++) pushHeard('group:10', { role: 'user', content: `m${i}`, at: i })
  const heard = getHeard('group:10')
  assert.equal(heard.length, 12)
  assert.equal(heard[0]!.content, 'm8')
  assert.equal(heard[11]!.content, 'm19')
})

test('旁听：落盘后重启还能读回来', () => {
  clearSessions()
  pushHeard('group:11', { role: 'user', content: '小红：在吗', at: 1 })
  clearSessions()
  const s = getSession('group:11')
  assert.equal(s.heard?.length, 1)
  assert.equal(s.heard?.[0]?.content, '小红：在吗')
})

test('旁听：和对话历史分开存，不会冒充成它参与过的对话', () => {
  clearSessions()
  pushTurn('group:12', { role: 'user', content: '小明：@它 在吗', at: 1 })
  pushHeard('group:12', { role: 'user', content: '小红：随便聊聊', at: 2 })
  const s = getSession('group:12')
  assert.equal(s.turns.length, 1)
  assert.equal(s.heard?.length, 1)
})

/* ---------------- 渲染 ---------------- */

test('旁听：渲染成一段带说明的背景，明确"没叫你"', () => {
  const text = renderHeard([
    { content: '小红：今天好热', at: 1 },
    { content: '小明：是啊', at: 2 },
  ])
  assert.ok(text.includes('群里刚才在聊'))
  assert.ok(text.includes('没叫你'))
  assert.ok(text.includes('小红：今天好热'))
  assert.ok(text.includes('小明：是啊'))
})

test('旁听：空列表渲染成空串（不要留个空标题）', () => {
  assert.equal(renderHeard([]), '')
})

test('旁听：超预算时保留最近的，丢掉最早的', () => {
  const long = 'x'.repeat(600)
  const text = renderHeard(
    [
      { content: `老消息：${long}`, at: 1 },
      { content: '新消息：在吗', at: 2 },
    ],
    800,
  )
  assert.ok(text.includes('新消息：在吗'))
})
