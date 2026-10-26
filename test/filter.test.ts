import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldHandle, type OnebotOptions, type OBEvent } from '../src/channel/onebot.ts'

const base: OnebotOptions = { host: '127.0.0.1', port: 8765, path: '/onebot/v11/ws', token: 't' }

const priv = (userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'private',
  user_id: userId,
  self_id: '552388771',
  message: [{ type: 'text', data: { text } }],
})

const group = (groupId: string, userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  self_id: '552388771',
  message: [{ type: 'text', data: { text } }],
})

const groupAt = (groupId: string, userId: string, text: string): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  self_id: '552388771',
  message: [
    { type: 'at', data: { qq: '552388771' } },
    { type: 'text', data: { text } },
  ],
})

const imageOnly = (): OBEvent => ({
  post_type: 'message',
  message_type: 'private',
  user_id: '1234567890',
  self_id: '552388771',
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

test('群聊：默认完全忽略', () => {
  assert.equal(shouldHandle(group('123', '999', '你好'), base), false)
})

test('群聊：开启后，@ 了才处理', () => {
  const opts = { ...base, allowGroup: true }
  assert.equal(shouldHandle(groupAt('123', '999', '你好'), opts), true)
})

test('群聊：没 @ 就忽略（默认行为）', () => {
  const opts = { ...base, allowGroup: true }
  assert.equal(shouldHandle(group('123', '999', '你好'), opts), false)
})

test('群聊：requireAt=false 时没 @ 也可以', () => {
  const opts = { ...base, allowGroup: true, requireAt: false }
  assert.equal(shouldHandle(group('123', '999', '你好'), opts), true)
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
    self_id: '552388771',
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
