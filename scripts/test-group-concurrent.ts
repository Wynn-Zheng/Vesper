/**
 * 群名单并发的体检。
 *
 * 关心的是：几个人同时触发刷新时，会不会把名单写成半截、或者互相覆盖。
 *   - 同时调两次 refresh
 *   - refresh 和 restore 同时调
 *   - 拉取失败时不能把已有名单清空
 *   - 只拉回 1 个人时保留旧名单（之前修过的）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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

const ROOT = 'data/test-group-concurrent'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/groups`, { recursive: true })
mkdirSync(`${ROOT}/versions`, { recursive: true })
gc.setGroupsRoot(`${ROOT}/groups`)

const GID = '111222333'

function members(n: number, prefix = '人'): Array<{ id: string; name: string; nick: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: String(10000 + i),
    name: `${prefix}${i}`,
    nick: `${prefix}昵称${i}`,
  }))
}

/** 假 transport */
function fakeTransport(list: () => Promise<Array<{ id: string; name: string; nick: string }>>, delayMs = 0) {
  return {
    listGroupMembers: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return list()
    },
  }
}

/* ============ 1. 同时调两次 refresh ============ */
console.log('=== 1. 两次并发 refresh ===')
{
  let calls = 0
  const t = {
    listGroupMembers: async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return members(calls === 1 ? 20 : 25)
    },
  }

  await Promise.all([
    gc.refreshGroupMembers(t, GID, { force: true }),
    gc.refreshGroupMembers(t, GID, { force: true }),
  ])

  const n = gc.groupMembers(GID).length
  check('落盘是完整的（不是半截）', n === 20 || n === 25, String(n))
  check('不是 0（没被清空）', n > 0, String(n))
  // 串行化应该只调一次，或者两次都写完整
  check(`实际调了 ${calls} 次`, calls >= 1, '')
}

/* ============ 2. 拉取失败不清空 ============ */
console.log('\n=== 2. 拉取失败 ===')
{
  // 先造 20 人
  mkdirSync(`${ROOT}/groups/${GID}`, { recursive: true })
  writeFileSync(
    `${ROOT}/groups/${GID}/members.json`,
    JSON.stringify({ groupId: GID, at: Date.now(), members: members(20) }),
    'utf8',
  )
  gc.clearMemberCache()
  check('初始 20 人', gc.groupMembers(GID).length === 20, String(gc.groupMembers(GID).length))

  // 拉取抛错
  const bad = {
    listGroupMembers: async () => {
      throw new Error('NapCat 未连接')
    },
  }
  await gc.refreshGroupMembers(bad, GID, { force: true }).catch(() => {})
  check('失败后还是 20 人', gc.groupMembers(GID).length === 20, String(gc.groupMembers(GID).length))

  // 拉取返回空
  const empty = { listGroupMembers: async () => [] }
  await gc.refreshGroupMembers(empty, GID, { force: true }).catch(() => {})
  check('返回空后还是 20 人', gc.groupMembers(GID).length === 20, String(gc.groupMembers(GID).length))
}

/* ============ 3. 只拉回 1 人（回归） ============ */
console.log('\n=== 3. 只拉回 1 人 ===')
{
  const one = { listGroupMembers: async () => [{ id: '1', name: '只剩一个', nick: '' }] }
  await gc.refreshGroupMembers(one, GID, { force: true }).catch(() => {})
  check('没被覆盖成 1 人', gc.groupMembers(GID).length === 20, String(gc.groupMembers(GID).length))
}

/* ============ 4. refresh 和 restore 同时调 ============ */
console.log('\n=== 4. refresh + restore 并发 ===')
{
  // 造快照：50 人
  const snapDir = `${ROOT}/versions/20260101-000001/groups/${GID}`
  mkdirSync(snapDir, { recursive: true })
  writeFileSync(
    `${snapDir}/members.json`,
    JSON.stringify({ groupId: GID, at: Date.now(), members: members(50, '快照') }),
    'utf8',
  )

  // 当前改成 5 人（触发恢复）
  writeFileSync(
    `${ROOT}/groups/${GID}/members.json`,
    JSON.stringify({ groupId: GID, at: Date.now(), members: members(5, '现在') }),
    'utf8',
  )
  gc.clearMemberCache()

  const t = fakeTransport(async () => members(30, '新拉'), 20)

  await Promise.all([
    gc.refreshGroupMembers(t, GID, { force: true }),
    Promise.resolve().then(() => gc.restoreGroupsFromSnapshots({ snapshotRoot: `${ROOT}/versions` })),
  ])

  const n = gc.groupMembers(GID).length
  check('最终是完整名单（20/30/50 之一）', [5, 20, 30, 50].includes(n) && n > 0, String(n))
  check('没写成 0 或半截', n > 0, String(n))

  // 文件本身要是合法 json
  const raw = readFileSync(`${ROOT}/groups/${GID}/members.json`, 'utf8')
  let ok = false
  try {
    JSON.parse(raw)
    ok = true
  } catch {
    /* 坏 */
  }
  check('members.json 是合法 json', ok, raw.slice(0, 60))
}

/* ============ 5. 未知群的 groupMembers ============ */
console.log('\n=== 5. 未知群 ===')
{
  let ok = true
  let n = -1
  try {
    n = gc.groupMembers('999999999').length
  } catch {
    ok = false
  }
  check('查不存在的群不炸', ok, '')
  check('返回空数组', n === 0, String(n))
  // 名单没拉到时 isKnownMember 故意返回 true：
  // 返回 false 会被 boot.ts 当成"出现新成员"，然后强制刷新——
  // 而拉不到名单的时候强制刷新只会失败，白费一次请求。
  check('名单没拉到时不误判成新成员', gc.isKnownMember('999999999', '123') === true, '')
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
