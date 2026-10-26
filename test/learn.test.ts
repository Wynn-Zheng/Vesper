import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { initLog } from '../src/core/log.ts'
import { loadJargon, saveJargon, explainJargon, renderJargon } from '../src/learn/jargon.ts'
import { loadPlays, recordPlay, relevantPlays, renderPlays } from '../src/learn/plays.ts'

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
