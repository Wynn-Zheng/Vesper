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
const backup = existsSync('persona/groups.json') ? readFileSync('persona/groups.json', 'utf8') : ''

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

  // 不存在的账号：现在会建档（群名单里看到的人都要能对上号）
  const ghost = store.syncPersonName('qq', '000000000', '谁')
  check('不存在的账号会建档', ghost === true && store.loadPerson('qq-000000000')?.name === '谁', store.loadPerson('qq-000000000')?.name)
}

/* ---------- 2. 拉名单时自动回写 ---------- */
console.log('\n=== 2. 拉名单自动回写名字 ===')
{
  // 先建一个人，名字故意写错
  store.ensurePerson('qq', '555000111', '错名字')

  gc.resetMemberCacheEverywhere()
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
  check('新人也被建档', store.loadPerson('qq-555000222')?.name === '新人', store.loadPerson('qq-555000222')?.name)
}

/* ---------- 3. 名字为空时不覆盖已有 ---------- */
console.log('\n=== 3. 空名字不覆盖 ===')
{
  store.ensurePerson('qq', '444000111', '有名字的')
  gc.resetMemberCacheEverywhere()
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

  // 群名单里的名字和 people 里的对得上吗
  let mismatch = 0
  for (const gid of gc.knownGroups()) {
    for (const m of gc.groupMembers(gid)) {
      const p = store.listPeople().find((x) => x.accounts.some((a) => a.id === m.id))
      if (p && m.name && p.name !== m.name) mismatch += 1
    }
  }
  check('群名单和 people 的名字一致', mismatch === 0, `${mismatch} 个不一致`)
}

// 恢复
gc.resetMemberCacheEverywhere()
if (backup) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('persona/groups.json', backup, 'utf8')
} else {
  try {
    unlinkSync('persona/groups.json')
  } catch {
    /* 本来就没了 */
  }
}

// 收尾：清掉测试建的假人（别污染真实数据）
{
  const { rmSync, existsSync } = await import('node:fs')
  const fakes = ['qq-000000000', 'qq-777000111', 'qq-555000111', 'qq-555000222', 'qq-444000111', 'qq-444000222']
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
