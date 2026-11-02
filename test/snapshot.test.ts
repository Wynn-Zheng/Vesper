import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSnapshotExcluded } from '../src/persona/version.ts'

/**
 * 快照要跳过什么。
 *
 * 关键一条是表情包库：它会随使用一直长大（群里每张图都进库），
 * 而快照保留 60 份。不跳的话，用户用几个月后 data/versions 会变成
 * 几十上百 GB —— 而且回滚人格时也没道理把表情包也退回去。
 */

test('跳过表情包目录本身和里面的文件', () => {
  assert.equal(isSnapshotExcluded('persona/emoji'), true)
  assert.equal(isSnapshotExcluded('persona/emoji/a.jpg'), true)
  assert.equal(isSnapshotExcluded('persona\\emoji\\a.jpg'), true, 'Windows 路径也要认')
})

test('跳过 .versions（快照不能把自己再拍一遍）', () => {
  assert.equal(isSnapshotExcluded('persona/.versions'), true)
  assert.equal(isSnapshotExcluded('persona/.versions/20260101/x'), true)
})

test('人格和记忆要保留（回滚它的意义就在这些）', () => {
  for (const p of [
    'persona/self.md',
    'persona/rules.yaml',
    'persona/people/123/meta.json',
    'persona/memory/facts.jsonl',
    'persona/cards/小满.md',
    'persona/groups/1.json',
  ]) {
    assert.equal(isSnapshotExcluded(p), false, `${p} 不该被跳过`)
  }
})

test('名字里带 emoji 但不是那个目录的，不能误伤', () => {
  assert.equal(isSnapshotExcluded('persona/cards/emoji 风格.md'), false)
  assert.equal(isSnapshotExcluded('persona/notes/emoji.md'), false)
})
