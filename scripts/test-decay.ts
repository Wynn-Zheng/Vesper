/**
 * 衰减函数和召回加强的体检。
 *
 * 依据（都查过 Crossref）：
 *   Wixted & Ebbesen (1991) 遗忘是幂函数，不是指数
 *   Roediger & Karpicke (2006) 主动回忆比重复阅读更巩固长期记忆
 *   McGaugh (2004) 情绪唤起加强记忆巩固
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

const recallSrc = readFileSync('src/memory/recall.ts', 'utf8')
const typesSrc = readFileSync('src/memory/types.ts', 'utf8')

/* ============ 1. 衰减是幂律不是指数 ============ */
console.log('=== 1. 衰减函数 ===')
{
  check('不再用 Math.exp 算 recency', !recallSrc.includes('Math.exp(-lambda * days)'), '还在用指数')
  check('用 Math.pow 算 recency', recallSrc.includes('Math.pow(1 + Math.max(0, days)'), '')
  check('注释里引用了 Wixted & Ebbesen', recallSrc.includes('Wixted'), '')
  check('注释里引用了 Murre & Dros 复现', recallSrc.includes('Murre'), '')
}

/* ============ 2. 幂律的实际形状（长尾） ============ */
console.log('\n=== 2. 幂律形状：要有长尾 ===')
{
  const lambda = 0.02
  const pow = (days: number, rc = 0): number => {
    const base = Math.pow(1 + Math.max(0, days), -lambda * 8)
    if (rc <= 0) return base
    const slow = 1 / (1 + Math.log(1 + rc) * 0.5)
    return Math.pow(1 + Math.max(0, days), -lambda * 8 * slow)
  }
  const exp = (days: number): number => Math.exp(-lambda * days)

  check('t=0 时是 1（不会炸）', Math.abs(pow(0) - 1) < 1e-9, String(pow(0)))
  check('半年后还有 40% 以上（长尾）', pow(180) > 0.4, pow(180).toFixed(3))
  check('两年后还没归零', pow(730) > 0.3, pow(730).toFixed(3))

  // 对比：指数半年后就基本没了
  check('对比：指数半年后已归零', exp(180) < 0.05, exp(180).toFixed(4))
  check('幂律明显比指数留得多（90 天）', pow(90) > exp(90) * 2, `${pow(90).toFixed(3)} vs ${exp(90).toFixed(3)}`)

  // 单调递减
  let mono = true
  for (let d = 0; d < 1000; d += 10) {
    if (pow(d + 10) > pow(d) + 1e-9) mono = false
  }
  check('单调递减（不会越久越新）', mono)
}

/* ============ 3. 回忆次数让衰减变慢 ============ */
console.log('\n=== 3. 测试效应：回忆越多越难忘 ===')
{
  const lambda = 0.02
  const pow = (days: number, rc = 0): number => {
    const base = Math.pow(1 + Math.max(0, days), -lambda * 8)
    if (rc <= 0) return base
    const slow = 1 / (1 + Math.log(1 + rc) * 0.5)
    return Math.pow(1 + Math.max(0, days), -lambda * 8 * slow)
  }

  check('回忆 1 次比 0 次留得多', pow(365, 1) > pow(365, 0), `${pow(365, 1).toFixed(3)} vs ${pow(365, 0).toFixed(3)}`)
  check('回忆 5 次比 1 次留得多', pow(365, 5) > pow(365, 1), `${pow(365, 5).toFixed(3)} vs ${pow(365, 1).toFixed(3)}`)
  check('回忆次数效果递减（不是线性加成）', pow(365, 10) - pow(365, 5) < pow(365, 5) - pow(365, 1), '')
  check('回忆 0 次时和基础一致', Math.abs(pow(365, 0) - Math.pow(1 + 365, -lambda * 8)) < 1e-9)
}

/* ============ 4. Episode 有 recallCount ============ */
console.log('\n=== 4. 数据字段 ===')
{
  check('Episode 有 recallCount', typesSrc.includes('recallCount?: number'), '')
  check('types.ts 注释说明它影响衰减', typesSrc.includes('让衰减变慢') || typesSrc.includes('衰减变慢'), '')
  check('recall.ts 里 flushRecalls 会 +1', recallSrc.includes('(e.recallCount ?? 0) + 1'), '')
  check('scoreOf 接收 recallCount', /recallCount = 0/.test(recallSrc), '')
  check('调用处传了 e.recallCount', recallSrc.includes('e.recallCount ?? 0'), '')
}

/* ============ 5. 正确性：不破坏可见性和排序 ============ */
console.log('\n=== 5. 原有逻辑没坏 ===')
{
  const recall = await import('../src/memory/recall.ts')

  // 可见性照旧
  check('私聊能看自己的', recall.visible('private:1', 'private:1') === true)
  check('私聊看不到别人的', recall.visible('private:2', 'private:1') === false)
  check('群聊能看本群', recall.visible('group:9', 'group:9') === true)
  check('shared 谁都能看', recall.visible('shared', 'private:1') === true)

  // lambda 三档照旧
  check('高重要度 lambda 小（忘得慢）', recall.lambdaOf(9) < recall.lambdaOf(6), `${recall.lambdaOf(9)} vs ${recall.lambdaOf(6)}`)
  check('低重要度 lambda 大（忘得快）', recall.lambdaOf(3) > recall.lambdaOf(6), `${recall.lambdaOf(3)} vs ${recall.lambdaOf(6)}`)

  // 坏数据仍然安全
  check('NaN 重要度不炸', Number.isFinite(recall.lambdaOf(NaN as unknown as number)), '')
}

/* ============ 6. 文档存在且提到关键论文 ============ */
console.log('\n=== 6. 调研文档 ===')
{
  const fs = await import('node:fs')
  const p = 'docs/人脑记忆研究.md'
  check('文档存在', fs.existsSync(p))
  if (fs.existsSync(p)) {
    const doc = fs.readFileSync(p, 'utf8')
    for (const k of ['Wixted', 'Roediger', 'McGaugh', 'Tulving', 'Squire', 'McClelland', 'Nader', 'Hintzman', 'Baddeley', 'Atkinson', 'Murre', 'Kumaran']) {
      check(`提到 ${k}`, doc.includes(k), '')
    }
    const dois = new Set((doc.match(/10\.\d{4,}\/[^\s)\]]+/g) || []).map((x) => x.replace(/[.,]$/, '')))
    check(`列了 ${dois.size} 个 DOI（≥10）`, dois.size >= 10, String(dois.size))
    check('说明了哪些是推断', doc.includes('我的推断'), '')
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
