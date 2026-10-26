import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitBySentence } from '../src/channel/send.ts'

test('按句末标点切', () => {
  assert.deepEqual(splitBySentence('在吗。在的！好的？', 40, 10), ['在吗。', '在的！', '好的？'])
})

test('按换行切', () => {
  assert.deepEqual(splitBySentence('第一行\n第二行', 40, 10), ['第一行', '第二行'])
})

test('单句超长时按逗号切', () => {
  const out = splitBySentence('今天天气不错，我们去外面走走吧，顺便买点东西', 12, 10)
  assert.ok(out.length > 1)
  assert.ok(out.every((s) => s.length <= 12))
})

test('超过条数上限时截断，不把剩下的全塞进最后一条', () => {
  const out = splitBySentence('一。二。三。四。五。', 40, 3)
  assert.equal(out.length, 3)
  assert.equal(out[2], '三。', '第三条不该拖着一串')
  assert.ok(out.every((s) => s.length <= 40), '每条都不该超过上限')
})

test('空字符串返回空数组', () => {
  assert.deepEqual(splitBySentence('   ', 40, 3), [])
})

test('中文省略号和波浪号也算句末', () => {
  const out = splitBySentence('等等……算了～', 40, 10)
  assert.deepEqual(out, ['等等……', '算了～'])
})
