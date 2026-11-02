import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setConfigPath } from '../src/console/config-write.ts'

/**
 * 写 rules.yaml 的一个键。
 *
 * 最关键的一条：**键不存在时要能补上**。
 * 老用户升级后，新版本加的配置项在文件里没有对应行
 * （默认值来自代码里的 DEFAULTS）。以前只支持"改已有的键"，
 * 于是新设置一律"界面上有、点保存报找不到键" —— 实测部署实例就是这样。
 */

const sample = `行为:
  改口概率: 0
  静默时段: ["23:30", "08:30"]

  防抖:
    档位: 自然

NapCat:
  记录日志: false
`

test('键不存在：往父级段落里补一行', () => {
  const r = setConfigPath(sample, '行为.群聊模式', '熟人续话')
  assert.equal(r.ok, true, r.error)
  assert.ok(r.text.includes('群聊模式: "熟人续话"'), r.text)
  // 不能插到别的段落里去
  const lines = r.text.split('\n')
  const idx = lines.findIndex((l) => l.includes('群聊模式'))
  assert.ok(idx > 0 && idx < lines.findIndex((l) => l.includes('NapCat')), '应插在「行为」段落内')
})

test('补进去的缩进要和同段其他键一致', () => {
  const r = setConfigPath(sample, '行为.群聊模式', '只听')
  const line = r.text.split('\n').find((l) => l.includes('群聊模式'))!
  assert.equal(/^(\s*)/.exec(line)![1], '  ', '行为 段落的子键是 2 空格缩进')
})

test('键已存在：改值，不新增行，并保留行尾注释', () => {
  const withKey = sample.replace('  改口概率: 0', '  改口概率: 0   # 说明')
  const r = setConfigPath(withKey, '行为.改口概率', 0.2)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('改口概率: 0.2   # 说明'))
})

test('补过一次之后再写，应该走改值而不是重复插入', () => {
  const r1 = setConfigPath(sample, '行为.群聊模式', '熟人续话')
  const r2 = setConfigPath(r1.text, '行为.群聊模式', '自己判断')
  assert.equal(r2.ok, true)
  assert.equal((r2.text.match(/群聊模式/g) ?? []).length, 1, '不能插两行')
  assert.ok(r2.text.includes('群聊模式: "自己判断"'))
})

test('父级不存在时仍然报错（不许凭空造段落）', () => {
  const r = setConfigPath(sample, '不存在的段.某个键', 1)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /找不到父级/)
})

test('CRLF 文件也能补键', () => {
  const crlf = sample.replace(/\n/g, '\r\n')
  const r = setConfigPath(crlf, '行为.群聊模式', '只听')
  assert.equal(r.ok, true, r.error)
})

test('父级是列表时拒绝补键（否则会写出非法 YAML）', () => {
  const listYaml = `关系:
  阶段:
    - 名字: 陌生
      值: 0
    - 名字: 眼熟
      值: 20
`
  const r = setConfigPath(listYaml, '关系.阶段.测试新键', 1)
  assert.equal(r.ok, false, '列表里不能加键')
  assert.match(r.error ?? '', /列表/)
  // 关键：原文件必须原样返回，不能被改坏
  assert.equal(r.text, listYaml)
})

test('普通映射父级照常补键（别把这条规则用过头）', () => {
  const yaml = `行为:
  改口概率: 0
  静默时段: ["23:30", "08:30"]
`
  const r = setConfigPath(yaml, '行为.群聊模式', '熟人续话')
  assert.equal(r.ok, true, r.error)
  assert.ok(r.text.includes('群聊模式: "熟人续话"'))
})
