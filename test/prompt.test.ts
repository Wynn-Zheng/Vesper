import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, loadRules, resolveDebounce, stageOf, talkValueOf } from '../src/core/config.ts'
import { buildSystem, replyBudget } from '../src/loop/prompt.ts'
import { sanitize } from '../src/loop/chat.ts'
import { phaseOf } from '../src/self/format.ts'

test('system prompt 包含 rules.yaml 的关键约束', () => {
  const s = buildSystem({ rules: DEFAULTS, now: new Date('2026-10-25T01:30:00') })
  assert.ok(s.includes('3 句'), '应包含条数上限')
  assert.ok(/每句不超过 \d+ 个字/.test(s), '应包含字数上限')
  assert.ok(s.includes('不要用 Markdown'))
  assert.ok(s.includes('不编造共同经历'))
  assert.ok(s.includes('2026-10-25 01:30'), '应包含当前时间')
})

test('回复长度跟着对方的投入走', () => {
  const short = replyBudget(DEFAULTS, 3)
  const mid = replyBudget(DEFAULTS, 15)
  const long = replyBudget(DEFAULTS, 100)
  assert.ok(short < mid, '短消息应比中等消息给更少的字数')
  assert.ok(mid <= long, '长消息可以回得更长')
  assert.ok(short >= 12, '再短也有下限')
})

test('短消息时 prompt 里会提示别铺开', () => {
  const s = buildSystem({ rules: DEFAULTS, userChars: 4 })
  assert.ok(s.includes('他这句很短'))
})

test('没有自我时用默认的"刚被创造"描述', () => {
  const s = buildSystem({ rules: DEFAULTS })
  assert.ok(s.includes('刚被创造出来'))
})

test('有自我块时替换默认描述', () => {
  const s = buildSystem({ rules: DEFAULTS, self: '关于你自己：\n- 你叫「小满」' })
  assert.ok(s.includes('小满'))
  assert.ok(!s.includes('刚被创造出来'))
})

test('关系和记忆分别注入', () => {
  const s = buildSystem({ rules: DEFAULTS, relation: '关于你们的关系：\n- 陌生', memory: '- 他四级没复习' })
  assert.ok(s.includes('关于你们的关系'))
  assert.ok(s.includes('他四级没复习'))
})

test('画像和事实冲突时以事实为准（提示写进了 prompt）', () => {
  const s = buildSystem({ rules: DEFAULTS, profile: '他这个人挺安静的', memory: '- 他其实很爱说话' })
  assert.ok(s.includes('他这个人挺安静的'))
  assert.ok(s.includes('以这里为准'), 'memory 块要说明它比画像更可信')
})

test('画像过长会被截断（它容易越写越长，白占预算）', () => {
  const long = '他'.repeat(900)
  const s = buildSystem({ rules: DEFAULTS, profile: long })
  assert.ok(s.includes(long.slice(0, 600)))
  assert.ok(!s.includes(long), '不应整段塞进去')
})

test('阶段按阈值正确匹配', () => {
  assert.equal(stageOf(DEFAULTS, 0).名, '陌生')
  assert.equal(stageOf(DEFAULTS, 10).名, '陌生')
  assert.equal(stageOf(DEFAULTS, 11).名, '眼熟')
  assert.equal(stageOf(DEFAULTS, 26).名, '朋友')
  assert.equal(stageOf(DEFAULTS, 100).名, '很亲近')
})

test('活跃度：按时段取不同的发言频率', () => {
  const rules = {
    ...DEFAULTS,
    行为: {
      ...DEFAULTS.行为,
      发言频率: 0.4,
      频率规则: [
        { 时段: '00:00-08:59', 值: 0.1 },
        { 时段: '19:00-23:29', 值: 0.8 },
      ],
    },
  }
  const at = (h: number) => {
    const d = new Date('2026-10-25T00:00:00')
    d.setHours(h, 30, 0, 0)
    return d
  }
  assert.equal(talkValueOf(rules, at(3)), 0.1, '深夜应该很安静')
  assert.equal(talkValueOf(rules, at(20)), 0.8, '晚上应该活跃')
  assert.equal(talkValueOf(rules, at(13)), 0.4, '没命中规则用默认值')
})

test('活跃度：跨夜的时段也能匹配', () => {
  const rules = {
    ...DEFAULTS,
    行为: {
      ...DEFAULTS.行为,
      发言频率: 0.5,
      频率规则: [{ 时段: '23:00-02:00', 值: 0.05 }],
    },
  }
  const at = (h: number) => {
    const d = new Date('2026-10-25T00:00:00')
    d.setHours(h, 30, 0, 0)
    return d
  }
  assert.equal(talkValueOf(rules, at(23)), 0.05)
  assert.equal(talkValueOf(rules, at(1)), 0.05)
  assert.equal(talkValueOf(rules, at(3)), 0.5)
})

test('防抖：四个档位各自一套值', () => {
  const d = (档位: string) => ({ ...DEFAULTS.行为.防抖, 档位: 档位 as '自然' })

  const fast = resolveDebounce(d('快速'))!
  assert.equal(fast.安静, 1, '快速档安静 1 秒')
  assert.equal(fast.活跃, 3)
  assert.equal(fast.同人续发, 1)
  assert.equal(fast.换人, 0.5)

  const natural = resolveDebounce(d('自然'))!
  assert.equal(natural.安静, 2)
  assert.equal(natural.活跃, 5)
  assert.equal(natural.同人续发, 2)
  assert.equal(natural.换人, 0.5)

  const steady = resolveDebounce(d('沉稳'))!
  assert.equal(steady.安静, 4)
  assert.equal(steady.活跃, 7)
  assert.equal(steady.同人续发, 4, '沉稳档给补话留更多时间')
  assert.equal(steady.换人, 2)
})

test('防抖：关闭档返回 null，调用方直接处理不聚合', () => {
  assert.equal(resolveDebounce({ ...DEFAULTS.行为.防抖, 档位: '关闭' }), null)
})

test('防抖：自定义档用填的数字', () => {
  const r = resolveDebounce({
    档位: '自定义',
    安静: 9,
    活跃: 8,
    同人续发: 7,
    换人: 6,
    被at最多: 5,
    批次上限: 4,
  })!
  assert.equal(r.安静, 9)
  assert.equal(r.活跃, 8)
  assert.equal(r.批次上限, 4)
})

test('防抖：档位写错时按自然走，不抛', () => {
  const r = resolveDebounce({ ...DEFAULTS.行为.防抖, 档位: '瞎写' as '自然' })!
  assert.equal(r.安静, 2, '写错不该让机器人收不了消息')
})

test('sanitize 去掉引号与 markdown', () => {
  assert.equal(sanitize('"在的"'), '在的')
  assert.equal(sanitize('**好**'), '好')
  assert.equal(sanitize('# 标题\n正文'), '标题\n正文')
  assert.equal(sanitize('- 一条'), '一条')
})

test('未知配置项被忽略并给出警告', () => {
  const { warnings } = loadRules('persona/不存在的文件.yaml')
  assert.ok(warnings.some((w) => w.includes('没找到')))
})

test('作息：深夜是 sleep，午后是 rest，其他 active', () => {
  const at = (h: number, m = 0) => {
    const d = new Date('2026-10-25T00:00:00')
    d.setHours(h, m, 0, 0)
    return d
  }
  assert.equal(phaseOf(DEFAULTS, at(2)), 'sleep')
  assert.equal(phaseOf(DEFAULTS, at(23, 45)), 'sleep')
  assert.equal(phaseOf(DEFAULTS, at(13)), 'rest')
  assert.equal(phaseOf(DEFAULTS, at(10)), 'active')
  assert.equal(phaseOf(DEFAULTS, at(20)), 'active')
})

test('活跃度配置写错时回落到默认值，不传 NaN 下去', () => {
  const bad = {
    ...DEFAULTS,
    行为: { ...DEFAULTS.行为, 发言频率: 'abc' as unknown as number, 频率规则: [] },
  }
  const v = talkValueOf(bad)
  assert.ok(!Number.isNaN(v), '不能是 NaN')
  assert.equal(v, 0.4, '应回落到默认 0.4')
})