/**
 * episode 衰减档位的体检。
 *
 * 修的问题：
 *   lambdaOf 要求 importance >= 8 才算高情绪，但实测 9 条 episode 的 importance
 *   全是 2-3，那条分支**从未触发**——所有 episode 都用 17 天半衰期。
 *   而 emotion 字段 100% 有值。
 *
 * 依据：McGaugh (2004) 情绪唤起加强记忆巩固，说的是情绪，不是主观评分。
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

const recall = await import('../src/memory/recall.ts')
const store = await import('../src/memory/store.ts')

const HIGH = 0.005
const NORMAL = 0.02
const LOW = 0.04

function ep(importance: number, emotion?: string): Parameters<typeof recall.lambdaOfEpisode>[0] {
  return {
    id: 'x',
    date: '2026-10-25',
    scope: 'private:1',
    importance,
    title: 't',
    body: 'b',
    ...(emotion === undefined ? {} : { emotion }),
  } as Parameters<typeof recall.lambdaOfEpisode>[0]
}

/* ============ 1. 四种组合 ============ */
console.log('=== 1. 判定规则 ===')
{
  check('有情绪 + imp=3 → 高情绪档', recall.lambdaOfEpisode(ep(3, '被触动')) === HIGH, String(recall.lambdaOfEpisode(ep(3, '被触动'))))
  check('有情绪 + imp=5 → 高情绪档', recall.lambdaOfEpisode(ep(5, '开心')) === HIGH)
  check('有情绪 + imp=9 → 高情绪档', recall.lambdaOfEpisode(ep(9, '震惊')) === HIGH)
  check('有情绪 + imp=2 → 低档（太琐碎）', recall.lambdaOfEpisode(ep(2, '无所谓')) === LOW, String(recall.lambdaOfEpisode(ep(2, '无所谓'))))

  check('无情绪 + imp=8 → 高情绪档', recall.lambdaOfEpisode(ep(8)) === HIGH)
  check('无情绪 + imp=9 → 高情绪档', recall.lambdaOfEpisode(ep(9)) === HIGH)
  check('无情绪 + imp=6 → 普通档', recall.lambdaOfEpisode(ep(6)) === NORMAL, String(recall.lambdaOfEpisode(ep(6))))
  check('无情绪 + imp=5 → 普通档', recall.lambdaOfEpisode(ep(5)) === NORMAL)
  check('无情绪 + imp=3 → 低档', recall.lambdaOfEpisode(ep(3)) === LOW)

  check('空 emotion 字符串当没有', recall.lambdaOfEpisode(ep(3, '   ')) === LOW, String(recall.lambdaOfEpisode(ep(3, '   '))))
}

/* ============ 2. 坏数据不炸 ============ */
console.log('\n=== 2. 坏数据 ===')
{
  check('NaN importance 不炸', Number.isFinite(recall.lambdaOfEpisode(ep(NaN, '有情绪'))), '')
  check('负数 importance 当 0', recall.lambdaOfEpisode(ep(-5)) === LOW)
  check('超大 importance 夹到 10', recall.lambdaOfEpisode(ep(999)) === HIGH)
  check('emotion 是 undefined 不炸', Number.isFinite(recall.lambdaOfEpisode(ep(5))))
}

/* ============ 3. 和旧函数的关系 ============ */
console.log('\n=== 3. 没破坏旧函数 ===')
{
  // lambdaOf 还应该按 importance 走（facts 在用）
  check('lambdaOf(9) 还是高档', recall.lambdaOf(9) === HIGH)
  check('lambdaOf(6) 还是普通档', recall.lambdaOf(6) === NORMAL)
  check('lambdaOf(3) 还是低档', recall.lambdaOf(3) === LOW)
  check('lambdaOf 不看 emotion（签名就没有）', recall.lambdaOf.length >= 1)
}

/* ============ 4. 真实数据：应该 7 条进高档 ============ */
console.log('\n=== 4. 真实数据 ===')
{
  const eps = store.loadEpisodes()
  check(`读到 ${eps.length} 条 episode`, eps.length >= 9, String(eps.length))

  const byLambda = new Map<number, number>()
  for (const e of eps) {
    const l = recall.lambdaOfEpisode(e)
    byLambda.set(l, (byLambda.get(l) ?? 0) + 1)
  }

  const highCount = byLambda.get(HIGH) ?? 0
  const lowCount = byLambda.get(LOW) ?? 0

  console.log(`  分布: 高情绪 ${highCount} / 普通 ${byLambda.get(NORMAL) ?? 0} / 低 ${lowCount}`)
  console.log(`  （旧函数会是：高 0 / 普通 0 / 低 ${eps.length}）`)

  check('大部分进高情绪档', highCount >= 6, String(highCount))
  check('旧的 lambdaOf 确实全是低档（证明这是修 bug）', eps.every((e) => recall.lambdaOf(e.importance) === LOW), '')
  check('新函数有区分度（不是全进高档）', lowCount >= 1, String(lowCount))

  // 「凌晨两点他失眠」这种必须有情绪档
  const important = eps.find((e) => e.title.includes('失眠') || e.title.includes('四点半'))
  check('「凌晨失眠」那条进了高情绪档', important ? recall.lambdaOfEpisode(important) === HIGH : false, important?.title)
}

/* ============ 5. 效果：三个月后还剩多少 ============ */
console.log('\n=== 5. 实际效果（90 天） ===')
{
  const days = 90
  const decay = (l: number): number => Math.pow(1 + days, -l * 8)
  const high = decay(HIGH)
  const low = decay(LOW)

  console.log(`  高情绪档 90 天后: ${high.toFixed(3)}`)
  console.log(`  低档     90 天后: ${low.toFixed(3)}`)
  console.log(`  旧行为（全低档）:  ${low.toFixed(3)}`)

  check('高情绪档 90 天后还在 0.5 以上', high > 0.5, high.toFixed(3))
  check('比旧行为留得多 3 倍以上', high > low * 3, `${high.toFixed(3)} vs ${low.toFixed(3)}`)
}

/* ============ 6. 代码里确实换了 ============ */
console.log('\n=== 6. 接线 ===')
{
  const src = readFileSync('src/memory/recall.ts', 'utf8')
  check('lamlbdaOfEpisode 被导出', src.includes('export function lambdaOfEpisode'))
  check('scoreOf 调用处用了新函数', src.includes('lambdaOfEpisode(e, opts.decay)'), '')
  check('旧 lambdaOf 还在（facts 用）', src.includes('export function lambdaOf('))
  check('注释引用了 McGaugh', src.includes('McGaugh'), '')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
