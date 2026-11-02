/**
 * 事实关系三分类：same / different / contradict。
 *
 * 覆盖 （内部交接文档，未公开） §5.10「无矛盾检测」和踩坑全记录 #9：
 *   原来 sameFact 只回 yes/no，no 同时表示"两件不同的事"和"互相矛盾"，
 *   结果无关的两件事也去打扰用户（open 里堆满"我记得X，听到Y"），
 *   而真正的矛盾只是两条并存、永远不失效。
 *
 * 现在：same → 刷新确认；different → 两条并存（不打扰）；
 *       contradict → 旧事实标 supersededAt（不再注入），新的写入。
 *
 * 全部在临时目录 + 本地假模型里跑。
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawTurn, Scope } from '../src/memory/types.ts'

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

const root = mkdtempSync(join(tmpdir(), 'qqbot-fact-conflict-'))
const originalCwd = process.cwd()
process.chdir(root)

const memRoot = join(root, 'memory')
const { setMemoryRoot } = await import('../src/memory/store.ts')
const { setPeopleRoot } = await import('../src/people/store.ts')
const { initLog } = await import('../src/core/log.ts')
const { DEFAULTS } = await import('../src/core/config.ts')
const facts = await import('../src/memory/facts.ts')
const { distill } = await import('../src/memory/distill.ts')
const { recall, similarity } = await import('../src/memory/recall.ts')
const { loadOpen } = await import('../src/people/open.ts')

setMemoryRoot(memRoot)
setPeopleRoot(join(root, 'people'))
initLog(join(root, 'logs'), false)

process.on('exit', () => {
  try {
    process.chdir(originalCwd)
  } catch {
    /* ignore */
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- 假模型 ---------------- */

let relationReply = 'same'
let distillPayload: unknown = { episodes: [], facts: [], open: [], insights: [] }
let relationCalls = 0

const srv = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    let last = ''
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> }
      last = parsed.messages?.at(-1)?.content ?? ''
    } catch {
      last = ''
    }
    // 关系判断的 prompt 里带「第一条：」，其余是整理调用
    const isRelation = last.includes('第一条：')
    if (isRelation) relationCalls++
    const content = isRelation ? relationReply : JSON.stringify(distillPayload)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
const addr = srv.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const llm = { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'm' }

function turn(text: string, scope: Scope): RawTurn {
  return { ts: Date.now(), scope, role: 'user', text }
}

async function distillFacts(personId: string, scope: Scope, factTexts: string[], relation = 'same'): Promise<void> {
  relationReply = relation
  distillPayload = {
    episodes: [],
    facts: factTexts.map((text) => ({ text, confidence: 0.9, visibility: 'public', tier: 'normal' })),
    open: [],
    insights: [],
  }
  await distill({ personId, scope, turns: [turn(factTexts[0]!, scope)], llm, rules: DEFAULTS })
}

/* ---------------- 1. 同一件事：刷新，不新增 ---------------- */

console.log('=== 1. same：刷新确认 ===')
{
  const pid = 'qq-30001'
  const scope = 'private:qq-30001' as Scope
  const oldText = '他养了一只叫豆豆的猫'
  const newText = '他养了一只猫叫豆豆'
  const sim = similarity(oldText, newText)
  check('用例本身落在灰色地带（0.45-0.9）', sim >= 0.45 && sim <= 0.9, `sim=${sim.toFixed(3)}`)

  await distillFacts(pid, scope, [oldText], 'same')
  await distillFacts(pid, scope, [newText], 'same')

  const list = facts.loadFacts(pid)
  check('只有一条（没变成两条并存的重复）', list.length === 1, `实际 ${list.length} 条：${list.map((f) => f.text).join(' / ')}`)
  check('旧事实没有被标失效', !list[0]!.supersededAt, String(list[0]!.supersededAt))
}

/* ---------------- 2. 两件不同的事：并存，不打扰 ---------------- */

console.log('\n=== 2. different：并存 ===')
{
  const pid = 'qq-30002'
  const scope = 'private:qq-30002' as Scope
  const a = '他特别喜欢听周杰伦的歌，晚上也听'
  const b = '他特别喜欢听陈奕迅的歌，晚上也听'
  const sim = similarity(a, b)
  check('用例本身落在灰色地带', sim >= 0.45 && sim <= 0.9, `sim=${sim.toFixed(3)}`)

  await distillFacts(pid, scope, [a], 'different')
  await distillFacts(pid, scope, [b], 'different')

  const list = facts.loadFacts(pid)
  check('两条都留着', list.length === 2, `实际 ${list.length} 条：${list.map((f) => f.text).join(' / ')}`)
  check('都不算失效', list.every((f) => !f.supersededAt))
  const open = loadOpen(pid)
  check(
    '不会因为"两件不同的事"去打扰用户',
    !open.some((o) => o.text.includes('先按新的记了')),
    open.map((o) => o.text).join(' / '),
  )
}

/* ---------------- 3. 互相矛盾：旧的失效，新的写入 ---------------- */

console.log('\n=== 3. contradict：旧的失效 ===')
{
  const pid = 'qq-30003'
  const scope = 'private:qq-30003' as Scope
  const oldText = '他喜欢听周杰伦的歌'
  const newText = '他不喜欢听周杰伦的歌'
  const sim = similarity(oldText, newText)
  check('用例本身落在灰色地带', sim >= 0.45 && sim <= 0.9, `sim=${sim.toFixed(3)}`)

  await distillFacts(pid, scope, [oldText], 'contradict')
  await distillFacts(pid, scope, [newText], 'contradict')

  const list = facts.loadFacts(pid)
  const oldFact = list.find((f) => f.text === oldText)
  const newFact = list.find((f) => f.text === newText)
  check('新的写进来了', !!newFact && !newFact.supersededAt, JSON.stringify(newFact ?? null))
  check('旧的标了失效，但没被删', !!oldFact && !!oldFact.supersededAt, JSON.stringify(oldFact ?? null))
  check('失效日期就是这次整理的日期', /^\d{4}-\d{2}-\d{2}$/.test(oldFact?.supersededAt ?? ''), oldFact?.supersededAt ?? '')

  const open = loadOpen(pid)
  check(
    'open 里留了一条说明（人能知道它改主意了）',
    open.some((o) => o.text.includes('先按新的记了')),
    open.map((o) => o.text).join(' / '),
  )

  // recall 不该再把失效的注入
  const r = recall({
    personId: pid,
    scope,
    query: '你听周杰伦吗',
    limit: 8,
    weights: DEFAULTS.记忆.检索.权重,
  })
  const injected = r.facts.map((f) => f.text)
  check('recall 不再注入失效事实', !injected.includes(oldText), injected.join(' / '))
  check('recall 注入了新事实', injected.includes(newText), injected.join(' / '))
}

/* ---------------- 4. 老格式兼容 ---------------- */

console.log('\n=== 4. 老数据兼容 ===')
{
  const pid = 'qq-30004'
  const dir = join(root, 'people', pid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'facts.md'),
    ['# 关于这个人的事实', '', '## 平常', '- 他住在杭州（2026-01-01，置信 0.9，公开）', ''].join('\n'),
  )
  const list = facts.loadFacts(pid)
  check('没有「已失效」字段的老行照样能读', list.length === 1 && !list[0]!.supersededAt, JSON.stringify(list))

  // 带失效标记的行能读回来
  writeFileSync(
    join(dir, 'facts.md'),
    [
      '# 关于这个人的事实',
      '',
      '## 平常',
      '- 他住在杭州（2026-01-01，置信 0.9，公开，已失效 2026-10-28）',
      '- 他搬去苏州了（2026-10-28，置信 0.9，公开）',
      '',
    ].join('\n'),
  )
  const list2 = facts.loadFacts(pid)
  const moved = list2.find((f) => f.text === '他住在杭州')
  check('「已失效」能解析成 supersededAt', moved?.supersededAt === '2026-10-28', JSON.stringify(moved ?? null))
}

/* ---------------- 5. 重新听到失效事实：恢复 ---------------- */

console.log('\n=== 5. 失效后又被提到 ===')
{
  const pid = 'qq-30005'
  const scope = 'private:qq-30005' as Scope
  const text = '他住在杭州'
  const dir = join(root, 'people', pid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'facts.md'),
    ['# 关于这个人的事实', '', '## 平常', `- ${text}（2026-01-01，置信 0.9，公开，已失效 2026-10-01）`, ''].join('\n'),
  )
  // 高相似度（>0.9）会走 touch；这里用 appendFacts 直接验证"重新写入会清掉失效标记"
  facts.appendFacts(pid, [{ text, date: '2026-10-28', confidence: 0.9, visibility: 'public' }])
  const list = facts.loadFacts(pid)
  check('再次确认后失效标记被清掉（它又成立了）', list.length === 1 && !list[0]!.supersededAt, JSON.stringify(list))
  void scope
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
srv.close()
process.exit(fail > 0 ? 1 : 0)
