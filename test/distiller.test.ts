import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldDistill } from '../src/scheduler/distiller.ts'
import type { RawTurn } from '../src/memory/types.ts'

const turns = (n: number): RawTurn[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: Date.now() - (n - i) * 1000,
    scope: 'private:1' as const,
    role: 'user' as const,
    text: `m${i}`,
  }))

test('没有新消息就不整理', () => {
  assert.equal(shouldDistill([], 0), false)
})

test('攒够 minTurns 就整理', () => {
  assert.equal(shouldDistill(turns(20), Date.now(), Date.now(), 20), true)
  assert.equal(shouldDistill(turns(19), Date.now(), Date.now(), 20), false)
})

test('攒不够但超过一天，也会整理（防止长期不触发）', () => {
  const dayAgo = Date.now() - 25 * 3600_000
  assert.equal(shouldDistill(turns(5), dayAgo, Date.now(), 20), true)
})

test('攒不够、也不满一天，就不动', () => {
  const hourAgo = Date.now() - 3600_000
  assert.equal(shouldDistill(turns(5), hourAgo, Date.now(), 20), false)
})

test('首次运行（lastAt=0）不会因为时间条件误触发', () => {
  assert.equal(shouldDistill(turns(3), 0, Date.now(), 20), false)
})
