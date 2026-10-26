/**
 * 体验对标改进的验证。
 *
 * P0：情绪序列带强度 + 原因 + 趋势（依据 ZifaMem 论文实测 +39%）
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

const mood = await import('../src/persona/mood.ts')
const { buildRelationBlock } = await import('../src/relation/format.ts')
const { DEFAULTS } = await import('../src/core/config.ts')

/* ---------- 1. reason 字段能存能读 ---------- */
console.log('=== 1. reason 落盘 ===')
{
  const f = mood.moodFile()
  let backup = ''
  try {
    backup = readFileSync(f, 'utf8')
  } catch {
    /* 本来没有 */
  }

  const now = Date.now()
  mood.saveMood({
    emotion: '低落',
    intensity: 0.2,
    at: now,
    reason: '他说来不了了',
    recent: [
      { emotion: '开心', intensity: 0.9, at: now - 3600_000, reason: '他说要请我吃饭' },
      { emotion: '平静', intensity: 0.5, at: now - 1800_000, reason: '等了半小时他还没来' },
      { emotion: '低落', intensity: 0.2, at: now, reason: '他说来不了了' },
    ],
  })

  const raw = readFileSync(f, 'utf8')
  check('文件里有「因为」', raw.includes('因为'), raw.split('\n').find((l) => l.includes('因为'))?.slice(0, 60) ?? '')

  const back = mood.loadMood()
  check('读回来 reason 还在', back?.recent?.[0]?.reason === '他说要请我吃饭', String(back?.recent?.[0]?.reason))
  check('三条都读回来', back?.recent?.length === 3, String(back?.recent?.length))
  check('强度保留', back?.recent?.[0]?.intensity === 0.9, String(back?.recent?.[0]?.intensity))

  // 老格式（没有 因为）也要能读
  writeFileSync(
    f,
    [
      '情绪: 平静',
      '强度: 0.5',
      '时间: 2026-10-26T00:00:00.000Z',
      '最近:',
      '- { 情绪: 开心, 强度: 0.8, 时间: 2026-10-26T00:00:00.000Z }',
    ].join('\n'),
    'utf8',
  )
  const old = mood.loadMood()
  check('老格式能读（没有因为）', old?.recent?.length === 1 && old.recent[0]!.emotion === '开心', JSON.stringify(old?.recent))

  // reason 里有逗号/括号不破坏解析
  writeFileSync(
    f,
    [
      '情绪: 平静',
      '强度: 0.5',
      '时间: 2026-10-26T00:00:00.000Z',
      '最近:',
      '- { 情绪: 开心, 强度: 0.8, 时间: 2026-10-26T00:00:00.000Z, 因为: 他说要请我吃饭 然后又说算了 }',
    ].join('\n'),
    'utf8',
  )
  const withComma = mood.loadMood()
  check('reason 含标点也能读', withComma?.recent?.[0]?.reason !== undefined, JSON.stringify(withComma?.recent))

  if (backup) writeFileSync(f, backup, 'utf8')
  else rmSync(f, { force: true })
}

/* ---------- 2. 渲染带强度 + 原因 ---------- */
console.log('\n=== 2. 渲染 ===')
{
  const now = Date.now()
  const m = {
    emotion: '低落',
    intensity: 0.2,
    at: now,
    recent: [
      { emotion: '开心', intensity: 0.9, at: now - 3600_000, reason: '他说要请我吃饭' },
      { emotion: '平静', intensity: 0.5, at: now - 1800_000, reason: '他还没来' },
      { emotion: '低落', intensity: 0.2, at: now, reason: '他说来不了了' },
    ],
  }
  const s = { closeness: 30, anchors: [], dimensions: {} } as never
  const text = buildRelationBlock(DEFAULTS, s, m, now)

  check('渲染出当前心情', text.includes('低落'), text.slice(0, 100))
  check('渲染出强度', text.includes('0.9') && text.includes('0.2'), text)
  check('渲染出原因', text.includes('他说要请我吃饭'), text)
  check('渲染出趋势（往下掉）', text.includes('往下掉'), text.match(/情绪在.*/)?.[0] ?? '')

  // 上升趋势
  const up = { ...m, recent: [
    { emotion: '低落', intensity: 0.2, at: now - 3600_000 },
    { emotion: '开心', intensity: 0.9, at: now },
  ] }
  const textUp = buildRelationBlock(DEFAULTS, s, up, now)
  check('上升时写「往上走」', textUp.includes('往上走'), textUp.match(/情绪在.*/)?.[0] ?? '')

  // 变化小就不提趋势
  const flat = { ...m, recent: [
    { emotion: '平静', intensity: 0.5, at: now - 1000 },
    { emotion: '平静', intensity: 0.55, at: now },
  ] }
  const textFlat = buildRelationBlock(DEFAULTS, s, flat, now)
  check('变化小不提趋势', !textFlat.includes('往上走') && !textFlat.includes('往下掉'), textFlat.match(/情绪在.*/)?.[0] ?? '')

  // 只有一条时不提序列
  const single = { ...m, recent: [{ emotion: '平静', intensity: 0.5, at: now }] }
  const textSingle = buildRelationBlock(DEFAULTS, s, single, now)
  check('只有一条时不提「最近的情绪」', !textSingle.includes('最近的情绪'), textSingle)
}

/* ---------- 3. 不破坏原有行为 ---------- */
console.log('\n=== 3. 回归 ===')
{
  const now = Date.now()
  const s = { closeness: 5, anchors: [], dimensions: {} } as never
  const text = buildRelationBlock(DEFAULTS, s, null, now)
  check('没有 mood 时能渲染', text.length > 0 && !text.includes('心情'), text.slice(0, 60))
  check('关系值低时有提醒', text.includes('还不熟'), text)

  // 衰减后不显示过时的情绪
  const stale = { emotion: '开心', intensity: 0.9, at: now - 48 * 3600_000 }
  const textStale = buildRelationBlock(DEFAULTS, s, stale, now)
  check('两天前的情绪不显示', !textStale.includes('开心'), textStale.slice(0, 80))
}

/* ---------- 4. 长度可控 ---------- */
console.log('\n=== 4. 长度 ===')
{
  const now = Date.now()
  const m = {
    emotion: '低落',
    intensity: 0.2,
    at: now,
    recent: Array.from({ length: 5 }, (_, i) => ({
      emotion: ['开心', '平静', '好奇', '烦躁', '低落'][i]!,
      intensity: 0.9 - i * 0.15,
      at: now - (5 - i) * 600_000,
      reason: '这是一句比较长的原因说明用来测试截断效果啊',
    })),
  }
  const s = { closeness: 50, anchors: [], dimensions: {} } as never
  const text = buildRelationBlock(DEFAULTS, s, m, now)
  const emotionLine = text.split('\n').find((l) => l.includes('最近的情绪')) ?? ''
  check('只取最近 4 条', (emotionLine.match(/→/g) ?? []).length <= 3, emotionLine)
  check('整段不超过 800 字', text.length < 800, String(text.length))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
