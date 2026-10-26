/**
 * 资源增长检查：跑久了会不会把磁盘/上下文撑爆。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

function size(p: string): number {
  try {
    const s = statSync(p)
    if (s.isFile()) return s.size
    let total = 0
    for (const e of readdirSync(p, { withFileTypes: true })) total += size(join(p, e.name))
    return total
  } catch {
    return 0
  }
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`
}

console.log('=== 磁盘占用 ===')
const targets: Array<[string, number]> = [
  ['persona', 5 * 1024 * 1024],
  ['persona/memory/raw', 2 * 1024 * 1024],
  ['persona/memory/episodes', 1024 * 1024],
  ['persona/self-history', 512 * 1024],
  ['persona/outward', 256 * 1024],
  ['persona/people', 2 * 1024 * 1024],
  ['data/logs', 20 * 1024 * 1024],
  ['data/versions', 50 * 1024 * 1024],
]

for (const [p, limit] of targets) {
  const s = size(p)
  check(`${p}  ${kb(s)}`, s < limit, `超过 ${kb(limit)}`)
}

console.log('\n=== 单文件增长 ===')
const single: Array<[string, number]> = [
  ['persona/self.md', 8 * 1024],
  ['persona/life.md', 20 * 1024],
  ['persona/will.json', 8 * 1024],
  ['persona/issues.json', 64 * 1024],
  ['persona/outward/watched.json', 128 * 1024],
  ['persona/rules.yaml', 32 * 1024],
]
for (const [p, limit] of single) {
  const s = existsSync(p) ? size(p) : 0
  check(`${p}  ${kb(s)}`, s < limit, `超过 ${kb(limit)}`)
}

/* ---------- prompt 长度 ---------- */
console.log('\n=== prompt 长度 ===')
{
  const { buildSelfBlock } = await import('../src/self/format.ts')
  const { loadRules } = await import('../src/core/config.ts')
  const rules = loadRules().rules
  const self = buildSelfBlock(rules, new Date(), 'qq-1234567890', '主人')
  check(`selfBlock ${self.length} 字（应 < 3000）`, self.length < 3000, `${self.length}`)

  // 看看里面有啥
  const lines = self.split('\n').filter(Boolean)
  console.log(`   共 ${lines.length} 行，前几行：`)
  for (const l of lines.slice(0, 6)) console.log(`     ${l.slice(0, 70)}`)
}

/* ---------- 记忆条数 ---------- */
console.log('\n=== 记忆规模 ===')
{
  const { loadFacts } = await import('../src/memory/facts.ts')
  const { loadEpisodes } = await import('../src/memory/store.ts')
  const { loadOpen } = await import('../src/people/open.ts')
  const { listPeople } = await import('../src/people/store.ts')

  let totalFacts = 0
  let totalOpen = 0
  for (const p of listPeople()) {
    const f = loadFacts(p.id).length
    const o = loadOpen(p.id).length
    totalFacts += f
    totalOpen += o
    if (f > 100) check(`${p.name} 事实 ${f} 条（超过 100，可能该清理）`, false)
    if (o > 50) check(`${p.name} 待办 ${o} 条（超过 50）`, false)
  }
  const eps = loadEpisodes().length
  check(`事实共 ${totalFacts} 条`, totalFacts < 500, `${totalFacts}`)
  check(`待办共 ${totalOpen} 条`, totalOpen < 200, `${totalOpen}`)
  check(`经历共 ${eps} 段`, eps < 500, `${eps}`)
  console.log(`   （${listPeople().length} 个人）`)
}

/* ---------- 日志行数 ---------- */
console.log('\n=== 日志 ===')
{
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const f = `data/logs/${key}.jsonl`
  if (existsSync(f)) {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).length
    check(`今天日志 ${lines} 行`, lines < 50000, `${lines}`)
    // warn/error 占比
    const all = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    const bad = all.filter((l) => /"level":"(warn|error)"/.test(l)).length
    console.log(`   其中 warn/error ${bad} 行（${((bad / all.length) * 100).toFixed(1)}%）`)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
