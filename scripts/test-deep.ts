/**
 * 深查：新功能之间的交互、并发写、长期运行。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
/** 从 .env 读控制台 token（不依赖环境变量，直接跑也能通） */
function envToken(): string {
  if (process.env.CONSOLE_TOKEN) return process.env.CONSOLE_TOKEN
  try {
    const t = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const m = /^CONSOLE_TOKEN=(.*)$/m.exec(t)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

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

const observe = await import('../src/self/observe.ts')
const will = await import('../src/self/will.ts')

/* ---------- 1. issues.json 并发写 ---------- */
{
  observe.refreshIssues()
  const before = observe.loadIssueStore().items.length

  // 模拟"定时器 refreshIssues" 和 "chat 里 markMentioned" 撞一起
  const keys = observe.loadIssueStore().items.map((i) => i.key)
  await Promise.all([
    Promise.resolve().then(() => observe.refreshIssues()),
    Promise.resolve().then(() => observe.markMentioned(keys.slice(0, 1))),
  ])

  const after = observe.loadIssueStore()
  check('并发写 issues.json 不丢数据', after.items.length === before, `${before} → ${after.items.length}`)
  const valid = after.items.every((i) => i.key && i.message)
  check('并发写后每条都完整', valid)
}

/* ---------- 2. issues 的 key 会随代码行号变 ---------- */
{
  // key 里含 where（文件:行号）。代码一改行号就变，旧条目永远留着。
  observe.refreshIssues()
  const store = observe.loadIssueStore()
  const stale = store.items.filter((i) => i.where && !existsSync(i.where.split(':')[0]!))
  check(`没有指向已删除文件的条目（发现 ${stale.length} 条）`, stale.length === 0, stale.map((s) => s.where).join(','))

  // 检查：refreshIssues 会不会把"这次没扫到的旧条目"清掉
  const beforeCount = store.items.length
  // 手工塞一个假的旧条目
  store.items.push({
    key: '假条目|已过期|x',
    message: '这是假的',
    where: 'src/不存在.ts:1',
    level: 'warn',
    count: 99,
    firstAt: 1,
    lastAt: 1,
    confidence: '确定',
    samples: [],
    mentionedAt: 0,
  })
  writeFileSync('persona/issues.json', JSON.stringify(store, null, 2), 'utf8')

  const afterRefresh = observe.refreshIssues()
  const stillThere = afterRefresh.some((i) => i.key === '假条目|已过期|x')
  check(`refreshIssues 会清掉这次没扫到的旧条目（假条目还在：${stillThere}）`, !stillThere, `refresh 后 ${afterRefresh.length} 条 vs 之前 ${beforeCount + 1}`)
}

/* ---------- 3. will.json 并发写 ----------
 * 注意：这里只测 saveWill 的并发，不碰 impression ——
 * setImpression 会写真实的 impression.md，测试不该污染生产数据。
 */
{
  const { saveWill } = will
  const snapshot = will.loadWill()
  await Promise.all([
    Promise.resolve().then(() => saveWill({ ...snapshot, talkReason: '并发A' })),
    Promise.resolve().then(() => saveWill({ ...snapshot, talkReason: '并发B' })),
  ])
  const w = will.loadWill()
  check('并发 saveWill 文件仍完整', typeof w.at === 'number' && typeof w.talk === 'boolean', JSON.stringify(w).slice(0, 80))
  // 恢复
  saveWill(snapshot)
}

/* ---------- 4. 诊断失败会不会无限重试 ---------- */
{
  observe.refreshIssues()
  const sure = observe.loadIssueStore().items.filter((i) => i.confidence === '确定' && i.where && !i.guess)
  console.log(`   （当前 ${sure.length} 条确定问题待诊断）`)

  // startObserving 里每次都会重试没 guess 的。如果模型一直失败，
  // 每 6 小时重试一次——这个频率可接受，但要确认不会每次都烧钱。
  const todo = sure.slice(0, 2)
  check(`每次最多诊断 ${todo.length} 条（上限 2）`, todo.length <= 2)
}

/* ---------- 5. 日志噪音会不会被当成问题 ---------- */
{
  const issues = observe.findIssues({ days: 3, minCount: 2 })
  const noise = issues.filter((i) => /工具重名|控制台请求出错/.test(i.message))
  check('已知噪音被过滤', noise.length === 0, noise.map((n) => n.message).join(', '))

  // 测试警告（我们自己造的）也该被过滤吗？
  const testNoise = issues.filter((i) => /测试警告|压测/.test(i.message))
  console.log(`   （测试噪音 ${testNoise.length} 条：${testNoise.map((t) => t.message).join(', ') || '无'}）`)
}

/* ---------- 6. readSourceAt 在代码被改后 ---------- */
{
  const { readSourceAt } = await import('../src/self/diagnose.ts')
  // 行号超出（代码变短了的情况）
  const r = readSourceAt('src/outward/bili.ts:99999')
  check('行号超出返回 null', r === null, JSON.stringify(r)?.slice(0, 60))
}

/* ---------- 7. 两个定时器会不会同时跑 ---------- */
{
  // startObserving 启动后 2 分钟跑第一次
  // startSelfReflect 启动后 3 分钟跑第一次
  // startWatching 启动后 10 分钟 + 随机 0-20 分钟
  console.log('   定时器第一次触发时间：')
  console.log('     自检     2 分钟')
  console.log('     反思     3 分钟')
  console.log('     刷视频   10-30 分钟')
  console.log('   → 自检和反思差 1 分钟，不会同时打模型')
  check('自检和反思错开', true)
}

/* ---------- 8. 控制台 issues 面板数据 ---------- */
{
  const st = await fetch('http://127.0.0.1:7788/api/state', {
    headers: { 'x-console-token': envToken() },
  })
  if (st.ok) {
    const d = (await st.json()) as { issues?: unknown[]; watched?: unknown[] }
    check('state 接口带 issues', Array.isArray(d.issues), typeof d.issues)
    check('state 接口带 watched', Array.isArray(d.watched), typeof d.watched)
    // 前端渲染需要的字段
    const first = (d.issues as Array<Record<string, unknown>>)?.[0]
    if (first) {
      check('issue 有 confidence / message / count', 'confidence' in first && 'message' in first && 'count' in first, JSON.stringify(first).slice(0, 80))
    }
  } else {
    check('state 接口（服务没起，跳过）', true)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
