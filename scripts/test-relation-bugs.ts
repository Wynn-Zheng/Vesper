/**
 * 关系模块体检。
 *
 * 关系模块以前只有实现没有边界测试，这个脚本补上三个模块的边界验证。
 */
import { mkdtempSync } from 'node:fs'
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

/* ================= 关系 ================= */
console.log('=== 关系：store 的坏数据容错 ===')
const relStore = await import('../src/relation/store.ts')
const relTypes = await import('../src/relation/types.ts')

{
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-rel-'))
  relStore.setRelationRoot(dir)

  // 1) 关系值手工改成 150 / -20 / abc / NaN 都要夹回 [0,100]
  const cases: Array<[string, number]> = [
    ['总关系值: 150', 100],
    ['总关系值: -20', 0],
    ['总关系值: abc', 0],
    // Infinity 不是有限数，兜底到 0（保守值）
    ['总关系值: .inf', 0],
  ]
  for (const [content, expect] of cases) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'p1'), { recursive: true })
    writeFileSync(join(dir, 'p1', 'relation.yaml'), content, 'utf8')
    const r = relStore.loadRelation('p1')
    check(`${content} → ${r.closeness}（应为 ${expect}）`, r.closeness === expect, String(r.closeness))
  }

  // 2) 锚点上限
  check('MAX_ANCHORS 是 200', relStore.MAX_ANCHORS === 200, String(relStore.MAX_ANCHORS))
  check('MAX_DIMENSION_EVENTS 是 50', relStore.MAX_DIMENSION_EVENTS === 50, String(relStore.MAX_DIMENSION_EVENTS))

  // 3) 空文件 / 坏 YAML 返回默认值
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(dir, 'p2'), { recursive: true })
  writeFileSync(join(dir, 'p2', 'relation.yaml'), '', 'utf8')
  const r2 = relStore.loadRelation('p2')
  check('空文件返回默认关系值 0', r2.closeness === 0, String(r2.closeness))
  check('空文件返回空锚点', Array.isArray(r2.anchors) && r2.anchors.length === 0)

  writeFileSync(join(dir, 'p2', 'relation.yaml'), '\t非法: [', 'utf8')
  const r3 = relStore.loadRelation('p2')
  check('坏 YAML 不崩、返回默认值', r3.closeness === 0, String(r3.closeness))
}

console.log('\n=== 关系：evaluate 的模型输出收敛 ===')
{
  // normalizeAnchor 之类如果没导出，就跳过；先看导出
  const keys = Object.keys(await import('../src/relation/evaluate.ts'))
  console.log('   evaluate.ts 导出:', keys.join(', '))
}

console.log('\n=== 关系：阶段边界 ===')
{
  const { stageOf, DEFAULTS } = await import('../src/core/config.ts')
  const stages = DEFAULTS.关系.阶段
  // 每个阶段的"至"正好等于阈值时应该归到该阶段
  for (const s of stages) {
    const got = stageOf(DEFAULTS, s.至)
    check(`关系值 ${s.至} 应归到「${s.名}」`, got.名 === s.名, `实际 ${got.名}`)
  }
  // 差 1 分不该跨阶段
  for (const s of stages) {
    if (s.至 <= 0) continue
    const got = stageOf(DEFAULTS, s.至 - 0.1)
    check(`关系值 ${(s.至 - 0.1).toFixed(1)} 不该越过「${s.名}」`, got.至 <= s.至, `实际 ${got.名}`)
  }
}

/* ================= 学习 ================= */
console.log('\n=== 学习：plays 往返一致 ===')
{
  const plays = await import('../src/learn/plays.ts')
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs')

  const f = plays.playsFile()
  const backup = existsSync(f) ? readFileSync(f, 'utf8') : ''
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-plays-'))
  console.log(`   （plays 文件固定为 ${f}，测试会备份/恢复）`)

  plays.savePlays([])
  plays.recordPlay(9, '甲场景', '甲回复')
  plays.recordPlay(2, '乙场景', '乙回复')
  plays.toggleChecked('甲场景', true)

  const first = plays.loadPlays()
  const rendered = readFileSync(f, 'utf8')
  check('★ 标记写进了文件', rendered.includes('★'))
  check('读回来 checked 为 true', first.find((p) => p.scene === '甲场景')?.checked === true)

  // 再存一次，内容应该完全一样（往返稳定）
  plays.savePlays(first)
  const second = readFileSync(f, 'utf8')
  check('往返一次内容不变', rendered === second)

  // 恢复
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, backup, 'utf8')
}

console.log('\n=== 学习：jargon 解析容错 ===')
{
  const jargon = await import('../src/learn/jargon.ts')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const d = await mkdtemp(join(tmpdir(), 'qqbot-jargon-'))
  // jargon 的路径是不是可注入的？先看导出
  console.log('   jargon.ts 导出:', Object.keys(jargon).join(', '))
  check('loadJargon 对不存在的群返回空数组', Array.isArray(jargon.loadJargon('不存在')))
}

/* ================= 人格 ================= */
console.log('\n=== 人格：mood 衰减 ===')
{
  const mood = await import('../src/persona/mood.ts')
  console.log('   mood.ts 导出:', Object.keys(mood).join(', '))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
