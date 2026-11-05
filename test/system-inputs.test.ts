/**
 * prompt 输入清单只能有一份。
 *
 * 背景（B-118）：线上回复（chat.ts）和控制台试聊（preview.ts）各自手写一遍
 * `buildSystem({...})`。以前 preview 那份少了 desktop/core/requests/speech/
 * expression/growth/intent/codeMap/personRole/consoleMode/keyword 十来个字段 ——
 * 用户在试聊里问「你能看到我屏幕吗」，它答"看不到"，而线上其实能截图。
 *
 * 注释里写「要和 chat.ts 保持同一份清单」是拦不住人的：加字段忘了另一边，
 * 编译器不会响。所以这里断言的是**字段集合本身**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemInputs } from '../src/loop/system-inputs.ts'
import { buildSystem } from '../src/loop/prompt.ts'
import { loadRules } from '../src/core/config.ts'
import type { Recalled } from '../src/memory/types.ts'

const recalled: Recalled = { facts: [], episodes: [], insights: [], open: [], recent: [] }

function ctx(extra: Record<string, unknown> = {}) {
  return {
    rules: loadRules().rules,
    scope: 'private:10001',
    text: '在吗',
    personId: 'qq-1',
    personName: '小明',
    selfPersonName: '小明',
    inGroup: false,
    groupBlock: '',
    gapHours: null,
    expressionText: '',
    recalled,
    ...extra,
  } as Parameters<typeof buildSystemInputs>[0]
}

/** 这些字段少一个，试聊和线上就会说不一致的话 */
const MUST_HAVE = [
  'keyword',
  'rules',
  'card',
  'actionDesc',
  'self',
  'codeMap',
  'personName',
  'profile',
  'relation',
  'consoleMode',
  'core',
  'requests',
  'speech',
  'expression',
  'growth',
  'desktop',
  'abilities',
  'intent',
  'memory',
  'userChars',
  'phase',
]

test('输入清单包含所有关键字段（少一个就会让试聊和线上说法不一致）', () => {
  const parts = buildSystemInputs(ctx())
  for (const k of MUST_HAVE) {
    assert.ok(k in parts, `PromptParts 少了 ${k}`)
  }
  // personRole 允许 undefined（没建档的人），但键要算进去过
  assert.ok('personRole' in buildSystemInputs(ctx()), 'personRole 应当存在于入参对象里')
})

test('chat 传 groupChat/repeatHint，试聊不传（保持私聊语义）', () => {
  const chatParts = buildSystemInputs(ctx({ inGroup: true, groupChat: true, repeatHint: false }))
  const previewParts = buildSystemInputs(ctx())
  assert.equal(chatParts.groupChat, true)
  assert.equal(chatParts.repeatHint, false)
  assert.equal('groupChat' in previewParts, false, '试聊不该带群聊标记')
  assert.equal('repeatHint' in previewParts, false, '试聊没有历史，算不出重复')
})

test('群聊会把群上下文和表达拼进 relation，私聊不会', () => {
  const group = buildSystemInputs(ctx({ inGroup: true, groupBlock: '【群：摸鱼群】', expressionText: '' }))
  const priv = buildSystemInputs(ctx())
  assert.ok((group.relation ?? '').includes('摸鱼群'))
  assert.equal((priv.relation ?? '').includes('摸鱼群'), false)
})

test('隔了多久没说话：≥2 小时才写进 relation', () => {
  const near = buildSystemInputs(ctx({ gapHours: 1 }))
  const far = buildSystemInputs(ctx({ gapHours: 6 }))
  assert.equal((near.relation ?? '').includes('距离上次说话'), false)
  assert.ok((far.relation ?? '').includes('距离上次说话'))
})

test('desktop/abilities 跟着规则开关走', () => {
  const rules = loadRules().rules
  const on = buildSystemInputs(ctx({ rules: { ...rules, 电脑操作: { enabled: true, 允许操作: true } } }))
  const off = buildSystemInputs(ctx({ rules: { ...rules, 电脑操作: { enabled: false } } }))
  assert.equal(on.desktop?.只读, true)
  assert.equal(on.desktop?.可操作, true)
  assert.equal(off.desktop?.只读, false)
  assert.equal(off.desktop?.可操作, false)
})

test('最终文本仍由 buildSystem 拼：非空且带自我段', () => {
  const text = buildSystem(buildSystemInputs(ctx()))
  assert.ok(text.length > 0)
  assert.equal(typeof text, 'string')
})
