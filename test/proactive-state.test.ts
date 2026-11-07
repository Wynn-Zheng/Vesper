/**
 * 主动消息的状态写入（B-35）。
 *
 * 缺陷原样：`lastAt` 在三种**没发出去**的分支里也写 ——
 * 选择不说、和上次太像、通道没连上。而间隔门读的就是 `lastAt`，
 * 于是"没发出去"被算成"已经主动过一次"：连着三次选择不说，
 * 接下来一周它就不肯开口，哪怕当天真有事想说。
 *
 * 修法是把两个时间拆开：`lastSentAt`（真发出去过）与 `lastAttemptAt`（试过）。
 * 间隔门只认前者。这里锁住的就是这个约定。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  lastProactiveOf,
  stateAfterAttempt,
  stateAfterSent,
  type ProactiveState,
} from '../src/scheduler/proactive.ts'

function base(): ProactiveState {
  return { date: '2026-01-01', count: 2, lastAt: 1_000, lastText: '上次说的', noReply: 0, lastSentAt: 1_000 }
}

test('没发出去：只留尝试时间，不动 sent/last/count', () => {
  const s = base()
  const now = 9_999_999
  const next = stateAfterAttempt(s, now, 1)
  assert.equal(next.lastAttemptAt, now)
  assert.equal(next.lastSentAt, 1_000, 'lastSentAt 不能被没发出去的动作改掉')
  assert.equal(next.lastAt, 1_000)
  assert.equal(next.count, 2, '额度不能被没发出去的动作吃掉')
  assert.equal(next.noReply, 1)

  // 关键：间隔门读到的仍然是上次真发的时间
  assert.equal(lastProactiveOf(next), 1_000)
})

test('真发出去：sent/last/count/text 一起更新，尝试时间清零', () => {
  const s = { ...base(), lastAttemptAt: 5_000 }
  const now = 9_999_999
  const next = stateAfterSent(s, '今天想跟你说个事', now, 0)
  assert.equal(next.lastSentAt, now)
  assert.equal(next.lastAt, now)
  assert.equal(next.count, 3)
  assert.equal(next.lastText, '今天想跟你说个事')
  assert.equal(next.lastAttemptAt, 0)
  assert.equal(next.noReply, 1)
  assert.equal(lastProactiveOf(next), now)
})

test('连着几次不说，间隔门仍然按上次真发的时间算', () => {
  let s = base()
  // 连续三次尝试都没发出去
  for (let i = 1; i <= 3; i++) s = stateAfterAttempt(s, 1_000 + i * 60_000, i)
  assert.equal(lastProactiveOf(s), 1_000, '三次没发出去不该让间隔门往后推')
  assert.equal(s.count, 2, '额度也不该被吃掉')
})

test('老数据只有 lastAt 时沿用（兼容）', () => {
  const legacy = { date: '2026-01-01', count: 1, lastAt: 777, lastText: '', noReply: 0 } as ProactiveState
  assert.equal(lastProactiveOf(legacy), 777)
})

test('lastSentAt 为 0（从没发过）时退到 lastAt', () => {
  const s: ProactiveState = { ...base(), lastSentAt: 0, lastAt: 42 }
  assert.equal(lastProactiveOf(s), 42)
})
