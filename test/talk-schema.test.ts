import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TALK_FIELDS, readPath, validateTalkValues } from '../src/console/talk-schema.ts'

/**
 * 对话规则页的字段声明与校验。
 *
 * 这一层的意义：写坏一个类型会让 loadRules 抛错 → 热重载继续用旧值 →
 * **下次启动整份回落 DEFAULTS**（用户的全部配置没了）。
 * 之前 /api/ability/param 就是裸写，没有任何校验。
 */

const byPath = new Map(TALK_FIELDS.map((f) => [f.path, f]))

test('每个字段都有路径、标签、说明和分组', () => {
  for (const f of TALK_FIELDS) {
    // 顶层数组（关键词反应）没有分组前缀，其余都该是「分组.键」
    assert.ok(f.path.includes('.') || f.kind === 'list', `${f.path} 应该是 分组.键 的形式`)
    assert.ok(f.label && f.label.length > 0, `${f.path} 缺 label`)
    assert.ok(f.hint && f.hint.length > 0, `${f.path} 缺 hint（用户要知道改了会怎样）`)
    assert.ok(f.group, `${f.path} 缺 group`)
    assert.ok(f.level === 'basic' || f.level === 'advanced', `${f.path} 的 level 不对`)
    if (f.kind === 'choice') assert.ok((f.options ?? []).length >= 2, `${f.path} 的选项太少`)
    if (f.kind === 'number') assert.ok(f.min != null && f.max != null, `${f.path} 缺范围`)
    // 列表类型必须说清每行长什么样，否则前端渲染不出来
    if (f.kind === 'list') assert.ok((f.items ?? []).length >= 1, `${f.path} 没声明 items`)
  }
})

test('路径不重复', () => {
  const seen = new Set<string>()
  for (const f of TALK_FIELDS) {
    assert.equal(seen.has(f.path), false, `${f.path} 重复声明`)
    seen.add(f.path)
  }
})

test('未接线的键不准出现在界面上', () => {
  // 这 9 个在代码里没有消费者，给了界面就是假开关
  const dead = [
    '说话.分句',
    '记忆.摘要粒度',
    '记忆.反思.触发',
    '记忆.反思.产出条数',
    '记忆.衰减.关系锚点',
    '关系.维度',
    '关系.阶段.主动',
    '外部.刷视频.最短间隔小时',
    '外部.发空间.需要确认',
  ]
  for (const p of dead) {
    assert.equal(byPath.has(p), false, `${p} 没有消费者，不该出现在界面上`)
  }
})

test('开关：只接受布尔', () => {
  const ok = validateTalkValues(TALK_FIELDS, { '行为.私聊暂停': true })
  assert.equal(ok.ok, true)
  const bad = validateTalkValues(TALK_FIELDS, { '行为.私聊暂停': 'yes' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.errors.join(), /true \/ false/)
})

test('选择：只接受声明过的选项', () => {
  const ok = validateTalkValues(TALK_FIELDS, { '行为.防抖.档位': '沉稳' })
  assert.equal(ok.ok, true)
  const bad = validateTalkValues(TALK_FIELDS, { '行为.防抖.档位': '很快' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.errors.join(), /只能是/)
})

test('数字：超范围会被 clamp，不是静默接受', () => {
  // 防抖.安静 是 number（0-30 秒）
  const r = validateTalkValues(TALK_FIELDS, { '行为.防抖.安静': 99 })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.values[0]!.value, 30)
    assert.equal(r.values[0]!.coerced, true)
  }

  // 条数是 choice，99 不在选项里 → 直接拒绝（比 clamp 更严格）
  const c = validateTalkValues(TALK_FIELDS, { '说话.每轮最多条数': 99 })
  assert.equal(c.ok, false)
})

test('未知键直接拒绝（不能借着这个接口写任意配置）', () => {
  const r = validateTalkValues(TALK_FIELDS, { '电脑操作.允许操作': true })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.errors.join(), /没有这个设置项/)
})

test('空提交会被拒绝', () => {
  const r = validateTalkValues(TALK_FIELDS, {})
  assert.equal(r.ok, false)
})

test('静默时段：枚举转数组，"不设静默"转空数组', () => {
  const a = validateTalkValues(TALK_FIELDS, { '行为.静默时段': '01:00|07:00' })
  assert.equal(a.ok, true)
  if (a.ok) assert.deepEqual(a.values[0]!.value, ['01:00', '07:00'])

  const b = validateTalkValues(TALK_FIELDS, { '行为.静默时段': 'none' })
  assert.equal(b.ok, true)
  if (b.ok) assert.deepEqual(b.values[0]!.value, [])

  const c = validateTalkValues(TALK_FIELDS, { '行为.静默时段': '晚上' })
  assert.equal(c.ok, false)
})

test('readPath 能按路径取值', () => {
  const obj = { 行为: { 防抖: { 档位: '自然' }, 发言频率: 0.4 } }
  assert.equal(readPath(obj, '行为.防抖.档位'), '自然')
  assert.equal(readPath(obj, '行为.发言频率'), 0.4)
  assert.equal(readPath(obj, '行为.不存在'), undefined)
  assert.equal(readPath(null, '行为.发言频率'), undefined)
})

test('防抖明细都声明了 requires（否则改了不生效）', () => {
  const detail = ['安静', '活跃', '同人续发', '换人', '被at最多', '批次上限']
  for (const k of detail) {
    const f = byPath.get('行为.防抖.' + k)
    assert.ok(f, `缺 行为.防抖.${k}`)
    assert.ok(f.requires, `行为.防抖.${k} 必须声明 requires —— 档位不是自定义时它会被预设覆盖`)
    assert.equal(f.requires.path, '行为.防抖.档位')
    assert.equal(f.requires.equals, '自定义')
  }
})
