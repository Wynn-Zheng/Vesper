/**
 * 一键冒烟：验证从"消息进来"到"记忆落盘再召回"整条链路。
 * 用法：node scripts/smoke.ts        （不花钱，用假数据）
 *      node --env-file=.env scripts/smoke.ts   （额外跑一次真实整理，会调用模型）
 *
 * 全程在临时目录里，绝不碰 persona/ 的真实数据。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, stageOf } from '../src/core/config.ts'
import { initLog } from '../src/core/log.ts'
import { similarity } from '../src/core/text.ts'
import { appendFacts, effectiveConfidence, loadFacts, setVisibility, touchFact } from '../src/memory/facts.ts'
import { recall } from '../src/memory/recall.ts'
import { appendRaw, loadEpisodes, nextEpisodeId, readRaw, saveEpisode, setMemoryRoot, today } from '../src/memory/store.ts'
import { appendOpen, loadOpen } from '../src/people/open.ts'
import { ensurePerson, personIdOf, setPeopleRoot } from '../src/people/store.ts'
import { loadMood, saveMood, decayedMood } from '../src/persona/mood.ts'
import { applyAnchor, loadRelation, saveRelation, setRelationRoot } from '../src/relation/store.ts'
import { EMPTY_RELATION } from '../src/relation/types.ts'

initLog('', false)

const dir = mkdtempSync(join(tmpdir(), 'qqbot-smoke-'))
setMemoryRoot(join(dir, 'memory'))
setPeopleRoot(join(dir, 'people'))
setRelationRoot(join(dir, 'people'))

const pid = personIdOf('qq', '10001')
const today0 = today()

const results: Array<{ name: string; ok: boolean; note?: string }> = []
function check(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, note: String(err).slice(0, 120) })
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/* 1. 建档 */
check('建档：第一次见就建目录', () => {
  const p = ensurePerson('qq', '10001', '小明')
  assert(p.id === pid, `id 不对：${p.id}`)
  assert(p.name === '小明', '名字不对')
})

/* 2. 原文 */
check('原文：写入后能按天读回', () => {
  appendRaw({ ts: Date.now(), scope: 'private:10001', role: 'user', text: '我妈住院了', senderId: '10001' })
  appendRaw({ ts: Date.now(), scope: 'private:10001', role: 'assistant', text: '严重吗' })
  const r = readRaw(today0)
  assert(r.length >= 2, `只读到 ${r.length} 条`)
  assert(r.some((t) => t.text === '我妈住院了'), '没读到原文')
})

/* 3. 事实：写入 / 读取 / 可见性 / 过期 */
check('事实：三档可见性可读回', () => {
  appendFacts(pid, [
    { text: '他12月要考四级', date: today0, confidence: 0.95, visibility: 'public' },
    { text: '他妈妈住院了', date: today0, confidence: 0.9, visibility: 'private' },
    { text: '他最近在减肥', date: today0, confidence: 0.7, visibility: 'unsure' },
  ])
  const f = loadFacts(pid)
  assert(f.length === 3, `读到 ${f.length} 条`)
  assert(f[1]!.visibility === 'private', '可见性错了')
})

check('事实：能改可见性', () => {
  assert(setVisibility(pid, '他最近在减肥', 'public'), '改档失败')
  assert(loadFacts(pid).find((x) => x.text === '他最近在减肥')?.visibility === 'public', '没改成')
})

check('事实：写进去的括号不会破坏格式', () => {
  appendFacts(pid, [{ text: '他喜欢（大概）摇滚', date: today0, confidence: 0.6, visibility: 'public' }])
  const got = loadFacts(pid).find((x) => x.text.includes('摇滚'))
  assert(got, '含括号的事实丢了')
})

check('事实：越久没提，有效置信度越低', () => {
  const old = { text: 'x', date: '2026-01-01', confidence: 1, visibility: 'public' as const }
  const fresh = { ...old, date: today0, lastConfirmed: today0 }
  const a = effectiveConfidence(old, Date.now())
  const b = effectiveConfidence(fresh, Date.now())
  assert(a < b, `旧事实应更不可信：${a} vs ${b}`)
  assert(a < 0.2, `很久没提的应该被滤掉：${a}`)
})

check('事实：再次提到会刷新确认日期', () => {
  appendFacts(pid, [{ text: '他在学英语', date: '2026-01-01', confidence: 0.9, visibility: 'public' }])
  touchFact(pid, '他在学英语', today0)
  const f = loadFacts(pid).find((x) => x.text === '他在学英语')
  assert(f?.lastConfirmed === today0, `确认日期没更新：${f?.lastConfirmed}`)
})

/* 4. 待办 */
check('待办：按人存，别人读不到', () => {
  appendOpen(pid, [{ text: '问问他妈妈手术情况', date: today0, kind: 'todo' }])
  assert(loadOpen(pid).length === 1, '自己读不到')
  assert(loadOpen(personIdOf('qq', '10002')).length === 0, '别人不该读到')
})

/* 5. 经历：id 不冲突 */
check('经历：同一天多次写入不会覆盖', () => {
  const id1 = nextEpisodeId('private:10001', today0)
  saveEpisode({ id: id1, date: today0, scope: 'private:10001', importance: 9, title: '他说他妈住院', body: '语气很平' })
  const id2 = nextEpisodeId('private:10001', today0)
  assert(id1 !== id2, `id 撞了：${id1} / ${id2}`)
  saveEpisode({ id: id2, date: today0, scope: 'private:10001', importance: 3, title: '聊了天气', body: '' })
  assert(loadEpisodes().length === 2, '两段经历应该都在')
})

/* 6. 召回 */
check('召回：相关的排前面', () => {
  const r = recall({
    personId: pid,
    scope: 'private:10001',
    query: '你妈身体怎么样了',
    limit: 5,
    weights: DEFAULTS.记忆.检索.权重,
  })
  assert(r.episodes.length > 0, '一条都没召回')
  assert(r.episodes[0]!.title === '他说他妈住院', `第一条是：${r.episodes[0]!.title}`)
})

check('召回：最近三天的事即使不相关也带上', () => {
  const r = recall({
    personId: pid,
    scope: 'private:10001',
    query: '完全不相关的话题xyz',
    limit: 5,
    weights: DEFAULTS.记忆.检索.权重,
    minScore: 99,
  })
  assert(r.episodes.length > 0, '最近的事应该兜底带上')
})

check('召回：群聊看不到私聊经历', () => {
  const r = recall({
    personId: pid,
    scope: 'group:888',
    query: '住院',
    limit: 5,
    weights: DEFAULTS.记忆.检索.权重,
  })
  assert(!r.episodes.some((e) => e.scope.startsWith('private:')), '群里泄露了私聊记忆')
})

check('召回：群聊不注入私聊待办', () => {
  const r = recall({
    personId: pid,
    scope: 'group:888',
    query: '在吗',
    limit: 5,
    weights: DEFAULTS.记忆.检索.权重,
  })
  assert(r.open.length === 0, '群里带了私聊待办')
})

/* 7. 关系 */
check('关系：锚点能改关系值并落盘', () => {
  const r = applyAnchor(
    structuredClone(EMPTY_RELATION),
    { event: '他说了家里的事', dimension: '信任', direction: 'up', amount: 2, reason: '愿意讲私事' },
    DEFAULTS,
  )
  saveRelation(pid, r.state)
  const back = loadRelation(pid)
  assert(back.closeness === 2, `关系值 ${back.closeness}`)
  assert(back.anchors.length === 1, '锚点没存')
})

check('关系：两个人互不影响', () => {
  assert(loadRelation(personIdOf('qq', '10002')).closeness === 0, '别人不该有关系值')
})

check('关系：没有理由不动', () => {
  const r = applyAnchor(structuredClone(EMPTY_RELATION), { event: 'x', dimension: '信任', direction: 'up', amount: 2, reason: '' }, DEFAULTS)
  assert(r.delta === 0, '没理由却动了')
})

/* 8. 心情 */
check('心情：全局一份，会随时间衰减', () => {
  const now = Date.now()
  saveMood({ emotion: '担心', intensity: 1, at: now })
  assert(loadMood()?.emotion === '担心', '存不进去')
  // 衰减按效价分两档（负面 11 小时、其余 6 小时），8 小时后应该还有残留
  const at8 = decayedMood(loadMood(), now + 8 * 3600_000)
  assert(
    (at8?.intensity ?? 1) > 0.2 && (at8?.intensity ?? 1) < 0.7,
    `8 小时后应在 0.2~0.7，实际 ${at8?.intensity}`,
  )
  // 两天后归零
  assert(decayedMood(loadMood(), now + 48 * 3600_000) === null, '48 小时后应归零')
})

/* 9. 阶段 */
check('阶段：阈值正确', () => {
  assert(stageOf(DEFAULTS, 0).名 === '陌生', '0 应为陌生')
  assert(stageOf(DEFAULTS, 11).名 === '眼熟', '11 应为眼熟')
})

/* 10. 相似度 */
check('相似度：自己和自己为 1', () => {
  assert(similarity('今天有点累', '今天有点累') === 1, '自相似应为 1')
})

/* 汇总 */
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`${mark} ${r.name}${r.note ? `\n     ${r.note}` : ''}`)
}

/* 可选：真模型整理 */
const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
if (apiKey) {
  console.log('')
  console.log('跑一次真实整理（会调用模型）…')
  try {
    const { distill } = await import('../src/memory/distill.ts')
    const turns = readRaw(today0).filter((t) => t.scope === 'private:10001')
    const r = await distill({
      personId: pid,
      scope: 'private:10001',
      turns,
      rules: DEFAULTS,
      llm: {
        apiKey,
        baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
        model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
      },
    })
    console.log(`  整理结果：经历 ${r.episodes} / 事实 ${r.facts} / 待办 ${r.open} / 洞察 ${r.insights}`)
    const after = loadEpisodes().length
    console.log(`  经历总数：${after}（整理前 2）`)
  } catch (err) {
    console.log(`  \x1b[31m整理失败：${String(err).slice(0, 160)}\x1b[0m`)
    failed.push({ name: '真实整理', ok: false })
  }
} else {
  console.log('')
  console.log('（没有 DEEPSEEK_API_KEY，跳过真实整理）')
}

console.log('')
console.log(`${results.length - failed.length} / ${results.length} 通过`)

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

process.exit(failed.length ? 1 : 0)
