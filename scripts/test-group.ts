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
const FILE = 'persona/groups.json'
const GID = '999999999'

const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''

/* ---------- 1. 落盘 ---------- */
console.log('=== 1. 落盘 ===')
{
  gc.resetMemberCacheEverywhere()
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
    groups: Record<string, { at: number; members: Array<{ id: string; name: string }> }>
  }
  check('文件里有这个群', !!onDisk.groups[GID], Object.keys(onDisk.groups).join(','))
  check('文件里是 3 个人', onDisk.groups[GID]?.members.length === 3, String(onDisk.groups[GID]?.members.length))
}

/* ---------- 2. 重启后还能读（模拟：清内存，从盘 hydrate） ---------- */
console.log('\n=== 2. 重启后还能读 ===')
{
  // clearMemberCache 会连盘一起清；这里手动只清内存的做法没法直接测，
  // 所以换个角度：新开一个"进程"读同一个文件（用子模块读盘验证格式对）
  const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as {
    groups: Record<string, { at: number; members: Array<{ id: string; name: string }> }>
  }
  const entry = onDisk.groups[GID]
  check('盘里的数据能被解析成 {at, members}', !!entry && typeof entry.at === 'number' && Array.isArray(entry.members))
  check('名字都在', entry?.members.map((m) => m.name).join(',') === '甲,乙,丙', entry?.members.map((m) => m.name).join(','))
}

/* ---------- 3. 过期不返回空 ---------- */
console.log('\n=== 3. 过期也返回旧数据 ===')
{
  const { utimesSync, writeFileSync } = await import('node:fs')
  // 把文件内容里的时间戳改成一小时前，模拟"很久没更新"
  const data = JSON.parse(readFileSync(FILE, 'utf8')) as {
    groups: Record<string, { at: number; members: Array<{ id: string; name: string }> }>
  }
  data.groups[GID]!.at = Date.now() - 3 * 3600_000
  writeFileSync(FILE, JSON.stringify(data), 'utf8')

  // 清内存缓存，逼它从盘读
  gc.resetMemberCacheEverywhere()
  writeFileSync(FILE, JSON.stringify(data), 'utf8') // clearMemberCache 会清盘，重写

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
  gc.resetMemberCacheEverywhere()
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
  gc.resetMemberCacheEverywhere()
  await gc.refreshGroupMembers(broken, GID)
  check('拉失败不抛错', true)
  check('没有旧缓存时返回空数组', gc.groupMembers(GID).length === 0)

  // 5b. 有旧缓存时：失败也要保住旧的
  gc.resetMemberCacheEverywhere()
  const good = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: '1', name: '甲' }]
    },
  }
  await gc.refreshGroupMembers(good, GID)
  // 把缓存时间改旧，逼它下次真去拉
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { groups: Record<string, { at: number }> }
  disk.groups[GID]!.at = 0
  writeFileSync(FILE, JSON.stringify(disk), 'utf8')
  gc.clearMemberCache()

  await gc.refreshGroupMembers(broken, GID)
  check('拉失败时保住旧缓存（不返回空）', gc.groupMembers(GID).length === 1, String(gc.groupMembers(GID).length))
}

/* ---------- 6. knownGroups ---------- */
console.log('\n=== 6. knownGroups ===')
{
  const groups = gc.knownGroups()
  check('能扫出群号', groups.length >= 1, groups.join(','))
  check('扫出来的都是数字', groups.every((g) => /^\d+$/.test(g)), groups.join(','))
}

// 恢复
gc.resetMemberCacheEverywhere()
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
