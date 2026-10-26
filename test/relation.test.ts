import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, stageOf } from '../src/core/config.ts'
import { decayedMood, loadMood, saveMood } from '../src/persona/mood.ts'
import { setPeopleRoot, personIdOf } from '../src/people/store.ts'
import { buildRelationBlock } from '../src/relation/format.ts'
import { applyAnchor, loadRelation, saveRelation, setRelationRoot } from '../src/relation/store.ts'
import { EMPTY_RELATION, type RelationState } from '../src/relation/types.ts'

const dir = mkdtempSync(join(tmpdir(), 'qqbot-rel-'))
setPeopleRoot(join(dir, 'people'))
setRelationRoot(join(dir, 'people'))

const pid = personIdOf('qq', '1')
const other = personIdOf('qq', '2')

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const anchor = (over: Partial<Parameters<typeof applyAnchor>[1]> = {}) => ({
  event: '他说了家里的事',
  dimension: '信任' as const,
  direction: 'up' as const,
  amount: 2,
  reason: '愿意跟我说这种事',
  ...over,
})

test('没有锚点理由时变化无效', () => {
  const r = applyAnchor(structuredClone(EMPTY_RELATION), anchor({ reason: '' }), DEFAULTS)
  assert.equal(r.delta, 0)
})

test('单次变化被限制在 ±2', () => {
  const r = applyAnchor(structuredClone(EMPTY_RELATION), anchor({ amount: 10 }), DEFAULTS)
  assert.equal(r.delta, 2)
})

test('总关系值不会超过上限', () => {
  const s: RelationState = { ...structuredClone(EMPTY_RELATION), closeness: 99 }
  const r = applyAnchor(s, anchor(), DEFAULTS)
  assert.equal(r.state.closeness, 100)
})

test('关系按人存，互不影响', () => {
  const a = applyAnchor(structuredClone(EMPTY_RELATION), anchor(), DEFAULTS).state
  saveRelation(pid, a)
  assert.equal(loadRelation(pid).closeness, 2)
  assert.equal(loadRelation(other).closeness, 0)
})

test('阶段随关系值变化', () => {
  const r = applyAnchor({ ...structuredClone(EMPTY_RELATION), closeness: 9 }, anchor(), DEFAULTS)
  assert.equal(stageOf(DEFAULTS, r.state.closeness).名, '眼熟')
})

test('心情是全局的，随时间衰减', () => {
  const now = Date.now()
  saveMood({ emotion: '担心', intensity: 1, at: now })
  const m = loadMood()
  assert.equal(m?.emotion, '担心')

  const fresh = decayedMood(m, now)
  assert.ok(fresh && fresh.intensity > 0.9)

  // 衰减从「一律 2 小时半衰期」改成按效价分两档：
  //   负面 11 小时、其余 6 小时（依据 Frijda 1988：情绪会习惯化，
  //   但不是两小时就消失）。所以 8 小时后还应该有相当一部分。
  const later = decayedMood(m, now + 8 * 3600_000)
  assert.ok(later && later.intensity > 0.2, '8 小时后应该还有残留，但明显弱了')
  assert.ok(later!.intensity < 0.7, '8 小时后应该明显弱了')

  // 两天后应该没了（强度低于 0.1 的阈值）
  assert.equal(decayedMood(m, now + 48 * 3600_000), null, '48 小时后应该归零')
})

test('心情带多轮序列', () => {
  const now = Date.now()
  saveMood({
    emotion: '好奇',
    intensity: 0.6,
    at: now,
    recent: [
      { emotion: '平静', intensity: 0.3, at: now - 60000 },
      { emotion: '好奇', intensity: 0.6, at: now },
    ],
  })
  const m = loadMood()
  assert.equal(m?.recent?.length, 2)
  assert.equal(m?.recent?.[0]?.emotion, '平静')
})

test('关系块包含阶段、称呼、锚点', () => {
  const s: RelationState = { ...structuredClone(EMPTY_RELATION), closeness: 12 }
  s.anchors = [
    { date: '2026-10-25', event: '他说四级没复习', dimension: '信任', direction: 'up', amount: 1, reason: '愿意讲自己的事' },
  ]
  const text = buildRelationBlock(DEFAULTS, s, { emotion: '好奇', intensity: 0.5, at: Date.now() })
  assert.ok(text.includes('眼熟'))
  assert.ok(text.includes('你'))
  assert.ok(text.includes('四级没复习'))
  assert.ok(text.includes('好奇'))
})
