/**
 * 主动消息的问候窗口必须跟着静默时段走。
 *
 * 背景（B-34）：窗口以前写死 8–11 / 22–1，而静默时段是配的（默认 23:30–08:30）。
 * 用户把静默改成 09:30 结束后，早上那句永远撞进静默里发不出来 —— 而且没有任何报错，
 * 只是"它早上从不打招呼"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { greetingWindows, inQuietHours } from '../src/scheduler/proactive.ts'
import type { Rules } from '../src/core/config.ts'

/** 只造这一个字段，够 greetingWindows 用 */
function rulesWithQuiet(start: string, end: string): Rules {
  return { 行为: { 静默时段: [start, end] } } as unknown as Rules
}

function inWindow(w: readonly [number, number], hour: number, minute = 0): boolean {
  const cur = hour * 60 + minute
  const [a, b] = w
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b
}

test('默认静默 23:30–08:30：早上窗口从静默结束后开始', () => {
  const w = greetingWindows(rulesWithQuiet('23:30', '08:30'))
  // 8:30 之前不该算"早上"——那时还在静默里
  assert.equal(inWindow(w.morning, 7, 0), false)
  assert.equal(inWindow(w.morning, 8, 30), true)
  assert.equal(inWindow(w.morning, 10, 0), true)
  assert.equal(inWindow(w.morning, 12, 0), false)
})

test('静默改成 09:30 结束：早上窗口跟着后移，8 点不再是早上', () => {
  const w = greetingWindows(rulesWithQuiet('23:00', '09:30'))
  assert.equal(inWindow(w.morning, 8, 0), false, '8 点还在静默里')
  assert.equal(inWindow(w.morning, 9, 30), true)
})

test('深夜窗口在静默开始之前结束', () => {
  const w = greetingWindows(rulesWithQuiet('23:30', '08:30'))
  assert.equal(inWindow(w.night, 22, 0), true)
  assert.equal(inWindow(w.night, 23, 20), true)
  assert.equal(inWindow(w.night, 23, 40), false, '静默已开始，不该再算深夜窗口')
})

test('没有静默时段时退回默认 08:00–11:00 / 22:00–01:00', () => {
  const none = { 行为: {} } as unknown as Rules
  const w = greetingWindows(none)
  assert.deepEqual(w.morning, [480, 660])
  assert.deepEqual(w.night, [1320, 60])
  // 深夜窗口跨午夜：0:30 应该算
  assert.equal(inWindow(w.night, 0, 30), true)
  assert.equal(inWindow(w.night, 1, 30), false)
})

test('静默形状配错（只有一个元素 / 不是字符串）时退回默认，不抛错', () => {
  const bad1 = { 行为: { 静默时段: ['23:30'] } } as unknown as Rules
  const bad2 = { 行为: { 静默时段: [23, 8] } } as unknown as Rules
  for (const r of [bad1, bad2]) {
    const w = greetingWindows(r)
    assert.deepEqual(w.morning, [480, 660])
    assert.deepEqual(w.night, [1320, 60])
  }
})

test('窗口与静默时段不重叠：静默里的时刻不进问候窗口', () => {
  const r = rulesWithQuiet('23:30', '08:30')
  const w = greetingWindows(r)
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const quiet = inQuietHours(r, new Date(2026, 10, 5, h, m))
      if (!quiet) continue
      assert.equal(
        inWindow(w.morning, h, m) || inWindow(w.night, h, m),
        false,
        `${h}:${String(m).padStart(2, '0')} 在静默里，不该同时命中问候窗口`,
      )
    }
  }
})
