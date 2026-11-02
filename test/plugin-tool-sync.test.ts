import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolRegistry } from '../src/tools/registry.ts'
import { syncPluginTools } from '../src/tools/plugin-sync.ts'
import type { Tool } from '../src/tools/types.ts'

/**
 * 插件工具同步进注册表。
 *
 * 这条治的是"重载成功但模型还在调旧代码"（BUG3-21）：
 * 控制台里点"测试"跑的是新实现，聊天里模型调到的却是旧 wrapper，
 * 只有重启后端才恢复。用户看到的现象是"重载没生效"。
 */

const mk = (name: string, tag: string): Tool => ({
  name,
  description: tag,
  parameters: { type: 'object', properties: {} },
  run: async () => tag,
})

test('重载后注册表里换成了新实现', async () => {
  const reg = new ToolRegistry()
  const names = new Set<string>()
  syncPluginTools(reg, [mk('weather', 'v1')], names)
  assert.equal(await (reg.list()[0] as Tool).run({}, {} as never), 'v1')

  // 插件改代码后重载：回调再被调一次，带着新的工具表
  syncPluginTools(reg, [mk('weather', 'v2')], names)
  assert.equal(reg.list().length, 1, '不能变成两个同名工具')
  assert.equal(await (reg.list()[0] as Tool).run({}, {} as never), 'v2')
})

test('插件被卸载后，它的工具要从注册表消失', () => {
  const reg = new ToolRegistry()
  const names = new Set<string>()
  syncPluginTools(reg, [mk('a', 'x'), mk('b', 'y')], names)
  assert.equal(reg.list().length, 2)

  syncPluginTools(reg, [mk('a', 'x2')], names)
  assert.equal(reg.list().length, 1)
  assert.equal(reg.get('b'), undefined)
  assert.ok(reg.get('a'))
})

test('插件不能顶掉内置工具', () => {
  const reg = new ToolRegistry()
  const names = new Set<string>()
  reg.register(mk('read_code', '内置'))
  syncPluginTools(reg, [mk('read_code', '插件的')], names, () => {}, () => {})
  assert.equal(reg.get('read_code')?.description, '内置', '内置工具不能被插件覆盖')
  assert.equal(names.size, 0, '被跳过的名字不该记成"插件注册过的"')
})

test('上次是插件注册的名字，这次还能覆盖（不算撞内置）', () => {
  const reg = new ToolRegistry()
  const names = new Set<string>()
  syncPluginTools(reg, [mk('weather', 'v1')], names)
  // 第二次：existing 存在，但它在 pluginNames 里 → 允许覆盖
  syncPluginTools(reg, [mk('weather', 'v3')], names)
  assert.equal(reg.get('weather')?.description, 'v3')
})

test('空表 = 全部注销', () => {
  const reg = new ToolRegistry()
  const names = new Set<string>()
  syncPluginTools(reg, [mk('a', 'x')], names)
  syncPluginTools(reg, [], names)
  assert.equal(reg.list().length, 0)
})

test('registry 为 null 时不炸（控制台可能在别处先起）', () => {
  assert.doesNotThrow(() => syncPluginTools(null, [mk('a', 'x')], new Set()))
})
