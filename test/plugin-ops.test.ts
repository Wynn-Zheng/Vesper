import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHost } from '../src/plugins/host.ts'
import { installPlugin, setEnabled, uninstallPlugin } from '../src/plugins/installer.ts'
import { scanPlugins } from '../src/plugins/registry.ts'

/**
 * 插件"装/卸"路径上的几个坑（第三轮扫描 BUG3-24/25/28）。
 *
 * 这些的共同点：**用户装了个插件，结果卸不掉 / 装没了 / 让 bot 不说话**。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-ops-'))
const pluginsRoot = join(dir, 'plugins')
const dataRoot = join(dir, 'data')
mkdirSync(pluginsRoot, { recursive: true })
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 造一个插件目录（目录名可以和清单 id 不同） */
function makePlugin(dirName: string, id: string, entry = 'index.mjs', body?: string): string {
  const p = join(pluginsRoot, dirName)
  mkdirSync(p, { recursive: true })
  writeFileSync(
    join(p, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', entry, type: 'event' }, null, 2),
    'utf8',
  )
  if (body !== undefined) writeFileSync(join(p, entry), body, 'utf8')
  return p
}

/* ---------------- BUG3-24：目录名 ≠ 清单 id ---------------- */

test('目录名和清单 id 不一致时，也能停用（写的是真实目录）', async () => {
  const p = makePlugin('my-weather', 'weather2')
  const r = await setEnabled({ id: 'weather2', pluginsRoot, enabled: false })
  assert.equal(r.ok, true, r.error)
  assert.ok(existsSync(join(p, 'disabled')), 'disabled 标记要写进真实目录')
  await setEnabled({ id: 'weather2', pluginsRoot, enabled: true })
  assert.equal(existsSync(join(p, 'disabled')), false)
})

test('目录名和清单 id 不一致时，也能卸载', async () => {
  const p = makePlugin('weird-dir', 'uninst2')
  const r = await uninstallPlugin({ id: 'uninst2', pluginsRoot })
  assert.equal(r.ok, true, r.error)
  assert.equal(existsSync(p), false, '真实目录要被删掉')
})

test('扫描能报出"目录名与 id 不一致"，让用户知道为什么', async () => {
  makePlugin('not-matching', 'mismatch')
  const { plugins, warnings } = await scanPlugins(pluginsRoot)
  assert.ok(plugins.some((p) => p.manifest.id === 'mismatch'), '插件本身要能扫到')
  // warnings 里应该有一条提示（否则用户不知道为什么卸载按钮对不上）
  const hint = warnings.find((e) => e.id === 'not-matching')
  assert.ok(hint, `应该有一条关于目录名的提示，实际：${JSON.stringify(warnings)}`)
})

/* ---------------- BUG3-25：从已安装目录原地覆盖 ---------------- */

test('从"已安装目录本身"安装 → 拒绝，且插件不被删', async () => {
  // 入口文件也要造出来，否则会在"入口不存在"那一步就先失败，测不到这条
  const p = makePlugin('selfcopy', 'selfcopy', 'index.mjs', 'export function activate() {}\n')
  const r = await installPlugin({
    source: p,
    pluginsRoot,
    allowOverwrite: true,
  })
  assert.equal(r.ok, false, '应该拒绝')
  assert.match(r.error ?? '', /目标目录|换个目录/)
  assert.ok(existsSync(join(p, 'plugin.json')), '原插件必须还在（这条最要紧）')
})

test('正常覆盖安装会把新内容换进去', async () => {
  makePlugin('upgrade', 'upgrade', 'index.mjs', 'export const v = 1\n')
  const src = join(dir, 'src-upgrade')
  mkdirSync(src, { recursive: true })
  writeFileSync(
    join(src, 'plugin.json'),
    JSON.stringify({ id: 'upgrade', name: 'upgrade', version: '2.0.0', entry: 'index.mjs', type: 'event' }, null, 2),
    'utf8',
  )
  writeFileSync(join(src, 'index.mjs'), 'export const v = 2\n', 'utf8')

  const r = await installPlugin({ source: src, pluginsRoot, allowOverwrite: true })
  assert.equal(r.ok, true, r.error)
  const installed = readFileSync(join(pluginsRoot, 'upgrade', 'index.mjs'), 'utf8')
  assert.match(installed, /v = 2/)
})

/* ---------------- BUG3-28：工具名要合法 ---------------- */

test('非法工具名不会被注册（否则模型侧整条请求 400）', async () => {
  makePlugin(
    'bad-tool',
    'bad-tool',
    'index.mjs',
    `
export function activate(ctx) {
  ctx.registerTool({ name: '天气 查询', description: 'x', parameters: { type: 'object', properties: {} }, run: () => 'ok' })
  ctx.registerTool({ name: 'ok_name-2', description: 'y', parameters: { type: 'object', properties: {} }, run: () => 'ok' })
}
`,
  )
  const host = createHost({
    pluginsRoot,
    dataRoot,
    settingsFile: join(dir, 'plugins.yaml'),
    logger: () => {},
  })
  const loaded = await host.load('bad-tool')
  assert.equal(loaded.ok, true, loaded.error)

  const names = host.tools().map((t) => t.name)
  assert.equal(names.includes('天气 查询'), false, '带空格的名字不能进注册表')
  assert.ok(names.includes('ok_name-2'), '合法的那个要能注册')
  // 错误要让用户看得见
  assert.ok(
    host.errors.some((e) => e.message.includes('工具名不合法')),
    `应该记录一条"工具名不合法"，实际：${JSON.stringify(host.errors)}`,
  )
})
