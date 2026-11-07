/**
 * 静态检查：前端引用的 DOM id 是否都存在、后端 API 与前端调用是否对得上。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const html = readFileSync('console/index.html', 'utf8')
// 匹配**所有**内联 <script> 块再拼起来。
// 之前是非贪婪的单个 match，只取到第一个块（页面头部的配置），
// 函数全在第三个块里，于是 5 个检查永远误报「缺少」。
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map((m) => m[1] ?? '')
  .join('\n')

/** 发现问题就 +1；脚本最后据此决定退出码。以前这里从不设非零退出码，
 * 而 check-all 只认最后那句「✓ 关键函数都在」—— 于是这项检查**永远通过**，
 * 不管前面报了多少 ❌。*/
let problems = 0

/* ---------- 1. DOM id 引用 ---------- */
const definedIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]!))
// 运行时动态创建的也要算：xx.id = 'foo'
for (const m of html.matchAll(/\.id\s*=\s*'([^']+)'/g)) definedIds.add(m[1]!)
for (const f of readdirSync('console').filter((n) => n.endsWith('.js'))) {
  const js = readFileSync(join('console', f), 'utf8')
  for (const m of js.matchAll(/\.id\s*=\s*'([^']+)'/g)) definedIds.add(m[1]!)
}
const usedIds = new Set(Array.from(script.matchAll(/\$\('([^']+)'\)/g)).map((m) => m[1]!))

const missing = [...usedIds].filter((id) => !definedIds.has(id))
console.log('=== DOM 引用检查 ===')
console.log(`定义 ${definedIds.size} 个 id，脚本引用 ${usedIds.size} 个`)
if (missing.length) {
  problems++
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
// 路由早就拆到 src/console/*-api.ts 了，只读 server.ts 会漏掉一大半，
// 于是一堆"前端调了不存在接口"的假阳性。全部扫一遍。
const apiDir = 'src/console'
const apiFiles = readdirSync(apiDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(apiDir, f))
const routes = new Set<string>()
/** 前缀路由（path.startsWith(...)），前端拼 id 的那种 */
const prefixes: string[] = []
for (const f of apiFiles) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/path === '(\/api\/[^']+)'/g)) routes.add(m[1]!)
  for (const m of src.matchAll(/path\.startsWith\('(\/api\/[^']+)'\)/g)) prefixes.push(m[1]!)
}
console.log('\n=== API 路由 ===')
console.log(`router 定义了 ${routes.size} 个（另有 ${prefixes.length} 个前缀路由）`)

// 前端调用的 api(...) / getData(...) / sendJson(...) 路径
const called = new Set(
  Array.from(script.matchAll(/(?:api|getData|sendJson)\(\s*'(\/api\/[^'?]+)/g)).map((m) => m[1]!),
)
// console/*.js 里那 40 来个调用以前从没被扫过（拆文件时留下的盲区）。
// 它们跟 index.html 用同一套后端，一起纳入检查。
const consoleJs = readdirSync('console').filter((f) => f.endsWith('.js'))
const jsScripts: Array<{ file: string; src: string }> = consoleJs.map((f) => ({
  file: `console/${f}`,
  src: readFileSync(join('console', f), 'utf8'),
}))
for (const { src } of jsScripts) {
  for (const m of src.matchAll(/'(\/api\/[^'?]+)'/g)) called.add(m[1]!.replace(/\/$/, ''))
}

/**
 * 精确命中，或者被前缀路由接住（如 /api/plugins/list）。
 * 另外前端有 '/api/self/requests/' + action 这种拼接写法：末尾带 / 时，
 * 只要后端有以它开头的路由就算对得上。
 */
const known = (p: string): boolean =>
  routes.has(p) ||
  prefixes.some((pre) => p.startsWith(pre)) ||
  (p.endsWith('/') && [...routes].some((r) => r.startsWith(p)))
const calledMissing = [...called].filter((p) => !known(p))
if (calledMissing.length) {
  problems++
  console.log('❌ 前端调了不存在接口：', calledMissing.join(', '))
} else {
  console.log('✓ 前端调用的接口都存在')
}

// 后端有但前端没用的
const unused = [...routes].filter((r) => r !== '/api/events' && ![...called].some((c) => c === r))
if (unused.length) console.log(`⚠ 后端有但前端没调：${unused.length} 个（多为面板/插件间接调用，仅供参考）`)

/* ---------- 2.5 HTTP 方法 ---------- */
// 只比对路径是不够的：曾经有个新设置漏写了 'PUT'（sendJson 默认 POST），
// 路径对得上、审计一直绿，但那个设置在界面上根本存不进去（404）。
// 这里把"后端只认 PUT、前端却按默认 POST 发"的调用挑出来。
const putOnly = new Set<string>()
const postOnly = new Set<string>()
for (const f of apiFiles) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/req\.method === '(PUT|POST)' && path === '(\/api\/[^']+)'/g)) {
    if (m[1] === 'PUT') putOnly.add(m[2]!)
    else postOnly.add(m[2]!)
  }
}
const badMethod: string[] = []
// 不能用简单的正则截参数：第二个参数里常常有 `x.trim()` 这种括号，
// 一旦按 `[^)]*` 截断，就会把后面真正的 'PUT' 一起截掉（假阳性）。
// 这里做一次括号配平扫描，取到完整的实参列表。
function scanSendJson(src: string, label: string): void {
  for (let i = src.indexOf("sendJson('"); i >= 0; i = src.indexOf("sendJson('", i + 1)) {
    const open = src.indexOf('(', i)
    if (open < 0) continue
    let depth = 0
    let end = -1
    for (let j = open; j < src.length; j++) {
      const ch = src[j]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end < 0) continue
    const call = src.slice(i, end + 1)
    const path = /^sendJson\(\s*'(\/api\/[^'?]+)'/.exec(call)?.[1]
    if (!path) continue
    const method = /,\s*'(PUT|POST|PATCH|DELETE)'\s*\)$/.exec(call)?.[1] ?? 'POST'
    if (putOnly.has(path) && !postOnly.has(path) && method !== 'PUT') {
      badMethod.push(`${path}（${label} 用了 ${method}，后端只认 PUT）`)
    }
  }
}
scanSendJson(script, 'index.html')
for (const { file, src } of jsScripts) scanSendJson(src, file)
console.log('\n=== HTTP 方法 ===')
if (badMethod.length) {
  problems++
  console.log('❌ 方法对不上（会被 404 或 405 挡掉）：')
  for (const b of [...new Set(badMethod)]) console.log('   ' + b)
} else {
  console.log(`✓ 写操作方法都对得上（index.html + ${jsScripts.length} 个 console/*.js）`)
}

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
      // 用真正的解析器，别用手写正则 —— `{}`、`[]`、块标量都是合法 YAML，
      // 正则版会把空对象判成"不像 yaml"，属于工具误报，不是数据坏了。
      const doc = parseYaml(text)
      // 解析成功即可；null 代表空文件，也算合法
      void doc
    }
  } catch (e) {
    bad++
    console.log(`❌ ${f}: ${String((e as Error).message).slice(0, 60)}`)
  }
}
if (!bad) console.log('✓ 所有 JSON/JSONL/YAML 都能解析')
else problems++

/* ---------- 4. self.md 结构 ---------- */
console.log('\n=== self.md 结构 ===')
try {
  const self = readFileSync('persona/self.md', 'utf8')
  const hasFront = /^---\r?\n[\s\S]*?\r?\n---/.test(self)
  const hasWho = self.includes('# 我是谁')
  const hasThink = self.includes('## 我最近在想')
  console.log(`frontmatter ${hasFront ? '✓' : '❌'} / 我是谁 ${hasWho ? '✓' : '❌'} / 我最近在想 ${hasThink ? '✓' : '❌'}`)
  if (!hasFront || !hasWho || !hasThink) problems++
  // 2026-11-01 起 self.md 不再存 traits（性格/喜好归角色卡），旧的 `我·xxx` 行可以忽略
  const oldTraits = Array.from(self.matchAll(/^我·([^:]+):\s*(.+)$/gm))
  if (oldTraits.length) console.log(`（旧格式特征 ${oldTraits.length} 条，已废弃，可忽略）`)
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
const okChecks = ['showGroup', 'runLoaders', 'doSearch', 'loadSelfV2', 'loadDashboard', 'loadHistory']
for (const n of okChecks) {
  if (!script.includes(n)) {
    problems++
    console.log(`❌ 缺少 ${n}`)
  }
}

// 结尾必须有**结论行**，而且它要反映真实结果。
// 以前这里无条件打印「✓ 关键函数都在」，check-all 又只匹配这句 ——
// 于是不管前面报了多少 ❌，这项检查永远"通过"。这类假绿比没有检查更危险：
// 它会让人以为控制台被验证过了。
if (problems) {
  console.log(`\n审计结果：发现 ${problems} 类问题`)
  process.exitCode = 1
} else {
  console.log('\n审计结果：OK')
}
