import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { resolvePluginPath } from '../src/plugins/sandbox.ts'

/**
 * `files` 权限的边界（BUG3-16）。
 *
 * 两条都是真事：
 *   1. 根原来是 `process.cwd()`（整个项目目录）—— 插件能读写 `.env`（API Key）、
 *      `persona/rules.yaml`、别的插件代码。`files` 本来只想给"读写自己的数据"。
 *   2. 注释写着"符号链接也按真实路径算（realpath）"，但代码**从来没调用过 realpath**。
 *      在数据目录里建一个 junction 指向外面，就能读根外的文件。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-sandbox-'))
const pluginDir = join(dir, 'data', 'plugins', 'demo')
const outside = join(dir, 'secrets')
mkdirSync(pluginDir, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'env.txt'), 'DEEPSEEK_API_KEY=sk-should-not-be-readable', 'utf8')
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('自己目录里的文件正常放行', () => {
  const p = resolvePluginPath(pluginDir, 'note.md')
  assert.equal(p, join(pluginDir, 'note.md'))
  // 子目录也行
  assert.equal(resolvePluginPath(pluginDir, 'sub/a.txt'), join(pluginDir, 'sub', 'a.txt'))
  // 根本身也算合法
  assert.equal(resolvePluginPath(pluginDir, '.'), pluginDir)
})

test('.. 嵌套往外跳会被拦下', () => {
  assert.throws(() => resolvePluginPath(pluginDir, '../env.txt'), /路径越界/)
  assert.throws(() => resolvePluginPath(pluginDir, 'a/../../env.txt'), /路径越界/)
  assert.throws(() => resolvePluginPath(pluginDir, '../../../../.env'), /路径越界/)
})

test('回到同级的兄弟目录也不行', () => {
  // data/plugins/demo → data/plugins 是"上一级"，不在根里
  assert.throws(() => resolvePluginPath(pluginDir, '..' + sep + 'other'), /路径越界/)
})

test('绝对路径不能直接给', () => {
  assert.throws(() => resolvePluginPath(pluginDir, join(outside, 'env.txt')), /路径越界/)
})

test('junction 指向外面：读会被拦（realpath 真的在调）', (t) => {
  let linked = false
  try {
    // Windows 上 junction 不需要管理员权限
    symlinkSync(outside, join(pluginDir, 'out'), 'junction')
    linked = true
  } catch (e) {
    t.skip(`这个环境不支持 junction：${String(e).slice(0, 60)}`)
    return
  }
  assert.ok(linked)
  assert.throws(() => resolvePluginPath(pluginDir, 'out/env.txt'), /路径越界/)
})

test('junction 指向外面：写新文件也会被拦', (t) => {
  try {
    symlinkSync(outside, join(pluginDir, 'outw'), 'junction')
  } catch (e) {
    t.skip(`这个环境不支持 junction：${String(e).slice(0, 60)}`)
    return
  }
  // 目标是还不存在的文件：要靠"最近已存在祖先"的 realpath 才拦得住
  assert.throws(() => resolvePluginPath(pluginDir, 'outw/evil.txt'), /路径越界/)
  assert.equal(existsSync(join(outside, 'evil.txt')), false, '外面不该出现这个文件')
  // 外面那个文件也没被动过
  assert.equal(readFileSync(join(outside, 'env.txt'), 'utf8').includes('sk-'), true)
})

test('根不存在时不会静默放行，而是报不可解析', () => {
  assert.throws(() => resolvePluginPath(join(dir, 'no-such-root'), 'a.txt'), /不可解析/)
})
