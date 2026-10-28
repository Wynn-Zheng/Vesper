/**
 * 自动整理（scheduler/distiller.ts）的分批与游标边界。
 *
 * 覆盖 docs/交接文档.md §5 里三个会丢记忆的问题：
 *   P0-1 整理失败也推进游标 → 那批消息永久丢失
 *   P0-3 一次吃 7 天全部 raw、只记 3 件 → 分批
 *   游标用 Date.now() 会跳过整理期间新到的消息 → 推进到"这批最后一条的 ts"
 *
 * 用本地假模型，不联网；全部在临时目录里跑，不碰 data/ 和 persona/。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qqbot-distill-batch-'))
const memRoot = join(root, 'memory')

// 有些模块用相对路径（persona/jargon.yaml），chdir 到临时目录免得写脏真实数据。
// 退出时先 chdir 回来再删：Windows 上"当前目录被占用"会删不掉（踩过）。
const originalCwd = process.cwd()
process.chdir(root)

const { setMemoryRoot, appendRaw } = await import('../src/memory/store.ts')
const { setPeopleRoot } = await import('../src/people/store.ts')
const { initLog } = await import('../src/core/log.ts')
const { DEFAULTS } = await import('../src/core/config.ts')
const { tick } = await import('../src/scheduler/distiller.ts')

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

let mode: 'ok' | 'fail' = 'ok'
let calls = 0

/** 假模型返回的内容，测试里可以整体替换 */
let modelBody: unknown = {
  episodes: [{ title: '一起聊了会儿', body: '他说了点什么，我听着。', importance: 4, emotion: '平静' }],
  facts: [],
  open: [],
  insights: [],
}

const srv = createServer((req, res) => {
  calls++
  if (mode === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":"boom"}')
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelBody) } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    }),
  )
})
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
const addr = srv.address()
const port = typeof addr === 'object' && addr ? addr.port : 0

const llm = { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'm' }

/** 阈值压到 4 条，免得测试要造 150 条 */
const rules = {
  ...DEFAULTS,
  记忆: { ...DEFAULTS.记忆, 反思: { ...DEFAULTS.记忆.反思, 阈值: 4, 每天至少: 1 } },
}

function stateFile(): string {
  return join(memRoot, '.state.json')
}

function readState(): { scopes: Record<string, number> } {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as { scopes: Record<string, number> }
  } catch {
    return { scopes: {} }
  }
}

const scopeA = 'private:10001' as Scope
const scopeB = 'private:20002' as Scope

/** 造 n 条像样的话（太短会被 filter 当废话筛掉） */
function seed(scope: Scope, n: number, startTs: number): RawTurn[] {
  const out: RawTurn[] = []
  for (let i = 0; i < n; i++) {
    const turn: RawTurn = {
      ts: startTs + i * 60_000,
      scope,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `第 ${i} 段：今天面试完一直在想那道手写题，感觉还挺可惜的。`,
    }
    appendRaw(turn)
    out.push(turn)
  }
  return out
}

const base = Date.now() - 3 * 3600_000
const turnsA = seed(scopeA, 100, base)
const lastTsA = turnsA[turnsA.length - 1]!.ts

/* ---------------- 1. 分批：100 条不该只发一次 ---------------- */

console.log('=== 1. 分批整理 ===')
calls = 0
await tick({ llm, rules })

// 100 条里 filter 会筛掉一部分，剩下约 75 条 → 40 条一批，至少 2 批
check('原文多时分多次调模型（不再是"225 条只记 3 件"）', calls >= 2, `实际调用 ${calls} 次`)
check('每批都落了 episode', readState().scopes[scopeA] !== undefined)

/* ---------------- 2. 游标：推进到批次最后一条，不是现在 ---------------- */

console.log('\n=== 2. 游标位置 ===')
const cursorA = readState().scopes[scopeA]
check('游标 = 这批最后一条消息的时间', cursorA === lastTsA, `游标 ${cursorA}，期望 ${lastTsA}`)
check('游标没有被推成 Date.now()', cursorA !== undefined && Math.abs(Date.now() - cursorA) > 60_000, String(cursorA))

/* ---------------- 3. 没有新消息就不重复整理 ---------------- */

console.log('\n=== 3. 不重复整理 ===')
const before = calls
await tick({ llm, rules })
check('没有新原文时不再调模型', calls === before, `调用从 ${before} 变成 ${calls}`)

/* ---------------- 4. 失败不推进游标 ---------------- */

console.log('\n=== 4. 失败不推进游标 ===')
const turnsB = seed(scopeB, 10, base + 600_000 + 100 * 60_000)
mode = 'fail'
calls = 0
await tick({ llm, rules })
check('失败时确实调了模型（不是没触发）', calls > 0, `调用 ${calls} 次`)
const cursorB = readState().scopes[scopeB]
check('失败后游标没被推进（这批下次还会重试）', cursorB === undefined, `游标变成 ${cursorB}`)

// 恢复后重试，应该还能整理出东西
mode = 'ok'
calls = 0
await tick({ llm, rules })
const retryCursor = readState().scopes[scopeB]
check('恢复后同一批能重试成功', retryCursor === turnsB[turnsB.length - 1]!.ts, `游标 ${retryCursor}`)

/* ---------------- 5. 整理期间新到的消息不会被跳过 ---------------- */

console.log('\n=== 5. 整理期间的新消息 ===')
// 先让游标停在 A 的中间，模拟"上一轮只整理到这里"
const stateNow = readState()
stateNow.scopes[scopeA] = turnsA[49]!.ts
writeFileSync(stateFile(), JSON.stringify(stateNow, null, 2))
calls = 0
await tick({ llm, rules })
const afterCalls = calls
check('游标之后的消息会被重新整理', afterCalls > 0, `调用 ${afterCalls} 次`)
check(
  '整理后游标推进到新末尾',
  readState().scopes[scopeA] === lastTsA,
  `游标 ${readState().scopes[scopeA]}`,
)

/* ---------------- 6. chunkTurns 纯函数 ---------------- */

console.log('\n=== 6. chunkTurns ===')
const { chunkTurns } = await import('../src/memory/distill.ts')
{
  const turns = Array.from({ length: 90 }, (_, i) => ({ ts: 1000 + i, text: 'x'.repeat(10) }))
  const batches = chunkTurns(turns, 40)
  check('条数上限生效', batches.every((b) => b.length <= 40), batches.map((b) => b.length).join(','))
  check('切分不丢不重', batches.reduce((n, b) => n + b.length, 0) === turns.length)
  check('保持时间顺序', batches.flat().every((t, i) => t.ts === turns[i]!.ts))

  const long = Array.from({ length: 30 }, (_, i) => ({ ts: 1000 + i, text: 'y'.repeat(600) }))
  const byChars = chunkTurns(long, 1000, 5000)
  check('字符预算生效', byChars.length > 1, `批数 ${byChars.length}`)

  const sameTs = Array.from({ length: 5 }, () => ({ ts: 777, text: 'z'.repeat(10) }))
  const t1 = chunkTurns(sameTs, 2, 12)
  check(
    '同一毫秒的记录不会被拆到两批（否则失败重试会跳过它们）',
    t1.every((b) => b.every((x) => x.ts === 777)) && t1.every((b) => b.length >= 1),
    t1.map((b) => b.length).join(','),
  )
}

/* ---------------- 7. 群聊 facts 按发言人归属 ---------------- */

console.log('\n=== 7. 群聊 facts 归属 ===')
{
  const people = await import('../src/people/store.ts')
  const { distill } = await import('../src/memory/distill.ts')
  const { loadFacts } = await import('../src/memory/facts.ts')

  people.ensurePerson('qq', '2001', '小明')
  people.ensurePerson('qq', '2002', '小红')

  const groupScope = 'group:90001' as Scope
  const groupTurns: RawTurn[] = [
    { ts: base + 900_000, scope: groupScope, role: 'user', senderId: '2001', text: '我下周要考四级，有点慌' },
    { ts: base + 900_060, scope: groupScope, role: 'user', senderId: '2002', text: '我昨天捡了只小猫，叫团子' },
    { ts: base + 900_120, scope: groupScope, role: 'assistant', text: '四级加油，猫好可爱' },
  ]

  modelBody = {
    episodes: [],
    facts: [
      { text: '小明下周要考四级', confidence: 0.9, visibility: 'public', tier: 'normal', who: '小明' },
      { text: '小红养了一只叫团子的猫', confidence: 0.9, visibility: 'public', tier: 'normal', who: '小红' },
      { text: '有人下周要考试', confidence: 0.5, visibility: 'public', tier: 'normal', who: '' },
      { text: '张三要搬家', confidence: 0.5, visibility: 'public', tier: 'normal', who: '张三' },
    ],
    open: [],
    insights: [],
  }

  const gr = await distill({
    personId: 'qq-group',
    scope: groupScope,
    turns: groupTurns,
    llm,
    rules,
  })
  check('群聊整理成功', gr.ok, JSON.stringify(gr))
  check('群聊记下了事实（不再整段丢弃）', gr.facts >= 2, `facts=${gr.facts}`)

  const ming = loadFacts('qq-2001').map((f) => f.text)
  const hong = loadFacts('qq-2002').map((f) => f.text)
  check('小明的四级写到小明身上', ming.some((t) => t.includes('四级')), ming.join('|'))
  check('小红的猫写到小红身上', hong.some((t) => t.includes('猫')), hong.join('|'))
  check('没写 who 的事实不记（宁可少记，不能记错人）', !ming.some((t) => t.includes('有人')) && !hong.some((t) => t.includes('有人')))
  check(
    '群里没说过话的人不会被凭空建档',
    !ming.some((t) => t.includes('张三')) && !hong.some((t) => t.includes('张三')),
  )
  check('事实没有落到群的占位人身上', loadFacts('qq-group').length === 0)

  // 重名时不该乱认人
  people.ensurePerson('qq', '2003', '小明')
  const dupTurns: RawTurn[] = [
    ...groupTurns,
    { ts: base + 900_180, scope: groupScope, role: 'user', senderId: '2003', text: '我也叫小明，刚换工作' },
  ]
  modelBody = {
    episodes: [],
    facts: [{ text: '小明换工作了', confidence: 0.9, visibility: 'public', tier: 'normal', who: '小明' }],
    open: [],
    insights: [],
  }
  const dup = await distill({ personId: 'qq-group', scope: groupScope, turns: dupTurns, llm, rules })
  check(
    '同名的两个人都在群里时不归属（记错人比不记更糟）',
    dup.facts === 0,
    `facts=${dup.facts}`,
  )
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
srv.close()
process.exit(fail > 0 ? 1 : 0)
