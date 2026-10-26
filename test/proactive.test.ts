import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import { inQuietHours, proactiveBudget, shouldProactive, tooSimilar } from '../src/scheduler/proactive.ts'

const at = (h: number, m = 0): Date => {
  // 不要写死日期：lastTalkAt 用的是 Date.now()，日期一过测试就失效（2026-10-26 就挂过）
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

test('静默时段：23:30 到 08:30 生效', () => {
  assert.equal(inQuietHours(DEFAULTS, at(23, 30)), true)
  assert.equal(inQuietHours(DEFAULTS, at(2, 0)), true)
  assert.equal(inQuietHours(DEFAULTS, at(8, 29)), true)
  assert.equal(inQuietHours(DEFAULTS, at(8, 30)), false)
  assert.equal(inQuietHours(DEFAULTS, at(14, 0)), false)
})

test('陌生阶段完全不主动', () => {
  assert.equal(proactiveBudget('陌生').dailyMax, 0)
})

test('阶段越高，间隔越短、额度越大', () => {
  const a = proactiveBudget('眼熟')
  const b = proactiveBudget('亲密')
  assert.ok(b.minGapHours < a.minGapHours)
  assert.ok(b.dailyMax > a.dailyMax)
})

const base = {
  rules: DEFAULTS,
  now: at(15, 0),
  stageName: '朋友',
  lastTalkAt: Date.now() - 30 * 3600_000,
  lastProactiveAt: 0,
  todayCount: 0,
  openCount: 1,
}

test('正常情况可以主动', () => {
  assert.equal(shouldProactive(base).ok, true)
})

test('静默时段不主动', () => {
  assert.equal(shouldProactive({ ...base, now: at(2, 0) }).ok, false)
})

test('额度用完不主动', () => {
  assert.equal(shouldProactive({ ...base, todayCount: 2 }).ok, false)
})

test('间隔不够不主动', () => {
  const r = shouldProactive({ ...base, lastTalkAt: Date.now() - 2 * 3600_000 })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('间隔'))
})

test('陌生阶段被挡', () => {
  assert.equal(shouldProactive({ ...base, stageName: '陌生' }).ok, false)
})

test('相似度过高会被判定重复', () => {
  assert.equal(tooSimilar('你妈的手术准备得怎么样了', '你妈手术准备得怎么样'), true)
  assert.equal(tooSimilar('今天下雨了', '四级复习得如何'), false)
})
