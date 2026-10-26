/**
 * 群聊多发言人上下文。
 *
 * 起因（用户截图）：群里两个人聊天，突然 @ 它：
 *   群代肝：现在就开始练
 *   (ฅ]ω[*ฅ)：不要
 *   (ฅ]ω[*ฅ)：走路老疼了
 *   群代肝：早不练晚不练，腹肌何时能出现
 *   群代肝：@小助手 你说对吧
 *
 * 之前渲染成 4 条「他：」，模型分不清谁是谁，「对吧」指什么只能瞎猜。
 * 现在：带发言人名字 + 取 8 条（不是 4 条）。
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

const store = await import('../src/memory/store.ts')
const people = await import('../src/people/store.ts')
const recall = await import('../src/memory/recall.ts')
const gc = await import('../src/people/groupcache.ts')
const src = readFileSync('src/memory/recall.ts', 'utf8')
const typesSrc = readFileSync('src/memory/types.ts', 'utf8')

const ROOT = 'data/test-speaker'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/memory/raw`, { recursive: true })
mkdirSync(`${ROOT}/people`, { recursive: true })
mkdirSync(`${ROOT}/groups`, { recursive: true })
store.setMemoryRoot?.(`${ROOT}/memory`)
people.setPeopleRoot(`${ROOT}/people`)
gc.setGroupsRoot(`${ROOT}/groups`)

/* ============ 1. 数据结构 ============ */
console.log('=== 1. RawTurn 有 speakerName ===')
{
  check('类型里有 speakerName', typesSrc.includes('speakerName?: string'), '')
  check('注释说明「只用于渲染，不落盘」', typesSrc.includes('不落盘'), '')
}

/* ============ 2. 多发言人场景 ============ */
console.log('\n=== 2. 两个人的群聊 ===')
people.ensurePerson('qq', '1234567890', '群代肝')
people.ensurePerson('qq', '503712366', '(ฅ]ω[*ฅ)')

const GID = '710344485'
const now = Date.now()
const turns = [
  { senderId: '1234567890', text: '现在就开始练' },
  { senderId: '503712366', text: '不要' },
  { senderId: '503712366', text: '走路老疼了' },
  { senderId: '1234567890', text: '早不练晚不练，腹肌何时能出现' },
  { senderId: '1234567890', text: '@小助手 你说对吧' },
]
for (let i = 0; i < turns.length; i++) {
  const t = turns[i]!
  store.appendRaw({
    ts: now - (turns.length - i) * 1000,
    scope: `group:${GID}`,
    role: 'user',
    text: t.text,
    senderId: t.senderId,
  })
}

const r = recall.recall({
  personId: 'qq-1234567890',
  scope: `group:${GID}`,
  query: '@小助手 你说对吧',
  limit: 8,
  weights: { 新近: 0.5, 相关: 3, 重要: 2 },
})

check(`recent 取了 ${r.recent.length} 条`, r.recent.length === 5, String(r.recent.length))
check('每条都补了 speakerName', r.recent.every((t) => !!t.speakerName), JSON.stringify(r.recent.map((t) => t.speakerName)))
check('第一个说话的是「群代肝」', r.recent[0]?.speakerName === '群代肝', r.recent[0]?.speakerName)
check('第二个是「(ฅ]ω[*ฅ)」', r.recent[1]?.speakerName === '(ฅ]ω[*ฅ)', r.recent[1]?.speakerName)

const text = recall.renderRecalled(r)
const idx = text.indexOf('【最近说过的话】')
const block = text.slice(idx, idx + 400)

check('渲染里带「群代肝：」', block.includes('群代肝：'), '')
check('渲染里带「(ฅ]ω[*ฅ)：」', block.includes('(ฅ]ω[*ฅ)：'), '')
check('不再是清一色的「他：」', (block.match(/他：/g) ?? []).length < 3, String((block.match(/他：/g) ?? []).length))

console.log('\n--- 实际渲染 ---')
console.log(
  block
    .split('\n')
    .slice(0, 8)
    .map((l) => '  ' + l)
    .join('\n'),
)

/* ============ 3. 取 8 条不是 4 条 ============ */
console.log('\n=== 3. 数量 ===')
{
  check('代码里是 slice(-8)', src.includes('.slice(-8)'), '')
  check('不再是 slice(-4)', !src.includes('.slice(-4)'), '')

  for (let i = 0; i < 5; i++) {
    store.appendRaw({
      ts: now + i * 1000,
      scope: `group:${GID}`,
      role: 'user',
      text: `补充消息 ${i}`,
      senderId: '1234567890',
    })
  }
  const r2 = recall.recall({
    personId: 'qq-1234567890',
    scope: `group:${GID}`,
    query: '补充',
    limit: 8,
    weights: { 新近: 0.5, 相关: 3, 重要: 2 },
  })
  check(`10 条只取 8 条（实际 ${r2.recent.length}）`, r2.recent.length === 8, String(r2.recent.length))
}

/* ============ 4. 查不到名字时回落 ============ */
console.log('\n=== 4. 查不到名字 ===')
{
  store.appendRaw({
    ts: now + 10000,
    scope: `group:${GID}`,
    role: 'user',
    text: '我是陌生人',
    senderId: '999999999',
  })
  const r3 = recall.recall({
    personId: 'qq-1234567890',
    scope: `group:${GID}`,
    query: '陌生人',
    limit: 8,
    weights: { 新近: 0.5, 相关: 3, 重要: 2 },
  })
  const stranger = r3.recent.find((t) => t.text === '我是陌生人')
  check('查不到名字的没有 speakerName', !stranger?.speakerName, String(stranger?.speakerName))
  check('渲染时回落到「他」', recall.renderRecalled(r3).includes('他：我是陌生人'), '')
}

/* ============ 5. 私聊不受影响 ============ */
console.log('\n=== 5. 私聊 ===')
{
  store.appendRaw({ ts: now, scope: 'private:1234567890', role: 'user', text: '在吗', senderId: '1234567890' })
  const r4 = recall.recall({
    personId: 'qq-1234567890',
    scope: 'private:1234567890',
    query: '在吗',
    limit: 8,
    weights: { 新近: 0.5, 相关: 3, 重要: 2 },
  })
  check('私聊也能补名字', r4.recent.every((t) => !t.senderId || !!t.speakerName), JSON.stringify(r4.recent.map((t) => t.speakerName)))
  check('私聊不会混进群消息', r4.recent.every((t) => t.scope === 'private:1234567890'), JSON.stringify(r4.recent.map((t) => t.scope)))
}

/* ============ 6. 不落盘 ============ */
console.log('\n=== 6. speakerName 不写进 raw ===')
{
  const storeSrc = readFileSync('src/memory/store.ts', 'utf8')
  check('appendRaw 不处理 speakerName', !/appendRaw[\s\S]{0,300}speakerName/.test(storeSrc), '')
}

/* ============ 7. 只拉回 1 人时保留旧名单 ============ */
console.log('\n=== 7. 拉回 1 人当失败 ===')
{
  const G2 = '777777777'
  mkdirSync(`${ROOT}/groups/${G2}`, { recursive: true })

  // 先造一个 10 人的旧名单
  const old = {
    groupId: G2,
    at: Date.now() - 1000,
    members: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), name: `人${i}`, nick: `人${i}` })),
  }
  writeFileSync(`${ROOT}/groups/${G2}/members.json`, JSON.stringify(old), 'utf8')
  gc.clearMemberCache()

  // 假装 transport 只返回 1 个人（NapCat 短暂连上时会这样）
  const transport = { listGroupMembers: async () => [{ id: '1', name: '只剩一个' }] }
  await gc.refreshGroupMembers(transport, G2, { force: true })

  const after = gc.groupMembers(G2)
  check(`只拉回 1 人时不覆盖（还是 ${after.length} 人）`, after.length === 10, String(after.length))
  check('旧名单里的人还在', after.some((m) => m.name === '人0'), '')
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
