import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  shouldHandle,
  isObserveOnly,
  isAddressed,
  isAtOthers,
  replyTargetId,
  type OnebotOptions,
  type OBEvent,
} from '../src/channel/onebot.ts'

const base: OnebotOptions = { host: '127.0.0.1', port: 8765, path: '/onebot/v11/ws', token: 't' }

const priv = (userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'private',
  user_id: userId,
  self_id: '10000',
  message: [{ type: 'text', data: { text } }],
})

const group = (groupId: string, userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  self_id: '10000',
  message: [{ type: 'text', data: { text } }],
})

const groupAt = (groupId: string, userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  self_id: '10000',
  message: [
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text } },
  ],
})

const imageOnly = (): OBEvent => ({
  post_type: 'message',
  message_type: 'private',
  user_id: '1234567890',
  self_id: '10000',
  message: [{ type: 'image', data: {} }],
})

test('私聊：主人的消息通过', () => {
  assert.equal(shouldHandle(priv('1234567890', '在吗'), { ...base, ownerQQ: '1234567890' }), true)
})

test('私聊：别人的消息被拦', () => {
  assert.equal(shouldHandle(priv('999', '在吗'), { ...base, ownerQQ: '1234567890' }), false)
})

test('私聊：没设 ownerQQ 时谁都能触发（仅调试用）', () => {
  assert.equal(shouldHandle(priv('999', '在吗'), base), true)
})

test('群聊：allowGroup=false 时完全忽略', () => {
  // 注意：现在「没设置 allowGroup」= 默认开（见 access.ts 的注释），
  // 所以这条要显式写 false 才是在测"关掉群聊"。
  assert.equal(shouldHandle(group('123', '999', '你好'), { ...base, allowGroup: false }), false)
})

test('群聊：开启后，@ 了才处理', () => {
  const opts = { ...base, allowGroup: true }
  assert.equal(shouldHandle(groupAt('123', '999', '你好'), opts), true)
})

test('群聊：没 @ 就只记录不回复（默认行为）', () => {
  const opts = { ...base, allowGroup: true }
  const ev = group('123', '999', '你好')
  // 消息还是要进来：不进来就学不到这个群怎么说话、记不住发生过什么、
  // 「发言频率」也永远不生效（这几件事以前全都是坏的）
  assert.equal(shouldHandle(ev, opts), true, '应该进历史')
  // 但不回复
  assert.equal(isObserveOnly(ev, opts), true, '没叫它就不回')
})

test('群聊：@ 了就会回复', () => {
  const opts = { ...base, allowGroup: true }
  assert.equal(isObserveOnly(groupAt('123', '999', '你好'), opts), false)
})

test('群聊：@ 的是别人 —— 即使刚聊过也不插嘴', () => {
  const opts = {
    ...base,
    allowGroup: true,
    recentTalkers: new Map([['123:999', Date.now()]]),
    followUpWindowMs: 120_000,
  }
  // 上一句刚问过它，这一句「@小明 你试试」是跟小明说的
  const ev: OBEvent = {
    post_type: 'message',
    message_type: 'group',
    group_id: '123',
    user_id: '999',
    self_id: '10000',
    message: [
      { type: 'at', data: { qq: '777' } },
      { type: 'text', data: { text: ' 你试试' } },
    ],
  }
  // 消息照进历史
  assert.equal(shouldHandle(ev, opts), true)
  // 但不该回 —— 以前会回一句「试什么」
  assert.equal(isObserveOnly(ev, opts), true, '@ 了别人就不要接话')
})

test('群聊：@别人 同时又 @它 → 还是要回', () => {
  const opts = { ...base, allowGroup: true }
  const ev: OBEvent = {
    post_type: 'message',
    message_type: 'group',
    group_id: '123',
    user_id: '999',
    self_id: '10000',
    message: [
      { type: 'at', data: { qq: '777' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 你们俩看看' } },
    ],
  }
  assert.equal(isObserveOnly(ev, opts), false)
})

test('群聊：没 @ 任何人、也没 @它，刚聊过 → 接着聊', () => {
  const opts = {
    ...base,
    allowGroup: true,
    recentTalkers: new Map([['123:999', Date.now()]]),
    followUpWindowMs: 120_000,
  }
  assert.equal(isObserveOnly(group('123', '999', '那你呢'), opts), false)
})

test('群聊：requireAt=false 时没 @ 也会回复', () => {
  const opts = { ...base, allowGroup: true, requireAt: false }
  assert.equal(shouldHandle(group('123', '999', '你好'), opts), true)
  assert.equal(isObserveOnly(group('123', '999', '你好'), opts), false, '不要求 @ 就该参与')
})

test('群聊：群号白名单之外被拦', () => {
  const opts = { ...base, allowGroup: true, groupAllow: ['888'] }
  assert.equal(shouldHandle(groupAt('123', '999', '你好'), opts), false)
  assert.equal(shouldHandle(groupAt('888', '999', '你好'), opts), true)
})

test('群聊：成员白名单之外被拦', () => {
  const opts = { ...base, allowGroup: true, memberAllow: ['1234567890'] }
  assert.equal(shouldHandle(groupAt('123', '999', '你好'), opts), false)
  assert.equal(shouldHandle(groupAt('123', '1234567890', '你好'), opts), true)
})

test('纯图片消息不触发', () => {
  assert.equal(shouldHandle(imageOnly(), { ...base, ownerQQ: '1234567890' }), false)
})

test('图片加文字会触发（文字有意义）', () => {
  const ev: OBEvent = {
    post_type: 'message',
    message_type: 'private',
    user_id: '1234567890',
    self_id: '10000',
    message: [
      { type: 'image', data: {} },
      { type: 'text', data: { text: '看这个' } },
    ],
  }
  assert.equal(shouldHandle(ev, { ...base, ownerQQ: '1234567890' }), true)
})

/* ---------------- 引用回复：判断"在跟谁说" ---------------- */

const quoted = (replyId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: '123',
  user_id: '999',
  self_id: '10000',
  message: [
    { type: 'reply', data: { id: replyId } },
    { type: 'text', data: { text } },
  ],
})

test('引用：能从消息段里取出被引用消息的 id', () => {
  assert.equal(replyTargetId(quoted('777', '嗯').message), '777')
  assert.equal(replyTargetId(group('123', '999', '没有引用').message), '')
})

test('引用它自己说过的话（没 @）→ 算在跟它说话', () => {
  const own = new Set(['555'])
  const ev = quoted('555', '那你刚才说的那个呢')
  // 没 @ 也没叫名字
  assert.equal(isAddressed(ev, [], own), true, '引用它说的话应该算 addressed')
  assert.equal(isAddressed(ev, []), false, '没有 ownIds 就判断不了，别瞎猜')
})

test('引用别人的话 → 不据此判"在跟别人说"（太容易误伤）', () => {
  const own = new Set(['555'])
  const ev = quoted('666', '你这个怎么弄的')
  assert.equal(isAddressed(ev, [], own), false, '引用别人的话不算叫我')
  // 故意不用 reply 做否定判断：ownIds 是进程内存的，重启就空。
  // 重启后引用它昨天的话会被误判成"引用别人"，于是它装没看见 —— 比不判更差。
  // 这类消息交给 @/叫名字/刚聊过/内容打分去决定。
  assert.equal(isAtOthers(ev, own), false)
})

test('引用它自己 → 不算在跟别人说', () => {
  const own = new Set(['555'])
  assert.equal(isAtOthers(quoted('555', '嗯嗯'), own), false)
})

test('引用 + @它 → 仍然按 @ 处理', () => {
  const own = new Set(['555'])
  const ev: OBEvent = {
    post_type: 'message',
    message_type: 'group',
    group_id: '123',
    user_id: '999',
    self_id: '10000',
    message: [
      { type: 'reply', data: { id: '666' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 你看这个' } },
    ],
  }
  assert.equal(isAddressed(ev, [], own), true)
  assert.equal(isObserveOnly(ev, { ...base, allowGroup: true }), false)
})

test('空消息不触发', () => {
  const ev: OBEvent = { post_type: 'message', message_type: 'private', user_id: '1234567890', message: [] }
  assert.equal(shouldHandle(ev, base), false)
})
