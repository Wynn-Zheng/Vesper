import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendJsonl, readJsonl, writeAtomic } from '../src/store/fs.ts'

const dir = mkdtempSync(join(tmpdir(), 'qqbot-fs-'))

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('原子写：内容和编码都对', () => {
  const f = join(dir, 'a.txt')
  writeAtomic(f, '中文内容\n第二行')
  assert.equal(readFileSync(f, 'utf8'), '中文内容\n第二行')
})

test('原子写：不留临时文件', () => {
  const f = join(dir, 'b.txt')
  writeAtomic(f, 'x')
  const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  assert.equal(leftovers.length, 0, `不该留下临时文件：${leftovers.join(',')}`)
})

test('原子写：连续写同一文件不会打架', () => {
  const f = join(dir, 'c.json')
  for (let i = 0; i < 20; i++) writeAtomic(f, JSON.stringify({ i }))
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { i: 19 })
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0)
})

test('原子写：并发写同一文件不抛错', async () => {
  const f = join(dir, 'd.txt')
  // 同步 API 不会真并发，但能验证临时文件名唯一——不会互相覆盖到 ENOENT
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        writeAtomic(f, `内容${i}`)
        return true
      }),
    ),
  )
  assert.ok(results.every(Boolean))
  assert.ok(existsSync(f))
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0)
})

test('jsonl：追加和读回', () => {
  const f = join(dir, 'e.jsonl')
  appendJsonl(f, { a: 1 })
  appendJsonl(f, { a: 2 })
  const rows = readJsonl<{ a: number }>(f)
  assert.equal(rows.length, 2)
  assert.equal(rows[1]!.a, 2)
})

test('jsonl：坏行跳过，不废掉整份文件', () => {
  const f = join(dir, 'f.jsonl')
  appendJsonl(f, { ok: 1 })
  // 手动塞一行坏的
  const raw = readFileSync(f, 'utf8')
  writeAtomic(f, `${raw}{坏行\n`)
  appendJsonl(f, { ok: 2 })
  const rows = readJsonl<{ ok: number }>(f)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.ok, 1)
  assert.equal(rows[1]!.ok, 2)
})

test('jsonl：文件不存在返回空数组', () => {
  assert.deepEqual(readJsonl(join(dir, '不存在.jsonl')), [])
})
