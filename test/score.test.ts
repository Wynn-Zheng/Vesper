import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scoreReply, type ScoreParts } from '../src/loop/score.ts'

const base: ScoreParts = {
  addressed: false,
  isPrivate: false,
  followUp: false,
  text: '你好',
  idleMinutes: 0,
  recentReplies: 0,
  talkValue: 0.4,
}

const at = (over: Partial<ScoreParts>): ScoreParts => ({ ...base, ...over })

test('被打断：@ 和私聊直接放行', () => {
  assert.equal(scoreReply(at({ addressed: true })).probability, 1)
  assert.equal(scoreReply(at({ isPrivate: true })).probability, 1)
})

test('「嗯」不该回，提问该更想回', () => {
  const ack = scoreReply(at({ text: '嗯' }))
  const question = scoreReply(at({ text: '你在干嘛' }))
  assert.ok(ack.probability < 0.1, `「嗯」应该很低，实际 ${ack.probability}`)
  assert.ok(question.probability > ack.probability, '提问应该比应一声更想回')
})

test('求帮忙比普通陈述更想回', () => {
  const plain = scoreReply(at({ text: '今天下雨了' }))
  const request = scoreReply(at({ text: '帮我看看这个' }))
  assert.ok(request.probability > plain.probability)
})

test('连续对话会加分', () => {
  const cold = scoreReply(at({ text: '那你呢' }))
  const warm = scoreReply(at({ text: '那你呢', followUp: true }))
  assert.ok(warm.probability > cold.probability)
})

test('很久没说话会更想开口', () => {
  const idle = scoreReply(at({ text: '今天天气不错', idleMinutes: 180 }))
  const busy = scoreReply(at({ text: '今天天气不错', idleMinutes: 1 }))
  assert.ok(idle.probability > busy.probability)
})

test('刚说太多会被压住', () => {
  const first = scoreReply(at({ text: '你在干嘛' }))
  const spam = scoreReply(at({ text: '你在干嘛', recentReplies: 4 }))
  assert.ok(spam.probability < first.probability, '刚说太多应该更不想回')
  assert.equal(spam.probability, 0, '连续 4 次后应该闭嘴')
})

test('深夜活跃度低时更安静', () => {
  const night = scoreReply(at({ text: '今天天气不错', talkValue: 0.15 }))
  const evening = scoreReply(at({ text: '今天天气不错', talkValue: 0.6 }))
  assert.ok(night.probability < evening.probability)
})

test('打分带上理由，方便看日志', () => {
  const r = scoreReply(at({ text: '你觉得呢', followUp: true }))
  assert.ok(r.reasons.length > 0)
  assert.ok(r.reasons.some((x) => x.includes('接着刚才') || x.includes('意见')))
})

test('分数被夹在 0~100', () => {
  const high = scoreReply(at({ text: '帮我 你觉得 为什么 能不能', followUp: true, idleMinutes: 500, talkValue: 1 }))
  const low = scoreReply(at({ text: '嗯', recentReplies: 5 }))
  assert.ok(high.score <= 100)
  assert.ok(low.score >= 0)
})

test('配置写错（NaN）不会让它永远闭嘴', () => {
  const r = scoreReply(at({ text: '在吗', talkValue: Number.NaN }))
  assert.ok(!Number.isNaN(r.probability), 'probability 不能是 NaN')
  assert.ok(r.probability >= 0 && r.probability <= 1)
})

test('第一次说话时 idleMinutes 不会算成天文数字', () => {
  const now = Date.now()
  const huge = (now - 0) / 60_000 // lastTalk 为 0 的情况
  const r = scoreReply(at({ text: '在吗', idleMinutes: huge }))
  assert.ok(r.score <= 100, '分数不该因为时间戳为 0 就爆表')
})