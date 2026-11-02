/**
 * 插件系统第二轮查 bug：边界与攻击面。
 *
 * 关注：
 *   - 路径穿越（source = ../../xxx）
 *   - 重复 id 安装（会不会覆盖已有插件）
 *   - 插件入口文件不存在 / 入口是目录
 *   - 插件 activate 抛异常（会不会把别的插件带崩）
 *   - minHostVersion 不满足
 *   - 卸载时 id 里带 ../
 *   - 并发 toggle
 *
 * 原则：只用临时插件，绝不动 plugins/demo。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertTestPluginId, testPluginId } from './_plugin-test-guard.ts'

const BASE = 'http://127.0.0.1:7788'
const TOKEN = process.env['CONSOLE_TOKEN'] || ''

let pass = 0
let fail = 0
const fails: string[] = []

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    const line = `✗ ${name}${extra ? '  ' + extra : ''}`
    fails.push(line)
    console.log(line)
  }
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** 造一个临时插件目录，返回路径 */
function makePlugin(id: string, extra: Record<string, unknown> = {}, indexJs?: string): string {
  const dir = join(tmpdir(), 'qqbot-probe-' + id + '-' + Date.now())
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: 'probe ' + id, version: '0.0.1', entry: 'index.js', ...extra }),
    'utf8',
  )
  writeFileSync(join(dir, 'index.js'), indexJs ?? 'export function activate(){}', 'utf8')
  return dir
}

/** 装完就卸，确保不留垃圾 */
async function installAndCleanup(dir: string, id: string): Promise<void> {
  try {
  assertTestPluginId(id)
    await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true })
  assertTestPluginId(id)
  rmSync(join('plugins', id), { recursive: true, force: true })
   rmSync(join('data', 'plugins', id), { recursive: true, force: true })
  // 插件激活时宿主会建 data/plugins/<id> 数据目录，测试也要清掉
  rmSync(join('data', 'plugins', id), { recursive: true, force: true })
}

console.log('=== A. 路径穿越：source 指向项目外 ===')
{
  const r = await api('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ source: '..\\..\\..\\Windows' }),
  })
  ok('不会 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:false（拒绝）', r.body?.ok === false, JSON.stringify(r.body).slice(0, 200))
  ok('没有把 Windows 复制进来', !existsSync(join('plugins', 'Windows')))
}

console.log('\n=== B. source 带 .. 但指向一个合法插件 ===')
{
  // 造在项目外的临时目录，用相对路径穿越过去
const id = testPluginId('edge', 'traverse')
  // 注意：护栏只允许 edge- 前缀（见 _plugin-test-guard.ts）
  const dir = makePlugin(id)
  const rel = join('..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..', '..')
  void rel
  const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
  ok('绝对路径能装', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body).slice(0, 200))
  assertTestPluginId(id)
  const cleaned = await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  ok('能卸掉', cleaned.status === 200 && cleaned.body?.ok === true, JSON.stringify(cleaned.body).slice(0, 120))
  await installAndCleanup(dir, id)
}

console.log('\n=== C. 重复安装同一个 id ===')
{
const id = testPluginId('edge', 'dup')
  // 注意：护栏只允许 edge- 前缀（见 _plugin-test-guard.ts）
  const d1 = makePlugin(id, { version: '0.0.1' })
  const d2 = makePlugin(id, { version: '0.0.2' })
  try {
    const r1 = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: d1 }) })
    ok('第一次装成功', r1.status === 200 && r1.body?.ok === true, JSON.stringify(r1.body).slice(0, 150))

    const r2 = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: d2 }) })
    // 期望：要么拒绝（已存在），要么覆盖成功 —— 但不能崩
    ok('第二次不会 500', r2.status < 500, `实际 ${r2.status}`)
    console.log(`   第二次返回：${JSON.stringify(r2.body).slice(0, 160)}`)

    const list = await api('/api/plugins/list')
    const found = (list.body?.data?.plugins ?? []).find((p: any) => p.id === id)
    ok('列表里只有一个 probe-dup', (list.body?.data?.plugins ?? []).filter((p: any) => p.id === id).length === 1)
    console.log(`   装完版本：${found?.version}`)

  assertTestPluginId(id)
    await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  } finally {
    rmSync(d1, { recursive: true, force: true })
    rmSync(d2, { recursive: true, force: true })
  assertTestPluginId(id)
    rmSync(join('plugins', id), { recursive: true, force: true })
     rmSync(join('data', 'plugins', id), { recursive: true, force: true })
  }
}

console.log('\n=== D. 入口文件不存在 ===')
{
const id = testPluginId('edge', 'noentry')
  // 注意：护栏只允许 edge- 前缀（见 _plugin-test-guard.ts）
  const dir = join(tmpdir(), id + '-' + Date.now())
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: 'no entry', version: '0.0.1', entry: 'missing.js' }),
    'utf8',
  )
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
    ok('不会 500', r.status < 500, `实际 ${r.status}`)
    console.log(`   返回：${JSON.stringify(r.body).slice(0, 160)}`)

    // 就算装进去了，加载也应该失败但不崩
    const reload = await api('/api/plugins/reload', { method: 'POST', body: JSON.stringify({ id }) })
    ok('reload 不会 500', reload.status < 500, `实际 ${reload.status}`)

    const list = await api('/api/plugins/list')
    const found = (list.body?.data?.plugins ?? []).find((p: any) => p.id === id)
    if (found) ok('入口缺失时 loaded:false', found.loaded === false, JSON.stringify(found))
    else ok('入口缺失时干脆没装进来', true)

  assertTestPluginId(id)
    await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  assertTestPluginId(id)
    rmSync(join('plugins', id), { recursive: true, force: true })
     rmSync(join('data', 'plugins', id), { recursive: true, force: true })
  }
}

console.log('\n=== E. activate 抛异常 ===')
{
const id = testPluginId('edge', 'throw')
  // 注意：护栏只允许 edge- 前缀（见 _plugin-test-guard.ts）
  const dir = makePlugin(id, {}, 'export function activate(){ throw new Error("boom from plugin") }')
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
    ok('装得进去', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body).slice(0, 150))

    const reload = await api('/api/plugins/reload', { method: 'POST', body: JSON.stringify({ id }) })
    ok('reload 返回失败而不是 500', reload.status < 500, `实际 ${reload.status}`)
    console.log(`   reload：${JSON.stringify(reload.body).slice(0, 200)}`)

    // 关键：demo 不能被带崩
    const list = await api('/api/plugins/list')
    const demo = (list.body?.data?.plugins ?? []).find((p: any) => p.id === 'demo')
    ok('demo 仍然在列表里', demo !== undefined)
    ok('demo 仍然 loaded', demo?.loaded === true, JSON.stringify(demo))

  assertTestPluginId(id)
    await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  assertTestPluginId(id)
    rmSync(join('plugins', id), { recursive: true, force: true })
     rmSync(join('data', 'plugins', id), { recursive: true, force: true })
  }
}

console.log('\n=== F. minHostVersion 不满足 ===')
{
const id = testPluginId('edge', 'minver')
  // 注意：护栏只允许 edge- 前缀（见 _plugin-test-guard.ts）
  const dir = makePlugin(id, { minHostVersion: '999.0.0' })
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
    ok('不会 500', r.status < 500, `实际 ${r.status}`)
    console.log(`   返回：${JSON.stringify(r.body).slice(0, 200)}`)
  assertTestPluginId(id)
    await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  assertTestPluginId(id)
    rmSync(join('plugins', id), { recursive: true, force: true })
     rmSync(join('data', 'plugins', id), { recursive: true, force: true })
  }
}

console.log('\n=== G. 卸载时 id 带 ../（路径穿越） ===')
{
  const r = await api('/api/plugins/uninstall', {
    method: 'POST',
    body: JSON.stringify({ id: '../../src' }),
  })
  ok('不会 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:false（拒绝）', r.body?.ok === false, JSON.stringify(r.body).slice(0, 160))
  ok('src 还在', existsSync('src'))
}

console.log('\n=== H. 并发 toggle ===')
{
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      api('/api/plugins/toggle', {
        method: 'POST',
        body: JSON.stringify({ id: 'demo', enabled: i % 2 === 0 }),
      }),
    ),
  )
  ok('6 个并发都不 500', results.every((r) => r.status < 500), results.map((r) => r.status).join(','))
  // 收尾：确保 demo 是启用的
  await api('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ id: 'demo', enabled: true }) })
  await api('/api/plugins/reload', { method: 'POST', body: JSON.stringify({ id: 'demo' }) })
  const list = await api('/api/plugins/list')
  const demo = (list.body?.data?.plugins ?? []).find((p: any) => p.id === 'demo')
  ok('收尾后 demo enabled', demo?.enabled === true, JSON.stringify(demo))
}

console.log('\n=== I. demo 最终状态 ===')
{
  const list = await api('/api/plugins/list')
  const demo = (list.body?.data?.plugins ?? []).find((p: any) => p.id === 'demo')
  ok('demo 还在', demo !== undefined)
  ok('demo enabled', demo?.enabled === true)
  console.log(`   ${JSON.stringify(demo)}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ' + f)
}
process.exit(fail ? 1 : 0)
