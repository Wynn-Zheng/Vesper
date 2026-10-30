/**
 * 插件系统端到端查 bug（第一轮）。
 *
 * 只读 + 少量临时目录，不碰 plugins/demo。跑完自己清理。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertTestPluginId, testPluginId } from './_plugin-test-guard.ts'

const BASE = 'http://127.0.0.1:7788'
const TOKEN = process.env['CONSOLE_TOKEN'] || 'REDACTED'

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

console.log('=== 1. 列表 ===')
{
  // demo 可能因为上一次被卸载过而处于"文件在、内存没加载"的状态，
  // 先 reload 一次，保证下面的断言测的是加载链路而不是上次的残留。
  await api('/api/plugins/reload', { method: 'POST', body: JSON.stringify({ id: 'demo' }) })

  const r = await api('/api/plugins/list')
  ok('list 200', r.status === 200, `实际 ${r.status}`)
  ok('ok:true', r.body?.ok === true)
  const list = r.body?.data?.plugins ?? []
  ok('有 demo 插件', list.some((p: any) => p.id === 'demo'))
  const demo = list.find((p: any) => p.id === 'demo')
  ok('demo loaded:true', demo?.loaded === true, JSON.stringify(demo))
  ok('demo enabled:true', demo?.enabled === true)
}

console.log('\n=== 2. 不存在的子路径 ===')
{
  const r = await api('/api/plugins/nope')
  ok('404', r.status === 404, `实际 ${r.status}`)
  ok('error 里有提示', typeof r.body?.error === 'string')
}

console.log('\n=== 3. 非法 body ===')
{
  const r = await api('/api/plugins/toggle', { method: 'POST', body: '{not json' })
  ok('400', r.status === 400, `实际 ${r.status}`)
  ok('说明 invalid body', String(r.body?.error ?? '').includes('invalid body'), r.body?.error)
}

console.log('\n=== 4. toggle 不存在的插件 ===')
{
  const r = await api('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ id: 'no-such-plugin', enabled: false }) })
  ok('不会 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:false', r.body?.ok === false, JSON.stringify(r.body))
}

console.log('\n=== 5. 卸载内置/不存在的 ===')
{
  const r = await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id: 'no-such-plugin' }) })
  ok('不会 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:false 或 400', r.body?.ok === false || r.status === 400)

  // 注意：**不要**拿 demo 当探针。之前这行真把 plugins/demo 卸载了，
  // 导致后面 check-all 里的插件测试全挂（demo 是项目里唯一的示例插件）。
}

console.log('\n=== 6. 检查更新（没有 index.json 时应给 error 不崩） ===')
{
  const r = await api('/api/plugins/updates')
  ok('status < 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:true', r.body?.ok === true, JSON.stringify(r.body).slice(0, 160))
  const items = r.body?.data?.items
  ok('items 是数组', Array.isArray(items))
  console.log(`   items=${JSON.stringify(items).slice(0, 200)}`)
  console.log(`   error=${JSON.stringify(r.body?.data?.error)}`)
}

console.log('\n=== 7. 安装一个不存在路径 ===')
{
  const r = await api('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ source: join(tmpdir(), 'definitely-not-there-' + Date.now()) }),
  })
  ok('不会 500', r.status < 500, `实际 ${r.status}`)
  ok('ok:false', r.body?.ok === false, JSON.stringify(r.body).slice(0, 160))
}

console.log('\n=== 8. 安装一个清单非法的目录 ===')
{
  const dir = join(tmpdir(), 'qqbot-bad-plugin-' + Date.now())
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'BAD ID', name: 'x' }), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export function activate(){}', 'utf8')
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
    ok('不会 500', r.status < 500, `实际 ${r.status}`)
    ok('ok:false', r.body?.ok === false, JSON.stringify(r.body).slice(0, 200))
    ok('没被复制进 plugins/', !existsSync(join('plugins', 'BAD ID')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n=== 9. 安装一个合法的新插件（再卸掉） ===')
{
  // 护栏：测试只能操作 e2e- 开头的插件（否则一个手滑就把 plugins/demo 删了）
  const id = testPluginId('e2e', 'tmp-check')
  const dir = join(tmpdir(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: '临时检查插件', version: '0.0.1', entry: 'index.js' }),
    'utf8',
  )
  writeFileSync(join(dir, 'index.js'), 'export function activate(ctx){ ctx.log("tmp ok") }', 'utf8')
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: dir }) })
    ok('安装成功', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body).slice(0, 200))
    ok('目录出现了', existsSync(join('plugins', id)))

    const list = await api('/api/plugins/list')
    ok('列表里有它', (list.body?.data?.plugins ?? []).some((p: any) => p.id === id))

    assertTestPluginId(id)
    const rm = await api('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
    ok('卸载成功', rm.status === 200 && rm.body?.ok === true, JSON.stringify(rm.body).slice(0, 200))
    ok('目录删掉了', !existsSync(join('plugins', id)))

    const list2 = await api('/api/plugins/list')
    ok('列表里没了', !(list2.body?.data?.plugins ?? []).some((p: any) => p.id === id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    assertTestPluginId(id)
    rmSync(join('plugins', id), { recursive: true, force: true })
  }
}

console.log('\n=== 10. 压缩包应明确拒绝 ===')
{
  const zip = join(tmpdir(), 'x-' + Date.now() + '.zip')
  writeFileSync(zip, 'PK', 'utf8')
  try {
    const r = await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ source: zip }) })
    ok('不会 500', r.status < 500, `实际 ${r.status}`)
    ok('ok:false', r.body?.ok === false)
    ok('说明不支持压缩包', String(r.body?.error ?? '').includes('压缩') || String(r.body?.error ?? '').includes('.zip'), r.body?.error)
  } finally {
    rmSync(zip, { force: true })
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ' + f)
}
process.exit(fail ? 1 : 0)
