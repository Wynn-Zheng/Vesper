import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isObserveOnly, rejectReason, type OBEvent, type OnebotOptions } from '../src/channel/onebot.ts'
import { DEFAULT_GROUP_CHAT_MODE, asGroupChatMode, GROUP_CHAT_MODES } from '../src/core/config.ts'

/**
 * 群聊三档：`只听` / `熟人续话` / `自己判断`。
 *
 * 这三档就是"群里要不要 @ 才回"的总开关。以前它藏在 .env 和
 * access.yaml 两处，改了没反应；现在统一到 rules.yaml 的 行为.群聊模式。
 */

const base: OnebotOptions = { host: '127.0.0.1', port: 8765, path: '/onebot/v11/ws', token: 't' }

const groupText = (text: string, userId = '999'): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: '123',
  user_id: userId,
  self_id: '10000',
  message: [{ type: 'text', data: { text } }],
})

const groupAt = (text: string, userId = '999'): OBEvent => ({
  post_type: 'message',
  message_type: 'group',
  group_id: '123',
  user_id: userId,
  self_id: '10000',
  message: [
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text } },
  ],
})

const optsFor = (mode: '只听' | '熟人续话' | '自己判断', talker = false): OnebotOptions => ({
  ...base,
  allowGroup: true,
  getGroupMode: () => mode,
  ...(talker ? { recentTalkers: new Map([['123:999', Date.now()]]), followUpWindowMs: 120_000 } : {}),
})

/* ---------------- 只听 ---------------- */

test('只听：被 @ 才回', () => {
  assert.equal(isObserveOnly(groupAt('在吗'), optsFor('只听')), false)
})

test('只听：没被叫就不回', () => {
  assert.equal(isObserveOnly(groupText('今天好热'), optsFor('只听')), true)
})

test('只听：刚聊过也不回（这就是它和「熟人续话」的区别）', () => {
  assert.equal(isObserveOnly(groupText('那你呢'), optsFor('只听', true)), true)
})

/* ---------------- 熟人续话（默认） ---------------- */

test('熟人续话：没被叫、也不熟 → 不回', () => {
  assert.equal(isObserveOnly(groupText('今天好热'), optsFor('熟人续话')), true)
})

test('熟人续话：刚跟它说过话 → 接着聊', () => {
  assert.equal(isObserveOnly(groupText('那你呢'), optsFor('熟人续话', true)), false)
})

/* ---------------- 自己判断 ---------------- */

test('自己判断：没被叫也放行，交给打分决定', () => {
  assert.equal(isObserveOnly(groupText('今天好热'), optsFor('自己判断')), false)
})

test('自己判断：@ 别人仍然不抢答', () => {
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
  assert.equal(isObserveOnly(ev, optsFor('自己判断')), true)
})

/* ---------------- 日志要跟判定一致 ---------------- */

test('拒绝原因会说清是哪个档位挡的', () => {
  const p = { allowGroup: true, groupAllow: [], groupDeny: [], memberAllow: [], memberDeny: [], requireAt: true }
  const o: OnebotOptions = { ...base, allowGroup: true, getPolicy: () => p, getGroupMode: () => '只听' }
  assert.match(rejectReason(groupText('今天好热'), o), /只听/)
})

/* ---------------- 配置层 ---------------- */

test('配置：默认档是熟人续话', () => {
  assert.equal(DEFAULT_GROUP_CHAT_MODE, '熟人续话')
  assert.ok(GROUP_CHAT_MODES.includes(DEFAULT_GROUP_CHAT_MODE))
})

test('配置：非法档位不被接受（由 loadRules 回落并告警）', () => {
  assert.equal(asGroupChatMode('自己判断'), '自己判断')
  assert.equal(asGroupChatMode(' 只听 '), '只听')
  assert.equal(asGroupChatMode('乱写'), null)
  assert.equal(asGroupChatMode(123), null)
  assert.equal(asGroupChatMode(undefined), null)
})
