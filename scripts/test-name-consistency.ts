/**
 * 名字一致性的体检。
 *
 * 这一轮修的三个 bug：
 *   1. group.ts 的「认识几个」按名字比（群名片 vs QQ昵称，永远对不上）
 *   2. senderName 为空时退到 m.from.name —— 群聊时那是**群名**
 *   3. 渲染"打过交道的人"只给昵称，群里看着像换了个人
 *
 * 核心认识：
 *   members[].name  = 群名片（群里显示的名字，每个群不同）
 *   members[].nick  = QQ 昵称（全局唯一）
 *   person.name     = QQ 昵称（档案里的全局名）
 *   m.from.name     = 群名（群聊）/ 对方名（私聊）
 *   这四样不能混用。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

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

const group = await import('../src/people/group.ts')
const gc = await import('../src/people/groupcache.ts')
const store = await import('../src/memory/store.ts')
const people = await import('../src/people/store.ts')

const groupSrc = readFileSync('src/people/group.ts', 'utf8')
const bootSrc = readFileSync('src/boot.ts', 'utf8')
const chatSrc = readFileSync('src/loop/chat.ts', 'utf8')

/* ============ 1. GroupMate 有 id ============ */
console.log('=== 1. 按 id 匹配 ===')
{
  check('GroupMate 接口有 id', /interface GroupMate \{[^}]*id: string/s.test(groupSrc), '')
  check('peopleInGroup 填了 id', groupSrc.includes('out.push({ id: account'), '')
  check('「认识几个」按 id 算', groupSrc.includes('mates.map((m) => m.id)'), '')
  check('不再按名字算', !groupSrc.includes('mates.map((m) => m.name)'), '')
}

/* ============ 2. senderName 为空时的兜底 ============ */
console.log('\n=== 2. 不把群名当人名 ===')
{
  check('boot 的 who 不用 from.name', !bootSrc.includes('m.senderName ?? m.from.name ?? m.from.id'), '')
  check('boot 的 who 退到 senderNick', bootSrc.includes('m.senderName ?? m.senderNick'), '')
  check('chat 的 personName 不用 from.name', !chatSrc.includes('personName: m.senderName ?? m.from.name,'), '')
  check('chat 的 personName 退到 senderNick', chatSrc.includes('personName: m.senderName ?? m.senderNick'), '')
  check('chat 的 userContent 也修了', !chatSrc.includes('formatUserText(scope, m.senderName ?? m.from.name'), '')
}

/* ============ 3. 渲染时两者都给 ============ */
console.log('\n=== 3. 群名片 + 昵称都给 ===')
{
  check('渲染"打过交道的人"时查群名片', groupSrc.includes('members.find((x) => x.id === m.id)?.name'), '')
  check('两个名字不一样时都显示', groupSrc.includes('你记的名字是'), '')

  // 用真实数据渲染。
  // ⚠️ 这两条依赖线上数据的具体状态（群名片是否和昵称不同、是否聊过），
  // 数据一变就误报。所以数据不满足时只提示、不算失败 ——
  // 真正的逻辑验证在第 4 节的假数据里做。
  const real = group.renderGroupContext('631887317')
  if (real.includes('你记的名字是')) {
    check('渲染里出现了"你记的名字是"', true, '')
  } else {
    console.log('⚠ 跳过「你记的名字是」：当前群数据里群名片和昵称一致')
  }
  if (!real.includes('实际聊过的只有 0 个')) {
    check('「认识几个」不再是 0', true, '')
  } else {
    console.log('⚠ 跳过「认识几个」：当前群里还没有聊过的人')
  }
}

/* ============ 4. 用造的假数据验证匹配逻辑 ============ */
console.log('\n=== 4. 假数据：群名片和昵称不同 ===')
{
  const ROOT = 'data/test-nameconsistency'
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/groups/111`, { recursive: true })
  mkdirSync(`${ROOT}/people`, { recursive: true })
  mkdirSync(`${ROOT}/memory/raw`, { recursive: true })

  gc.setGroupsRoot(`${ROOT}/groups`)
  people.setPeopleRoot(`${ROOT}/people`)
  store.setMemoryRoot?.(`${ROOT}/memory`)

  // 群里：名片「群代肝」，昵称「欲辨已妄言」
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    `${ROOT}/groups/111/members.json`,
    JSON.stringify({
      groupId: '111',
      at: Date.now(),
      members: [
        { id: '1001', name: '群代肝', nick: '欲辨已妄言' },
        { id: '1002', name: '路人甲', nick: '路人甲的昵称' },
        { id: '1003', name: '路人乙', nick: '路人乙的昵称' },
      ],
    }),
    'utf8',
  )
  gc.clearMemberCache()

  // 档案：全局名是昵称
  people.ensurePerson('qq', '1001', '欲辨已妄言')

  // 这个人在群里说过话
  store.appendRaw({ ts: Date.now(), scope: 'group:111', role: 'user', text: '在', senderId: '1001' })

  const mates = group.peopleInGroup('111')
  check('认出了 1 个', mates.length === 1, String(mates.length))
  check('拿的是 QQ 昵称', mates[0]?.name === '欲辨已妄言', mates[0]?.name)
  check('带上了 QQ 号', mates[0]?.id === '1001', mates[0]?.id)

  const ctx = group.renderGroupContext('111')
  check('总人数对', ctx.includes('一共 3 人'), ctx.split('\n')[0])
  check('认识 1 个、另外 2 个不认识', ctx.includes('实际聊过的只有 1 个，另外 2 个'), ctx.split('\n').find((l) => l.includes('实际聊过')) ?? '')
  check('打过交道那段用群名片', ctx.includes('群代肝'), ctx.slice(ctx.indexOf('其中我和这些人')))

  rmSync(ROOT, { recursive: true, force: true })
}

/* ============ 4b. 重名时才带 uid ============ */
console.log('\n=== 4b. 重名 ===')
{
  const ROOT = 'data/test-dupname'
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/memory/raw`, { recursive: true })
  mkdirSync(`${ROOT}/people`, { recursive: true })
  store.setMemoryRoot?.(`${ROOT}/memory`)
  people.setPeopleRoot(`${ROOT}/people`)

  const recall = await import('../src/memory/recall.ts')

  // 两个人都叫「小明」
  people.ensurePerson('qq', '111', '小明')
  people.ensurePerson('qq', '222', '小明')
  const now = Date.now()
  store.appendRaw({ ts: now - 3000, scope: 'group:9', role: 'user', text: '我要去吃饭', senderId: '111' })
  store.appendRaw({ ts: now - 2000, scope: 'group:9', role: 'user', text: '我也去', senderId: '222' })
  store.appendRaw({ ts: now - 1000, scope: 'group:9', role: 'user', text: '@bot 一起吗', senderId: '111' })

  const w = { 新近: 0.5, 相关: 3, 重要: 2 }
  const r = recall.recall({ personId: 'qq-111', scope: 'group:9', query: '一起吗', limit: 8, weights: w })
  const text = recall.renderRecalled(r)

  check('重名时带上 uid', text.includes('小明(111)') && text.includes('小明(222)'), text.slice(text.indexOf('【最近'), text.indexOf('【最近') + 120))

  // 不重名时不带
  people.ensurePerson('qq', '333', '小红')
  store.appendRaw({ ts: now, scope: 'group:8', role: 'user', text: '我一个人', senderId: '333' })
  const r2 = recall.recall({ personId: 'qq-333', scope: 'group:8', query: '一个人', limit: 8, weights: w })
  const text2 = recall.renderRecalled(r2)
  check('不重名时不带 uid', text2.includes('小红：') && !text2.includes('小红(333)'), text2.slice(text2.indexOf('【最近'), text2.indexOf('【最近') + 100))

  // 私聊永远不带（哪怕同一人出现多次）
  store.appendRaw({ ts: now - 1000, scope: 'private:333', role: 'user', text: '在吗', senderId: '333' })
  store.appendRaw({ ts: now, scope: 'private:333', role: 'user', text: '在不在', senderId: '333' })
  const r3 = recall.recall({ personId: 'qq-333', scope: 'private:333', query: '在吗', limit: 8, weights: w })
  const text3 = recall.renderRecalled(r3)
  check('私聊不带 uid', !text3.includes('(333)'), text3.slice(text3.indexOf('【最近'), text3.indexOf('【最近') + 100))

  rmSync(ROOT, { recursive: true, force: true })
}

/* ============ 5. 名字来源不能被误用 ============ */
console.log('\n=== 5. 别的地方没有同类问题 ===')
{
  // 全项目搜"用 from.name 当人名"
  const bad: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) {
        const c = readFileSync(p, 'utf8')
        if (/senderName \?\? m\.from\.name|personName: m\.from\.name/.test(c)) bad.push(p)
      }
    }
  }
  walk('src')
  check('没有别的地方把群名当人名', bad.length === 0, bad.join(','))
}

import { readdirSync } from 'node:fs'

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
