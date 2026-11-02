import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { renderBatch } from '../src/loop/chat.ts'
import { renderHeard } from '../src/loop/prompt.ts'
import { clearSessions, getHeard, pushHeard, setSessionRoot } from '../src/loop/session.ts'
import { mentionsName } from '../src/channel/onebot.ts'

/**
 * QA 扫描报告（.team/buglog.md）里指出的几条回归。
 * 都是"会烧钱 / 会烦"的实际问题，不是洁癖。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-bugfix-'))
setSessionRoot(dir)
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- BUG-02：合批要带预算，不能被刷屏撑爆 ---------------- */

test('合批：逐条超长时截断，不会把整篇原文塞进 prompt', () => {
  const long = 'x'.repeat(5000)
  const out = renderBatch([{ name: '小明', text: long }])
  assert.ok(out.length < 3000, `应被截断，实际 ${out.length}`)
  assert.ok(out.includes('这条太长了'))
})

test('合批：总量超预算时保留最近的，老的整条丢掉', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ name: '甲', text: `第${i}条` + 'y'.repeat(1500) }))
  const out = renderBatch(lines)
  assert.ok(out.length <= 8000 + 200, `总长应受控，实际 ${out.length}`)
  assert.ok(out.includes('第9条'), '最近那条要在')
  assert.equal(out.includes('第0条'), false, '最早那条应被丢掉')
})

test('合批：正常短消息全保留', () => {
  const out = renderBatch([
    { name: '小红', text: '在吗' },
    { name: '小明', text: '嗯' },
  ])
  assert.equal(out, '小红：在吗\n小明：嗯')
})

/* ---------------- BUG-03：最新一条旁听太长，不该整段消失 ---------------- */

test('旁听：最新一条超预算时截断收进来，整段不会消失', () => {
  const text = renderHeard([
    { content: '小红：短句', at: 1 },
    { content: '小明：' + 'z'.repeat(900), at: 2 },
  ])
  assert.notEqual(text, '', '不能因为一条长消息就整段丢掉')
  assert.ok(text.includes('群里刚才在聊'))
})

/* ---------------- BUG-04：旁听要有时间窗，不能把隔天的当"刚才" ---------------- */

test('旁听：超过时间窗的旧消息不会再被当成"刚才在聊"', () => {
  clearSessions()
  const threeHoursAgo = Date.now() - 3 * 3_600_000
  pushHeard('group:77', { role: 'user', content: '小明：昨天的旧话', at: threeHoursAgo })
  assert.equal(getHeard('group:77').length, 0, '3 小时前的不该算"刚才"')
})

test('旁听：时间窗内的照常返回', () => {
  clearSessions()
  pushHeard('group:78', { role: 'user', content: '小明：刚才的话', at: Date.now() - 60_000 })
  const heard = getHeard('group:78')
  assert.equal(heard.length, 1)
  assert.equal(heard[0]!.content, '小明：刚才的话')
})

/* ---------------- BUG-11：单字名字不该按子串命中 ---------------- */

test('单字名字：只有单独出现或带呼语才算', () => {
  assert.equal(mentionsName('圆满', ['满']), false)
  assert.equal(mentionsName('满足', ['满']), false)
  assert.equal(mentionsName('满了', ['满']), false)
  assert.equal(mentionsName('满', ['满']), true)
  assert.equal(mentionsName('满在吗', ['满']), true)
  assert.equal(mentionsName('叫满一声', ['满']), false, '右边紧跟别的字不算')
})
