import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldHandle, isObserveOnly, type OnebotOptions, type OBEvent } from '../src/channel/onebot.ts'

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

test('空消息不触发', () => {
  const ev: OBEvent = { post_type: 'message', message_type: 'private', user_id: '1234567890', message: [] }
  assert.equal(shouldHandle(ev, base), false)
})
