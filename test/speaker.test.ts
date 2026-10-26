import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatUserText } from '../src/loop/chat.ts'

test('群聊：谁说的要标出来', () => {
  assert.equal(formatUserText('group:1', '群代肝', '你好'), '群代肝：你好')
})

test('私聊：不加前缀（只有一个人，加了反而怪）', () => {
  assert.equal(formatUserText('private:1', '小明', '你好'), '你好')
})

test('群聊：没有昵称时退化成原文，不出现「：」这种空壳', () => {
  assert.equal(formatUserText('group:1', '', '你好'), '你好')
  assert.equal(formatUserText('group:1', undefined, '你好'), '你好')
  assert.equal(formatUserText('group:1', '   ', '你好'), '你好')
})

test('三个人在群里说话，历史能分得清', () => {
  const turns = [
    formatUserText('group:1', '群代肝', '刚刚有三个人'),
    formatUserText('group:1', 'TeStiFy', '那我是谁'),
    formatUserText('group:1', '(ᗒᗨᗕ)', '我也在'),
  ]
  assert.deepEqual(turns, ['群代肝：刚刚有三个人', 'TeStiFy：那我是谁', '(ᗒᗨᗕ)：我也在'])
  // 每条都能看出是谁
  assert.ok(turns.every((t) => t.includes('：')))
  assert.equal(new Set(turns.map((t) => t.split('：')[0])).size, 3, '应该能分出 3 个人')
})
