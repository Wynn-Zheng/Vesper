/**
 * 情绪系统改动的体检。
 *
 * 改动一（P0）：对比基准 —— evaluate 的 prompt 里要带上"以前的事"和"最近的原话"
 * 改动二（P1）：效价 + 衰减分两档
 *
 * 依据：
 *   Regan et al. 2024 (arXiv:2402.04232)：情绪来自新事件 vs 过去记忆的对比
 *   Russell (1980)：情绪是二维的（valence × arousal）
 *   Frijda (1988)：情绪会习惯化，但不是两小时就消失
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

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

const mood = await import('../src/persona/mood.ts')
const evSrc = readFileSync('src/relation/evaluate.ts', 'utf8')
const moodSrc = readFileSync('src/persona/mood.ts', 'utf8')
const FILE = mood.moodFile()
const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null

/* ============ 1. 改动一：对比基准接上了 ============ */
console.log('=== 1. 对比基准（改动一）===')
{
  check('prompt 里有「以前的事」指令', evSrc.includes('以前的事'), '')
  check('prompt 要求对比强度', evSrc.includes('和以前**不一样**') || evSrc.includes('不一样'), '')
  check('prompt 提到"第三次说同一件事"该弱', evSrc.includes('第三次'), '')
  check('prompt 禁止推论心理', evSrc.includes('不要推论他的心理') || evSrc.includes('不要写成'), '')
  check('prompt 引用了 Regan', evSrc.includes('Regan'), '')
  check('有 recentContext 函数', evSrc.includes('function recentContext'), '')
  check('取经历用 sharedBigrams（不是 similarity）', evSrc.includes('sharedBigrams(userText'), '')
  check('还看最近原话（判断"说过没有"）', evSrc.includes('recentRawTurns'), '')
  check('不用 recall（避免污染召回次数）', !evSrc.includes('recall(') || evSrc.includes('不用 recall'), '')
  check('evaluate 把 past 拼进 userBlock', evSrc.includes('以前的事（判断强度时对比着看）'), '')
}

/* ============ 2. 改动二：效价 ============ */
console.log('\n=== 2. 效价（改动二）===')
{
  check('MoodEntry 有 valence', moodSrc.includes('valence?: number'), '')
  check('注释引用了 Russell', moodSrc.includes('Russell'), '')
  check('注释解释了为什么要加', /效价/.test(moodSrc), '')
  check('prompt 让模型输出效价', evSrc.includes('"效价"'), '')
  check('prompt 说明效价范围 -1~+1', evSrc.includes('-1 很难受'), '')
  check('保存时写效价', moodSrc.includes('效价: ${m.valence}'), '')
  check('解读时夹到 [-1,1]', moodSrc.includes('Math.min(1, Math.max(-1, v))'), '')

  // 实测读写
  mood.saveMood({ emotion: '测试', intensity: 0.5, valence: -0.7, at: Date.now() })
  check('存了能读回来', mood.loadMood()?.valence === -0.7, String(mood.loadMood()?.valence))

  // 老格式（没有效价）
  writeFileSync(FILE, '情绪: 老数据\n强度: 0.6\n时间: 2026-10-26T10:00:00.000Z\n', 'utf8')
  const m = mood.loadMood()
  check('老格式读得出', m?.emotion === '老数据', m?.emotion)
  check('老格式没有效价时是 undefined', m?.valence === undefined, String(m?.valence))
}

/* ============ 3. 衰减分两档 ============ */
console.log('\n=== 3. 衰减分档 ===')
{
  const at = Date.now()
  const H = 3_600_000

  check('注释引用了 Frijda', moodSrc.includes('Frijda'), '')
  check('代码里有按 valence 分档', moodSrc.includes('valence < -0.2'), '')
  check('衰减不是原来的一律 0.35', !moodSrc.includes('Math.exp(-0.35 * hours)'), '')

  const neg = mood.decayedMood({ emotion: '担心', intensity: 1, valence: -0.6, at: at - 11 * H }, at)
  const neu = mood.decayedMood({ emotion: '平静', intensity: 1, valence: 0, at: at - 11 * H }, at)
  check('11 小时后负面还在', (neg?.intensity ?? 0) > 0.4, String(neg?.intensity))
  check('同时间后负面比平淡留得多', (neg?.intensity ?? 0) > (neu?.intensity ?? 0) || neu === null, `${neg?.intensity} vs ${neu?.intensity}`)

  // 半衰期检查
  const negHalf = mood.decayedMood({ emotion: 'x', intensity: 1, valence: -0.9, at: at - 11.5 * H }, at)
  check('负面半衰期约 11 小时', negHalf !== null && negHalf.intensity >= 0.45 && negHalf.intensity <= 0.55, String(negHalf?.intensity))

  const neuHalf = mood.decayedMood({ emotion: 'x', intensity: 1, valence: 0.5, at: at - 5.8 * H }, at)
  check('其余半衰期约 6 小时', neuHalf !== null && neuHalf.intensity >= 0.45 && neuHalf.intensity <= 0.55, String(neuHalf?.intensity))

  check('比原来（2 小时）慢很多', (negHalf?.intensity ?? 0) > 0.4, '')
}

/* ============ 4. 边界 ============ */
console.log('\n=== 4. 边界 ===')
{
  const at = Date.now()
  check('NaN 强度 → null', mood.decayedMood({ emotion: 'x', intensity: NaN, at }, at) === null)
  check('0 强度 → null', mood.decayedMood({ emotion: 'x', intensity: 0, at }, at) === null)
  check('未来时间不衰减', mood.decayedMood({ emotion: 'x', intensity: 0.8, at: at + 3600_000 }, at)?.intensity === 0.8)

  writeFileSync(FILE, '情绪: x\n强度: abc\n时间: 2026-10-26T10:00:00.000Z\n', 'utf8')
  check('强度非法 → 兜到 0.3（不是 NaN）', mood.loadMood()?.intensity === 0.3, String(mood.loadMood()?.intensity))

  writeFileSync(FILE, '情绪: x\n强度: 0.5\n效价: 99\n时间: 2026-10-26T10:00:00.000Z\n', 'utf8')
  check('效价超范围夹到 1', mood.loadMood()?.valence === 1, String(mood.loadMood()?.valence))
}

/* ============ 5. 效果（用真实 episode 验算 pick 逻辑） ============ */
console.log('\n=== 5. pick 逻辑 ===')
{
  const store = await import('../src/memory/store.ts')
  const text = await import('../src/core/text.ts')
  const eps = store.loadEpisodes()
  check(`有 ${eps.length} 条 episode 可选`, eps.length > 0, String(eps.length))

  // 模拟 recentContext 的 pick：话题相关优先，不够就补最近的
  const q = '我妈住院了'
  const byTopic = eps
    .map((e) => ({ e, shared: text.sharedBigrams(q, `${e.title} ${e.body}`) }))
    .filter((x) => x.shared >= 2)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 2)
    .map((x) => x.e)
  const picked = [...byTopic]
  for (const e of [...eps].reverse()) {
    if (picked.length >= 3) break
    if (!picked.includes(e)) picked.push(e)
  }
  check('能凑够 3 条（话题不够就用最近的补）', picked.length === 3, String(picked.length))
  check('不会重复', new Set(picked.map((e) => e.id + e.scope)).size === picked.length, '')
}

/* ---------- 恢复 ---------- */
if (backup === null) {
  if (existsSync(FILE)) unlinkSync(FILE)
} else {
  writeFileSync(FILE, backup, 'utf8')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
