/**
 * 自我观察 / 意愿体检。
 *
 * 覆盖 observe.ts 的日志容错、问题筛选、待提队列，
 * 以及 will.ts 的过期判断、印象读写、坏文件回退。
 *
 * 全部在临时目录里跑（先 chdir 再动态 import），不碰真实的 data/logs 与 persona/。
 * 运行：node scripts/test-self-bugs.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Issue, StoredIssue } from '../src/self/observe.ts'
import type { WillState } from '../src/self/will.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'qqbot-self-bugs-'))
const originalCwd = process.cwd()
// 两个模块的路径都是相对 cwd 的（data/logs、persona/*），切到临时目录即可完全隔离。
process.chdir(root)
process.on('exit', () => {
  try {
    process.chdir(originalCwd)
  } catch {
    /* ignore */
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const { findIssues, loadIssueStore, markMentioned, unmentionedIssues } = await import('../src/self/observe.ts')
const { effectiveWill, impressionOf, loadWill, setImpression, willAgeHours } = await import('../src/self/will.ts')

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function logFile(): string {
  return join('data/logs', `${dayKey()}.jsonl`)
}

function writeLogLines(lines: string[]): void {
  mkdirSync('data/logs', { recursive: true })
  writeFileSync(logFile(), `${lines.join('\n')}\n`, 'utf8')
}

function writeLogs(records: Array<Record<string, unknown>>): void {
  writeLogLines(records.map((r) => JSON.stringify(r)))
}

function resetLogs(): void {
  rmSync('data/logs', { recursive: true, force: true })
}

function storedIssue(key: string, confidence: Issue['confidence'] = '确定'): StoredIssue {
  return {
    key,
    message: `消息 ${key}`,
    where: 'src/x.ts:1',
    level: 'warn',
    count: 2,
    firstAt: 1,
    lastAt: 2,
    confidence,
    samples: [],
    mentionedAt: 0,
  }
}

function resetIssueStore(items: StoredIssue[]): void {
  mkdirSync('persona', { recursive: true })
  writeFileSync('persona/issues.json', JSON.stringify({ at: Date.now(), items }, null, 2), 'utf8')
}

function willState(at: number, talk = false): WillState {
  return {
    at,
    talk,
    talkReason: talk ? '想说话' : '',
    watch: false,
    watchReason: '',
    impressions: {},
  }
}

function writeWill(w: WillState): void {
  mkdirSync('persona', { recursive: true })
  writeFileSync('persona/will.json', JSON.stringify(w, null, 2), 'utf8')
}

/* ---------- 1. 没有日志目录 ---------- */
console.log('=== 1. findIssues 没有日志目录 ===')
{
  resetLogs()
  let threw = false
  let issues: Issue[] = []
  try {
    issues = findIssues({ days: 1, minCount: 2 })
  } catch {
    threw = true
  }
  check('没有日志目录时返回空数组且不抛错', !threw && Array.isArray(issues) && issues.length === 0, String(issues))
}

/* ---------- 2. 坏 JSONL 行 ---------- */
console.log('\n=== 2. findIssues 坏 JSONL 容错 ===')
{
  const now = Date.now()
  writeLogLines([
    JSON.stringify({ ts: now, level: 'warn', msg: '好记录 A', extra: { where: 'src/a.ts:1' } }),
    '{"broken":',
    '这根本不是 JSON',
    'null',
    '[1,2,3]',
    '"只是一个字符串"',
    '123',
    JSON.stringify({ ts: now, level: 'warn', msg: '好记录 A', extra: { where: 'src/a.ts:1' } }),
    JSON.stringify({ ts: now, level: 'error', msg: '好记录 B', extra: { where: 'src/b.ts:2' } }),
  ])

  let threw = false
  let issues: Issue[] = []
  try {
    issues = findIssues({ days: 1, minCount: 1 })
  } catch {
    threw = true
  }
  const a = issues.find((i) => i.message === '好记录 A')
  const b = issues.find((i) => i.message === '好记录 B')
  check('坏行不抛错，好记录仍然解析出来', !threw && issues.length === 2, `抛错=${threw} 条数=${issues.length}`)
  check('坏行之间的重复记录仍能合并计数', a?.count === 2 && a?.where === 'src/a.ts:1', JSON.stringify(a))
  check('坏行之后的记录没被吞掉', b?.count === 1 && b?.where === 'src/b.ts:2', JSON.stringify(b))
}

/* ---------- 3. minCount 过滤 ---------- */
console.log('\n=== 3. findIssues minCount ===')
{
  writeLogs([{ ts: Date.now(), level: 'warn', msg: '只出现一次的警告', extra: { where: 'src/once.ts:9' } }])
  const issues = findIssues({ days: 1, minCount: 2 })
  check(
    '只出现 1 次的 warn 在 minCount=2 时不报',
    issues.length === 0,
    issues.map((i) => `${i.message}x${i.count}`).join(','),
  )
}

/* ---------- 4. 没有 where 的门槛 ---------- */
console.log('\n=== 4. findIssues 无 where 提高门槛 ===')
{
  const rec = (): Record<string, unknown> => ({ ts: Date.now(), level: 'warn', msg: '不知道在哪的警告' })

  writeLogs(Array.from({ length: 4 }, rec))
  const four = findIssues({ days: 1, minCount: 2 })
  check('没有 where 时出现 4 次仍不报（门槛 5）', four.length === 0, `报出 ${four.length} 条`)

  writeLogs(Array.from({ length: 5 }, rec))
  const five = findIssues({ days: 1, minCount: 2 })
  const hit = five.find((i) => i.message === '不知道在哪的警告')
  check('没有 where 时出现 5 次才报', hit?.count === 5, JSON.stringify(hit))
  check('没有 where 的条目置信度是「可能」', hit?.confidence === '可能', hit?.confidence)
}

/* ---------- 5. unmentionedIssues 的 slice(0,2) ---------- */
console.log('\n=== 5. unmentionedIssues 只取前 2 条 ===')
{
  resetIssueStore([storedIssue('a'), storedIssue('b'), storedIssue('c'), storedIssue('maybe', '可能')])
  const pending = unmentionedIssues()
  check(
    '3 条待提只返回前 2 条',
    pending.length === 2 && pending[0]?.key === 'a' && pending[1]?.key === 'b',
    pending.map((i) => i.key).join(','),
  )
  check('「可能」的条目不会被当成待提', !pending.some((i) => i.key === 'maybe'), pending.map((i) => i.key).join(','))
}

/* ---------- 6. markMentioned 全部标记后归零 ---------- */
console.log('\n=== 6. markMentioned 标记后归零 ===')
{
  resetIssueStore([storedIssue('a'), storedIssue('b'), storedIssue('c')])
  const before = unmentionedIssues().length
  const allKeys = loadIssueStore().items.map((i) => i.key)
  markMentioned(allKeys)
  const after = unmentionedIssues().length
  check(`标记全部之后待提归零（${before} → ${after}）`, before === 2 && after === 0, `${before} → ${after}`)
  check(
    'mentionedAt 已写入时间戳',
    loadIssueStore().items.every((i) => i.mentionedAt > 0),
    loadIssueStore()
      .items.map((i) => i.mentionedAt)
      .join(','),
  )
}

/* ---------- 7. willAgeHours(at=0) ---------- */
console.log('\n=== 7. willAgeHours 对 at=0 ===')
{
  const age = willAgeHours(willState(0))
  check('at=0 返回 Infinity', age === Number.POSITIVE_INFINITY, String(age))
}

/* ---------- 8. effectiveWill 超过 30 小时 ---------- */
console.log('\n=== 8. effectiveWill 过期 ===')
{
  writeWill(willState(Date.now() - 31 * 3_600_000, true))
  check('超过 30 小时返回 null', effectiveWill() === null, JSON.stringify(effectiveWill()))

  writeWill(willState(Date.now() - 29 * 3_600_000, true))
  check('未超过 30 小时仍能拿到', effectiveWill()?.talk === true, JSON.stringify(effectiveWill()))
}

/* ---------- 9. setImpression -> impressionOf ---------- */
console.log('\n=== 9. 印象写入后能读回 ===')
{
  rmSync(join('persona', 'people', 'u1'), { recursive: true, force: true })
  setImpression('u1', '说话很轻，喜欢猫')
  check('impressionOf 能读回刚写的印象', impressionOf('u1') === '说话很轻，喜欢猫', impressionOf('u1'))
  check('will.json 里也留了一份', loadWill().impressions.u1 === '说话很轻，喜欢猫', JSON.stringify(loadWill().impressions))
  check('impression.md 已生成', existsSync(join('persona', 'people', 'u1', 'impression.md')))
}

/* ---------- 10. loadWill 坏 JSON 回默认值 ---------- */
console.log('\n=== 10. loadWill 坏 JSON 回默认值 ===')
{
  mkdirSync('persona', { recursive: true })
  writeFileSync('persona/will.json', '{ 这不是合法 JSON', 'utf8')
  let threw = false
  let w = loadWill()
  try {
    w = loadWill()
  } catch {
    threw = true
  }
  check(
    '坏 JSON 返回默认值且不抛错',
    !threw && w.at === 0 && w.talk === false && w.watch === false && Object.keys(w.impressions).length === 0,
    JSON.stringify(w),
  )

  // 能解析但形状不对的 JSON（null / 数组）同样不能炸
  for (const bad of ['null', '[]', '"字符串"']) {
    writeFileSync('persona/will.json', bad, 'utf8')
    let badThrew = false
    let got: WillState | null = null
    try {
      got = loadWill()
    } catch {
      badThrew = true
    }
    check(
      `形状不对的 JSON（${bad}）也回默认值`,
      !badThrew && got?.at === 0 && Object.keys(got?.impressions ?? {}).length === 0,
      String(got),
    )
  }

  // 默认值之间不能共享同一个 impressions 对象
  writeFileSync('persona/will.json', 'bad', 'utf8')
  const w1 = loadWill()
  w1.impressions.leak = '不该漏到下一次'
  const w2 = loadWill()
  check('默认值的 impressions 不是共享对象', !('leak' in w2.impressions), JSON.stringify(w2.impressions))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
