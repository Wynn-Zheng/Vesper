/**
 * 记忆检索的边界体检。
 *
 * 关心的是：奇怪输入会不会让 recall 崩、或者给出明显错的结论。
 *   - 空 query / 纯标点 query
 *   - limit = 0 / 负数 / 很大
 *   - scope 不存在（没聊过的群）
 *   - facts 里置信度是 NaN / 负数（历史数据可能坏）
 *   - 关系值 NaN（上一轮修过 stageOf，这里顺带回归）
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

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

const store = await import('../src/memory/store.ts')
const people = await import('../src/people/store.ts')
const recall = await import('../src/memory/recall.ts')

const ROOT = 'data/test-recall-edge'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/memory/raw`, { recursive: true })
mkdirSync(`${ROOT}/people`, { recursive: true })
store.setMemoryRoot?.(`${ROOT}/memory`)
people.setPeopleRoot(`${ROOT}/people`)

const W = { 新近: 0.5, 相关: 3, 重要: 2 }
const PID = 'qq-9001'
const GID = 'group:555'

people.ensurePerson('qq', '9001', '测试的人')

// 造点数据
const now = Date.now()
writeFileSync(
  `${ROOT}/people/${PID}/facts.md`,
  `# 关于这个人的事实

## 平常

- 他在学 Rust（2026-10-26，置信 0.9，公开）
- 他养过一只猫（2026-10-25，置信 0.8，私密）
`,
  'utf8',
)

for (const [i, t] of ['我在学 Rust', '今天好累', '猫又掉毛了'].entries()) {
  store.appendRaw({
    ts: now - (3 - i) * 60_000,
    scope: 'private:9001',
    role: 'user',
    text: t,
    senderId: '9001',
  })
}

/* ============ 1. 正常调用 ============ */
console.log('=== 1. 正常调用 ===')
{
  const r = recall.recall({ personId: PID, scope: 'private:9001', query: 'Rust 学到哪了', limit: 8, weights: W })
  check('能取回事实', r.facts.length > 0, String(r.facts.length))
  check('能取回原话', r.recent.length > 0, String(r.recent.length))
  check('渲染不炸', recall.renderRecalled(r).length > 0, '')
}

/* ============ 2. 空 query ============ */
console.log('\n=== 2. 空 query ===')
{
  for (const q of ['', '   ', '？？？', '。。。']) {
    let ok = false
    try {
      const r = recall.recall({ personId: PID, scope: 'private:9001', query: q, limit: 8, weights: W })
      recall.renderRecalled(r)
      ok = true
    } catch (e) {
      ok = false
      console.log(`    ${JSON.stringify(q)} 抛错: ${String(e).slice(0, 60)}`)
    }
    check(`「${q || '(空)'}」不炸`, ok, '')
  }
}

/* ============ 3. limit 边界 ============ */
console.log('\n=== 3. limit ===')
{
  for (const [lim, label] of [
    [0, 'limit=0'],
    [-5, 'limit=-5'],
    [1, 'limit=1'],
    [1000, 'limit=1000'],
  ] as Array<[number, string]>) {
    let n = -1
    let ok = true
    try {
      const r = recall.recall({ personId: PID, scope: 'private:9001', query: 'Rust', limit: lim, weights: W })
      n = r.episodes.length
    } catch (e) {
      ok = false
      console.log(`    ${label} 抛错: ${String(e).slice(0, 60)}`)
    }
    check(`${label} 不炸`, ok, '')
    check(`${label} 不返回超量`, n <= Math.max(0, lim), `返回 ${n}`)
  }
}

/* ============ 4. 不存在的 scope ============ */
console.log('\n=== 4. 没聊过的 scope ===')
{
  let ok = true
  let r: ReturnType<typeof recall.recall> | null = null
  try {
    r = recall.recall({ personId: PID, scope: 'group:999999', query: 'Rust', limit: 8, weights: W })
  } catch {
    ok = false
  }
  check('不存在的 scope 不炸', ok, '')
  check('私聊的事实不会被群聊看见', (r?.facts ?? []).every((f) => f.visibility === 'public'), JSON.stringify((r?.facts ?? []).map((f) => f.visibility)))

  // 私密事实在群里不该出现
  const hasPrivate = (r?.facts ?? []).some((f) => f.text.includes('猫'))
  check('「养过一只猫」没漏到群里', !hasPrivate, '漏了')
}

/* ============ 5. 坏数据：置信度 NaN ============ */
console.log('\n=== 5. 坏数据 ===')
{
  writeFileSync(
    `${ROOT}/people/${PID}/facts.md`,
    `# 关于这个人的事实

## 平常

- 置信度坏掉的一条（2026-10-26，置信 abc，公开）
- 负数置信（2026-10-26，置信 -5，公开）
- 正常的一条（2026-10-26，置信 0.9，公开）
`,
    'utf8',
  )

  let ok = true
  let r: ReturnType<typeof recall.recall> | null = null
  try {
    r = recall.recall({ personId: PID, scope: 'private:9001', query: '坏', limit: 8, weights: W })
  } catch (e) {
    ok = false
    console.log(`    抛错: ${String(e).slice(0, 80)}`)
  }
  check('坏置信度不炸', ok, '')
  check('正常那条还在', (r?.facts ?? []).some((f) => f.text.includes('正常')), JSON.stringify((r?.facts ?? []).map((f) => f.text)))
  // NaN 置信度不该排到最前
  const first = r?.facts?.[0]?.text ?? ''
  check('坏的没排第一', !first.includes('坏掉') && !first.includes('负数'), first)
}

/* ============ 6. 关系值边界（回归 stageOf） ============ */
console.log('\n=== 6. 关系值 ===')
{
  const { loadRules, stageOf } = await import('../src/core/config.ts')
  const rules = loadRules().rules
  check('NaN → 陌生', stageOf(rules, NaN).名 === '陌生', stageOf(rules, NaN).名)
  check('Infinity → 陌生', stageOf(rules, Infinity).名 === '陌生', stageOf(rules, Infinity).名)
  check('-1 → 陌生', stageOf(rules, -1).名 === '陌生', stageOf(rules, -1).名)
  check('50 → 亲近', stageOf(rules, 50).名 === '亲近', stageOf(rules, 50).名)
  check('100 → 离不开', stageOf(rules, 100).名 === '离不开', stageOf(rules, 100).名)
}

/* ============ 7. 空档案的人 ============ */
console.log('\n=== 7. 空档案 ===')
{
  people.ensurePerson('qq', '9002', '啥都没有的人')
  let ok = true
  let r: ReturnType<typeof recall.recall> | null = null
  try {
    r = recall.recall({ personId: 'qq-9002', scope: 'private:9002', query: '你好', limit: 8, weights: W })
  } catch {
    ok = false
  }
  check('空档案不炸', ok, '')
  check('空档案返回空数组', (r?.facts.length ?? -1) === 0 && (r?.episodes.length ?? -1) === 0, JSON.stringify({ f: r?.facts.length, e: r?.episodes.length }))
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
