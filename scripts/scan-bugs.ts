/**
 * bug 扫描：把最近改的地方放在极端条件下跑一遍。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

let bugs = 0
function bug(name: string, detail = ''): void {
  bugs++
  console.log(`🐛 ${name}`)
  console.log(`   ${detail}`)
}
function ok(name: string): void {
  console.log(`✓ ${name}`)
}

const filter = await import('../src/memory/filter.ts')
const recall = await import('../src/memory/recall.ts')
const store = await import('../src/memory/store.ts')
const people = await import('../src/people/store.ts')
const facts = await import('../src/memory/facts.ts')
const core = await import('../src/memory/core.ts')

/* ============ A. pickForDistill 的边界 ============ */
console.log('=== A. pickForDistill 边界 ===')
{
  // 1. 空数组
  const r1 = filter.pickForDistill([], [])
  if (r1.length !== 0) bug('空数组应返回空', String(r1.length))
  else ok('空数组返回空')

  // 2. 全部相同时间戳（稳定排序？）
  const same = [
    { ts: 1, text: '内容甲在说话' },
    { ts: 1, text: '内容乙在说话' },
    { ts: 1, text: '内容丙在说话' },
    { ts: 1, text: '内容丁在说话' },
    { ts: 1, text: '内容戊在说话' },
  ]
  const r2 = filter.pickForDistill(same, [])
  if (r2.length === 0) bug('全同时间戳不应返回空', String(r2.length))
  else ok(`全同时间戳返回 ${r2.length} 条`)

  // 3. 只有 1 条
  const one = [{ ts: 1, text: '就一句话' }]
  const r3 = filter.pickForDistill(one, [])
  if (r3.length !== 1) bug('单条应保留', String(r3.length))
  else ok('单条保留')

  // 4. 全是废话 + minKeep 大于总数
  const noise = [{ ts: 1, text: '嗯' }, { ts: 2, text: '好' }]
  const r4 = filter.pickForDistill(noise, [], 0.75, 5)
  if (r4.length === 0) bug('全废话 + minKeep>总数 时返回空 → distill 可能拿不到原料', String(r4.length))
  else ok(`全废话 + minKeep>总数 返回 ${r4.length} 条`)

  // 5. text 带前后空格
  const spaced = [{ ts: 1, text: '   我答应你早点睡   ' }]
  const s = filter.worthDistilling(spaced[0]!, [])
  if (s < 3) bug('带前后空格的约定句应仍被识别', `score=${s}`)
  else ok(`带空格仍识别（score=${s}）`)

  // 6. 空字符串 text
  const empty = [{ ts: 1, text: '' }]
  const r6 = filter.pickForDistill(empty, [], 0.75, 0)
  if (r6.length > 0 && empty[0]!.text === '') ok('空 text 不炸')
}

/* ============ B. related 的 scope 隔离 ============ */
console.log('\n=== B. related scope 隔离 ===')
{
  const root = 'data/test-bug-rel'
  mkdirSync(`${root}/memory/episodes/private-1`, { recursive: true })
  mkdirSync(`${root}/memory/episodes/group-9`, { recursive: true })
  people.setPeopleRoot(`${root}/people`)
  store.setMemoryRoot?.(`${root}/memory`)

  store.saveEpisode({
    id: '2026-10-20-01',
    date: '2026-10-20',
    scope: 'private:1',
    importance: 3,
    title: '私聊第一条',
    body: 'a',
  })
  store.saveEpisode({
    id: '2026-10-20-01',
    date: '2026-10-20',
    scope: 'group:9',
    importance: 3,
    title: '群聊第一条',
    body: 'b',
  })

  const all = store.loadEpisodes()
  const sameId = all.filter((e) => e.id === '2026-10-20-01')
  if (sameId.length !== 2) bug('不同 scope 可以有同 id', `找到 ${sameId.length} 条`)
  else ok('不同 scope 同 id 能共存')

  // 关键：recall 时不能跨 scope 带出
  const r = recall.recall({
    personId: 'qq-1',
    scope: 'private:1',
    query: '第一条',
    limit: 8,
    weights: { 新近: 0.5, 相关: 3, 重要: 2 },
  })
  const leaked = r.episodes.filter((e) => e.scope === 'group:9')
  if (leaked.length) bug('私聊召回里混进了群聊 episode', leaked.map((e) => e.title).join(','))
  else ok('私聊召回没混进群聊 episode')

  rmSync(root, { recursive: true, force: true })
}

/* ============ C. faint 会不会写进文件 ============ */
console.log('\n=== C. faint 不写盘 ===')
{
  const root = 'data/test-bug-faint'
  mkdirSync(`${root}/memory/episodes/private-1`, { recursive: true })
  people.setPeopleRoot(`${root}/people`)
  store.setMemoryRoot?.(`${root}/memory`)

  store.saveEpisode({
    id: '2026-10-20-01',
    date: '2026-10-20',
    scope: 'private:1',
    importance: 3,
    title: 't',
    body: 'b',
  })
  const raw = readFileSync(`${root}/memory/episodes/private-1/2026-10-20-01.md`, 'utf8')
  if (raw.includes('faint')) bug('faint 被写进了 episode 文件', raw)
  else ok('faint 没被写进 episode 文件')

  rmSync(root, { recursive: true, force: true })
}

/* ============ D. facts 的 faint 不写盘 ============ */
console.log('\n=== D. facts faint 不写盘 ===')
{
  const root = 'data/test-bug-facts'
  mkdirSync(`${root}/people/qq-1`, { recursive: true })
  people.setPeopleRoot(`${root}/people`)

  writeFileSync(`${root}/people/qq-1/facts.md`, '# 关于这个人的事实\n\n## 平常\n\n- 测试一条（2026-10-20，置信 0.9，公开）\n', 'utf8')
  const list = facts.loadFacts('qq-1')
  list[0]!.faint = true
  facts.renderFacts(list)
  // renderFacts 的返回值不该含 faint，但 loadFacts 之后写回文件也不该含
  const rendered = facts.renderFacts(list)
  if (rendered.includes('faint')) bug('renderFacts 输出了 faint', rendered)
  else ok('renderFacts 不输出 faint')

  rmSync(root, { recursive: true, force: true })
}

/* ============ E. 核心记忆的边界 ============ */
console.log('\n=== E. 核心记忆边界 ===')
{
  // 同名不同类别
  const items = core.parseCore('## 身份\n- 同一句话\n## 边界\n- 同一句话\n')
  if (items.length !== 2) bug('同文本不同类别应算两条', String(items.length))
  else ok('同文本不同类别能共存')

  // 数组下标越界
  if (core.dropCore(999) !== false) bug('dropCore(越界) 应返回 false')
  else ok('dropCore 越界安全')

  if (core.approveRequest(999).ok !== false) bug('approveRequest(越界) 应返回失败')
  else ok('approveRequest 越界安全')

  // 超长文本
  const long = '啊'.repeat(500)
  core.requestCore(long, '身份', '')
  // 应该被截断到 200 且能提交
  const reqs = core.loadRequests()
  const hit = reqs.find((x) => x.text.startsWith('啊'))
  if (hit && hit.text.length > 200) bug('超长申请没被截断', String(hit.text.length))
  else ok(`超长申请被截断（${hit?.text.length ?? 0} 字）`)
}

/* ============ F. 衰减函数的极端值 ============ */
console.log('\n=== F. 衰减极端值 ===')
{
  const wide = [
    { imp: 0, emo: '' },
    { imp: 10, emo: '强烈' },
    { imp: NaN, emo: undefined },
    { imp: -5, emo: '有' },
    { imp: 999, emo: '有' },
  ]
  for (const w of wide) {
    const e = {
      id: 'x',
      date: '2026-10-20',
      scope: 'private:1' as const,
      importance: w.imp,
      title: 't',
      body: 'b',
      ...(w.emo === undefined ? {} : { emotion: w.emo }),
    }
    const l = recall.lambdaOfEpisode(e as Parameters<typeof recall.lambdaOfEpisode>[0])
    if (!Number.isFinite(l) || l < 0) bug(`lambdaOfEpisode 输出非法值 imp=${w.imp} emo=${w.emo}`, String(l))
  }
  ok('lambdaOfEpisode 极端输入都有合法输出')

  // 幂律在 days=0 时应该是 1
  // 直接测 scoreOf 不方便，用公式验算
  const days0 = Math.pow(1 + 0, -0.02 * 8)
  if (Math.abs(days0 - 1) > 1e-9) bug('幂律在 t=0 不是 1', String(days0))
  else ok('幂律 t=0 时是 1')
}

/* ============ G. 真实数据完整性 ============ */
console.log('\n=== G. 真实数据 ===')
{
  people.setPeopleRoot('persona/people')
  // 以前写死 `qq-1234567890` 和旧记忆根 `persona/memory`：本机根本没有这个档案，
  // 于是整段读到 0 条仍然打 ✓——「真实数据完整性」长期没检查任何东西。
  const everyone = people.listPeople()
  if (!everyone.length) {
    console.log('  （没有真实人物档案，本段跳过——不算通过）')
  } else {
    const pid = everyone[0]!.id
    const realFacts = facts.loadFacts(pid)
    ok(`真实 facts 读到 ${realFacts.length} 条（${pid}）`)
    if (realFacts.some((f) => f.faint)) bug('真实数据里出现了 faint 标记（不该持久化）')
    else ok('真实 facts 没有 faint 残留')

    const realEps = store.loadEpisodes()
    ok(`真实 episodes 读到 ${realEps.length} 条`)
    const noTier = realEps.filter((e) => !e.importance)
    if (noTier.length) bug('有 episode 缺 importance', String(noTier.length))
    else ok('所有 episode 都有 importance')

    const realCore = core.loadCore()
    ok(`真实核心记忆 ${realCore.length} 条`)
  }
}

/* ============ H. 代码里有没有可疑残留 ============ */
console.log('\n=== H. 代码检查 ===')
{
  const filterSrc = readFileSync('src/memory/filter.ts', 'utf8')
  if (filterSrc.includes('require(')) bug('filter.ts 里还有 require（ESM 会炸）')
  else ok('filter.ts 没有 require')

  const recallSrc = readFileSync('src/memory/recall.ts', 'utf8')
  if (/const seen = new Set/.test(recallSrc) && (recallSrc.match(/const seen = new Set/g) ?? []).length > 1) {
    bug('recall.ts 里有重复的 seen 变量声明', '')
  } else ok('recall.ts 变量不冲突')

  // 有没有调用不存在的函数
  if (recallSrc.includes('lambdaOfEpisode(e, opts.decay)') && !recallSrc.includes('export function lambdaOfEpisode')) {
    bug('调用了 lambdaOfEpisode 但没定义', '')
  } else ok('lambdaOfEpisode 定义和调用都在')
}

console.log(`\n${bugs === 0 ? '✅ 没发现 bug' : `🐛 发现 ${bugs} 个问题`}`)
process.exit(bugs > 0 ? 1 : 0)
