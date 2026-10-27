/**
 * 插件控制台前端自检：node scripts/selfcheck-console-plugins.ts
 *
 * 只读取 console/index.html 和 console/plugins.js 的文本做断言，
 * 不启动服务、不访问网络。
 */
import { readFileSync } from 'node:fs'

const missing: string[] = []

/** 读文本；读不到也记成一条缺失项，不直接抛栈 */
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    missing.push(`读不到 ${path}：${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

const html = read('console/index.html')
const js = read('console/plugins.js')

function must(name: string, ok: boolean): void {
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  missing.push(name)
  console.log(`✗ ${name}`)
}

/* ============ 1. index.html 的挂载点和脚本引用 ============ */
must("index.html 含 'plugins-panel'", html.includes('plugins-panel'))
must("index.html 含 'plugins.js'", html.includes('plugins.js'))

/* ============ 2. plugins.js 必须覆盖的接口 ============ */
for (const endpoint of [
  '/api/plugins/list',
  '/api/plugins/install',
  '/api/plugins/uninstall',
  '/api/plugins/toggle',
  '/api/plugins/updates',
]) {
  must(`plugins.js 含 '${endpoint}'`, js.includes(endpoint))
}

/* ============ 3. 禁止外链和占位 ============ */
for (const banned of ['http://', 'https://', 'TODO']) {
  must(`plugins.js 不含 '${banned}'`, !js.includes(banned))
}

/* ============ 结果 ============ */
if (missing.length > 0) {
  console.log('\n缺失项：')
  for (const item of missing) console.log(`- ${item}`)
  process.exit(1)
}

console.log('\n全部通过')
process.exit(0)
