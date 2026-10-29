/**
 * 核心记忆 + 临时记忆的体检。
 *
 * 核心：只有人能改，它只能申请。申请要能批/拒，不能自己写进 core.md。
 * 临时：7 天删，不进 distill，不污染 facts。
 */
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'

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

const core = await import('../src/memory/core.ts')
const temp = await import('../src/memory/temp.ts')

/* ---------- 备份真实数据 ---------- */
// core / core-requests 现在按角色卡隔离：测试用当前卡的真实路径
import { cardScopedPath as scopedPath } from '../src/persona/card.ts'
const CORE = scopedPath('core.md', 'persona/core.md')
const REQ = scopedPath('core-requests.md', 'persona/core-requests.md')
const TEMP_DIR = 'persona/memory/temp'
const backup = new Map<string, string | null>()
for (const f of [CORE, REQ]) backup.set(f, existsSync(f) ? readFileSync(f, 'utf8') : null)

/* ============================================================
 * 1. 核心记忆的解析和渲染
 * ============================================================ */
console.log('=== 1. core.md 解析 ===')
{
  // 空文件
  check('空文本 → 空数组', core.parseCore('').length === 0)

  // 分段
  const t1 = `# 标题

## 身份
- 他叫我「你」
- 我叫「欲辨已妄言」｜2026-10-25

## 边界
- 他讨厌被追问感受

## 诺言
- 我答应过记住他熬夜的事
`
  const items = core.parseCore(t1)
  check('解析出 4 条', items.length === 4, String(items.length))
  check('身份第一条对', items[0]?.text === '他叫我「你」', items[0]?.text)
  check('边界归类对', items.find((i) => i.text.includes('追问'))?.kind === '边界', JSON.stringify(items.find((i) => i.text.includes('追问'))))
  check('诺言归类对', items.find((i) => i.text.includes('答应'))?.kind === '诺言')
  check('日期后缀被拆出来', items[1]?.at === '2026-10-25', items[1]?.at)
  check('日期没留在正文里', !items[1]?.text.includes('2026'), items[1]?.text)

  // 平铺（老格式）
  const t2 = `- 他怕黑\n- 他讨厌吵`
  const flat = core.parseCore(t2)
  check('平铺也能读（当身份）', flat.length === 2 && flat.every((i) => i.kind === '身份'), JSON.stringify(flat.map((i) => i.kind)))

  // 坏数据
  const t3 = `## 身份\n\nthis is not a list item\n- 好的\n### 小标题\n* 星号也行`
  const messy = core.parseCore(t3)
  check('跳过非列表行', messy.length === 2, String(messy.length))
  check('星号列表也认', messy[1]?.text === '星号也行', messy[1]?.text)
}

/* ============================================================
 * 2. 它只能申请，不能直接写
 * ============================================================ */
console.log('\n=== 2. 申请 vs 写入 ===')
{
  // 清干净
  for (const f of [CORE, REQ]) if (existsSync(f)) unlinkSync(f)

  const r1 = core.requestCore('他讨厌被追问感受', '边界', '他明确说过')
  check('第一次申请成功', r1.ok === true, r1.why)

  const reqs = core.loadRequests()
  check('申请书里有 1 条', reqs.length === 1, String(reqs.length))
  check('申请书里带类别', reqs[0]?.kind === '边界', reqs[0]?.kind)
  check('申请书里带原因', reqs[0]?.reason === '他明确说过', reqs[0]?.reason)

  // 申请不等于核心
  check('申请了但核心还是空的', core.loadCore().length === 0, String(core.loadCore().length))

  // 重复申请被拦
  const r2 = core.requestCore('他讨厌被追问感受', '边界', '再说一次')
  check('重复申请被拦', r2.ok === false && r2.why.includes('已经提过'), r2.why)

  // 太短的被拦
  const r3 = core.requestCore('嗯', '身份', '')
  check('太短被拦', r3.ok === false)

  // 批准
  const ap = core.approveRequest(0)
  check('批准成功', ap.ok === true, String(ap.ok))
  check('核心里有 1 条了', core.loadCore().length === 1)
  check('申请书清空了', core.loadRequests().length === 0)
  check('批准后类别保留', core.loadCore()[0]?.kind === '边界')

  // 再申请同一条被拦（因为已经在核心里）
  const r4 = core.requestCore('他讨厌被追问感受', '边界', '')
  check('已经是核心的不能再申请', r4.ok === false && r4.why.includes('已经是'), r4.why)
}

/* ============================================================
 * 3. 申请被拒
 * ============================================================ */
console.log('\n=== 3. 拒绝申请 ===')
{
  core.requestCore('他喜欢猫', '偏好', '提过')
  const before = core.loadRequests().length
  const ok = core.rejectRequest(0)
  check('拒绝成功', ok === true)
  check('申请书少了一条', core.loadRequests().length === before - 1)
  check('核心没变', core.loadCore().length === 1)
}

/* ============================================================
 * 4. 上限
 * ============================================================ */
console.log('\n=== 4. 上限 ===')
{
  const items = []
  for (let i = 0; i < 30; i++) items.push({ text: `第 ${i} 条`, kind: '身份' as const, at: '' })
  check('30 条能写', core.saveCore(items) === true)

  items.push({ text: '第 31 条', kind: '身份' as const, at: '' })
  check('31 条被拒', core.saveCore(items) === false)

  // 恢复成 1 条
  core.saveCore([{ text: '他讨厌被追问感受', kind: '边界', at: '' }])
}

/* ============================================================
 * 5. prompt 渲染
 * ============================================================ */
console.log('\n=== 5. prompt 渲染 ===')
{
  const r = core.renderCoreForPrompt()
  check('有内容', r.length > 0)
  check('带【我一定不能弄错的】', r.includes('【我一定不能弄错的】'), r.slice(0, 40))
  check('带分类名', r.includes('边界'), r)
  // 边界要排在偏好前面
  core.saveCore([
    { text: '喜欢安静', kind: '偏好', at: '' },
    { text: '不许追问感受', kind: '边界', at: '' },
  ])
  const r2 = core.renderCoreForPrompt()
  const iBoundary = r2.indexOf('不许追问感受')
  const iPref = r2.indexOf('喜欢安静')
  check('边界排在偏好前面（不许干什么更优先）', iBoundary >= 0 && iPref > iBoundary, `${iBoundary} vs ${iPref}`)
}

/* ============================================================
 * 6. 临时记忆
 * ============================================================ */
console.log('\n=== 6. 临时记忆 ===')
{
  // 清理
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true })

  const id = temp.saveTemp({
    query: '什么是 SSR',
    source: 'test',
    results: [
      { title: 'SSR 是什么', url: 'https://example.com/1', snippet: '服务端渲染' },
      { title: 'SSR vs CSR', url: 'https://example.com/2', snippet: '对比' },
    ],
    body: '正文内容在这里',
  })
  check('存成功了', !!id, String(id))

  const all = temp.loadTemp()
  check('能读出来', all.length === 1, String(all.length))
  check('查询词对', all[0]?.query === '什么是 SSR', all[0]?.query)
  check('结果 2 条', all[0]?.results.length === 2, String(all[0]?.results.length))
  check('正文存下来了', all[0]?.body === '正文内容在这里', all[0]?.body?.slice(0, 20))

  // 相关性
  const rel = temp.relevantTemp('SSR')
  check('搜 SSR 能找到', rel.length === 1, String(rel.length))
  const notRel = temp.relevantTemp('今天天气怎么样')
  check('不相关的取不到', notRel.length === 0, String(notRel.length))

  // prompt 渲染
  const p = temp.renderTempForPrompt(rel)
  check('渲染带"可能过时"提示', p.includes('可能过时'), p.slice(0, 50))
  check('渲染带查询词', p.includes('什么是 SSR'))
}

/* ============================================================
 * 7. TTL 清理
 * ============================================================ */
console.log('\n=== 7. 7 天过期 ===')
{
  // 手动造一条 8 天前的
  const { mkdirSync } = await import('node:fs')
  mkdirSync(TEMP_DIR, { recursive: true })
  const oldAt = Date.now() - 8 * 86_400_000
  writeFileSync(
    `${TEMP_DIR}/2026-01-01-old.md`,
    `---\nat: ${oldAt}\nquery: 旧的东西\nsource: test\nttlDays: 7\n---\n\n# 搜：旧的东西\n\n## 结果\n\n1. 【旧】https://old.example\n`,
    'utf8',
  )

  const before = temp.loadTemp().length
  check('造了一条过期的（共 ' + before + ' 条）', before === 2, String(before))

  const removed = temp.prune()
  check('清理删了 1 条', removed === 1, String(removed))
  check('只剩新的那条', temp.loadTemp().length === 1, String(temp.loadTemp().length))
  check('剩下的是 SSR 那条', temp.loadTemp()[0]?.query === '什么是 SSR')
}

/* ============================================================
 * 8. 临时记忆不进 facts
 * ============================================================ */
console.log('\n=== 8. 临时不污染正式记忆 ===')
{
  // 读代码检查：temp.ts 不 import facts
  const src = readFileSync('src/memory/temp.ts', 'utf8')
  check('temp.ts 不导入 facts.ts', !src.includes("from './facts.ts'"), '')
  check('temp.ts 不调 appendFacts', !src.includes('appendFacts'), '')

  // distill 也不该碰 temp
  const distSrc = readFileSync('src/memory/distill.ts', 'utf8')
  check('distill 不碰 temp', !distSrc.includes("from './temp.ts'"), '')
}

/* ---------- 恢复 ---------- */
for (const [f, content] of backup) {
  if (content === null) {
    if (existsSync(f)) unlinkSync(f)
  } else {
    writeFileSync(f, content, 'utf8')
  }
}
if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
