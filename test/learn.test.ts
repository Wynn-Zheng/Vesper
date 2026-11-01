import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { initLog } from '../src/core/log.ts'
import { loadJargon, saveJargon, explainJargon, renderJargon } from '../src/learn/jargon.ts'
import { loadPlays, recordPlay, relevantPlays, renderPlays, savePlays } from '../src/learn/plays.ts'
import {
  loadExpressions,
  pickExpressions,
  renderExpressions,
  saveExpressions,
  toggleExpressionChecked,
} from '../src/learn/expression.ts'

initLog('', false)

const dir = mkdtempSync(join(tmpdir(), 'qqbot-learn-'))
process.chdir(dir)

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- 黑话 ---------------- */

test('黑话：存进去能读出来', () => {
  saveJargon('100', [{ word: '典', meaning: '形容某件事很离谱', evidence: '太典了', count: 2, date: '2026-10-25' }])
  const list = loadJargon('100')
  assert.equal(list.length, 1)
  assert.equal(list[0]!.word, '典')
})

test('黑话：不同群互不影响', () => {
  saveJargon('200', [{ word: '绷', meaning: '忍不住笑', evidence: '', count: 1, date: '2026-10-25' }])
  assert.equal(loadJargon('100').length, 1)
  assert.equal(loadJargon('200').length, 1)
  assert.equal(loadJargon('100')[0]!.word, '典')
})

test('黑话：只在说到这个词时才解释', () => {
  saveJargon('300', [
    { word: '典', meaning: '形容离谱', evidence: '', count: 1, date: '2026-10-25' },
    { word: '绷', meaning: '忍不住笑', evidence: '', count: 1, date: '2026-10-25' },
  ])
  const hit = explainJargon('这也太典了', '300')
  assert.equal(hit.length, 1)
  assert.equal(hit[0]!.word, '典')
  assert.equal(explainJargon('今天天气不错', '300').length, 0)
})

test('黑话：渲染成给模型看的文字', () => {
  saveJargon('400', [{ word: '典', meaning: '形容离谱', evidence: '', count: 1, date: '2026-10-25' }])
  const text = renderJargon(explainJargon('太典了', '400'))
  assert.ok(text.includes('典'))
  assert.ok(text.includes('形容离谱'))
})

/* ---------------- 应对经验 ---------------- */

test('经验：分高的记范例，分低的记教训', () => {
  recordPlay(9, '今天好累', '那就早点睡，别硬撑')
  recordPlay(2, '今天好累', '你应该保持积极的心态')
  const items = loadPlays()
  assert.equal(items.length, 2)
  assert.ok(items.some((p) => p.score === 9))
  assert.ok(items.some((p) => p.score === 2))
})

test('经验：中间分不记（没信号）', () => {
  const before = loadPlays().length
  recordPlay(5, '随便一句', '随便一答')
  assert.equal(loadPlays().length, before, '5 分不该被记')
})

test('经验：相似场景能找回来', () => {
  recordPlay(9, '最近工作压力好大', '那就先歇会儿，别一直绷着')
  const hit = relevantPlays('工作压力好大啊')
  assert.ok(hit.length > 0, '相似场景应该能找到')
  assert.ok(hit[0]!.score === 9)
  assert.equal(relevantPlays('完全无关的话题').length, 0, '不相关的不该带出来')
})

test('经验：渲染时好话坏话分开说', () => {
  const text = renderPlays([
    { score: 9, scene: 'a', reply: 'b', date: '2026-10-25' },
    { score: 2, scene: 'c', reply: 'd', date: '2026-10-25' },
  ])
  assert.ok(text.includes('效果不错'))
  assert.ok(text.includes('别这样'))
})

test('经验：重复场景只留一条，不堆一屏', () => {
  const before = loadPlays().length
  recordPlay(9, '今天好累', '那就早点睡')
  recordPlay(9, '今天好累', '去睡吧')
  assert.ok(loadPlays().length <= before + 1)
})

test('经验：空模板不该被当成"文件坏了"去备份', () => {
  // 这条防的是回归：判断"有正文"用的正则如果退化成"以 - 开头"，
  // 空模板里的「- （还没有）」每次保存都会触发一次备份，
  // 之前因为这个在 persona/learned/ 里堆了 270 个空备份文件。
  const dir = join(process.cwd(), 'persona', 'learned')
  const before = readdirSync(dir).filter((f) => f.includes('.bad-')).length
  savePlays([])
  const after = readdirSync(dir).filter((f) => f.includes('.bad-')).length
  assert.equal(after, before, '空模板不该产生备份文件')
})

/* ---------------- 群里的说法 ---------------- */

test('说法：存进去能读出来', () => {
  saveExpressions([{ text: '属实', scene: '表示同意', count: 2, date: '2026-11-01' }])
  const list = loadExpressions()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.text, '属实')
  assert.equal(list[0]!.count, 2)
})

test('说法：按语境挑，不相关的别带出来', () => {
  saveExpressions([
    { text: '属实', scene: '表示同意别人说的话', count: 3, date: '2026-11-01' },
    { text: '抽象', scene: '形容某件事很离谱', count: 1, date: '2026-11-01' },
  ])
  const hit = pickExpressions('这也太抽象了')
  assert.ok(hit.length > 0, '说到「抽象」时应该能带出来')
  assert.equal(hit[0]!.text, '抽象')

  assert.equal(pickExpressions('今天吃什么').length, 0, '完全不相关的不该带出来')
})

test('说法：说法本身出现在句子里，一定算相关', () => {
  saveExpressions([{ text: '绷不住了', scene: '忍不住笑', count: 1, date: '2026-11-01' }])
  const hit = pickExpressions('我绷不住了')
  assert.equal(hit.length, 1)
})

test('说法：只用精选时过滤掉没标星的', () => {
  saveExpressions([
    { text: '属实', scene: '表示同意', count: 3, date: '2026-11-01' },
    { text: '绷不住了', scene: '忍不住笑', count: 1, date: '2026-11-01', checked: true },
  ])
  const only = pickExpressions('属实绷不住了', 3, true)
  assert.equal(only.length, 1)
  assert.equal(only[0]!.text, '绷不住了')
})

test('说法：能标精选', () => {
  saveExpressions([{ text: '属实', scene: '表示同意', count: 3, date: '2026-11-01' }])
  assert.equal(toggleExpressionChecked('属实', true), true)
  assert.equal(loadExpressions()[0]!.checked, true)
  assert.equal(toggleExpressionChecked('不存在的说法', true), false)
})

test('说法：渲染成给模型看的文字', () => {
  const text = renderExpressions([{ text: '属实', scene: '表示同意', count: 1, date: '2026-11-01' }])
  assert.ok(text.includes('属实'))
  assert.ok(text.includes('表示同意'))
  assert.equal(renderExpressions([]), '')
})
