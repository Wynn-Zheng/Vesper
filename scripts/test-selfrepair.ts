/**
 * 针对新增功能的边界测试：
 * - warnAt 的性能（每条日志 new Error() 有开销）
 * - diagnose 会不会死循环
 * - searchCode 在大仓库上的耗时
 * - issues.json 会不会无限增长
 * - markMentioned 是否真的生效
 */
import { existsSync, statSync } from 'node:fs'

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

/* ---------- 1. warnAt 性能 ---------- */
{
  const { initLog, warnAt } = await import('../src/core/log.ts')
  initLog('data/logs-test', false) // 不写文件，只测计算
  const origLog = console.log
  console.log = () => {}
  const t0 = Date.now()
  for (let i = 0; i < 1000; i++) warnAt('压测', { i })
  const ms = Date.now() - t0
  console.log = origLog
  check(`1000 次 warnAt 耗时 ${ms}ms（应 < 2000）`, ms < 2000, `${ms}ms`)
}

/* ---------- 2. searchCode 性能 ---------- */
{
  const { searchCode } = await import('../src/self/diagnose.ts')
  const t0 = Date.now()
  const hits = searchCode('export', 50)
  const ms = Date.now() - t0
  check(`searchCode 扫全仓 ${ms}ms（应 < 3000）`, ms < 3000, `${ms}ms`)
  check('searchCode 有结果', hits.length > 0, `${hits.length} 条`)
}

/* ---------- 3. findCallers 特殊字符 ---------- */
{
  const { findCallers } = await import('../src/self/diagnose.ts')
  // 这些会破坏朴素正则
  for (const name of ['(', '[', '.*', 'a+b', '\\']) {
    try {
      findCallers(name)
      check(`findCallers("${name}") 不崩`, true)
    } catch (e) {
      check(`findCallers("${name}") 不崩`, false, String(e).slice(0, 50))
    }
  }
}

/* ---------- 4. readSlice 边界 ---------- */
{
  const { readSlice, readSourceAt } = await import('../src/self/diagnose.ts')
  check('负行号不崩', readSlice('src/index.ts', -10, 5) !== undefined)
  check('超大行号返回空或截断', (() => {
    const r = readSlice('src/index.ts', 99999, 100000)
    return r === null || r.from <= r.total
  })())
  check('路径穿越被拒', readSourceAt('src/../../etc/passwd:1') === null)
  check('非 src 被拒', readSourceAt('/etc/passwd:1') === null)
  check('空 where 返回 null', readSourceAt('') === null)
}

/* ---------- 5. diagnose 死循环 ---------- */
{
  const { diagnose } = await import('../src/self/diagnose.ts')
  const llm = {
    apiKey: 'sk-invalid',
    baseUrl: 'http://127.0.0.1:1', // 必然失败
    model: 'x',
  }
  const t0 = Date.now()
  const r = await diagnose(
    {
      key: 'x',
      message: '测试',
      where: 'src/index.ts:1',
      level: 'warn',
      count: 1,
      firstAt: Date.now(),
      lastAt: Date.now(),
      confidence: '确定',
      samples: [],
    },
    llm,
  )
  const ms = Date.now() - t0
  check(`模型不可用时返回 null（${ms}ms）`, r === null, JSON.stringify(r))
  check(`没有卡死（${ms}ms < 30000）`, ms < 30_000, `${ms}ms`)
}

/* ---------- 6. issues.json 增长 ---------- */
{
  const { refreshIssues } = await import('../src/self/observe.ts')
  const items = refreshIssues()
  const f = 'persona/issues.json'
  const size = existsSync(f) ? statSync(f).size : 0
  check(`issues.json 大小 ${(size / 1024).toFixed(1)} KB（应 < 100KB）`, size < 100_000, `${size} 字节`)
  check(`条目数 ${items.length}（应 < 100）`, items.length < 100, `${items.length}`)
}

/* ---------- 7. markMentioned 生效 ---------- */
{
  const { refreshIssues, unmentionedIssues, markMentioned, loadIssueStore } = await import('../src/self/observe.ts')
  const { writeFileSync } = await import('node:fs')
  const items = refreshIssues()
  const sure = items.filter((i) => i.confidence === '确定' && i.where)

  // 先重置：上一次跑测试可能已经把 mentionedAt 标成已提，这次就没东西可测了
  const reset = loadIssueStore()
  for (const i of reset.items) i.mentionedAt = 0
  writeFileSync('persona/issues.json', JSON.stringify(reset, null, 2), 'utf8')

  if (sure.length) {
    // 注意两件事：
    // 1. unmentionedIssues() 有 slice(0,2)，只标两条的话库里还有别的未提项
    // 2. 所以要标"库里所有 mentionedAt=0 的"，才能验证归零
    const allPending = loadIssueStore().items.filter((i) => i.mentionedAt === 0)
    const before = unmentionedIssues().length
    markMentioned(allPending.map((i) => i.key))
    const after = unmentionedIssues().length
    check(`markMentioned 让待提从 ${before} 降到 ${after}`, after === 0 && before > 0, `${before} → ${after}`)

    // 恢复成"没提过"，别影响线上行为
    const s = loadIssueStore()
    for (const i of s.items) i.mentionedAt = 0
    writeFileSync('persona/issues.json', JSON.stringify(s, null, 2), 'utf8')
  } else {
    check('markMentioned（当前没有确定问题，跳过）', true)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
