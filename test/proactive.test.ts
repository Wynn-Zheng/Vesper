import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import {
  computeUrge,
  inQuietHours,
  proactiveBudget,
  proactiveBudgetOf,
  shouldProactive,
  tooSimilar,
} from '../src/scheduler/proactive.ts'

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

test('陌生阶段不再完全禁言（只是门槛高、间隔长）', () => {
  const b = proactiveBudgetOf(DEFAULTS, '陌生')
  assert.equal(b.dailyMax, 1, '完全禁言会造成永久死锁：关系淡掉后再也没机会主动')
  assert.ok(b.minGapHours >= 24 * 7, `间隔应该很长，实际 ${b.minGapHours}h`)
  assert.ok(b.minUrge >= 5, `由头门槛应该很高，实际 ${b.minUrge}`)
})

test('阶段越高，间隔越短、额度越大、门槛越低', () => {
  const a = proactiveBudget('眼熟')
  const b = proactiveBudget('亲密')
  assert.ok(b.minGapHours < a.minGapHours)
  assert.ok(b.dailyMax > a.dailyMax)
  assert.ok(b.minUrge < a.minUrge)
})

// now 固定成"今天 15:00"，所以 lastTalkAt 也必须相对它算。
// 之前写的是 Date.now() - 30h：真实时间过了 21:00 之后，
// 今天15:00 减掉（现在-30h）就不够 24h 了，测试每天晚上九点后必挂。
const testNow = at(15, 0)

const base = {
  rules: DEFAULTS,
  now: testNow,
  stageName: '朋友',
  // 朋友阶段默认 5 天间隔，这里放 8 天前
  lastTalkAt: testNow.getTime() - 8 * 86_400_000,
  lastProactiveAt: 0,
  todayCount: 0,
  openCount: 1,
  urge: 5,
  noReply: 0,
}

test('正常情况可以主动', () => {
  assert.equal(shouldProactive(base).ok, true, shouldProactive(base).reason)
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

test('由头不够不主动（朋友阶段门槛 3）', () => {
  const r = shouldProactive({ ...base, urge: 2 })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('由头'), r.reason)
})

test('陌生阶段：由头不够挡，由头够就放行', () => {
  const blocked = shouldProactive({ ...base, stageName: '陌生', urge: 5 })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.reason.includes('由头'), blocked.reason)

  const far = testNow.getTime() - 40 * 86_400_000
  const allowed = shouldProactive({ ...base, stageName: '陌生', urge: 8, lastTalkAt: far })
  assert.equal(allowed.ok, true, allowed.reason)
})

test('连续 3 次没回：停下等对方先开口', () => {
  const r = shouldProactive({ ...base, noReply: 3 })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('没回'), r.reason)
})

test('连续 2 次没回：门槛抬高、间隔拉长', () => {
  // 由头刚好到基础门槛：抬高后就不够了
  assert.equal(shouldProactive({ ...base, noReply: 2, urge: 3 }).ok, false)
  // 间隔 8 天本来够，拉长 1.5 倍后不够（5 天 × 1.5 = 7.5 天 < 8 天，仍够）
  // 用「刚好到门槛」的由头，避免被"由头超门槛打折"放过 —— 这条测的是 ×1.5 本身
  const tighter = shouldProactive({ ...base, noReply: 2, urge: 5, lastTalkAt: testNow.getTime() - 6 * 86_400_000 })
  assert.equal(tighter.ok, false, tighter.reason)
})

test('rules 里把「每日上限」配成 0 就等于完全关闭', () => {
  const rules = {
    ...DEFAULTS,
    行为: { ...DEFAULTS.行为, 主动消息: { ...DEFAULTS.行为.主动消息, 每日上限: 0 as const } },
  }
  const b = proactiveBudgetOf(rules, '亲密')
  assert.equal(b.dailyMax, 0)
  assert.equal(shouldProactive({ ...base, rules, stageName: '亲密' }).ok, false)
})

test('rules 里的结构化字段会覆盖内置表', () => {
  const rules = {
    ...DEFAULTS,
    关系: {
      ...DEFAULTS.关系,
      阶段: DEFAULTS.关系.阶段.map((s) =>
        s.名 === '朋友' ? { ...s, 主动间隔小时: 1, 每日上限: 9, 最小由头: 0 } : s,
      ),
    },
  }
  const b = proactiveBudgetOf(rules, '朋友')
  assert.equal(b.minGapHours, 1)
  assert.equal(b.dailyMax, 9)
  assert.equal(b.minUrge, 0)
})

test('由头：没完的事最重，其次新经历、久未联系', () => {
  const baseUrge = {
    rules: DEFAULTS,
    stageName: '朋友',
    now: testNow,
    lastTalkAt: testNow.getTime() - 3600_000,
    openTodos: 0,
    freshEpisodeHours: null,
    hasLife: false,
    moodIntensity: 0,
    staleMajorFact: false,
  }
  assert.equal(computeUrge(baseUrge).score, 0)

  assert.ok(computeUrge({ ...baseUrge, openTodos: 1 }).score >= 3)
  assert.ok(computeUrge({ ...baseUrge, freshEpisodeHours: 10 }).score >= 2)

  const stale = computeUrge({ ...baseUrge, lastTalkAt: testNow.getTime() - 10 * 86_400_000 })
  assert.ok(stale.score >= 2)
  assert.ok(stale.reasons.includes('有一阵子没聊了'))

  // 从没聊过的人不会因为"久未联系"拿分
  assert.equal(computeUrge({ ...baseUrge, lastTalkAt: 0 }).reasons.includes('有一阵子没聊了'), false)
})

test('相似度过高会被判定重复', () => {
  assert.equal(tooSimilar('你妈的手术准备得怎么样了', '你妈手术准备得怎么样'), true)
  assert.equal(tooSimilar('今天下雨了', '四级复习得如何'), false)
})
