import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHost } from '../src/plugins/host.ts'
import { PERMISSION_NAMES } from '../src/plugins/manifest.ts'
import { scanPlugins } from '../src/plugins/registry.ts'

/**
 * `shell` 权限已移除（BUG3-29）。
 *
 * 移除的两个理由，都是实测出来的：
 *   1. 白名单里原来有 `node` / `python` —— `node -e "…"` 就是任意代码执行，
 *      等于白名单不存在。
 *   2. 剩下的命令在 Windows 上大半**不是可执行文件**：
 *      echo / dir / type / ls / cat / grep / wc / head / tail / uniq / date
 *      都是 cmd 内置或根本没有，`execFile('echo')` 直接 ENOENT。
 *      功能在目标平台上几乎不可用，而且 ENOENT 还被当成"成功、无输出"。
 *
 * 所以不是"改白名单"，是整条权限去掉；声明它的插件会收到一条明确提示。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-shell-'))
const pluginsRoot = join(dir, 'plugins')
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function makePlugin(id: string, permissions: string[]): void {
  const p = join(pluginsRoot, id)
  mkdirSync(p, { recursive: true })
  writeFileSync(
    join(p, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.mjs', type: 'event', permissions }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(p, 'index.mjs'),
    `
export function activate(ctx) {
  globalThis.__hasExec = typeof ctx.exec === 'function'
}
`,
    'utf8',
  )
}

test('shell 不再是合法权限名', () => {
  assert.equal((PERMISSION_NAMES as string[]).includes('shell'), false)
  // 该有的还在
  for (const p of ['net', 'memory', 'message', 'files']) {
    assert.ok((PERMISSION_NAMES as string[]).includes(p), `${p} 应该在`)
  }
})

test('声明 shell 的插件：没有 ctx.exec，但能正常加载', async () => {
  makePlugin('shell-plugin', ['shell'])
  const host = createHost({
    pluginsRoot,
    dataRoot: join(dir, 'data'),
    settingsFile: join(dir, 'plugins.yaml'),
    logger: () => {},
  })
  const r = await host.load('shell-plugin')
  assert.equal(r.ok, true, r.error)
  assert.equal((globalThis as unknown as { __hasExec: boolean }).__hasExec, false, 'ctx.exec 不该存在')
  await host.unload('shell-plugin')
})

test('声明 shell 会得到一条解释，而不是悄悄消失', async () => {
  const { warnings } = await scanPlugins(pluginsRoot)
  const hint = warnings.find((w) => w.id === 'shell-plugin' && w.message.includes('shell 权限'))
  assert.ok(hint, `应该有一条关于 shell 已移除的提示，实际：${JSON.stringify(warnings)}`)
})

test('未知权限名一律忽略（不阻止加载）', async () => {
  makePlugin('weird-perm', ['net', 'teleport'])
  const host = createHost({
    pluginsRoot,
    dataRoot: join(dir, 'data'),
    settingsFile: join(dir, 'plugins.yaml'),
    logger: () => {},
  })
  const r = await host.load('weird-perm')
  assert.equal(r.ok, true, r.error)
  await host.unload('weird-perm')
})
