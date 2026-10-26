/**
 * session 摘要字段与持久化兼容的自测。
 * 跑法：node scripts/test-session-summary.ts
 * 退出码 0 = 全过，非 0 = 有失败。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSessions,
  getSession,
  getSummary,
  loadSession,
  saveSession,
  sessionPath,
  setSessionRoot,
  setSummary,
} from '../src/loop/session.ts'

const root = mkdtempSync(join(tmpdir(), 'qqbot-session-'))
const sessionsDir = join(root, 'sessions')
mkdirSync(sessionsDir, { recursive: true })
setSessionRoot(sessionsDir)

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let pass = 0
let fail = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`√ ${name}`)
  } catch (e) {
    fail++
    console.log(`× ${name}`)
    console.log(`    ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

/* ---------- 1. 新会话的默认值 ---------- */

check('新会话：摘要字段都是默认值', () => {
  const s = loadSession('private:9001')
  assert.equal(s.key, 'private:9001')
  assert.deepEqual(s.turns, [])
  assert.equal(s.summary, '')
  assert.equal(s.summaryUpdatedAt, 0)
  assert.equal(s.summaryCursor, 0)
  assert.deepEqual(getSummary(s), { summary: '', summaryCursor: 0 })
})

/* ---------- 2. setSummary 写盘后读回一致 ---------- */

check('setSummary：更新三个字段并写回磁盘', () => {
  const s = loadSession('private:9001')
  const before = Date.now()
  setSummary(s, '对方在准备复试，有点慌', 7)
  const after = Date.now()

  assert.equal(s.summary, '对方在准备复试，有点慌')
  assert.equal(s.summaryCursor, 7)
  assert.ok(s.summaryUpdatedAt >= before && s.summaryUpdatedAt <= after, 'summaryUpdatedAt 应该是当前毫秒')

  const back = loadSession('private:9001')
  assert.deepEqual(getSummary(back), { summary: '对方在准备复试，有点慌', summaryCursor: 7 })
  assert.equal(back.summaryUpdatedAt, s.summaryUpdatedAt)
  assert.ok(existsSync(sessionPath('private:9001')), '应该真的落盘了')
})

check('getSession：内存清空后还能从磁盘取回摘要', () => {
  clearSessions()
  const s = getSession('private:9001')
  assert.deepEqual(getSummary(s), { summary: '对方在准备复试，有点慌', summaryCursor: 7 })
})

/* ---------- 3. 旧格式向后兼容 ---------- */

const oldFile = sessionPath('group:9002')
const oldTurns = [
  { role: 'user', content: '旧消息', at: 123 },
  { role: 'assistant', content: '旧回复', at: 456 },
]

writeFileSync(
  oldFile,
  JSON.stringify(
    {
      key: 'group:9002',
      title: '',
      turns: oldTurns,
      createdAt: 111,
    },
    null,
    2,
  ),
  'utf8',
)

check('旧格式：没有摘要字段也能读，自动补默认值', () => {
  const s = loadSession('group:9002')
  assert.equal(s.summary, '')
  assert.equal(s.summaryUpdatedAt, 0)
  assert.equal(s.summaryCursor, 0)
  assert.equal(s['title'], '', '空标题也要保留')
  assert.equal(s['createdAt'], 111, '未知旧字段不能丢')
  assert.deepEqual(s.turns, oldTurns)
})

check('坏 JSON：读失败不抛错，返回默认会话', () => {
  const file = sessionPath('group:9003')
  writeFileSync(file, '{这不是 JSON', 'utf8')
  const s = loadSession('group:9003')
  assert.equal(s.summary, '')
  assert.equal(s.summaryUpdatedAt, 0)
  assert.equal(s.summaryCursor, 0)
  assert.deepEqual(s.turns, [])
})

/* ---------- 4. 写回保留旧字段、字段顺序稳定 ---------- */

check('写回：原有字段不丢，字段顺序稳定', () => {
  const s = loadSession('group:9002')
  setSummary(s, '群里聊了旧话题', 2)

  const first = JSON.parse(readFileSync(oldFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(first).slice(0, 5), [
    'key',
    'turns',
    'summary',
    'summaryUpdatedAt',
    'summaryCursor',
  ])
  assert.equal(first['title'], '')
  assert.equal(first['createdAt'], 111)
  assert.deepEqual(first['turns'], oldTurns)
  assert.equal(first['summary'], '群里聊了旧话题')
  assert.equal(first['summaryCursor'], 2)

  // 再写一次，字段顺序和内容都应该完全一样
  saveSession(s)
  const second = JSON.parse(readFileSync(oldFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(second), Object.keys(first))
  assert.deepEqual(second, first)
})

/* ---------- 汇总 ---------- */

console.log('')
if (fail > 0) {
  console.log(`失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(1)
}
console.log(`全部通过：${pass} 项`)
