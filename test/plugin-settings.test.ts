import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getPluginConfig, loadPluginSettings, readPluginSettings, setPluginConfig } from '../src/plugins/settings.ts'

/**
 * 插件配置的读写。
 *
 * 关键一条：**合法空配置**和**文件坏了**必须区分开。
 * 以前用"文件有内容但解析出零条目"来猜损坏 —— 而全新安装的模板
 * 恰好就是 `plugins: {}`，于是每个插件第一次保存配置都报「解析失败」，
 * 用户完全不知道该怎么办（实测 BUG3-30）。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-config-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let seq = 0
const file = (content: string): string => {
  const p = join(dir, `plugins-${++seq}.yaml`)
  writeFileSync(p, content, 'utf8')
  return p
}

test('全新安装的模板（只有注释 + plugins: {}）能保存', () => {
  const p = file('# 插件配置\n# 说明……\nplugins: {}\n')
  setPluginConfig(p, 'demo', { city: '上海' })
  assert.deepEqual(getPluginConfig(p, 'demo'), { city: '上海' })
})

test('空文件也能保存（不是"坏了"）', () => {
  const p = file('')
  setPluginConfig(p, 'demo', { a: 1 })
  assert.deepEqual(getPluginConfig(p, 'demo'), { a: 1 })
})

test('文件不存在也能保存', () => {
  const p = join(dir, 'not-exist.yaml')
  setPluginConfig(p, 'demo', { a: 1 })
  assert.deepEqual(getPluginConfig(p, 'demo'), { a: 1 })
})

test('真坏文件：拒绝写入（不能把别人的配置清空）', () => {
  const p = file('plugins: [unclosed\n')
  assert.throws(() => setPluginConfig(p, 'x', { a: 1 }), /解析失败|结构不对/)
  // 原文件必须原样保留
  assert.equal(readFileSync(p, 'utf8'), 'plugins: [unclosed\n')
})

test('结构不对（plugins 是数组）：也拒绝', () => {
  const p = file('plugins:\n  - a\n  - b\n')
  const r = readPluginSettings(p)
  assert.equal(r.ok, false)
  assert.throws(() => setPluginConfig(p, 'x', { a: 1 }))
})

test('已有配置：改一个插件不能弄丢其它插件', () => {
  const p = file(
    ['plugins:', '  one:', '    config:', '      k: v', '  two:', '    config:', '      z: 2', ''].join('\n'),
  )
  assert.deepEqual(getPluginConfig(p, 'one'), { k: 'v' })
  setPluginConfig(p, 'two', { z: 3 })
  assert.deepEqual(getPluginConfig(p, 'one'), { k: 'v' })
  assert.deepEqual(getPluginConfig(p, 'two'), { z: 3 })
})

test('readPluginSettings 能明确区分"空"和"坏"', () => {
  assert.equal(readPluginSettings(file('plugins: {}\n')).ok, true)
  assert.equal(readPluginSettings(file('')).ok, true)
  assert.equal(readPluginSettings(file('plugins: [oops\n')).ok, false)
  // loadPluginSettings 仍然只返回内容，不抛错（控制台不能因为配置坏了就打不开）
  assert.deepEqual(loadPluginSettings(file('plugins: [oops\n')), {})
})
