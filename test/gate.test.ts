import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judge, readCounts } from '../scripts/gate.ts'

/**
 * 门禁判定本身。这里判错的话，整轮"全部通过"就是假的。
 * 三条假绿都是真实踩过的：
 *   1. 服务没跑 → 集成检查被记成通过（BUG-23）
 *   2. 审计脚本永不返回非零（BUG-24）
 *   3. 脚本一个用例都没跑，打印「通过 0 / 失败 0」（这一轮）
 */

test('读计数：两种格式都认', () => {
  assert.deepEqual(readCounts('通过 18 / 失败 0'), { pass: 18, fail: 0 })
  assert.deepEqual(readCounts('19 / 19 通过'), { pass: 19, fail: 19 - 19 })
  assert.deepEqual(readCounts('通过 10 / 失败 2'), { pass: 10, fail: 2 })
  assert.equal(readCounts('什么也没有'), null)
})

test('退出码非 0 → 失败（哪怕输出好看）', () => {
  const v = judge('通过 18 / 失败 0', 1, /通过/)
  assert.equal(v.ok, false)
  assert.match(v.why ?? '', /退出码/)
})

test('输出里没有预期内容 → 失败（跑了但什么都没发生）', () => {
  const v = judge('', 0, /通过 \d+ \/ 失败 0/)
  assert.equal(v.ok, false)
  assert.match(v.why ?? '', /没有预期内容/)
})

test('「通过 0 / 失败 0」不算通过（空转）', () => {
  // 这是最隐蔽的一种假绿：退出码 0、格式也对，但一个检查都没跑
  const v = judge('通过 0 / 失败 0', 0, /通过 \d+ \/ 失败 0/)
  assert.equal(v.ok, false)
  assert.match(v.why ?? '', /只跑了 0 项/)
})

test('「0 / 0 通过」（冒烟格式）同样不算通过', () => {
  const v = judge('0 / 0 通过', 0, /\d+ \/ \d+ 通过/)
  assert.equal(v.ok, false)
})

test('有失败项 → 失败（即使 expect 宽松）', () => {
  const v = judge('通过 10 / 失败 2', 0, /\S/)
  assert.equal(v.ok, false)
  assert.match(v.why ?? '', /2 项失败/)
})

test('正常跑完 → 通过', () => {
  assert.equal(judge('通过 18 / 失败 0', 0, /通过 \d+ \/ 失败 0/).ok, true)
  assert.equal(judge('19 / 19 通过', 0, /\d+ \/ \d+ 通过/).ok, true)
})

test('不带计数的检查（类型检查那种空输出）照常通过', () => {
  assert.equal(judge('', 0, /^$/).ok, true)
})

test('minChecks 可以要求更多', () => {
  assert.equal(judge('通过 1 / 失败 0', 0, /通过/, 5).ok, false)
  assert.equal(judge('通过 5 / 失败 0', 0, /通过/, 5).ok, true)
})

test('只看结尾摘要：测试标题里出现的计数不能算数', () => {
  // 真实踩过：单元测试的输出里有一条标题叫「通过 0 / 失败 0」，
  // 门禁把它当成结果，判"单元测试只跑了 0 项"。
  const noisy = [
    '✔ 「通过 0 / 失败 0」不算通过（空转）',
    '✔ 别的测试',
    ...Array.from({ length: 30 }, (_, i) => `✔ 用例 ${i}`),
    'ℹ tests 40',
    'ℹ pass 40',
    'ℹ fail 0',
  ].join('\n')
  assert.deepEqual(readCounts(noisy), { pass: 40, fail: 0 })
})

test('node --test 的格式也认', () => {
  assert.deepEqual(readCounts('ℹ tests 5\nℹ pass 5\nℹ fail 0'), { pass: 5, fail: 0 })
  assert.deepEqual(readCounts('ℹ tests 5\nℹ pass 3\nℹ fail 2'), { pass: 3, fail: 2 })
})
