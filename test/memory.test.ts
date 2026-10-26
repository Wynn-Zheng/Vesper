import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setPeopleRoot, personIdOf } from '../src/people/store.ts'
import { appendOpen, loadOpen } from '../src/people/open.ts'
import { appendFacts, loadFacts, setVisibility } from '../src/memory/facts.ts'
import { recall, similarity, visible } from '../src/memory/recall.ts'
import { appendRaw, loadEpisodes, saveEpisode, setMemoryRoot, today } from '../src/memory/store.ts'

const dir = mkdtempSync(join(tmpdir(), 'qqbot-mem-'))
setMemoryRoot(dir)
setPeopleRoot(join(dir, 'people'))

const pid = personIdOf('qq', '1')
const other = personIdOf('qq', '2')

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const weights = { 新近: 0.5, 相关: 3.0, 重要: 2.0 }

test('二元组相似度：相同为 1，无关接近 0', () => {
  assert.equal(similarity('今天有点累', '今天有点累'), 1)
  assert.ok(similarity('今天有点累', '我妈住院了') < 0.2)
  assert.ok(similarity('妈妈住院', '我妈住院了') > 0.3)
})

test('可见性：私聊只看自己和公共的，群聊只看本群和公共的', () => {
  // 私聊：自己 + shared，看不到别人的私聊、也看不到群聊
  assert.equal(visible('private:1', 'private:1'), true)
  assert.equal(visible('shared', 'private:1'), true)
  assert.equal(visible('private:2', 'private:1'), false, '别人的私聊绝不可见')
  assert.equal(visible('group:9', 'private:1'), false, '私聊里不带群聊的事')

  // 群聊：shared + 本群，看不到任何私聊
  assert.equal(visible('shared', 'group:9'), true)
  assert.equal(visible('group:9', 'group:9'), true)
  assert.equal(visible('group:8', 'group:9'), false)
  assert.equal(visible('private:1', 'group:9'), false)
})

test('raw 落盘与读取', () => {
  appendRaw({ ts: Date.now(), scope: 'private:1', role: 'user', text: '在吗' })
  appendRaw({ ts: Date.now(), scope: 'private:1', role: 'assistant', text: '在' })
  const r = recall({ personId: pid, scope: 'private:1', query: '在吗', limit: 5, weights })
  assert.ok(r.recent.length >= 2)
})

test('episode 保存与加载', () => {
  saveEpisode({
    id: `${today()}-01`,
    date: today(),
    scope: 'private:1',
    importance: 9,
    emotion: '担心',
    title: '他说他妈住院了',
    body: '语气很平，我觉得他在硬撑。',
  })
  const eps = loadEpisodes()
  assert.equal(eps.length, 1)
  assert.equal(eps[0]!.title, '他说他妈住院了')
  assert.equal(eps[0]!.importance, 9)
  assert.ok(eps[0]!.body.includes('硬撑'))
})

test('事实按人存，带可见性', () => {
  appendFacts(pid, [
    { text: '他不吃香菜', date: today(), confidence: 0.9, visibility: 'public' },
    { text: '他妈妈住院', date: today(), confidence: 0.95, visibility: 'private' },
    { text: '他最近在减肥', date: today(), confidence: 0.7, visibility: 'unsure' },
  ])
  const f = loadFacts(pid)
  assert.equal(f.length, 3)
  assert.equal(f[0]!.visibility, 'public')
  assert.equal(f[1]!.visibility, 'private')
  assert.equal(f[2]!.visibility, 'unsure')

  // 别人的事实读不到
  assert.equal(loadFacts(other).length, 0)
})

test('改一条事实的可见性', () => {
  assert.equal(setVisibility(pid, '他最近在减肥', 'public'), true)
  const f = loadFacts(pid)
  const item = f.find((x) => x.text === '他最近在减肥')
  assert.equal(item?.visibility, 'public')
})

test('待办按人存', () => {
  appendOpen(pid, [{ text: '问问他妈妈的情况', date: today(), kind: 'todo' }])
  assert.equal(loadOpen(pid).length, 1)
  assert.equal(loadOpen(other).length, 0)
})

test('检索：相关度高的 episode 排前面', () => {
  saveEpisode({
    id: `${today()}-02`,
    date: today(),
    scope: 'private:1',
    importance: 3,
    title: '聊了天气',
    body: '今天下雨了。',
  })
  const r = recall({ personId: pid, scope: 'private:1', query: '你妈身体怎么样了', limit: 5, weights })
  assert.equal(r.episodes[0]!.title, '他说他妈住院了')
})

test('群聊检索看不到私聊 episode', () => {
  saveEpisode({
    id: `${today()}-03`,
    date: today(),
    scope: 'group:9',
    importance: 5,
    title: '群里聊游戏',
    body: '他们在说一个游戏。',
  })
  const groupHit = recall({ personId: pid, scope: 'group:9', query: '住院', limit: 5, weights })
  assert.ok(!groupHit.episodes.some((e) => e.title === '他说他妈住院了'), '群里不能看到私聊记忆')
})

test('私聊检索看不到别人的私聊 episode', () => {
  // 另一个人（qq-2）的私聊经历
  saveEpisode({
    id: `${today()}-04`,
    date: today(),
    scope: 'private:2',
    importance: 9,
    title: '他说他要离婚',
    body: '这是别人的私事。',
  })
  const r = recall({ personId: pid, scope: 'private:1', query: '离婚 私事', limit: 8, weights })
  assert.ok(!r.episodes.some((e) => e.title === '他说他要离婚'), '不能看到别人的私聊经历')
})

test('私聊也看不到别人的群聊以外的东西，但能看到 shared', () => {
  saveEpisode({
    id: `${today()}-05`,
    date: today(),
    scope: 'shared',
    importance: 4,
    title: '公共的事',
    body: '大家都能知道。',
  })
  const r = recall({ personId: pid, scope: 'private:1', query: '公共', limit: 8, weights })
  assert.ok(r.episodes.some((e) => e.title === '公共的事'), 'shared 应该能看到')
})

test('群聊只注入公开事实，私密的不带进公共场合', () => {
  const r = recall({ personId: pid, scope: 'group:9', query: '香菜 减肥', limit: 5, weights })
  assert.ok(r.facts.every((f) => f.visibility === 'public'), '群里只该看到公开事实')
  const private_ = recall({ personId: pid, scope: 'private:1', query: '香菜 减肥', limit: 5, weights })
  assert.ok(private_.facts.some((f) => f.visibility === 'private'), '私聊应该能看到私密事实')
})

test('检索带最低分时，低分的被滤掉，但最近三天的事仍然带上', () => {
  const r = recall({ personId: pid, scope: 'private:1', query: '完全不相关的话题xyz', limit: 5, weights, minScore: 99 })
  // 高分结果一个都没有，但"最近三天无条件带上"仍然生效
  assert.ok(r.episodes.every((e) => e.date === today()), '兜底带上的只能是最近的')
  assert.ok(r.episodes.length <= 3, '兜底最多 3 条')
})
