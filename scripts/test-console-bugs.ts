/**
 * 控制台与主流程体检。
 *
 * 补 console/search + chat/prompt 的边界（这两块以前没有专门回归）。
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

/* ================= console/search ================= */
console.log('=== 1. 搜索的边界 ===')
{
  const { search } = await import('../src/console/search.ts')

  // 空 query
  check('空 query 返回空数组', search({ query: '' }).length === 0)
  check('纯空白 query 返回空数组', search({ query: '   ' }).length === 0)

  // 超长 query 不崩
  try {
    const r = search({ query: '啊'.repeat(2000) })
    check('2000 字 query 不崩', Array.isArray(r))
  } catch (e) {
    check('2000 字 query 不崩', false, String(e).slice(0, 60))
  }

  // 非法 types 不崩
  try {
    const r = search({ query: '测试', types: ['不存在的类型' as never] })
    check('非法 types 不崩', Array.isArray(r))
  } catch (e) {
    check('非法 types 不崩', false, String(e).slice(0, 60))
  }

  // days 超范围被夹住
  try {
    const r = search({ query: '测试', days: 99999 })
    check('days 超范围不崩', Array.isArray(r))
  } catch (e) {
    check('days 超范围不崩', false, String(e).slice(0, 60))
  }

  // 结果结构完整
  const hits = search({ query: '四级' })
  const bad = hits.filter((h) => !h.kind || !h.title || typeof h.score !== 'number')
  check('每条结果都有 kind/title/score', bad.length === 0, JSON.stringify(bad.slice(0, 1)))
  check('结果按 score 降序', hits.every((h, i) => i === 0 || hits[i - 1]!.score >= h.score))
}

console.log('\n=== 2. 导出 ===')
{
  const { exportAll } = await import('../src/console/backup.ts')
  const data = exportAll(7) as unknown as Record<string, unknown>
  check('导出有 exportedAt', typeof data.exportedAt === 'string')
  check('导出有 people 数组', Array.isArray(data.people))
  check('导出有 episodes', Array.isArray(data.episodes))
  check('导出有 raw', Array.isArray(data.raw))
  check('导出有 files', typeof data.files === 'object' && data.files !== null)
  // 能不能 JSON 序列化（有循环引用就会炸）
  try {
    JSON.stringify(data)
    check('导出能序列化成 JSON', true)
  } catch (e) {
    check('导出能序列化成 JSON', false, String(e).slice(0, 60))
  }
}

/* ================= prompt ================= */
console.log('\n=== 3. prompt 组装 ===')
{
  const { buildSystem } = await import('../src/loop/prompt.ts')
  const { DEFAULTS } = await import('../src/core/config.ts')

  // 最小输入
  const s1 = buildSystem({ rules: DEFAULTS, now: new Date() })
  check('最小输入能产出非空 prompt', s1.length > 100, String(s1.length))

  // 稳定内容在前、易变内容在后（prompt 缓存友好）
  const s2 = buildSystem({ rules: DEFAULTS, now: new Date(), phase: '深夜', repeatHint: true })
  const firstPhase = s1.indexOf('深夜')
  check('phase 为空时 prompt 里没有"深夜"', firstPhase < 0)
  const phaseIdx = s2.indexOf('深夜')
  check('phase 有值时被写进去了', phaseIdx > 0)
  // 易变内容应该靠后：phase 的位置应该在后 40%
  check('phase 靠后（>60% 位置）', phaseIdx > s2.length * 0.6, `${phaseIdx}/${s2.length}`)

  // 超长 userChars 不崩
  try {
    const s3 = buildSystem({ rules: DEFAULTS, now: new Date(), userChars: 999999 })
    check('超大 userChars 不崩', s3.length > 0)
  } catch (e) {
    check('超大 userChars 不崩', false, String(e).slice(0, 60))
  }
}

/* ================= chat 的纯函数 ================= */
console.log('\n=== 4. chat 的 sanitize 与分组 ===')
{
  const { sanitize, formatUserText } = await import('../src/loop/chat.ts')

  const cases: Array<[string, string]> = [
    ['"带引号"', '带引号'],
    ['**加粗**', '加粗'],
    ['`代码`', '代码'],
    ['正常文本', '正常文本'],
    ['', ''],
  ]
  for (const [input, expect] of cases) {
    const got = sanitize(input)
    check(`sanitize("${input.slice(0, 10)}")`, got === expect, `得到 "${got}"`)
  }

  check('群聊带名字前缀', formatUserText('group:1', '小明', '在吗') === '小明：在吗')
  check('私聊不带前缀', formatUserText('private:1', '小明', '在吗') === '在吗')
  check('空名字退化成原文', formatUserText('group:1', '  ', '在吗') === '在吗')
}

/* ================= 评分 ================= */
console.log('\n=== 5. 回复评分 ===')
{
  const { scoreReply } = await import('../src/loop/score.ts')

  const base = { addressed: false, isPrivate: false, followUp: false, text: '随便', idleMinutes: 0, recentReplies: 0, talkValue: 0.4 }

  // 被 @ 必然高分
  const at = scoreReply({ ...base, addressed: true })
  check('被 @ 时概率接近 1', at.probability >= 0.99, String(at.probability))

  // 私聊必然高分
  const priv = scoreReply({ ...base, isPrivate: true })
  check('私聊概率接近 1', priv.probability >= 0.99, String(priv.probability))

  // 概率恒在 [0,1]
  const weird = [
    { talkValue: -5 },
    { talkValue: 100 },
    { talkValue: Number.NaN },
    { idleMinutes: -10 },
    { idleMinutes: 999999 },
    { recentReplies: -1 },
    { recentReplies: 100 },
  ]
  for (const w of weird) {
    const r = scoreReply({ ...base, ...w })
    check(`异常输入 ${JSON.stringify(w)} 的概率合法`, Number.isFinite(r.probability) && r.probability >= 0 && r.probability <= 1, String(r.probability))
  }

  // 连续回得越多，概率越低
  const r0 = scoreReply({ ...base, recentReplies: 0 }).probability
  const r4 = scoreReply({ ...base, recentReplies: 4 }).probability
  check('连着回 4 次后概率变低', r4 < r0, `${r4} < ${r0}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)

// 显式标记为模块：否则 TS 会把顶层 let/const 当全局变量，与其它脚本互相冲突
// （报 TS2451 重复声明 / TS1375 顶层 await），加这一行就没有歧义了。
export {}
