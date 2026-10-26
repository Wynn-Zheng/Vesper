/**
 * 诊断工具体检：路径安全、行号边界、搜索参数。
 */
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

const d = await import('../src/self/diagnose.ts')

/* ---------- 1. 路径安全 ---------- */
console.log('=== 1. 路径安全 ===')
{
  const evil = [
    '/etc/passwd:1',
    '../../etc/passwd:1',
    'src/../../etc/passwd:1',
    'srcx/foo.ts:1',
    'persona/self.md:1',
    'C:\\Windows\\system32\\config:1',
    '',
  ]
  for (const e of evil) {
    const r = d.readSourceAt(e)
    check(`readSourceAt("${e.slice(0, 22)}") 返回 null`, r === null, JSON.stringify(r)?.slice(0, 40))
  }
  // 正常的能读到
  const ok = d.readSourceAt('src/index.ts:5')
  check('正常路径能读到', ok !== null && ok.code.length > 0)
}

/* ---------- 2. 行号边界 ---------- */
console.log('\n=== 2. 行号边界 ===')
{
  check('负行号返回 null', d.readSlice('src/index.ts', -10, 5) === null)
  check('超大行号返回 null', d.readSlice('src/index.ts', 999999, 1000000) === null)
  // from > to 时不该崩
  const r = d.readSlice('src/index.ts', 50, 10)
  check('from > to 不崩', r === null || r.from <= r.to, JSON.stringify(r)?.slice(0, 60))
}

/* ---------- 3. maxLines 上限 ---------- */
console.log('\n=== 3. maxLines 上限 ===')
{
  const r = d.readSlice('src/index.ts', 1, 5000)
  check('要 5000 行只给 80 行以内', r === null || r.to - r.from + 1 <= 80, r ? `${r.to - r.from + 1} 行` : 'null')
}

/* ---------- 4. searchCode 的短 query ---------- */
console.log('\n=== 4. searchCode ===')
{
  check('空 query 返回空数组', d.searchCode('').length === 0)
  check('单字符 query 返回空数组', d.searchCode('a').length === 0)
  const hits = d.searchCode('export', 5)
  check('正常 query 有结果', hits.length > 0 && hits.length <= 5, `${hits.length} 条`)
}

/* ---------- 5. findCallers 的正则安全 ---------- */
console.log('\n=== 5. findCallers 正则安全 ===')
{
  const evil = ['(', '[', '.*', 'a+b', '\\', '^', '$', '(?<x>', '{2,}']
  for (const e of evil) {
    try {
      const r = d.findCallers(e, 2)
      check(`findCallers("${e}") 不崩`, Array.isArray(r))
    } catch (err) {
      check(`findCallers("${e}") 不崩`, false, String(err).slice(0, 50))
    }
  }
}

/* ---------- 6. diagnose 的轮数控制 ---------- */
console.log('\n=== 6. diagnose 轮数 ===')
{
  const issue = {
    key: 'x',
    message: '测试',
    where: 'src/index.ts:1',
    level: 'warn' as const,
    count: 1,
    firstAt: Date.now(),
    lastAt: Date.now(),
    confidence: '确定' as const,
    samples: [],
  }
  const badLlm = { apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'm' }
  const t0 = Date.now()
  const r = await d.diagnose(issue, badLlm, { maxRounds: 1 })
  const ms = Date.now() - t0
  check(`maxRounds=1 且模型不可用时 ${ms}ms 内返回 null`, r === null && ms < 30_000, `${ms}ms`)

  // maxRounds=0 不该死循环
  const t1 = Date.now()
  const r2 = await d.diagnose(issue, badLlm, { maxRounds: 0 })
  const ms2 = Date.now() - t1
  check(`maxRounds=0 不死循环（${ms2}ms）`, ms2 < 30_000, `${ms2}ms`)
}

/* ---------- 7. renderDiagnosis ---------- */
console.log('\n=== 7. renderDiagnosis ===')
{
  const r = d.renderDiagnosis({ what: '在检查返回码。', why: '参数不对。', certainty: '猜的', howToFix: '打日志。' })
  check('不出现双句号', !r.includes('。。'), r)
  check('包含三部分', r.includes('检查返回码') && r.includes('参数不对') && r.includes('打日志'), r)
  const r2 = d.renderDiagnosis({ what: '看不出。', why: '看不出', certainty: '猜的', howToFix: '' })
  check('why 是"看不出"时不重复', !r2.includes('问题大概是'), r2)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
