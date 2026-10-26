/**
 * 名字同步的体检。
 *
 * 修过的问题：
 *   qq-1234567890 建档名「群代肝」，但实际昵称是「我是菜鸟」——名字只在他说话时更新
 *   qq-503712366 名字是空的
 *   拉群名单时不回写名字，所以不常说话的人一直挂着旧名字
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

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

const store = await import('../src/people/store.ts')
const gc = await import('../src/people/groupcache.ts')

const GID = '888888888'
// 备份所有群名单（新结构是按群分目录）
const GROUP_BACKUPS = new Map<string, string>()
try {
  const { readdirSync } = await import('node:fs')
  for (const gid of readdirSync('persona/groups')) {
    const f = `persona/groups/${gid}/members.json`
    if (existsSync(f)) GROUP_BACKUPS.set(gid, readFileSync(f, 'utf8'))
  }
} catch {
  /* 没有就算了 */
}

/* ---------- 1. syncPersonName ---------- */
console.log('=== 1. 只改名字 ===')
{
  // 建一个人
  const p = store.ensurePerson('qq', '777000111', '旧名字')
  check('建档成功', p.name === '旧名字', p.name)

  const changed = store.syncPersonName('qq', '777000111', '新名字')
  check('改名返回 true', changed === true)
  check('名字真的变了', store.loadPerson('qq-777000111')?.name === '新名字', store.loadPerson('qq-777000111')?.name)

  // 同名不重复写
  const again = store.syncPersonName('qq', '777000111', '新名字')
  check('同名返回 false（不重复写盘）', again === false)

  // 空名字不覆盖
  const empty = store.syncPersonName('qq', '777000111', '   ')
  check('空名字不覆盖', empty === false && store.loadPerson('qq-777000111')?.name === '新名字')

  // 不存在的账号：不建档（名单里的人不等于认识的人）
  const ghost = store.syncPersonName('qq', '000000000', '谁')
  check('不存在的账号不建档', ghost === false && store.loadPerson('qq-000000000') === null, String(ghost))
}

/* ---------- 1b. 群名片 vs QQ 昵称 ---------- */
console.log('\n=== 1b. 群名片不覆盖全局名 ===')
{
  // 先建一个人（代表"真聊过"），再看群名单能不能改他的全局名
  store.ensurePerson('qq', '666000111', '占位名')
  store.ensurePerson('qq', '666000222', '占位名2')

  gc.clearMemberCache()

  const g1 = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string; nick?: string }>> {
      return [{ id: '666000111', name: '群A的名片', nick: '真名' }]
    },
  }
  const g2 = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string; nick?: string }>> {
      return [{ id: '666000111', name: '群B的名片', nick: '真名' }]
    },
  }

  await gc.refreshGroupMembers(g1, '111111111', { force: true })
  const afterA = store.loadPerson('qq-666000111')?.name
  check('拉群 A 后全局名是 QQ 昵称', afterA === '真名', afterA)
  check('群 A 的名单里是群名片', gc.groupMembers('111111111')[0]?.name === '群A的名片', gc.groupMembers('111111111')[0]?.name)

  await gc.refreshGroupMembers(g2, '222222222', { force: true })
  const afterB = store.loadPerson('qq-666000111')?.name
  check('拉群 B 后全局名还是 QQ 昵称（没被覆盖）', afterB === '真名', afterB)
  check('群 B 的名单里是 B 的名片', gc.groupMembers('222222222')[0]?.name === '群B的名片', gc.groupMembers('222222222')[0]?.name)
  check('两群名片不同但全局名一致', gc.groupMembers('111111111')[0]!.name !== gc.groupMembers('222222222')[0]!.name && afterB === '真名')

  // 没有 nick 的老数据：用 name 兜底（但只更新已存在的）
  gc.clearMemberCache()
  const noNick = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: '666000222', name: '只有名片' }]
    },
  }
  await gc.refreshGroupMembers(noNick, '333333333', { force: true })
  check('没有 nick 时用 name 兜底', store.loadPerson('qq-666000222')?.name === '只有名片', store.loadPerson('qq-666000222')?.name)
}

/* ---------- 2. 拉名单时自动回写 ---------- */
console.log('\n=== 2. 拉名单自动回写名字 ===')
{
  // 先建一个人，名字故意写错
  store.ensurePerson('qq', '555000111', '错名字')

  gc.clearMemberCache()
  const transport = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [
        { id: '555000111', name: '对的名字' },
        { id: '555000222', name: '新人' },
      ]
    },
  }

  await gc.refreshGroupMembers(transport, GID, { force: true })

  check('旧人的名字被纠正', store.loadPerson('qq-555000111')?.name === '对的名字', store.loadPerson('qq-555000111')?.name)
  // 那个人只在名单里躺着、没聊过 → 不建档案
  check('只在名单里的人不建档', store.loadPerson('qq-555000222') === null, JSON.stringify(store.loadPerson('qq-555000222')))
}

/* ---------- 3. 名字为空时不覆盖已有 ---------- */
console.log('\n=== 3. 空名字不覆盖 ===')
{
  store.ensurePerson('qq', '444000111', '有名字的')
  gc.clearMemberCache()
  const transport = {
    async listGroupMembers(): Promise<Array<{ id: string; name: string }>> {
      return [
        { id: '444000111', name: '' },
        { id: '444000222', name: '' },
      ]
    },
  }
  await gc.refreshGroupMembers(transport, GID, { force: true })
  check('名单里名字为空时不动已有的', store.loadPerson('qq-444000111')?.name === '有名字的', store.loadPerson('qq-444000111')?.name)
  check('名字为空的新人不会建出空名字档', !store.loadPerson('qq-444000222') || !!store.loadPerson('qq-444000222')?.name)
}

/* ---------- 4. 真实数据检查 ---------- */
console.log('\n=== 4. 真实数据 ===')
{
  const people = store.listPeople()
  const empty = people.filter((p) => !p.name?.trim())
  check(`${people.length} 个人里没有空名字`, empty.length === 0, empty.map((p) => p.id).join(','))

  // 有档案的人：全局名应该是 QQ 昵称（不是群名片）
  let mismatch = 0
  for (const gid of gc.knownGroups()) {
    for (const m of gc.groupMembers(gid)) {
      const p = store.listPeople().find((x) => x.accounts.some((a) => a.id === m.id))
      if (!p || !m.nick) continue
      if (p.name !== m.nick) mismatch += 1
    }
  }
  check('有档案的人全局名是 QQ 昵称', mismatch === 0, `${mismatch} 个不一致`)
}

// 恢复
// 恢复群名单
{
  const { mkdirSync, rmSync } = await import('node:fs')
  const { readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  try {
    // 删掉测试期间新建的假群
    for (const gid of readdirSync('persona/groups')) {
      if (!GROUP_BACKUPS.has(gid)) rmSync(join('persona/groups', gid), { recursive: true, force: true })
    }
    // 恢复备份
    for (const [gid, content] of GROUP_BACKUPS) {
      mkdirSync(join('persona/groups', gid), { recursive: true })
      writeFileSync(join('persona/groups', gid, 'members.json'), content, 'utf8')
    }
  } catch {
    /* 恢复失败不影响结论 */
  }
}

// 收尾：清掉测试建的假人（别污染真实数据）
{
  const { rmSync, existsSync } = await import('node:fs')
  const fakes = ['qq-000000000', 'qq-777000111', 'qq-555000111', 'qq-555000222', 'qq-444000111', 'qq-444000222', 'qq-666000111', 'qq-666000222']
  let n = 0
  for (const id of fakes) {
    const dir = `persona/people/${id}`
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      n++
    }
  }
  if (n) console.log(`\n（清掉 ${n} 个测试假人）`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
