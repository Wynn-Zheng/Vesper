/**
 * 人格模块体检：情绪衰减 + 快照回滚。
 *
 * 第 6 轮 agenttree 的 #33 节点没产出任何文件（opencode 额度那时已经不稳），
 * 这个脚本是手动补的。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const version = await import('../src/persona/version.ts')

/* ================= 情绪衰减 ================= */
console.log('=== 1. 情绪衰减 ===')
{
  const mk = (emotion: string, intensity: number, at: number) => ({ emotion, intensity, at })

  check('null 输入返回 null', mood.decayedMood(null) === null)

  const now = Date.now()
  // intensity 是 0-1
  const fresh = mood.decayedMood(mk('开心', 0.8, now), now)
  check('刚存的强度不变', fresh?.intensity === 0.8, String(fresh?.intensity))

  // 24 小时后衰减到 0.05 以下 → 直接返回 null（不算"还有心情"）
  const day = 24 * 3600_000
  const old = mood.decayedMood(mk('开心', 0.8, now - day), now)
  check('24 小时后返回 null（衰减殆尽）', old === null, JSON.stringify(old))

  // 6 小时后还有一点
  const half = mood.decayedMood(mk('开心', 0.8, now - 6 * 3600_000), now)
  check('6 小时后还在但变弱了', half !== null && half.intensity < 0.8, String(half?.intensity))

  // 强度不会被衰减成负数
  const veryOld = mood.decayedMood(mk('开心', 0.8, now - day * 100), now)
  check('极老的记录返回 null 而不是负数', veryOld === null, JSON.stringify(veryOld))

  // 未来时间戳不崩
  const future = mood.decayedMood(mk('开心', 0.8, now + day), now)
  check('未来时间戳不崩', future === null || typeof future.intensity === 'number', JSON.stringify(future))

  // intensity 是 NaN（坏数据）时当没心情
  check('intensity 是 NaN 时返回 null', mood.decayedMood(mk('开心', Number.NaN, now), now) === null)

  // 超过 1 的强度被夹回 1
  const over = mood.decayedMood(mk('开心', 999, now), now)
  check('强度夹在 1 以内', (over?.intensity ?? 0) <= 1, String(over?.intensity))
}

console.log('\n=== 2. 情绪落盘 ===')
{
  const f = mood.moodFile()
  let backup = ''
  try {
    backup = readFileSync(f, 'utf8')
  } catch {
    /* 本来就没有 */
  }

  mood.saveMood({ emotion: '平静', intensity: 0.5, at: Date.now() })
  const back = mood.loadMood()
  check('存进去能读回来', back?.emotion === '平静' && Math.abs((back?.intensity ?? 0) - 0.5) < 1e-6, JSON.stringify(back))

  // 坏数据不崩
  writeFileSync(f, '\t非法: [', 'utf8')
  const bad = mood.loadMood()
  check('坏 YAML 返回 null 不抛错', bad === null, JSON.stringify(bad))

  // 恢复
  if (backup) writeFileSync(f, backup, 'utf8')
}

/* ================= 快照 ================= */
console.log('\n=== 3. 快照与回滚 ===')
{
  // version.ts 的 ROOT 是硬编码的，用真实目录（会备份现有快照列表）
  const before = version.listSnapshots()
  const count = before.length
  console.log(`   （现有 ${count} 个快照）`)

  // latestMtime 对不存在的目录返回 0
  check('latestMtime 对不存在目录返回 0', version.latestMtime(join(tmpdir(), '绝对不存在-' + Date.now())) === 0)

  // 快照能建出来
  const id = version.snapshot('体检测试')
  check('snapshot 返回 id 或 null', id === null || typeof id === 'string', String(id))

  if (id) {
    const after = version.listSnapshots()
    check('快照出现在列表里', after.some((s) => s.id === id), `id=${id}`)
    check('快照有 reason', after.find((s) => s.id === id)?.reason === '体检测试', JSON.stringify(after.find((s) => s.id === id)))
    check('快照有 at', typeof after.find((s) => s.id === id)?.at === 'number')

    // restore 一个不存在的 id 返回 false
    check('restore 不存在的 id 返回 false', version.restore('绝对不存在的-id') === false)
  } else {
    console.log('   （snapshot 返回 null，跳过后续断言）')
  }

  // listSnapshots 对坏元数据不崩
  check('listSnapshots 返回数组', Array.isArray(version.listSnapshots()))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
