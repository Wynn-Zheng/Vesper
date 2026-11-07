/**
 * 从快照恢复群名单。
 *
 * 起因：群名单被清空过（52 人 → 1 人 → 0 人），
 * 每次都要手动写脚本从 data/versions/ 里救。
 * 做成控制台按钮，以后不用找人。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const gc = await import('../src/people/groupcache.ts')

const ROOT = 'data/test-restore'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/groups`, { recursive: true })
mkdirSync(`${ROOT}/versions`, { recursive: true })
gc.setGroupsRoot(`${ROOT}/groups`)

const GID = '123456789'

/** 造一个快照 */
function makeSnap(id: string, gid: string, count: number): void {
  const dir = join(`${ROOT}/versions`, id, 'groups', gid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'members.json'),
    JSON.stringify({
      groupId: gid,
      at: Date.now(),
      members: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: `人${i}` })),
    }),
    'utf8',
  )
}

/** 写当前名单 */
function setCurrent(gid: string, count: number): void {
  const dir = join(`${ROOT}/groups`, gid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'members.json'),
    JSON.stringify({
      groupId: gid,
      at: Date.now(),
      members: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: `人${i}` })),
    }),
    'utf8',
  )
  gc.clearMemberCache()
}

/* ============ 1. 名单被清空时恢复 ============ */
console.log('=== 1. 被清空时恢复 ===')
{
  makeSnap('20260101-000001', GID, 10)
  makeSnap('20260102-000001', GID, 50) // 更完整
  makeSnap('20260103-000001', GID, 20)

  setCurrent(GID, 1)
  check('当前只有 1 人', gc.groupMembers(GID).length === 1, String(gc.groupMembers(GID).length))

  const r = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })
  check('恢复了 1 个群', r.restored.length === 1, String(r.restored.length))
  check('恢复到 50 人（最多那份）', gc.groupMembers(GID).length === 50, String(gc.groupMembers(GID).length))
  check('报告里有 from/to', r.restored[0]?.from === 1 && r.restored[0]?.to === 50, JSON.stringify(r.restored[0]))
  check('报告里说了用哪个快照', r.restored[0]?.snapshot === '20260102-000001', r.restored[0]?.snapshot)
}

/* ============ 2. 当前已经完整时不覆盖 ============ */
console.log('\n=== 2. 已经完整就跳过 ===')
{
  setCurrent(GID, 50)
  const r = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })
  check('不恢复', r.restored.length === 0, String(r.restored.length))
  check('记在跳过里', r.skipped.some((x) => x.groupId === GID), '')
  check('还是 50 人', gc.groupMembers(GID).length === 50, String(gc.groupMembers(GID).length))
}

/* ============ 3. 差得少时不覆盖（可能有人退群） ============ */
console.log('\n=== 3. 差得少不动 ===')
{
  setCurrent(GID, 47) // 比快照最好的 50 少 3
  const r = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions`, minGain: 5 })
  check('差 3 人不恢复（阈值 5）', r.restored.length === 0, String(r.restored.length))
  check('还是 47 人', gc.groupMembers(GID).length === 47, String(gc.groupMembers(GID).length))

  // 把阈值降到 1 就该恢复了
  const r2 = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions`, minGain: 1 })
  check('阈值降到 1 就恢复', r2.restored.length === 1, String(r2.restored.length))
  check('恢复到 50', gc.groupMembers(GID).length === 50, String(gc.groupMembers(GID).length))
}

/* ============ 4. 只处理当前存在的群 ============ */
console.log('\n=== 4. 假群不碰 ===')
{
  // 快照里有个当前不存在的假群
  makeSnap('20260104-000001', '999999999', 30)
  const r = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })
  check('假群不在恢复列表', !r.restored.some((x) => x.groupId === '999999999'), '')
  check('假群也不在跳过列表', !r.skipped.some((x) => x.groupId === '999999999'), JSON.stringify(r.skipped.map((x) => x.groupId)))
}

/* ============ 5. 边界 ============ */
console.log('\n=== 5. 边界 ===')
{
  // 快照目录不存在
  const r = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/nonexistent` })
  check('快照目录不存在时不炸', r.restored.length === 0 && r.scanned === 0, JSON.stringify(r))

  // 快照里的 json 坏了
  const badDir = join(`${ROOT}/versions`, '20260105-000001', 'groups', GID)
  mkdirSync(badDir, { recursive: true })
  writeFileSync(join(badDir, 'members.json'), '{坏掉的 json', 'utf8')
  const r2 = gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })
  check('坏快照跳过、不炸', r2.restored.length === 0, String(r2.restored.length))

  // 空 members
  const emptyDir = join(`${ROOT}/versions`, '20260106-000001', 'groups', GID)
  mkdirSync(emptyDir, { recursive: true })
  writeFileSync(join(emptyDir, 'members.json'), JSON.stringify({ members: [] }), 'utf8')
  setCurrent(GID, 1)
  gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })
  check('空 members 的快照不当来源', gc.groupMembers(GID).length !== 0, String(gc.groupMembers(GID).length))
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
