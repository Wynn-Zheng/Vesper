/**
 * 人物模块体检：src/people/store.ts + src/people/open.ts
 *
 * 重点看两类问题：
 *   1. id 校验/生成——路径穿越、空账号、超长、大小写、换行；
 *   2. 建档与待办的读写语义——缓存串根、账号没绑上、并集去重、坏文件容错、并发追加。
 *
 * 全部在临时目录里跑，不碰 persona/ 下的真实数据。
 * 运行：node scripts/test-people-bugs.ts
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountIdsOf,
  clearPersonCache,
  ensurePerson,
  findPersonByAccount,
  isValidPersonId,
  listPeople,
  loadPerson,
  personIdOf,
  personOfAccount,
  savePerson,
  setPeopleRoot,
  type Platform,
} from '../src/people/store.ts'
import { appendOpen, loadOpen, openFilePath, removeOpen } from '../src/people/open.ts'
import { drainWrites } from '../src/store/serialize.ts'

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

const base = mkdtempSync(join(tmpdir(), 'qqbot-people-bugs-'))
process.on('exit', () => {
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let rootSeq = 0
/** 每个小节一个干净的 people 根，避免互相污染 */
function freshRoot(label: string): string {
  const root = join(base, `${++rootSeq}-${label}`, 'people')
  mkdirSync(root, { recursive: true })
  setPeopleRoot(root)
  return root
}

/* =====================================================================
 * 1. isValidPersonId：合法 / 非法 / 穿越 / 空串 / 超长 / 大写
 * ===================================================================== */
console.log('=== 1. isValidPersonId ===')
{
  const valid = [
    'qq-1234567890',
    'wechat-wxid_abc-1',
    'qq-ABCdef123', // 账号部分允许大写
    'qq-a_b-c',
    `qq-${'a'.repeat(40)}`, // 账号 40 位是上限
    'abcdefghijkl-1', // 平台 12 位是上限
  ]
  for (const id of valid) check(`合法：${id.slice(0, 24)}`, isValidPersonId(id) === true)

  const invalid: Array<[string, string]> = [
    ['', '空串'],
    ['qq-', '账号为空'],
    ['-123', '平台为空'],
    ['q-123', '平台太短'],
    ['abcdefghijklm-1', '平台超长（13）'],
    [`qq-${'a'.repeat(41)}`, '账号超长（41）'],
    ['qq-a/b', '正斜杠'],
    ['qq-a\\b', '反斜杠'],
    ['qq-a b', '空格'],
    ['qq-a.b', '点'],
    ['qq-123\n', '结尾换行'],
    ['qq-123\r', '结尾回车'],
    ['qq-123\u2028', '结尾行分隔符'],
    ['qq-12\n3', '中间换行'],
    [' qq-123', '前导空格'],
    ['qq-123 ', '尾随空格'],
    ['../etc', '纯穿越'],
    ['qq-../x', '账号里穿越'],
    ['qq-..', '账号是两个点'],
    ['qq-../../etc', '账号里多级穿越'],
    ['qq-a/../../b', '混合穿越'],
    ['qq-C:\\x', 'Windows 盘符'],
    ['C:\\x', '绝对路径'],
    ['QQ-123', '平台大写'],
    ['Qq-123', '平台混合大小写'],
  ]
  for (const [id, why] of invalid) {
    check(`非法：${why}`, isValidPersonId(id) === false, `实际 true，id=${JSON.stringify(id)}`)
  }

  // 运行时可能从 JSON 里拿到非字符串，不能炸
  const weird = [undefined, null, 123, {}] as unknown as string[]
  let threw = false
  try {
    for (const v of weird) isValidPersonId(v)
  } catch {
    threw = true
  }
  check('非字符串输入不抛错且判为非法', !threw && weird.every((v) => isValidPersonId(v) === false))
}

/* =====================================================================
 * 2. personIdOf：同一平台同一账号稳定，且产物一定是合法 id
 * ===================================================================== */
console.log('\n=== 2. personIdOf 稳定性 ===')
{
  const accounts: Array<[Platform, string]> = [
    ['qq', '1234567890'],
    ['wechat', 'wxid_ABC-1'],
    ['qq', '../../etc'],
    ['qq', '王小明/wx'],
    ['qq', 'a'.repeat(80)],
    ['qq', ''],
  ]
  for (const [platform, account] of accounts) {
    const a = personIdOf(platform, account)
    const b = personIdOf(platform, account)
    check(
      `稳定且合法：${platform} / ${JSON.stringify(account.slice(0, 20))}`,
      a === b && isValidPersonId(a),
      `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
    )
  }

  // 和既有单测约定保持一致：非法字符逐个替换成下划线
  check('路径字符被替换成下划线', personIdOf('qq', '../../etc') === 'qq-______etc', personIdOf('qq', '../../etc'))
  check('不同账号得到不同 id', personIdOf('qq', '1') !== personIdOf('qq', '2'))
  check('不同平台得到不同 id', personIdOf('qq', '1') !== personIdOf('wechat', '1'))
}

/* =====================================================================
 * 3. personOfAccount：没绑定过的账号必须给兜底 id，不能 undefined / 非法
 * ===================================================================== */
console.log('\n=== 3. personOfAccount 兜底 ===')
{
  freshRoot('person-of-account')

  const pid = personOfAccount('qq', '88888')
  check('未知账号返回字符串', typeof pid === 'string' && pid.length > 0, String(pid))
  check('未知账号的兜底 id 合法', isValidPersonId(pid), JSON.stringify(pid))
  check('兜底 id 与 personIdOf 一致', pid === personIdOf('qq', '88888'))
  check('兜底不建目录（只是算 id）', loadPerson(pid) === null)

  const weird = personOfAccount('qq', '../../etc/x')
  check('带路径字符的账号也有合法兜底', isValidPersonId(weird), JSON.stringify(weird))

  const empty = personOfAccount('qq', '')
  check('空账号也有合法兜底', isValidPersonId(empty), JSON.stringify(empty))

  // 绑定过的账号要指向已存在的人
  const p = ensurePerson('qq', '88889', '已绑定')
  check('已绑定账号指向本人', personOfAccount('qq', '88889') === p.id)

  p.accounts.push({ platform: 'wechat', id: 'wx_bound' })
  savePerson(p)
  clearPersonCache()
  check('跨平台绑定后也指向本人', personOfAccount('wechat', 'wx_bound') === p.id)
}

/* =====================================================================
 * 4. findPersonByAccount：找不到就是 null
 * ===================================================================== */
console.log('\n=== 4. findPersonByAccount ===')
{
  freshRoot('find-person')

  check('空目录里找不到返回 null', findPersonByAccount('qq', '404') === null)

  const p = ensurePerson('qq', '40001', '能找到')
  check('存在的人能按账号找到', findPersonByAccount('qq', '40001')?.id === p.id)

  check('同号但不同平台不误判', findPersonByAccount('wechat', '40001') === null)
  check('有别人时找不到仍是 null', findPersonByAccount('qq', '40002') === null)
}

/* =====================================================================
 * 5. ensurePerson：重复进来只更新名字，不重置 accounts / firstSeen / id
 * ===================================================================== */
console.log('\n=== 5. ensurePerson 不重置字段 ===')
{
  freshRoot('ensure-person')

  const first = ensurePerson('qq', '50001', '原名')
  const firstSeen = first.firstSeen
  first.accounts.push({ platform: 'wechat', id: 'wx_50001' })
  savePerson(first)

  const again = ensurePerson('qq', '50001')
  check('不带名字重入，id 不变', again.id === first.id)
  check('不带名字重入，名字不被重置成账号', again.name === '原名', again.name)
  check('不带名字重入，账号列表保留', again.accounts.length === 2, JSON.stringify(again.accounts))
  check('不带名字重入，firstSeen 不变', again.firstSeen === firstSeen, String(again.firstSeen))

  const renamed = ensurePerson('qq', '50001', '新名')
  check('带新名字只更新名字', renamed.name === '新名')
  check('改名后账号列表还在', renamed.accounts.length === 2, JSON.stringify(renamed.accounts))
  check('改名后 firstSeen 不变', renamed.firstSeen === firstSeen)

  // 模拟"进程重启后，目录 id 已存在但 accounts 里缺这个账号"
  const pid = personIdOf('wechat', 'wx_50002')
  savePerson({
    id: pid,
    name: '微信端',
    accounts: [{ platform: 'qq', id: '59999' }],
    firstSeen: 111,
  })
  clearPersonCache()

  const restarted = ensurePerson('wechat', 'wx_50002', '微信端')
  check('已存在档案：id 不变', restarted.id === pid)
  check('已存在档案：名字不被重置', restarted.name === '微信端', restarted.name)
  check('已存在档案：firstSeen 不变', restarted.firstSeen === 111)
  check(
    '已存在档案：缺失的账号会被补绑',
    restarted.accounts.some((a) => a.platform === 'wechat' && a.id === 'wx_50002'),
    JSON.stringify(restarted.accounts),
  )

  // 清掉缓存再查，确认补绑真的落盘了（而不是只挂在缓存对象上）
  clearPersonCache()
  check('补绑后重启也能按账号找到', findPersonByAccount('wechat', 'wx_50002')?.id === pid)
  check('不带名字再次重入仍保留原名字', ensurePerson('wechat', 'wx_50002').name === '微信端')
}

/* =====================================================================
 * 6. accountIdsOf：多账号取并集（去重，不丢人）
 * ===================================================================== */
console.log('\n=== 6. accountIdsOf 并集 ===')
{
  freshRoot('account-ids')

  const p = ensurePerson('qq', '60001', '多账号')
  p.accounts.push({ platform: 'wechat', id: 'wx_60001' })
  p.accounts.push({ platform: 'qq', id: '60001' }) // 重复登记同一账号
  savePerson(p)
  clearPersonCache()

  const ids = accountIdsOf(p.id)
  const uniq = new Set(ids)
  check('多账号都在', uniq.has('60001') && uniq.has('wx_60001'), JSON.stringify(ids))
  check('并集已去重', ids.length === uniq.size, JSON.stringify(ids))
  check('并集里没有空串', ids.every((x) => x.length > 0), JSON.stringify(ids))

  // 没有 meta 时从 personId 反推，微信前缀也要剥掉
  const wechatOnly = personIdOf('wechat', 'wx_60002')
  savePerson({ id: wechatOnly, name: '只有微信', accounts: [], firstSeen: 1 })
  const fallback = accountIdsOf(wechatOnly)
  check('微信人的兜底账号不带宽前缀', fallback.length === 1 && fallback[0] === 'wx_60002', JSON.stringify(fallback))

  // 完全没建档时也要能反推
  const ghost = accountIdsOf('qq-60003')
  check('没建档也能反推 qq 账号', ghost.length === 1 && ghost[0] === '60003', JSON.stringify(ghost))
}

/* =====================================================================
 * 7. loadOpen：手工改坏的 open.md 不崩，坏行跳过、好行照读
 * ===================================================================== */
console.log('\n=== 7. loadOpen 容错 ===')
{
  freshRoot('load-open')

  const pid = ensurePerson('qq', '70001', '坏文件').id
  const file = openFilePath(pid)
  const broken = [
    '# 还没做完 / 想问他的事',
    '',
    '',
    '- [todo] 缺日期的条目',
    '- [done] kind 写错了（2026-10-20）',
    '- [pending] 半角括号(2026-10-21)',
    '- [todo] 正常条目（2026-10-22）',
    '   ',
    '随便一行',
    '- [todo] 坏日期（2026-1-2）',
    '- [todo] 另一个正常的（2026-10-23）',
    '',
  ].join('\n')
  writeFileSync(file, broken, 'utf8')

  let items = [] as ReturnType<typeof loadOpen>
  let threw = false
  try {
    items = loadOpen(pid)
  } catch {
    threw = true
  }
  check('坏文件不抛错', !threw)
  check('缺日期 / kind 写错 / 坏日期都不进结果', !items.some((i) => ['缺日期的条目', 'kind 写错了', '坏日期'].includes(i.text)), JSON.stringify(items))
  check(
    '好行照读且顺序不变',
    items.map((i) => i.text).join('|') === '半角括号|正常条目|另一个正常的',
    items.map((i) => i.text).join('|'),
  )
  check('半角括号也能解析', items[0]?.kind === 'pending' && items[0]?.date === '2026-10-21', JSON.stringify(items[0]))
  check('日期与 kind 解析正确', items[1]?.kind === 'todo' && items[1]?.date === '2026-10-22', JSON.stringify(items[1]))
  check('多空行不影响条数', items.length === 3, String(items.length))

  // CRLF + 行尾空格 + BOM
  const crlfPid = ensurePerson('qq', '70002', 'CRLF').id
  writeFileSync(openFilePath(crlfPid), '\uFEFF# 头\r\n\r\n- [todo] CRLF 条目（2026-10-24）  \r\n', 'utf8')
  const crlf = loadOpen(crlfPid)
  check('CRLF / 行尾空格 / BOM 都能读', crlf.length === 1 && crlf[0]?.text === 'CRLF 条目', JSON.stringify(crlf))

  check('文件不存在返回空数组', loadOpen(personIdOf('qq', '70099')).length === 0)
  check('目录不存在也不崩', loadOpen(personIdOf('qq', '70098')).length === 0)
}

/* =====================================================================
 * 8. removeOpen：删不存在的条目返回 false，且不动文件
 * ===================================================================== */
console.log('\n=== 8. removeOpen ===')
{
  freshRoot('remove-open')
  const pid = ensurePerson('qq', '80001', '删待办').id

  check('文件都没有时返回 false', removeOpen(pid, '不存在') === false)

  appendOpen(pid, [
    { text: '留着', date: '2026-10-20', kind: 'todo' },
    { text: '删掉', date: '2026-10-21', kind: 'pending' },
  ])
  const before = readFileSync(openFilePath(pid), 'utf8')

  check('删不存在的条目返回 false', removeOpen(pid, '真的不存在') === false)
  check('返回 false 时文件原样不动', readFileSync(openFilePath(pid), 'utf8') === before)

  check('删存在的条目返回 true', removeOpen(pid, '删掉') === true)
  const left = loadOpen(pid)
  check('只删掉目标条目', left.length === 1 && left[0]?.text === '留着', JSON.stringify(left))

  check('删最后一条也返回 true', removeOpen(pid, '留着') === true)
  check('删完文件里没有条目', loadOpen(pid).length === 0)
  check('再删同一条返回 false', removeOpen(pid, '留着') === false)
}

/* =====================================================================
 * 9. 并发 appendOpen：一条都不能丢
 * ===================================================================== */
console.log('\n=== 9. 并发 appendOpen ===')
{
  freshRoot('append-open')
  const pid = ensurePerson('qq', '90001', '并发').id
  writeFileSync(openFilePath(pid), '# 还没做完 / 想问他的事\n\n', 'utf8')

  const N = 60
  const items = Array.from({ length: N }, (_, i) => ({
    text: `并发条目 ${i}`,
    date: '2026-10-26',
    kind: (i % 2 === 0 ? 'todo' : 'pending') as 'todo' | 'pending',
  }))

  // 每个追加都放到独立微任务里，模拟同一轮事件循环内连续落盘
  await Promise.all(items.map((item) => Promise.resolve().then(() => appendOpen(pid, [item]))))
  await drainWrites()

  const loaded = loadOpen(pid)
  check(`${N} 条全部读回`, loaded.length === N, `读到 ${loaded.length} 条`)
  check('没有重复条目', new Set(loaded.map((i) => i.text)).size === N, `去重后 ${new Set(loaded.map((i) => i.text)).size} 条`)
  check(
    'kind / 日期没有串',
    items.every((it) => loaded.some((x) => x.text === it.text && x.kind === it.kind && x.date === it.date)),
  )

  const raw = readFileSync(openFilePath(pid), 'utf8')
  const rawLines = raw.split(/\r?\n/).filter((l) => l.startsWith('- ['))
  check(`${N} 条在文件里也一条不少`, rawLines.length === N, `文件里 ${rawLines.length} 行`)
}

/* =====================================================================
 * 附：换 people 根之后不能串上一个根的人（缓存要一起失效）
 * ===================================================================== */
console.log('\n=== 附加. setPeopleRoot 清缓存 ===')
{
  const rootA = freshRoot('switch-a')
  const pid = ensurePerson('qq', '91001', 'A 根的人').id
  check('A 根里建好了人', existsSync(join(rootA, pid, 'meta.json')))

  const rootB = freshRoot('switch-b')
  check('换根后旧账号查不到', findPersonByAccount('qq', '91001') === null)

  ensurePerson('qq', '91001', 'B 根的人')
  check('换根后重建的人在新根里', existsSync(join(rootB, pid, 'meta.json')))
  check('新根里只有一个人', listPeople().length === 1, `实际 ${listPeople().length}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
