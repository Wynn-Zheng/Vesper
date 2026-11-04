import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDate, localMinute } from '../src/core/time.ts'

test('本地时间格式化与 Date.parse 对称：往返不差 8 小时', () => {
  const ts = Date.parse('2026-11-04T23:50:00')
  const s = localMinute(ts)
  assert.equal(s, '2026-11-04 23:50')
  // 以前用 toISOString() 写、按本地解析，往返一次就变成次日 07:50
  assert.equal(Date.parse(s.replace(' ', 'T')), ts)
})

test('凌晨 0-8 点不会被记成前一天', () => {
  const ts = Date.parse('2026-11-04T00:30:00')
  assert.equal(localDate(ts), '2026-11-04')
  assert.equal(localMinute(ts), '2026-11-04 00:30')
})

test('个位月/日/时分补零', () => {
  const ts = Date.parse('2026-01-02T03:04:00')
  assert.equal(localMinute(ts), '2026-01-02 03:04')
})
