/**
 * 存储层体检：serialize.ts 的排队语义 + fs.ts 的原子写 / JSONL 完整性。
 *
 * 全部在临时目录里跑，不碰 persona/ 下的真实数据。
 * 运行：node scripts/test-store-bugs.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJsonl, readJsonl, writeAtomic } from '../src/store/fs.ts'
import { drainWrites, serialized } from '../src/store/serialize.ts'

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

const dir = mkdtempSync(join(tmpdir(), 'qqbot-store-bugs-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------- 1. serialized：空队列同步、有队列按序 ---------- */
console.log('=== 1. serialized 顺序 ===')
{
  // 队列空：必须当场执行完，不能偷偷丢到微任务里（否则调用方紧接着读会读不到）
  const order: string[] = []
  serialized('order:empty', () => {
    order.push('empty')
  })
  check('队列空时同步执行', order.length === 1 && order[0] === 'empty', JSON.stringify(order))

  // 造一个真正在途的任务：异步 fn + 手动放行的闸门
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  serialized('order:queue', async () => {
    order.push('1:start')
    await gate
    order.push('1:end')
  })
  serialized('order:queue', () => {
    order.push('2')
  })
  serialized('order:queue', () => {
    order.push('3')
  })

  // 让出一轮微任务：后两个不能抢在第一个前面
  await Promise.resolve()
  check(
    '排队任务不会提前执行',
    order.join(',') === 'empty,1:start',
    JSON.stringify(order),
  )

  release()
  await drainWrites()
  check(
    '排队任务按提交顺序执行',
    order.join(',') === 'empty,1:start,1:end,2,3',
    JSON.stringify(order),
  )
}

/* ---------- 2. 第一个任务抛错，后面的还能跑 ---------- */
console.log('\n=== 2. 失败不卡队列 ===')
{
  const syncOrder: string[] = []
  let escaped = false
  try {
    serialized('throw:sync', () => {
      syncOrder.push('boom')
      throw new Error('同步炸了')
    })
  } catch {
    escaped = true
  }
  check('同步抛错不会炸到调用方', !escaped)
  serialized('throw:sync', () => {
    syncOrder.push('after')
  })
  check('同步抛错后后续任务仍执行', syncOrder.join(',') === 'boom,after', JSON.stringify(syncOrder))

  // 排队中的同步抛错：前面先挂一个异步任务把队列占住
  let release1!: () => void
  const gate1 = new Promise<void>((r) => {
    release1 = r
  })
  const q1: string[] = []
  serialized('throw:queued-sync', async () => {
    q1.push('block')
    await gate1
  })
  serialized('throw:queued-sync', () => {
    q1.push('boom')
    throw new Error('排队里炸了')
  })
  serialized('throw:queued-sync', () => {
    q1.push('after')
  })
  release1()
  await drainWrites()
  check('排队任务同步抛错不卡住后面', q1.join(',') === 'block,boom,after', JSON.stringify(q1))

  // 排队中的异步 reject：同样不能卡住后面
  let release2!: () => void
  const gate2 = new Promise<void>((r) => {
    release2 = r
  })
  const q2: string[] = []
  serialized('throw:queued-async', async () => {
    q2.push('1')
    await gate2
    throw new Error('异步炸了')
  })
  serialized('throw:queued-async', () => {
    q2.push('2')
  })
  serialized('throw:queued-async', () => {
    q2.push('3')
  })
  release2()
  await drainWrites()
  check('排队任务 reject 不卡住后面', q2.join(',') === '1,2,3', JSON.stringify(q2))
}

/* ---------- 3. drainWrites 等所有排队任务 ---------- */
console.log('\n=== 3. drainWrites ===')
{
  const events: number[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })

  serialized('drain:1', async () => {
    events.push(1)
    await gate
    events.push(2)
  })
  serialized('drain:1', async () => {
    events.push(3)
    // 在排队任务执行期间再挂一个：drain 也不能提前返回
    serialized('drain:1', async () => {
      await Promise.resolve()
      events.push(4)
    })
  })

  release()
  await drainWrites()
  check(
    'drainWrites 等所有排队任务（含等待期间新挂的）',
    events.join(',') === '1,2,3,4',
    JSON.stringify(events),
  )

  // 排空后再来一轮，确认 drain 不会把后续任务误清掉
  const later: number[] = []
  serialized('drain:2', async () => {
    await Promise.resolve()
    later.push(1)
  })
  await drainWrites()
  check('drainWrites 后再排队仍能执行', later.join(',') === '1', JSON.stringify(later))
}

/* ---------- 4. 并发写同一文件 ---------- */
console.log('\n=== 4. writeAtomic 并发 ===')
{
  const f = join(dir, 'concurrent.json')
  const payloads = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ i, body: `第 ${i} 份内容`.repeat(50) }),
  )

  let error: unknown = null
  try {
    await Promise.all(payloads.map((content) => Promise.resolve().then(() => writeAtomic(f, content))))
  } catch (e) {
    error = e
  }
  check('20 次并发写同一文件不抛错（无 ENOENT）', error === null, String(error))

  const raw = existsSync(f) ? readFileSync(f, 'utf8') : ''
  check('最后内容完整，等于 20 份中的某一整份', payloads.includes(raw), `实际长度 ${raw.length}`)

  let parsed: { i?: number } | null = null
  try {
    parsed = JSON.parse(raw) as { i?: number }
  } catch {
    /* ignore */
  }
  check('最后内容是合法 JSON', typeof parsed?.i === 'number', raw.slice(0, 80))

  const leftovers = readdirSync(dir).filter((n) => n.startsWith('concurrent.json.') && n.endsWith('.tmp'))
  check('并发写后没有残留 .tmp', leftovers.length === 0, leftovers.join(','))
}

/* ---------- 5. writeAtomic 失败不留 .tmp ---------- */
console.log('\n=== 5. writeAtomic 失败清理 ===')
{
  // 把目标路径先占成目录，rename 一定失败，但 .tmp 已经写出来了
  const target = join(dir, 'target-is-dir')
  mkdirSync(target, { recursive: true })

  let caught: unknown = null
  try {
    writeAtomic(target, '写不进去的内容')
  } catch (e) {
    caught = e
  }
  check('写失败会抛错，调用方能感知', caught !== null, String(caught))

  const leftovers = readdirSync(dir).filter((n) => n.startsWith('target-is-dir.') && n.endsWith('.tmp'))
  check('写失败后不留 .tmp', leftovers.length === 0, leftovers.join(','))
  check('失败后目标目录没被破坏', existsSync(target))
}

/* ---------- 6. appendJsonl 并发追加 ---------- */
console.log('\n=== 6. appendJsonl 并发追加 ===')
{
  const f = join(dir, 'append.jsonl')
  // 模拟上次崩在写一半：文件末尾是一条没有换行的半行
  writeFileSync(f, '{"seed":1}\n{"half":', 'utf8')

  const N = 50
  const rows = Array.from({ length: N }, (_, i) => ({ i, text: `第 ${i} 行`.repeat(20) }))
  let error: unknown = null
  try {
    await Promise.all(rows.map((row) => Promise.resolve().then(() => appendJsonl(f, row))))
  } catch (e) {
    error = e
  }
  check(`${N} 次并发追加不抛错`, error === null, String(error))

  const raw = readFileSync(f, 'utf8')
  const parsed = readJsonl<{ i?: number; seed?: number }>(f)
  const appended = parsed.filter((r) => typeof r.i === 'number')
  check(
    `${N} 行一条不少`,
    appended.length === N,
    `读到 ${appended.length} 行`,
  )
  check(
    '追加内容没有重复/错位',
    new Set(appended.map((r) => r.i)).size === N,
    `去重后 ${new Set(appended.map((r) => r.i)).size} 行`,
  )
  check('追加后文件以换行结尾', raw.endsWith('\n'))

  // 除了种子里的半行，不应再有任何解析不了的行（没有把新行粘在坏行上）
  const bad = raw
    .split('\n')
    .filter((line) => line.trim())
    .filter((line) => {
      try {
        JSON.parse(line)
        return false
      } catch {
        return true
      }
    })
  check('没有产生新的半行（只有种下的那条坏行）', bad.length === 1 && bad[0] === '{"half":', bad.join(' | '))
}

/* ---------- 7. 坏 JSONL 不废掉整份文件 ---------- */
console.log('\n=== 7. readJsonl 容错 ===')
{
  const f = join(dir, 'broken.jsonl')
  writeFileSync(
    f,
    ['{"ok":1}', '{"broken":', '这根本不是 JSON', '{"ok":2}', '{"ok":3}', '{"ok":4'].join('\n'),
    'utf8',
  )
  const rows = readJsonl<{ ok: number }>(f)
  check(
    '中间的半行/坏行不会废掉整份文件',
    rows.map((r) => r.ok).join(',') === '1,2,3',
    rows.map((r) => r.ok).join(','),
  )

  const allBad = join(dir, 'all-bad.jsonl')
  writeFileSync(allBad, '坏\n也坏\n', 'utf8')
  let badThrew = false
  let badRows: unknown[] = []
  try {
    badRows = readJsonl(allBad)
  } catch {
    badThrew = true
  }
  check('整份都是坏行时返回空数组而不是抛错', !badThrew && badRows.length === 0)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
