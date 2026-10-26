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
const FILE = mood.moodFile()
const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null

/* ============ 1. 老格式（没有效价）要能读 ============ */
console.log('=== 1. 老格式兼容 ===')
{
  writeFileSync(
    FILE,
    `情绪: 担心
强度: 0.7
时间: 2026-10-26T10:00:00.000Z

最近:
- { 情绪: 平静, 强度: 0.5, 时间: 2026-10-26T08:00:00.000Z }
- { 情绪: 担心, 强度: 0.7, 时间: 2026-10-26T10:00:00.000Z, 因为: 他说不来了 }
`,
    'utf8',
  )
  const m = mood.loadMood()
  check('读出来了', !!m, '')
  check('情绪对', m?.emotion === '担心', m?.emotion)
  check('强度对', m?.intensity === 0.7, String(m?.intensity))
  check('没有效价时 valence 是 undefined', m?.valence === undefined, String(m?.valence))
  check('recent 读了 2 条', m?.recent?.length === 2, String(m?.recent?.length))
  check('recent 第一条对', m?.recent?.[0]?.emotion === '平静', m?.recent?.[0]?.emotion)
  check('recent 第二条有原因', m?.recent?.[1]?.reason === '他说不来了', m?.recent?.[1]?.reason)
}

/* ============ 2. 新格式（有效价）读写 ============ */
console.log('\n=== 2. 新格式 ===')
{
  mood.saveMood({
    emotion: '担心',
    intensity: 0.7,
    valence: -0.6,
    at: Date.parse('2026-10-26T10:00:00.000Z'),
    recent: [
      { emotion: '平静', intensity: 0.5, at: Date.parse('2026-10-26T08:00:00.000Z') },
      { emotion: '担心', intensity: 0.7, valence: -0.6, at: Date.parse('2026-10-26T10:00:00.000Z'), reason: '他说不来了' },
    ],
  })

  const raw = readFileSync(FILE, 'utf8')
  check('文件里有「效价」行', raw.includes('效价: -0.6'), raw.split('\n').slice(0, 5).join(' | '))
  check('recent 里也有效价', /\{ 情绪: 担心, 强度: 0.7, 效价: -0.6/.test(raw), raw.split('\n').find((l) => l.includes('担心')))

  const m = mood.loadMood()
  check('读回来效价对', m?.valence === -0.6, String(m?.valence))
  check('recent 读回来 2 条', m?.recent?.length === 2, String(m?.recent?.length))
  check('recent 里的效价也在', m?.recent?.[1]?.valence === -0.6, String(m?.recent?.[1]?.valence))
  check('recent 第一条没有效价', m?.recent?.[0]?.valence === undefined, String(m?.recent?.[0]?.valence))
}

/* ============ 3. 衰减分档 ============ */
console.log('\n=== 3. 衰减 ===')
{
  const at = Date.now()
  const H = 3_600_000

  // 负面：11 小时半衰期
  const neg = mood.decayedMood({ emotion: '担心', intensity: 1, valence: -0.6, at: at - 11 * H }, at)
  check('负面 11 小时后还有约一半', neg !== null && neg.intensity > 0.4 && neg.intensity < 0.6, String(neg?.intensity))

  // 正面/平淡：6 小时半衰期
  const neu = mood.decayedMood({ emotion: '平静', intensity: 1, valence: 0, at: at - 6 * H }, at)
  check('平淡 6 小时后还有约一半', neu !== null && neu.intensity > 0.4 && neu.intensity < 0.6, String(neu?.intensity))

  // 同一时刻，负面比平淡留得多
  const neg6 = mood.decayedMood({ emotion: '担心', intensity: 1, valence: -0.6, at: at - 6 * H }, at)
  check('6 小时后：负面比平淡留得多', (neg6?.intensity ?? 0) > (neu?.intensity ?? 0), `${neg6?.intensity} vs ${neu?.intensity}`)

  // 老数据（无效价）按平淡算
  const old = mood.decayedMood({ emotion: '担心', intensity: 1, at: at - 6 * H }, at)
  check('老数据按平淡衰减', Math.abs((old?.intensity ?? 0) - (neu?.intensity ?? 0)) < 0.01, `${old?.intensity} vs ${neu?.intensity}`)

  // 归零
  const gone = mood.decayedMood({ emotion: '高兴', intensity: 1, valence: 0, at: at - 48 * H }, at)
  check('48 小时后归零', gone === null, String(gone))

  // 未来时间不衰减
  const future = mood.decayedMood({ emotion: '高兴', intensity: 0.8, at: at + H }, at)
  check('未来时间原样返回', future?.intensity === 0.8, String(future?.intensity))

  // 坏数据
  check('NaN 强度返回 null', mood.decayedMood({ emotion: 'x', intensity: NaN, at }, at) === null)
  check('0 强度返回 null', mood.decayedMood({ emotion: 'x', intensity: 0, at }, at) === null)
}

/* ============ 4. 效价被夹住 ============ */
console.log('\n=== 4. 效价范围 ===')
{
  writeFileSync(FILE, `情绪: 测试\n强度: 0.5\n效价: 99\n时间: 2026-10-26T10:00:00.000Z\n`, 'utf8')
  check('超范围效价夹到 1', mood.loadMood()?.valence === 1, String(mood.loadMood()?.valence))

  writeFileSync(FILE, `情绪: 测试\n强度: 0.5\n效价: -99\n时间: 2026-10-26T10:00:00.000Z\n`, 'utf8')
  check('负超范围夹到 -1', mood.loadMood()?.valence === -1, String(mood.loadMood()?.valence))

  writeFileSync(FILE, `情绪: 测试\n强度: 0.5\n效价: abc\n时间: 2026-10-26T10:00:00.000Z\n`, 'utf8')
  check('非数字效价当 undefined', mood.loadMood()?.valence === undefined, String(mood.loadMood()?.valence))
}

/* ============ 5. 坏文件不炸 ============ */
console.log('\n=== 5. 坏数据 ===')
{
  writeFileSync(FILE, '', 'utf8')
  check('空文件返回 null', mood.loadMood() === null)

  writeFileSync(FILE, '随便写点什么\n没有情绪字段\n', 'utf8')
  check('缺情绪字段返回 null', mood.loadMood() === null)

  writeFileSync(FILE, '情绪: 高兴\n强度: abc\n', 'utf8')
  const m = mood.loadMood()
  check('强度非法时不炸（夹到 0）', m !== null && Number.isFinite(m.intensity), String(m?.intensity))
}

/* ---------- 恢复 ---------- */
if (backup === null) {
  if (existsSync(FILE)) unlinkSync(FILE)
} else {
  writeFileSync(FILE, backup, 'utf8')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
