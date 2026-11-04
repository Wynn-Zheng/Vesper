import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { buildSelfBlock, buildPhaseBlock } from '../src/self/format.ts'
import { appendLife, loadLife, loadSelf, recentLife, saveSelf, setSelfFiles } from '../src/self/store.ts'
import { DEFAULTS } from '../src/core/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'qqbot-self-'))
setSelfFiles(join(dir, 'self.md'), join(dir, 'life.md'))
// 挪到临时目录：否则 buildSelfBlock 会读到项目里真实的角色卡，
// 卡名会盖掉"还没有名字"/rules.yaml 名字这两条路径，测试就跟本机状态绑死了。
const oldCwd = process.cwd()
process.chdir(dir)
// 共享进程模式下必须还原，否则后面的测试文件全在这个临时目录里跑。
after(() => process.chdir(oldCwd))

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const at = (h: number) => {
  const d = new Date('2026-10-25T00:00:00')
  d.setHours(h, 0, 0, 0)
  return d
}

test('没有名字时，prompt 里说"还没有名字"', () => {
  const block = buildSelfBlock(DEFAULTS, at(10))
  assert.ok(block.includes('还没有名字'))
})

test('保存名字后能读回，并出现在 prompt 里', () => {
  saveSelf({ name: '小满', nameReason: '觉得满一点好', about: '我在学着认识人。', thinking: '想弄明白人为什么怕沉默', abilities: '', aboutOwner: 'it', aboutExtra: '' })
  const doc = loadSelf()
  assert.equal(doc.name, '小满')
  assert.equal(doc.about, '我在学着认识人。')

  const block = buildSelfBlock(DEFAULTS, at(10))
  assert.ok(block.includes('小满'))
  assert.ok(block.includes('满一点好'))
  assert.ok(block.includes('怕沉默'))
})

test('名字为空时回落到 rules.yaml 的名字', () => {
  const rules = { ...DEFAULTS, 人格: { ...DEFAULTS.人格, 名字: '阿三' } }
  saveSelf({ name: '', nameReason: '', about: '', thinking: '', abilities: '', aboutOwner: 'it', aboutExtra: '' })
  const block = buildSelfBlock(rules, at(10))
  assert.ok(block.includes('阿三'))
})

test('生活记录按日期追加，同一天合并', () => {
  appendLife('2026-10-25', ['想明白一件事', '发现自己更喜欢晚上'])
  appendLife('2026-10-25', ['今天又想到那个问题'])
  appendLife('2026-10-26', ['早上醒得早'])

  const entries = loadLife()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.date, '2026-10-25')
  assert.equal(entries[0]!.lines.length, 3)
  assert.equal(entries[1]!.date, '2026-10-26')
})

test('recentLife 取最新的几条', () => {
  const recent = recentLife(2)
  assert.equal(recent.length, 2)
  assert.ok(recent.includes('早上醒得早'))
})

test('深夜时状态块带困倦提示', () => {
  assert.ok(buildPhaseBlock(DEFAULTS, at(2)).includes('困'))
})

test('白天状态块为空', () => {
  assert.equal(buildPhaseBlock(DEFAULTS, at(10)), '')
})

test('自我块不含作息（作息移到末尾，避免破坏 prompt 缓存）', () => {
  const block = buildSelfBlock(DEFAULTS, at(2))
  assert.ok(!block.includes('困'))
})
