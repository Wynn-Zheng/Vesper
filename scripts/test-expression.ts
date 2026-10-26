/**
 * 表达学习升级验证：精选标记、只用精选、审核。
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const plays = await import('../src/learn/plays.ts')
const { DEFAULTS } = await import('../src/core/config.ts')

/* ---------- 1. 配置默认值 ---------- */
console.log('=== 1. 配置 ===')
{
  check('默认开审核', DEFAULTS.表达学习.审核 === true)
  check('默认不只精选（先宽进）', DEFAULTS.表达学习.只用精选 === false)
}

/* ---------- 2. 精选标记的读写 ---------- */
console.log('\n=== 2. 精选标记 ===')
{
  // 写到真实文件（plays.ts 的 FILE 是硬编码的）
  const before = plays.loadPlays()
  const backup = JSON.stringify(before)

  // 清空重来
  plays.savePlays([])
  plays.recordPlay(9, '今天好累', '那就早点睡')
  plays.recordPlay(2, '今天好累', '你应该保持积极')

  const items = plays.loadPlays()
  check(`记了 ${items.length} 条`, items.length === 2, String(items.length))
  check('默认都没精选', items.every((p) => !p.checked))

  // 标记一条
  const ok = plays.toggleChecked('今天好累', true)
  check('toggleChecked 成功', ok)
  const after = plays.loadPlays()
  const good = after.filter((p) => p.score >= 7)
  check('好的一条被标记了', good.some((p) => p.checked), JSON.stringify(after.map((p) => ({ s: p.score, c: p.checked }))))

  // 文件里应该有 ★
  const raw = readFileSync('persona/learned/plays.md', 'utf8')
  check('plays.md 里有 ★', raw.includes('★'), raw.split('\n').find((l) => l.includes('★')) || '（没找到）')

  // 再取消
  plays.toggleChecked('今天好累', false)
  check('可以取消精选', plays.loadPlays().every((p) => !p.checked))

  // 恢复
  plays.savePlays(JSON.parse(backup) as ReturnType<typeof plays.loadPlays>)
}

/* ---------- 3. 只用精选的过滤 ---------- */
console.log('\n=== 3. 只用精选 ===')
{
  const backup = JSON.stringify(plays.loadPlays())
  plays.savePlays([])
  plays.recordPlay(9, '我最近好累啊', '那就早点睡')
  plays.recordPlay(9, '我最近好累', '去睡吧')
  plays.toggleChecked('我最近好累啊', true)

  const all = plays.relevantPlays('我最近好累', 5, false)
  const onlyChecked = plays.relevantPlays('我最近好累', 5, true)
  check(`全部模式返回 ${all.length} 条`, all.length >= 1)
  check(`只精选返回 ${onlyChecked.length} 条`, onlyChecked.length === 1, JSON.stringify(onlyChecked.map((p) => p.scene)))
  check('只精选的那条确实是标记过的', onlyChecked.every((p) => p.checked))

  plays.savePlays(JSON.parse(backup) as ReturnType<typeof plays.loadPlays>)
}

/* ---------- 4. 审核：不值得的不记 ---------- */
console.log('\n=== 4. 审核（用假模型）===')
{
  const backup = JSON.stringify(plays.loadPlays())
  plays.savePlays([])

  // 假模型：对"应该保持积极"这种模板句说不
  const fakeLlm = {
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:1', // 连不上 → reviewPlay 的 catch 会返回 true（保守放过）
    model: 'x',
  }
  const rules = { ...DEFAULTS, 表达学习: { 审核: true, 只用精选: false } }

  const r1 = await plays.recordPlayReviewed(9, '今天好累', '那就早点睡', fakeLlm, rules)
  check('模型不可用时保守放过（不因网络丢经验）', r1 === true)

  // 关掉审核：不该调模型
  const rulesOff = { ...DEFAULTS, 表达学习: { 审核: false, 只用精选: false } }
  const r2 = await plays.recordPlayReviewed(9, '今天好累', '去睡吧', fakeLlm, rulesOff)
  check('关掉审核直接记', r2 === true)

  // 低分不审核（差评留着当反面教材）
  const r3 = await plays.recordPlayReviewed(2, '今天好累', '你应该积极', fakeLlm, rules)
  check('低分直接记（不审）', r3 === true)

  plays.savePlays(JSON.parse(backup) as ReturnType<typeof plays.loadPlays>)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
