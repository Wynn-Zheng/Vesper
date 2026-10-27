import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

/* ============ 1. 新模块 ============ */
console.log('=== 1. 新模块 ===')
for (const f of [
  'src/console/health.ts',
  'src/console/ability.ts',
  'src/console/member-api.ts',
  'src/console/settings-api.ts',
  'src/console/test-api.ts',
  'src/console/misc-api.ts',
  'src/memory/intent.ts',
  'src/tools/desktop.ts',
  'src/tools/desktop-log.ts',
  'src/tools/desktop-pending.ts',
  'electron/main.js',
  'console/members.js',
  'console/settings.js',
  'console/test.js',
]) {
  check(f, existsSync(f), '')
}

/* ============ 2. 路由一致性 ============ */
console.log('\n=== 2. 路由一致性 ===')
const html = readFileSync('console/index.html', 'utf8')
const groupsM = /const GROUPS = \{([\s\S]*?)\n\}/.exec(html)
const views: string[] = []
if (groupsM) {
  for (const m of groupsM[1]!.matchAll(/\['(v-[\w-]+)'/g)) views.push(m[1]!)
}
check(`GROUPS 里有 ${views.length} 个 view`, views.length > 0, '')

for (const v of views) check(`section ${v}`, html.includes(`id="${v}"`), '')

// 静态页（不需要 loader）
const STATIC = new Set(['v-try'])
const runM = /function runLoaders\(viewId\) \{([\s\S]*?)\n\}/.exec(html)
const body = runM ? runM[1]! : ''
const missing = views.filter((v) => !body.includes(`'${v}'`) && !STATIC.has(v))
check(`runLoaders 覆盖（缺 ${missing.length ? missing.join(',') : '无'}）`, missing.length === 0, missing.join(','))

/* ============ 3. 所有 API 在 token 之后 ============ */
console.log('\n=== 3. API 保护 ===')
// 把所有 console 的 ts 拼起来找 token 校验位置
const srv = readFileSync('src/console/server.ts', 'utf8')
const iToken = srv.indexOf('token 不对')

const allApiFiles = readdirSync('src/console')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(`src/console/${f}`, 'utf8'))
  .join('\n')

for (const api of ['/api/health', '/api/ability', '/api/member/table', '/api/self/v2', '/api/test/tools', '/api/settings/data', '/api/napcat', '/api/balance']) {
  check(`${api} 有实现`, allApiFiles.includes(api), '')
}

// 挂载顺序：所有 handleXxxApi 都在 token 校验之后
const iMount = srv.indexOf('handleMemberApi(req')
check(
  '子模块挂载在 token 之后',
  iMount > iToken && iToken > 0,
  `mount@${iMount} token@${iToken}`,
)

/* ============ 4. 静态路由 ============ */
console.log('\n=== 4. 静态路由 ===')
check('只允许 .js/.css', srv.includes('(js|css)'), '')
// 静态文件根目录改成 staticRoot() 了（打包后 cwd 不是项目根），
// 但目录穿越检查必须还在：拼出来的路径要以根目录开头
check('目录穿越检查', srv.includes('startsWith(root)') && srv.includes('function staticRoot'), '')
check('在 token 之前', srv.indexOf('(js|css)') < iToken, '')

/* ============ 5. 前端 onclick ============ */
console.log('\n=== 5. 全局函数 ===')
const jsFiles = readdirSync('console').filter((f) => f.endsWith('.js'))
const allJs = jsFiles.map((f) => readFileSync(`console/${f}`, 'utf8')).join('\n') + html

const called = new Set<string>()
for (const m of html.matchAll(/on(?:click|input|change)="([\w.]+)\(/g)) called.add(m[1]!)
const undef: string[] = []
for (const fn of called) {
  const ok =
    new RegExp(`function\\s+${fn}\\s*\\(`).test(allJs) ||
    new RegExp(`window\\.${fn}\\s*=`).test(allJs) ||
    new RegExp(`const\\s+${fn}\\s*=`).test(allJs)
  if (!ok) undef.push(fn)
}
check(`onclick 都有定义（${called.size} 个，缺 ${undef.length ? undef.join(',') : '无'}）`, undef.length === 0, undef.join(','))

/* ============ 6. 每个 js 文件都有 IIFE 或"挂到 window" ============ */
console.log('\n=== 6. 前端模块形式 ===')
for (const f of jsFiles) {
  const c = readFileSync(`console/${f}`, 'utf8')
  check(`${f} 有 window.xxx 暴露`, /window\.\w+\s*=/.test(c), '')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
