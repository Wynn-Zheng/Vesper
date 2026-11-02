import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadRules, asGroupChatMode, DEFAULTS } from '../src/core/config.ts'
import { setConfigPath } from '../src/console/config-write.ts'

/**
 * 「老安装升级」这一整条路径。
 *
 * 为什么单独测：真实部署实例上踩过一次 —— 新加的配置项（群聊模式）
 * 在仓库的 rules.yaml 里有，所以单测/check-all 全绿；但用户数据目录里的
 * rules.yaml 是老版本生成的，没有那一行，于是"界面上有开关、点保存报
 * 找不到键"。这条测试模拟的就是**用户手上那个旧文件**。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-upgrade-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** v0.1.6 时代的 rules.yaml：没有 群聊模式，也没有后来加的一些键 */
const OLD_RULES = `人格:
  名字: 小暮
  自称: 我
说话:
  每轮最多条数: 3
  每条最多字数: 60
行为:
  改口概率: 0
  静默时段: ["23:30", "08:30"]
  发言频率: 0.4
NapCat:
  记录日志: false
`

/** 更老的版本：连整段都没有 */
const ANCIENT_RULES = `人格:
  名字: 小暮
`

function tmpRules(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

test('老 rules.yaml：缺失的新键自动取默认值，不报错', () => {
  const p = tmpRules('old.yaml', OLD_RULES)
  const r = loadRules(p)
  assert.equal(r.rules.行为.群聊模式, DEFAULTS.行为.群聊模式)
  assert.equal(r.rules.行为.群聊模式, '熟人续话')
  // 老文件里没有的段落也要补齐
  assert.ok(r.rules.视觉)
  assert.ok(r.rules.上下文压缩)
  // 不能因为缺键就报"未知配置项"
  assert.equal(r.warnings.filter((w) => w.includes('群聊模式')).length, 0)
})

test('老 rules.yaml：用户自己写的值要保留', () => {
  const p = tmpRules('old2.yaml', OLD_RULES)
  const r = loadRules(p)
  assert.equal(r.rules.行为.发言频率, 0.4)
  assert.equal(r.rules.说话.每条最多字数, 60)
  assert.equal(r.rules.人格.名字, '小暮')
})

test('远古 rules.yaml（只有一个段落）：也能正常加载', () => {
  const p = tmpRules('ancient.yaml', ANCIENT_RULES)
  const r = loadRules(p)
  assert.equal(r.rules.人格.名字, '小暮')
  assert.equal(r.rules.行为.群聊模式, '熟人续话')
})

test('升级后第一次改新键：能补进文件，且改完还能读回来', () => {
  const p = tmpRules('old3.yaml', OLD_RULES)
  const raw = readFileSync(p, 'utf8')
  const w = setConfigPath(raw, '行为.群聊模式', '只听')
  assert.equal(w.ok, true, w.error)
  writeFileSync(p, w.text, 'utf8')

  const r = loadRules(p)
  assert.equal(r.rules.行为.群聊模式, '只听', '写进去的值要能读回来')
  // 老内容不能丢
  assert.equal(r.rules.人格.名字, '小暮')
  assert.equal(r.rules.行为.发言频率, 0.4)
})

test('群聊模式写错：回落默认并给出可读告警', () => {
  const p = tmpRules('bad.yaml', OLD_RULES.replace('发言频率: 0.4', '发言频率: 0.4\n  群聊模式: 乱写的'))
  const r = loadRules(p)
  assert.equal(r.rules.行为.群聊模式, '熟人续话')
  const w = r.warnings.find((x) => x.includes('群聊模式'))
  assert.ok(w, '应该有一条告警')
  assert.ok(w!.includes('只听') && w!.includes('自己判断'), '告警里要列出合法值')
})

test('asGroupChatMode：只认三档，其它一律 null', () => {
  assert.equal(asGroupChatMode('只听'), '只听')
  assert.equal(asGroupChatMode('熟人续话'), '熟人续话')
  assert.equal(asGroupChatMode('自己判断'), '自己判断')
  assert.equal(asGroupChatMode('只@接梗'), null, '没做的档位不能被接受')
  assert.equal(asGroupChatMode(''), null)
  assert.equal(asGroupChatMode(null), null)
})

/* ---------------- access.yaml 的老格式 ---------------- */

test('老 access.yaml（没有「开启」）：按 .env，.env 也没写就默认开', async () => {
  const { loadAccess } = await import('../src/core/access.ts')
  const p = join(dir, 'access-old.yaml')
  writeFileSync(p, '群:\n  白名单: ["111"]\n成员:\n  必须at: true\n', 'utf8')
  const prev = process.env['ALLOW_GROUP']
  delete process.env['ALLOW_GROUP']
  try {
    const a = loadAccess(p)
    assert.equal(a.allowGroup, true, '装出来就是为了在群里用，默认开')
    assert.deepEqual(a.groupAllow, ['111'])
    assert.equal(a.requireAt, true)
  } finally {
    if (prev !== undefined) process.env['ALLOW_GROUP'] = prev
  }
})

test('老 access.yaml 尊重 .env 的关闭', async () => {
  const { loadAccess } = await import('../src/core/access.ts')
  const p = join(dir, 'access-old2.yaml')
  writeFileSync(p, '群:\n  白名单: []\n', 'utf8')
  const prev = process.env['ALLOW_GROUP']
  process.env['ALLOW_GROUP'] = 'false'
  try {
    assert.equal(loadAccess(p).allowGroup, false)
  } finally {
    if (prev === undefined) delete process.env['ALLOW_GROUP']
    else process.env['ALLOW_GROUP'] = prev
  }
})

test('access.yaml 坏掉：全拒（不能变成全放行）', async () => {
  const { loadAccess, checkAccess } = await import('../src/core/access.ts')
  const p = join(dir, 'access-broken.yaml')
  writeFileSync(p, '{这不是 yaml', 'utf8')
  const a = loadAccess(p)
  assert.equal(checkAccess(a, '123', '456').ok, false, '解析失败必须全拒')
})

test('access.yaml 不存在：生成一份，且默认能用在群里', async () => {
  const { loadAccess } = await import('../src/core/access.ts')
  const p = join(dir, 'access-fresh.yaml')
  const a = loadAccess(p)
  assert.equal(a.allowGroup, true)
  assert.ok(existsSync(p), '应该顺手写出一份，控制台才有东西可改')
})
