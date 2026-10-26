/**
 * 群成员名单的体检。
 *
 * 修过的问题：
 *   1. 纯内存缓存，重启就空 → 落盘
 *   2. TTL 10 分钟，安静十分钟就"忘了" → 一小时，且过期也返回旧数据
 *   3. 名单为空时它以为"群里就我们俩" → 明确说"不清楚，别以为只有你们俩"
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

const gc = await import('../src/people/groupcache.ts')
const group = await import('../src/people/group.ts')
const GID = '999999999'
const FILE = `persona/groups/${GID}/members.json`

const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''

/* ---------- 1. 落盘 ---------- */
console.log('=== 1. 落盘 ===')
{
  gc.clearMemberCache()
  const fakeTransport = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
        { id: '3', name: '丙' },
      ]
    },
  }

  await gc.refreshGroupMembers(fakeTransport, GID)
  check('刷新后内存里有', gc.groupMembers(GID).length === 3, String(gc.groupMembers(GID).length))
  check('文件写出来了', existsSync(FILE))

  const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as {
    groupId: string
    at: number
    members: Array<{ id: string; name: string; nick?: string }>
  }
  check('文件里 groupId 对', onDisk.groupId === GID, onDisk.groupId)
  check('文件里是 3 个人', onDisk.members.length === 3, String(onDisk.members.length))
}

/* ---------- 2. 重启后还能读（模拟：清内存，从盘 hydrate） ---------- */
console.log('\n=== 2. 重启后还能读 ===')
{
  // clearMemberCache 会连盘一起清；这里手动只清内存的做法没法直接测，
  // 所以换个角度：新开一个"进程"读同一个文件（用子模块读盘验证格式对）
  const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as {
    at: number
    members: Array<{ id: string; name: string }>
  }
  check('盘里的数据能被解析成 {at, members}', typeof onDisk.at === 'number' && Array.isArray(onDisk.members))
  check('名字都在', onDisk.members.map((m) => m.name).join(',') === '甲,乙,丙', onDisk.members.map((m) => m.name).join(','))
}

/* ---------- 3. 过期不返回空 ---------- */
console.log('\n=== 3. 过期也返回旧数据 ===')
{
  const { writeFileSync } = await import('node:fs')
  // 把文件里的时间戳改到三小时前，模拟"很久没更新"
  const data = JSON.parse(readFileSync(FILE, 'utf8')) as {
    groupId: string
    at: number
    members: Array<{ id: string; name: string }>
  }
  data.at = Date.now() - 3 * 3600_000
  writeFileSync(FILE, JSON.stringify(data), 'utf8')

  // 只清内存，逼它从盘读
  gc.clearMemberCache()

  const m = gc.groupMembers(GID)
  check('三小时前的数据仍然读得到（不返回空）', m.length === 3, String(m.length))
  check('能判断出已经旧了', gc.membersAreStale(GID) === true)
}

/* ---------- 4. renderGroupContext 的措辞 ---------- */
console.log('\n=== 4. 渲染措辞 ===')
{
  // 4a. 有名单：要说清"一共几人"和"你只认识几个"
  const withList = group.renderGroupContext(GID)
  check('有名单时说"一共 N 人"', /一共 \d+ 人/.test(withList), withList.slice(0, 80))
  check('有名单时说清"你实际聊过的只有几个"', withList.includes('实际聊过'), withList)

  // 4b. 没名单：要说"不清楚"，不能说"就我们俩"
  gc.clearMemberCache()
  unlinkSync(FILE)
  const noList = group.renderGroupContext(GID)
  check('没名单时说"不清楚"', noList.includes('不清楚'), noList.slice(0, 60))
  check('没名单时提醒"别以为只有你们俩"', noList.includes('别以为'), noList.slice(0, 80))
}

/* ---------- 5. 拉失败不崩 ---------- */
console.log('\n=== 5. 拉失败不崩、保住旧缓存 ===')
{
  const broken = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      throw new Error('NapCat 未连接')
    },
  }

  // 5a. 没有旧缓存时：返回空、不抛错
  gc.clearMemberCache()
  await gc.refreshGroupMembers(broken, GID)
  check('拉失败不抛错', true)
  check('没有旧缓存时返回空数组', gc.groupMembers(GID).length === 0)

  // 5b. 有旧缓存时：失败也要保住旧的
  gc.clearMemberCache()
  const good = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: '1', name: '甲' }]
    },
  }
  await gc.refreshGroupMembers(good, GID)
  // 把缓存时间改旧，逼它下次真去拉
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { at: number }
  disk.at = 0
  writeFileSync(FILE, JSON.stringify(disk), 'utf8')
  gc.clearMemberCache()

  await gc.refreshGroupMembers(broken, GID)
  check('拉失败时保住旧缓存（不返回空）', gc.groupMembers(GID).length === 1, String(gc.groupMembers(GID).length))
}

/* ---------- 5b. 新成员检测 ---------- */
console.log('\n=== 5b. 名单外的人会触发强制刷新 ===')
{
  gc.clearMemberCache()
  const members = [
    { id: '1', name: '甲' },
    { id: '2', name: '乙' },
  ]
  let calls = 0
  const transport = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      calls += 1
      return members
    },
  }

  await gc.refreshGroupMembers(transport, GID, { force: true })
  check('名单里有的认得出', gc.isKnownMember(GID, '1') === true)
  check('名单里没的认不出', gc.isKnownMember(GID, '999') === false)
  // 用一个从没拉过的假群号：盘里也没有，才是真的"名单空"
  check('名单空时当作"都知道"（不空转刷新）', gc.isKnownMember('123456789', '999') === true)

  // force 会跳过 TTL
  gc.clearMemberCache()
  calls = 0
  await gc.refreshGroupMembers(transport, GID)
  const afterFirst = calls
  await gc.refreshGroupMembers(transport, GID)
  check('TTL 内不重复拉', calls === afterFirst, `${afterFirst} → ${calls}`)
  await gc.refreshGroupMembers(transport, GID, { force: true })
  check('force 会强制拉', calls === afterFirst + 1, String(calls))
}

/* ---------- 5c. 全刷一遍 ---------- */
console.log('\n=== 5c. refreshAllGroups ===')
{
  gc.clearMemberCache()
  const transport = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: '1', name: '甲' }]
    },
  }
  const r = await gc.refreshAllGroups(transport, { force: true })
  check(`全刷覆盖 ${r.total} 个群`, r.total >= 1, String(r.total))
  check('全刷成功数等于总数', r.ok === r.total, `${r.ok}/${r.total}`)
  check('没有失败的', r.failed.length === 0, r.failed.join(','))
}

/* ---------- 6. knownGroups ---------- */
console.log('\n=== 6. knownGroups ===')
{
  const groups = gc.knownGroups()
  check('能扫出群号', groups.length >= 1, groups.join(','))
  check('扫出来的都是数字', groups.every((g) => /^\d+$/.test(g)), groups.join(','))
}

// 恢复
gc.clearMemberCache()
if (backup) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(FILE, backup, 'utf8')
} else {
  try {
    unlinkSync(FILE)
  } catch {
    /* 本来就没了 */
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
