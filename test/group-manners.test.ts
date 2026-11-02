import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripMentions } from '../src/channel/send.ts'
import { mentionsName } from '../src/channel/onebot.ts'
import { buildSystem } from '../src/loop/prompt.ts'
import { DEFAULTS } from '../src/core/config.ts'

/**
 * 群聊里的"人味"与安全边界。
 *
 * 三条都来自外部证据，不是拍脑袋：
 *   - @ 是"加急 + 强义务"，群里点名会给人压力（中青报 2021 / 礼貌研究）；
 *   - LLM 在多人场合会系统性偏早插话，所以必须给它"这次不说"的选项
 *     （PITCH, arXiv:2610.25896）；
 *   - 名字按子串匹配会天天误触发（"小鱼干" → 小鱼），比不回还怪。
 */

/* ---------------- 不要 @ 人 ---------------- */

test('出站：CQ 码形态的 @ 被去掉', () => {
  assert.equal(stripMentions('[CQ:at,qq=123] 你看这个'), ' 你看这个')
})

test('出站：@全体成员 / @所有人 / @everyone 被整段去掉', () => {
  assert.equal(stripMentions('@全体成员 开会了'), ' 开会了')
  assert.equal(stripMentions('@所有人 注意'), ' 注意')
  assert.equal(stripMentions('@everyone hi'), ' hi')
})

test('出站：@昵称 只去掉 @ 符号，名字留着（不然句子会断）', () => {
  assert.equal(stripMentions('@小明 刚才那句'), '小明 刚才那句')
})

test('出站：普通文字和孤立的 @ 不动', () => {
  assert.equal(stripMentions('正常文字'), '正常文字')
  assert.equal(stripMentions('我 @ 你说的是'), '我 @ 你说的是')
})

/* ---------------- 叫名字要词边界 ---------------- */

test('名字：后面紧跟别的字，不算叫她（小鱼干 / 小鱼儿）', () => {
  assert.equal(mentionsName('小鱼干好好吃', ['小鱼']), false)
  assert.equal(mentionsName('今天小鱼儿怎么样', ['小鱼']), false)
  assert.equal(mentionsName('满意', ['小满']), false)
  assert.equal(mentionsName('满满的', ['小满']), false)
})

test('名字：单独出现或以呼语结尾，算叫她', () => {
  assert.equal(mentionsName('小鱼', ['小鱼']), true)
  assert.equal(mentionsName('小鱼在吗', ['小鱼']), true)
  assert.equal(mentionsName('问一下小鱼', ['小鱼']), true)
  assert.equal(mentionsName('小满！', ['小满']), true)
})

test('名字：带空格或标点也算', () => {
  assert.equal(mentionsName('大肥鱼 你在干嘛', ['大肥鱼']), true)
  assert.equal(mentionsName('大肥鱼，出来', ['大肥鱼']), true)
})

test('名字：未定 / 空名字不参与匹配', () => {
  assert.equal(mentionsName('随便说点什么', ['未定', '']), false)
  assert.equal(mentionsName('随便说点什么', []), false)
})

test('名字：不看左边，因为中文没有空格（"问一下小鱼"要能命中）', () => {
  assert.equal(mentionsName('刚喊了小鱼', ['小鱼']), true)
  assert.equal(mentionsName('他刚才问小鱼呢', ['小鱼']), true)
  // 但后面紧跟别的字仍然不算（严格性都放在右边）
  assert.equal(mentionsName('刚喊了小鱼一声', ['小鱼']), false)
})

/* ---------------- prompt：可以不说话 / 不要 @ ---------------- */

test('群聊 prompt：明确给它「这次可以不说话」的选项', () => {
  const s = buildSystem({ rules: DEFAULTS, groupChat: true })
  assert.ok(s.includes('可以选择这次不说话'))
  assert.ok(s.includes('直接返回空内容'))
})

test('群聊 prompt：明确不要 @ 人、不要 @ 全体', () => {
  const s = buildSystem({ rules: DEFAULTS, groupChat: true })
  assert.ok(s.includes('不要 @ 任何人'))
  assert.ok(s.includes('不要 @ 全体成员'))
})

test('私聊 prompt：不加这两条（私聊不存在"插不插话"的问题）', () => {
  const s = buildSystem({ rules: DEFAULTS, groupChat: false })
  assert.equal(s.includes('可以选择这次不说话'), false)
  assert.equal(s.includes('不要 @ 任何人'), false)
  // 人称规则两边都要有
  assert.ok(s.includes('人称别弄反'))
})

/* ---------------- 超时不能重发（会重复发言） ---------------- */

test('引用发送超时：不重发（避免同一句话发两遍）', async () => {
  const { shouldRetryWithoutReply } = await import('../src/channel/onebot.ts')
  assert.equal(shouldRetryWithoutReply(new Error('action send_group_msg 超时')), false)
})

test('引用被撤回/删除（retcode≠0）：可以重发一次', async () => {
  const { shouldRetryWithoutReply } = await import('../src/channel/onebot.ts')
  assert.equal(shouldRetryWithoutReply(new Error('action 失败：消息不存在')), true)
})

test('名字：中文里"名字+你/帮/觉"也是叫她（没有空格和标点）', () => {
  // 这是最常见的一句开场白，以前全被当成"没叫它"，只进旁听不回 ——
  // 用户看到的是"叫了也不理"，比不接话更伤人。
  assert.equal(mentionsName('小满你在吗', ['小满']), true)
  assert.equal(mentionsName('小满帮我看下这个报错', ['小满']), true)
  assert.equal(mentionsName('小满你觉得呢', ['小满']), true)
  assert.equal(mentionsName('小满能听见吗', ['小满']), true)
  assert.equal(mentionsName('小满快出来', ['小满']), true)
  // 但"名字 + 能拼成别的词的字"仍然不算
  assert.equal(mentionsName('小满儿', ['小满']), false)
  assert.equal(mentionsName('满足感', ['小满']), false)
})
