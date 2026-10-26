/**
 * 名字边界的体检。
 *
 * 这轮关心的是：换名字的几条路径在**奇怪输入**下会不会把数据写坏。
 *   - 空 / 纯空格 / 只含控制字符
 *   - 超长（QQ 昵称上限 24 个字符，但群名片能到 36，API 我们限制 40）
 *   - emoji / 组合字符（一个 emoji 在 JS 里是 2 个 code unit，别按长度切一半）
 *   - 和群名片的关系：改全局名不该影响群名片
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

const store = await import('../src/people/store.ts')
const gc = await import('../src/people/groupcache.ts')

const ROOT = 'data/test-name-edge'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/people`, { recursive: true })
mkdirSync(`${ROOT}/groups`, { recursive: true })
store.setPeopleRoot(`${ROOT}/people`)
gc.setGroupsRoot(`${ROOT}/groups`)

/* ============ 1. ensurePerson 的 trim ============ */
console.log('=== 1. ensurePerson 的 trim ===')
{
  const p = store.ensurePerson('qq', '1001', '  有空格  ')
  check('首尾空格被去掉', p.name === '有空格', JSON.stringify(p.name))

  const p2 = store.ensurePerson('qq', '1002', '   ')
  check('纯空格不会变成名字', p2.name !== '   ', JSON.stringify(p2.name))

  const p3 = store.ensurePerson('qq', '1003')
  // 不传名字时回落到账号本身（避免名字为空时界面显示空白）
  check('不传名字时回落到账号', p3.name === '1003', JSON.stringify(p3.name))
}

/* ============ 2. 超长名字 ============ */
console.log('\n=== 2. 超长名字 ===')
{
  const long = '名'.repeat(100)
  const p = store.ensurePerson('qq', '1004', long)
  // ensurePerson 现在不截断（API 层限制 40）。这里记录实际行为，
  // 如果以后加了截断，这个断言要跟着改。
  check('ensurePerson 不截断（API 层负责）', p.name.length === 100, String(p.name.length))

  // 但写盘 / 读回来要完整
  const back = store.loadPerson(p.id)
  check('读回来还是 100 字', back?.name.length === 100, String(back?.name.length))
}

/* ============ 3. emoji / 组合字符 ============ */
console.log('\n=== 3. emoji 名字 ===')
{
  const emoji = '🐱猫猫'
  const p = store.ensurePerson('qq', '1005', emoji)
  check('emoji 名字存得下', p.name === emoji, JSON.stringify(p.name))

  const back = store.loadPerson(p.id)
  check('读回来没坏', back?.name === emoji, JSON.stringify(back?.name))

  // 组合字符（family emoji 是多个 code point 拼的）
  const combo = '👨‍👩‍👧'
  const p2 = store.ensurePerson('qq', '1006', combo)
  const back2 = store.loadPerson(p2.id)
  check('组合 emoji 没被截断', back2?.name === combo, JSON.stringify(back2?.name))
}

/* ============ 4. 控制字符 / 换行 ============ */
console.log('\n=== 4. 控制字符 ===')
{
  // 换行会破坏 prompt 的结构，但档案里存的是 json，不涉及注入
  const weird = 'a\nb\tc'
  const p = store.ensurePerson('qq', '1007', weird)
  const back = store.loadPerson(p.id)
  check('含换行的名字能存（json 转义管用）', back?.name === weird, JSON.stringify(back?.name))

  // JSON 本身要能解析（没有被写坏）
  const raw = readFileSync(`${ROOT}/people/${p.id}/meta.json`, 'utf8')
  let ok = false
  try {
    JSON.parse(raw)
    ok = true
  } catch {
    /* 坏 json */
  }
  check('meta.json 还是合法 json', ok, raw.slice(0, 80))
}

/* ============ 5. 改名不影响群名片 ============ */
console.log('\n=== 5. 改名 vs 群名片 ===')
{
  // 群里叫「群代肝」，全局名是「欲辨已妄言」
  mkdirSync(`${ROOT}/groups/999`, { recursive: true })
  writeFileSync(
    `${ROOT}/groups/999/members.json`,
    JSON.stringify({
      groupId: '999',
      at: Date.now(),
      members: [{ id: '2001', name: '群代肝', nick: '欲辨已妄言' }],
    }),
    'utf8',
  )
  gc.clearMemberCache()

  const p = store.ensurePerson('qq', '2001', '欲辨已妄言')
  check('建档时用昵称', p.name === '欲辨已妄言', p.name)

  // 改全局名
  store.savePerson({ ...p, name: '新名字' })
  const back = store.loadPerson(p.id)
  check('全局名改了', back?.name === '新名字', back?.name)

  // 群名片不该跟着变
  const m = gc.groupMembers('999').find((x) => x.id === '2001')
  check('群名片没变', m?.name === '群代肝', m?.name)
  check('群里的昵称也没变', m?.nick === '欲辨已妄言', m?.nick)
}

/* ============ 6. 重名的人 ============ */
console.log('\n=== 6. 两个人都叫小明 ===')
{
  const a = store.ensurePerson('qq', '3001', '小明')
  const b = store.ensurePerson('qq', '3002', '小明')
  check('两个不同的 personId', a.id !== b.id, `${a.id} / ${b.id}`)
  check('两个都叫小明', a.name === '小明' && b.name === '小明', '')

  // 按账号能找到对应的人（不会混）
  check('1001 号找得到', store.personOfAccount('qq', '3001') === a.id, store.personOfAccount('qq', '3001'))
  check('1002 号找得到', store.personOfAccount('qq', '3002') === b.id, store.personOfAccount('qq', '3002'))
}

/* ============ 7. 非法 personId ============ */
console.log('\n=== 7. 非法 id ===')
{
  for (const bad of ['', '../etc', 'qq/../x', 'qq-', 'person']) {
    const ok = store.isValidPersonId(bad)
    check(`「${bad}」被拒绝`, !ok, '通过了')
  }
  check('正常的通过', store.isValidPersonId('qq-1234567890'), '')
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
