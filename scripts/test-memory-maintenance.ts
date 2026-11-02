/**
 * 记忆层的"别无限涨"部分：insights 去重/上限、episodes 缓存、raw 清理。
 *
 * 对应 （内部交接文档，未公开） §5.6 / §5.8 / §5.7。
 * 全部在临时目录里跑，不碰 data/ 和 persona/。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Episode, Insight } from '../src/memory/types.ts'

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

const root = mkdtempSync(join(tmpdir(), 'qqbot-mem-maint-'))

const store = await import('../src/memory/store.ts')
const { setPeopleRoot } = await import('../src/people/store.ts')
const open = await import('../src/people/open.ts')
store.setMemoryRoot(root)
// open.md 走 peopleRoot，不设的话会写到真实的 persona/people 里
setPeopleRoot(join(root, 'people'))

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 生成互不相同的字符串：带随机段，保证相似度远低于去重阈值 */
function distinctText(i: number): string {
  return `${i}：${randomUUID().slice(0, 8)}${randomUUID().slice(0, 8)}，这件事我记着`
}

function insight(i: number): Insight {
  return { id: `2026-10-28-${i}`, date: '2026-10-28', scope: 'shared', text: distinctText(i), evidence: [] }
}

/* ---------------- 1. insights 去重 ---------------- */

console.log('=== 1. insights 去重 ===')
{
  const a = insight(1)
  store.appendInsights([a])
  store.appendInsights([a])
  check('完全相同的洞察只留一条', store.loadInsights().length === 1, `实际 ${store.loadInsights().length}`)

  store.appendInsights([{ ...a, id: 'dup-2', text: `${a.text.slice(0, 22)}xx` }])
  check('差一点点的也算重复（不再占检索名额）', store.loadInsights().length === 1, `实际 ${store.loadInsights().length}`)

  store.appendInsights([insight(2)])
  check('真正不同的洞察能写进来', store.loadInsights().length === 2, `实际 ${store.loadInsights().length}`)

  store.appendInsights([{ ...insight(3), text: '   ' }])
  check('空文本不写', store.loadInsights().length === 2, `实际 ${store.loadInsights().length}`)
}

/* ---------------- 2. insights 上限 ---------------- */

console.log('\n=== 2. insights 上限 ===')
{
  const batch: Insight[] = []
  for (let i = 100; i < 610; i++) batch.push(insight(i))
  store.appendInsights(batch)
  const all = store.loadInsights()
  check('总数被限制在 500 条', all.length === 500, `实际 ${all.length}`)
  check('保留的是最新的（末尾是刚写的）', all[all.length - 1]!.id === '2026-10-28-609', all[all.length - 1]!.id)
}

/* ---------------- 3. episodes 缓存 ---------------- */

console.log('\n=== 3. episodes 缓存 ===')
{
  const ep = (id: string, title: string): Episode => ({
    id,
    date: '2026-10-28',
    scope: 'private:10001',
    importance: 5,
    title,
    body: '正文',
  })

  store.saveEpisode(ep('2026-10-28-01', '第一件'))
  check('新写的能立刻读到', store.loadEpisodes().some((e) => e.title === '第一件'))

  // 返回的是拷贝：调用方改它不该污染缓存（recall 会改 lastRecalled）
  const first = store.loadEpisodes()
  const hit = first.find((e) => e.title === '第一件')!
  hit.title = '被改坏了'
  check('调用方修改不影响下一次读取', store.loadEpisodes().some((e) => e.title === '第一件'))

  store.saveEpisode(ep('2026-10-28-02', '第二件'))
  check('再写一条，缓存自动失效后能看到两条', store.loadEpisodes().filter((e) => e.scope === 'private:10001').length === 2)

  store.deleteEpisode('2026-10-28-01', 'private:10001')
  check('删掉后立刻不可见（缓存已失效）', !store.loadEpisodes().some((e) => e.title === '第一件'))
}

/* ---------------- 4. raw 清理 ---------------- */

console.log('\n=== 4. raw 清理 ===')
{
  const rawDir = join(root, 'raw')
  mkdirSync(rawDir, { recursive: true })
  check('memoryRoot 指向临时目录', store.memoryRoot() === root)

  const day = (offset: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const mk = (offset: number): string => {
    const name = `${day(offset)}.jsonl`
    writeFileSync(join(rawDir, name), `${JSON.stringify({ ts: 1, scope: 'shared', role: 'user', text: 'x' })}\n`)
    return name
  }

  mk(40)
  mk(36)
  mk(20)
  mk(0)
  const removed = store.pruneRaw(35)
  const left = readdirSync(rawDir)
  check('超过 35 天的删掉', removed === 2, `删了 ${removed} 个`)
  check('40 天前的不在了', !left.includes(`${day(40)}.jsonl`))
  check('最近 20 天和今天的还在', left.includes(`${day(20)}.jsonl`) && left.includes(`${day(0)}.jsonl`))
  check('非日期文件名不误删', (() => {
    writeFileSync(join(rawDir, 'notes.txt'), 'x')
    store.pruneRaw(35)
    return readdirSync(rawDir).includes('notes.txt')
  })())
}

/* ---------------- 5. open.md 去重 ---------------- */

console.log('\n=== 5. open.md 去重 ===')
{
  const pid = 'qq-40001'
  open.appendOpen(pid, [{ text: '想问问他「他家里的事」能不能提', date: '2026-10-01', kind: 'pending' }])
  open.appendOpen(pid, [{ text: '想问问他「他家里的事」能不能提', date: '2026-10-02', kind: 'pending' }])
  check('完全相同的待办只留一条', open.loadOpen(pid).length === 1, `实际 ${open.loadOpen(pid).length}`)

  open.appendOpen(pid, [{ text: '想问问他「他家里的事」能不能提。', date: '2026-10-03', kind: 'pending' }])
  check('几乎同一句（相似度>0.9）也不重复', open.loadOpen(pid).length === 1, `实际 ${open.loadOpen(pid).length}`)

  open.appendOpen(pid, [{ text: '他答应下周把书还我', date: '2026-10-03', kind: 'todo' }])
  check('不同的事能正常追加', open.loadOpen(pid).length === 2, `实际 ${open.loadOpen(pid).length}`)

  check('文件头只出现一次（没重复写标题）', (() => {
    const text = readFileSync(open.openFilePath(pid), 'utf8')
    return (text.match(/^# 还没做完/gm) ?? []).length === 1
  })())
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
