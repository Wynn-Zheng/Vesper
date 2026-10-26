/**
 * 静态检查：前端引用的 DOM id 是否都存在、后端 API 与前端调用是否对得上。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync('console/index.html', 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

/* ---------- 1. DOM id 引用 ---------- */
const definedIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]!))
// 动态创建的也算（el('div',...,...) 里没有 id；但 querySelector 用的要算）
const usedIds = new Set(Array.from(script.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1]!))

const missing = [...usedIds].filter((id) => !definedIds.has(id))
console.log('=== DOM 引用检查 ===')
console.log(`定义 ${definedIds.size} 个 id，脚本引用 ${usedIds.size} 个`)
if (missing.length) {
  console.log('❌ 引用了不存在的 id：')
  for (const id of missing) {
    // 找出在哪个函数里
    const idx = script.indexOf(`$('${id}')`)
    const before = script.slice(0, idx)
    const fn = before.lastIndexOf('function ')
    const fnName = fn >= 0 ? before.slice(fn, before.indexOf('(', fn)).replace('function ', '').trim() : '?'
    console.log(`   ${id}  （在 ${fnName || '顶层'} 里）`)
  }
} else {
  console.log('✓ 全部存在')
}

/* ---------- 2. 后端 API 路由 ---------- */
const serverSrc = readFileSync('src/console/server.ts', 'utf8')
const routes = new Set(Array.from(serverSrc.matchAll(/path === '([^']+)'/g)).map((m) => m[1]!))
console.log('\n=== API 路由 ===')
console.log(`router 定义了 ${routes.size} 个`)

// 前端调用的 api(...) 路径
const called = new Set(
  Array.from(script.matchAll(/api\('([^'?]+)/g)).map((m) => m[1]!),
)
const calledMissing = [...called].filter((p) => !routes.has(p))
if (calledMissing.length) {
  console.log('❌ 前端调了不存在接口：', calledMissing.join(', '))
} else {
  console.log('✓ 前端调用的接口都存在')
}

// 后端有但前端没用的
const unused = [...routes].filter((r) => r !== '/api/events' && ![...called].some((c) => c === r))
if (unused.length) console.log(`⚠ 后端有但前端没调：${unused.join(', ')}`)

/* ---------- 3. 数据文件格式 ---------- */
console.log('\n=== 数据文件 ===')
function walk(dir: string, out: string[] = []): string[] {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else out.push(p)
    }
  } catch {
    /* 目录不存在 */
  }
  return out
}

const personaFiles = walk('persona')
console.log(`persona/ 下 ${personaFiles.length} 个文件`)

// JSON / JSONL / YAML 能不能解析
let bad = 0
for (const f of personaFiles) {
  if (f.includes('node_modules')) continue
  try {
    const text = readFileSync(f, 'utf8')
    if (f.endsWith('.json') || f.endsWith('.jsonl')) {
      if (f.endsWith('.jsonl')) {
        for (const line of text.split('\n')) {
          if (line.trim()) JSON.parse(line)
        }
      } else {
        JSON.parse(text)
      }
    }
    if (f.endsWith('.yaml')) {
      // 粗略：每行要么空、要么注释、要么 key: value 或 列表项
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#') || t.startsWith('-')) continue
        if (!/^[\p{L}\p{N}_·「」()（）、。：: -]+[:：]/.test(t) && !t.endsWith(':') && !t.includes(':')) {
          throw new Error(`第 ${text.split('\n').indexOf(line) + 1} 行不像 yaml: ${t.slice(0, 40)}`)
        }
      }
    }
  } catch (e) {
    bad++
    console.log(`❌ ${f}: ${String((e as Error).message).slice(0, 60)}`)
  }
}
if (!bad) console.log('✓ 所有 JSON/JSONL/YAML 都能解析')

/* ---------- 4. self.md 结构 ---------- */
console.log('\n=== self.md 结构 ===')
try {
  const self = readFileSync('persona/self.md', 'utf8')
  const hasFront = /^---\r?\n[\s\S]*?\r?\n---/.test(self)
  const hasWho = self.includes('# 我是谁')
  const hasThink = self.includes('## 我最近在想')
  console.log(`frontmatter ${hasFront ? '✓' : '❌'} / 我是谁 ${hasWho ? '✓' : '❌'} / 我最近在想 ${hasThink ? '✓' : '❌'}`)
  const traits = Array.from(self.matchAll(/^我·([^:]+):\s*(.+)$/gm))
  console.log(`特征 ${traits.length} 条：${traits.map((m) => `${m[1]}=${m[2]}`).join(', ')}`)
  const longTrait = traits.find((m) => m[1]!.trim().length > 12 || m[2]!.trim().length > 40)
  if (longTrait) console.log(`⚠ 超长特征：${longTrait[0]}`)
} catch {
  console.log('（没有 self.md）')
}

/* ---------- 5. 历史版本数量 ---------- */
console.log('\n=== self-history ===')
try {
  const hist = readdirSync('persona/self-history').filter((n) => n.endsWith('.md'))
  const drifts = readFileSync('persona/self-history/drift.jsonl', 'utf8').split('\n').filter((l) => l.trim()).length
  console.log(`历史 ${hist.length} 份（上限 60）· 漂移记录 ${drifts} 条`)
  if (hist.length > 55) console.log('⚠ 快满了')
} catch {
  console.log('（没有历史）')
}

/* ---------- 6. 检查有没有残留的旧引用 ---------- */
console.log('\n=== 已删除功能的残留引用 ===')
const deadNames = ['loadOverview', 'renderRelation', 'titles[']
for (const n of deadNames) {
  if (script.includes(n)) console.log(`⚠ 还有 ${n}`)
}
const okChecks = ['showGroup', 'runLoaders', 'loadState', 'loadTrend', 'renderSched', 'doSearch', 'renderPicker']
for (const n of okChecks) {
  if (!script.includes(n)) console.log(`❌ 缺少 ${n}`)
}
console.log('✓ 关键函数都在')
