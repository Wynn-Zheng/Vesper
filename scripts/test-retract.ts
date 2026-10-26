/**
 * 改口 / 反悔的体检。
 *
 * 两层：
 *   1. prompt 级 —— 允许它说到一半当场改
 *   2. 流程级 —— 自评很差时，小概率补一句"说错了"
 *
 * 为什么流程级要用预设句而不是现生成：
 *   改口本来就该短、该含糊（"算了，当我没说"没人写小作文），
 *   现生成容易变成长篇认错。而且这是低频行为，不值一次模型调用。
 */
import { readFileSync } from 'node:fs'

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

const boot = readFileSync('src/boot.ts', 'utf8')
const promptSrc = readFileSync('src/loop/prompt.ts', 'utf8')
const configSrc = readFileSync('src/core/config.ts', 'utf8')
const judgeSrc = readFileSync('src/loop/judge.ts', 'utf8')

/* ============ 1. prompt 级 ============ */
console.log('=== 1. prompt 里允许改口 ===')
{
  check('有「允许你改口」', promptSrc.includes('允许你改口'), '')
  check('给了例子', promptSrc.includes('说岔了') || promptSrc.includes('当我没说'), '')
  check('提醒别每次都改', promptSrc.includes('别每次都改'), '')

  const p = await import('../src/loop/prompt.ts')
  const { loadRules } = await import('../src/core/config.ts')
  const rules = loadRules().rules
  const sys = p.buildSystem({ rules, now: new Date() })

  check('真的进了 prompt', sys.includes('允许你改口'), '')
  // 格式：要是个列表项（前面有 "- "）
  const line = sys.split('\n').find((l) => l.includes('允许你改口'))
  check('是列表项格式（- 开头）', !!line?.startsWith('- '), line?.slice(0, 20))
}

/* ============ 2. 配置 ============ */
console.log('\n=== 2. 配置项 ===')
{
  check('有改口概率', configSrc.includes('改口概率'), '')
  check('默认值存在且是 0（关）', /改口概率:\s*0\b/.test(configSrc), '')

  // ⚠️ 关键：merge 只合并 DEFAULTS 已有的键，YAML 里独有的会被丢弃。
  // 所以类型里加了字段还不够，DEFAULTS 里必须有默认值，否则永远读不到。
  const { loadRules: lr } = await import('../src/core/config.ts')
  const loaded = lr()
  check('实际能读到改口概率（不是 undefined）', loaded.rules.行为.改口概率 !== undefined, String(loaded.rules.行为.改口概率))
  check('实际能读到已读不回概率', loaded.rules.行为.已读不回概率 !== undefined, String(loaded.rules.行为.已读不回概率))
  check('没有未知键警告', (loaded.unknown?.length ?? 0) === 0, (loaded.unknown ?? []).join(','))
}

/* ============ 3. 预设句 ============ */
console.log('\n=== 3. 预设句 ===')
{
  check('有 FIX_LINES', boot.includes('FIX_LINES'), '')
  // 从源码里把数组抠出来数一下
  const m = /const FIX_LINES = \[([\s\S]*?)\]/.exec(boot)
  check('能找到数组定义', !!m, '')
  if (m) {
    const items = m[1]!.split('\n').filter((l) => l.trim().startsWith("'"))
    check(`有 ${items.length} 句`, items.length >= 3, String(items.length))
    check('句子都不长（<= 30 字）', items.every((l) => l.replace(/['",]/g, '').trim().length <= 30), '')
    check('含"说岔/没说/收回/不对"这类词', /说岔|没说|收回|不对|说错/.test(m[1]!), '')
  }
}

/* ============ 4. 触发条件 ============ */
console.log('\n=== 4. 触发条件 ===')
{
  check('只有 score < 4 才考虑', /r\.score\s*<\s*4/.test(boot), '')
  check('要求 issue 非空', /r\.issue\.trim\(\)/.test(boot), '')
  check('按概率触发', /Math\.random\(\)\s*<\s*fixRate/.test(boot), '')
  check('概率为 0 时不触发', /fixRate\s*>\s*0/.test(boot), '')
  check('失败不影响主流程', /补不出去就算了/.test(boot) || /catch\s*\{\s*\/\*[^*]*补不出去/.test(boot), '')

  // 位置：必须在 judge 的 .then 里（自评之后）
  const iJudge = boot.indexOf('judgeReply')
  const iFix = boot.indexOf('改口概率')
  check('在 judge 之后触发', iJudge > 0 && iFix > iJudge, `judge@${iJudge} fix@${iFix}`)
}

/* ============ 5. 延迟（像"发完才后悔"） ============ */
console.log('\n=== 5. 延迟 ===')
{
  check('有延迟', /await sleep\(1200/.test(boot) || /sleep\(1200/.test(boot), '')
  const m = /sleep\((\d+)\s*\+\s*Math\.random\(\)\s*\*\s*(\d+)\)/.exec(boot)
  check('延迟 1.2~3.7 秒之间（不是秒回）', !!m, m?.[0] ?? '')
}

/* ============ 6. 自评能给低分吗 ============ */
console.log('\n=== 6. 依赖的自评 ===')
{
  check('judge 存在', judgeSrc.includes('export async function judgeReply'), '')
  check('judge 返回 0-10 的分', judgeSrc.includes('Math.min(10, Math.max(0, raw))'), '')
  check('judge 会返回 issue', judgeSrc.includes('issue:'), '')
  check('judge 用 temperature 0.2（稳定）', judgeSrc.includes('temperature: 0.2'), '')
}

/* ============ 7. 用真模型看它会不会真给低分 ============ */
console.log('\n=== 7. 实测自评（不触发改口，只看分）===')
{
  const { loadRules } = await import('../src/core/config.ts')
  const { judgeReply } = await import('../src/loop/judge.ts')
  const rules = loadRules().rules
  const llm = {
    apiKey: process.env['DEEPSEEK_API_KEY']!,
    baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
    model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
  }

  const cases = [
    { label: '好的回复', u: '今天好累啊', s: '那就早点躺下。' },
    { label: '差的回复（客服腔 + 长）', u: '今天好累啊', s: '我理解你的感受，工作确实会让人疲惫。建议你合理安排作息，注意劳逸结合，相信你一定能调整好的。' },
  ]

  for (const c of cases) {
    const r = await judgeReply({ llm, userText: c.u, selfText: c.s, who: 'test' })
    console.log(`  ${c.label}：${r?.score ?? '?'}/10  ${r?.issue ? `「${r.issue}」` : ''}`)
    if (c.label.includes('差')) {
      check('差的回复分数明显低（< 6）', (r?.score ?? 10) < 6, String(r?.score))
    }
    await new Promise((r2) => setTimeout(r2, 600))
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
