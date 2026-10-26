/**
 * 记忆层体检：src/memory/facts.ts + src/memory/recall.ts
 *
 * 覆盖手工改坏的数据、未来/无效日期、并发追加、可见性矩阵和空库召回。
 * 全部在临时目录里跑，不碰 persona/ 下的真实数据。
 * 运行：node scripts/test-memory-bugs.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { peopleRoot, personIdOf, setPeopleRoot } from '../src/people/store.ts'
import { setMemoryRoot, saveEpisode, loadEpisodes } from '../src/memory/store.ts'
import {
  appendFacts,
  deleteFact,
  effectiveConfidence,
  factsFilePath,
  isDeleted,
  loadDeleted,
  loadFacts,
  type PersonFact,
} from '../src/memory/facts.ts'
import { flushRecalls, lambdaOf, recall, visible } from '../src/memory/recall.ts'
import { drainWrites } from '../src/store/serialize.ts'
import type { Scope } from '../src/memory/types.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-bugs-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const weights = { 新近: 0.5, 相关: 3, 重要: 2 }
/** 固定一个"现在"，避免测试结果跟着机器日期漂 */
const NOW = Date.parse('2026-06-01T00:00:00')

/** 每个场景用独立的 memory/people 根，互不影响 */
function useRoots(name: string): void {
  const base = join(dir, name)
  setMemoryRoot(join(base, 'memory'))
  setPeopleRoot(join(base, 'people'))
  mkdirSync(join(base, 'memory'), { recursive: true })
  mkdirSync(join(base, 'people'), { recursive: true })
}

/* ---------- 1. 手工改坏的 facts.md ---------- */
console.log('=== 1. loadFacts 面对坏文件 ===')
{
  useRoots('facts-broken')
  const pid = personIdOf('qq', '10001')
  const f = factsFilePath(pid)
  mkdirSync(dirname(f), { recursive: true })

  writeFileSync(
    f,
    [
      '# 关于这个人的事实',
      '',
      '- 正常事实（2026-05-01，置信 0.9，公开）',
      '   ',
      '- 老格式（2026-05-02，置信 0.8）',
      '- 可见性写错（2026-05-03，置信 0.7，公开的）',
      '- 未知标签（2026-05-04，置信 0.6，随便）',
      '- 缺置信（2026-05-05，公开）',
      '- 置信乱码（2026-05-06，置信 abc，公开）',
      '- 缺日期（置信 0.5，公开）',
      '- 半行（2026-05-07，置信 0.4',
      '- 带确认日期（2026-05-08，置信 0.9，确认 2026-05-09，私密）｜他亲口说的',
      '- 待确认（2026-05-10，置信 0.5，待确认）',
    ].join('\r\n'),
    'utf8',
  )

  let facts: PersonFact[] = []
  let threw = false
  try {
    facts = loadFacts(pid)
  } catch {
    threw = true
  }
  const byText = new Map(facts.map((x) => [x.text, x]))

  check('坏 facts.md 不抛错', !threw)
  check('正常行能读出', byText.get('正常事实')?.visibility === 'public')
  check('空行和缺字段行只跳过，不影响其他行', facts.length === 6, `读到 ${facts.length} 条：${facts.map((x) => x.text).join(',')}`)
  check('老格式没有可见性时按私密', byText.get('老格式')?.visibility === 'private')
  check('可见性写错按最保守的私密收下', byText.get('可见性写错')?.visibility === 'private')
  check('未知可见性也不丢文字', byText.get('未知标签')?.visibility === 'private')
  check(
    '确认日期和来源能读回',
    byText.get('带确认日期')?.lastConfirmed === '2026-05-09' && byText.get('带确认日期')?.source === '他亲口说的',
  )
  check('所有置信度都是有限数', facts.every((x) => Number.isFinite(x.confidence)))
  check(
    '缺日期/缺置信/乱码/半行没有被瞎猜成事实',
    !byText.has('缺置信') && !byText.has('置信乱码') && !byText.has('缺日期') && !byText.has('半行'),
  )
}

/* ---------- 2. effectiveConfidence 的日期边界 ---------- */
console.log('\n=== 2. effectiveConfidence 日期边界 ===')
{
  const base: PersonFact = { text: 'x', date: '2026-01-01', confidence: 0.8, visibility: 'public' }

  const future = effectiveConfidence({ ...base, lastConfirmed: '2099-01-01' }, NOW)
  check('未来确认日期当作刚确认，不超过本身置信度', Number.isFinite(future) && future === 0.8, String(future))

  const invalid = effectiveConfidence({ ...base, lastConfirmed: '不是日期' }, NOW)
  check('无效确认日期退回首次记录日期并正常衰减', Number.isFinite(invalid) && invalid < 0.2, String(invalid))

  const bothBad = effectiveConfidence({ ...base, date: '坏日期', lastConfirmed: '也坏' }, NOW)
  check('两个日期都坏时返回有限值、不崩', Number.isFinite(bothBad) && bothBad === 0.8, String(bothBad))

  const over = effectiveConfidence({ ...base, confidence: 1.7, lastConfirmed: '2026-06-01' }, NOW)
  check('置信度超过 1 被夹到 1', over === 1, String(over))

  const nan = effectiveConfidence({ ...base, confidence: Number.NaN, lastConfirmed: '2026-06-01' }, NOW)
  check('置信度 NaN 按 0 处理', nan === 0, String(nan))

  const futureNow = effectiveConfidence({ ...base, lastConfirmed: '2026-06-02' }, NOW)
  check('确认日期在未来时不产生负衰减', futureNow === 0.8, String(futureNow))
}

/* ---------- 3. deleteFact 删不存在的条目 ---------- */
console.log('\n=== 3. deleteFact 删不存在 ===')
{
  useRoots('facts-delete')
  const pid = personIdOf('qq', '10002')
  appendFacts(pid, [{ text: '他不吃香菜', date: '2026-05-01', confidence: 0.9, visibility: 'public' }])
  const before = readFileSync(factsFilePath(pid), 'utf8')

  let threw = false
  let missing = false
  let empty = false
  try {
    missing = deleteFact(pid, '根本不存在的另一件事')
    empty = deleteFact(pid, '')
  } catch {
    threw = true
  }
  check('删不存在的条目返回 false 且不抛错', !threw && missing === false && empty === false)
  check('删失败不破坏原文件', readFileSync(factsFilePath(pid), 'utf8') === before)

  const noFile = personIdOf('qq', '10003')
  check('文件不存在时也返回 false', deleteFact(noFile, '随便') === false)
  check('删已有条目返回 true', deleteFact(pid, '他不吃香菜') === true && loadFacts(pid).length === 0)
}

/* ---------- 4. isDeleted 的黑名单坏掉 ---------- */
console.log('\n=== 4. isDeleted 黑名单坏文件 ===')
{
  useRoots('facts-deleted')
  const pid = personIdOf('qq', '10004')
  mkdirSync(join(peopleRoot(), pid), { recursive: true })
  writeFileSync(
    join(peopleRoot(), pid, 'deleted.jsonl'),
    [
      '这不是 jsonl',
      '{"text":"删过的事实"}',
      'null',
      '[1,2,3]',
      '{"text":123}',
      '{"broken":',
      '{"text":"另一条删过的"}',
    ].join('\n'),
    'utf8',
  )

  let deleted: string[] = []
  let threw = false
  try {
    deleted = loadDeleted(pid)
  } catch {
    threw = true
  }
  check('不是 JSONL 也不抛错', !threw)
  check('坏行跳过，好的记录还能读', deleted.join('|') === '删过的事实|另一条删过的', deleted.join('|'))
  check('命中的条目 isDeleted 为 true', isDeleted(pid, '删过的事实') && isDeleted(pid, '另一条删过的'))
  check('无关条目 isDeleted 为 false', !isDeleted(pid, '完全无关的事'))

  // 极端情况：路径被占成目录，读文件会抛 EISDIR
  const dirPid = personIdOf('qq', '10005')
  mkdirSync(join(peopleRoot(), dirPid, 'deleted.jsonl'), { recursive: true })
  let dirThrew = false
  let dirDeleted = true
  try {
    dirDeleted = isDeleted(dirPid, '随便')
  } catch {
    dirThrew = true
  }
  check('黑名单路径是目录时也不抛错（按空黑名单处理）', !dirThrew && dirDeleted === false)
}

/* ---------- 5. appendFacts 并发 10 次 ---------- */
console.log('\n=== 5. appendFacts 并发 10 次 ===')
{
  useRoots('facts-concurrent')
  const pid = personIdOf('qq', '10006')
  const items: PersonFact[] = Array.from({ length: 10 }, (_, i) => ({
    text: `并发事实 ${i}`,
    date: '2026-05-01',
    confidence: 0.8,
    visibility: 'public',
  }))

  let threw = false
  try {
    await Promise.all(items.map((item) => Promise.resolve().then(() => appendFacts(pid, [item]))))
    await drainWrites()
  } catch {
    threw = true
  }

  const got = loadFacts(pid)
  check('10 次并发追加不抛错', !threw)
  check('10 条一条不少', got.length === 10, `读到 ${got.length} 条`)
  check('10 条没有重复、没有互相覆盖', new Set(got.map((f) => f.text)).size === 10)

  const leftovers = readdirSync(dirname(factsFilePath(pid))).filter((n) => n.endsWith('.tmp'))
  check('没有残留 .tmp', leftovers.length === 0, leftovers.join(','))
}

/* ---------- 6. visible 可见性矩阵 ---------- */
console.log('\n=== 6. visible 可见性矩阵 ===')
{
  const cases: Array<[Scope, Scope, boolean]> = [
    // 当前是私聊：自己 + shared，别人的私聊和群聊都不可见
    ['shared', 'private:1', true],
    ['private:1', 'private:1', true],
    ['private:2', 'private:1', false],
    ['group:9', 'private:1', false],
    ['shared', 'private:2', true],
    ['private:2', 'private:2', true],
    ['private:1', 'private:2', false],
    // 当前是群聊：shared + 本群，任何私聊都不可见
    ['shared', 'group:9', true],
    ['group:9', 'group:9', true],
    ['group:8', 'group:9', false],
    ['private:1', 'group:9', false],
    ['private:2', 'group:9', false],
    ['shared', 'group:8', true],
    ['group:8', 'group:8', true],
    ['group:9', 'group:8', false],
    // 当前是 shared：只有 shared
    ['shared', 'shared', true],
    ['private:1', 'shared', false],
    ['private:2', 'shared', false],
    ['group:9', 'shared', false],
  ]

  const bad: string[] = []
  for (const [scope, current, want] of cases) {
    const got = visible(scope, current)
    if (got !== want) bad.push(`${scope} -> ${current}: 期望 ${want}，实际 ${got}`)
  }
  check('shared/private/group 可见性矩阵全部符合预期', bad.length === 0, bad.join('; '))
  check('私聊绝看不到别人的私聊', !visible('private:2', 'private:1') && !visible('private:1', 'private:2'))
  check('群聊看不到任何私聊', !visible('private:1', 'group:9') && !visible('private:2', 'group:8'))
  check('shared 在私聊和群聊里都可见', visible('shared', 'private:1') && visible('shared', 'group:9'))
}

/* ---------- 7. recall 空数据 ---------- */
console.log('\n=== 7. recall 空数据 ===')
{
  useRoots('recall-empty')
  const pid = personIdOf('qq', '10007')
  let r: ReturnType<typeof recall> | null = null
  let threw = false
  try {
    r = recall({ personId: pid, scope: 'private:1', query: '', limit: 5, weights, now: NOW })
  } catch {
    threw = true
  }
  check('episodes/facts/query 都为空时不抛错', !threw && r !== null)
  check(
    '空数据返回空结构',
    !!r && r.facts.length === 0 && r.episodes.length === 0 && r.insights.length === 0 && r.open.length === 0 && r.recent.length === 0,
  )
}

{
  useRoots('recall-empty-episodes')
  const pid = personIdOf('qq', '10008')
  appendFacts(pid, [{ text: '只有事实没有经历', date: '2026-05-30', confidence: 0.9, visibility: 'public' }])
  const r = recall({ personId: pid, scope: 'private:1', query: '', limit: 5, weights, now: NOW })
  check('只有 facts、episodes 为空时也不崩', r.facts.length === 1 && r.episodes.length === 0)
}

{
  useRoots('recall-empty-facts')
  const pid = personIdOf('qq', '10008')
  saveEpisode({
    id: '2026-05-31-01',
    date: '2026-05-31',
    scope: 'private:1',
    importance: 5,
    title: '最近的事',
    body: '正文',
  })
  const r = recall({ personId: pid, scope: 'private:1', query: '', limit: 5, weights, now: NOW })
  check('没有 facts 时仍能召回经历', r.facts.length === 0 && r.episodes.length === 1)
  flushRecalls()
}

/* ---------- 8. lambdaOf importance 边界 ---------- */
console.log('\n=== 8. lambdaOf importance 边界 ===')
{
  const normal = lambdaOf(7)
  const high = lambdaOf(8)
  check('importance 10 用高情绪衰减', lambdaOf(10) === 0.005)
  check('importance 8 是高档边界', high === 0.005)
  check('importance 7 仍是普通档', normal === 0.02)
  check('importance 5 是普通档边界', lambdaOf(5) === 0.02)
  check('importance 0 / -1 用最快衰减', lambdaOf(0) === 0.04 && lambdaOf(-1) === 0.04)
  check('重要的事忘得更慢：high < normal < 低重要', high < normal && normal < lambdaOf(0))
  check('自定义衰减配置生效', lambdaOf(10, { 高情绪: 0.1, 普通: 0.3 }) === 0.1 && lambdaOf(0, { 普通: 0.3 }) === 0.6)
  check('importance 是 NaN 时也返回有限值', Number.isFinite(lambdaOf(Number.NaN)))
}

/* ---------- 9. 附加：同名 episode 不跨 scope 串 ---------- */
console.log('\n=== 9. 附加：同 id 的 episode 不跨 scope 串 ===')
{
  useRoots('recall-same-id')
  const pid = personIdOf('qq', '10009')
  const date = '2026-05-31'
  // 同一天、两个 scope 都会生成 2026-05-31-01
  saveEpisode({ id: `${date}-01`, date, scope: 'shared', importance: 5, title: '公共同号', body: '' })
  saveEpisode({ id: `${date}-01`, date, scope: 'private:1', importance: 5, title: '私聊同号', body: '' })
  const r = recall({ personId: pid, scope: 'private:1', query: '', limit: 5, weights, now: NOW })
  const titles = r.episodes.map((e) => e.title)
  check('同 id 的 shared/private 经历都能召回', titles.includes('公共同号') && titles.includes('私聊同号'), titles.join(','))
  flushRecalls()
}

{
  useRoots('recall-mark-scope')
  const pid = personIdOf('qq', '10010')
  const id = '2026-01-01-01'
  saveEpisode({ id, date: '2026-01-01', scope: 'shared', importance: 1, title: '公共无关', body: '' })
  saveEpisode({ id, date: '2026-01-01', scope: 'private:1', importance: 5, title: '想确认的事', body: '' })

  const r = recall({
    personId: pid,
    scope: 'private:1',
    query: '想确认的事',
    limit: 5,
    weights: { 新近: 0.1, 相关: 10, 重要: 0 },
    minScore: 5,
    now: NOW,
  })
  check('高分筛选只召回相关的那条', r.episodes.length === 1 && r.episodes[0]?.title === '想确认的事', r.episodes.map((e) => e.title).join(','))

  flushRecalls()
  const eps = loadEpisodes()
  const priv = eps.find((e) => e.scope === 'private:1' && e.id === id)
  const shared = eps.find((e) => e.scope === 'shared' && e.id === id)
  check(
    '召回记账只标当前 scope，不误标同 id 的公共经历',
    (priv?.lastRecalled ?? 0) > 0 && !(shared?.lastRecalled && shared.lastRecalled > 0),
    `private=${priv?.lastRecalled ?? 0}, shared=${shared?.lastRecalled ?? 0}`,
  )
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
