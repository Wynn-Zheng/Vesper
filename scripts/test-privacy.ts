/**
 * 隐私边界测试：一个人的私事绝不能出现在另一个人的上下文里。
 * 用真实的 recall()，不是自己拼。
 */
import { loadFacts } from '../src/memory/facts.ts'
import { loadEpisodes } from '../src/memory/store.ts'
import { recall } from '../src/memory/recall.ts'
import { listPeople } from '../src/people/store.ts'
import { loadOpen } from '../src/people/open.ts'
import { loadRules } from '../src/core/config.ts'

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

const rules = loadRules().rules
const weights = rules.记忆.检索.权重
const decay = rules.记忆.衰减

console.log('=== 当前数据 ===')
const people = listPeople().filter((p) => p.id && p.name)
for (const p of people) {
  const f = loadFacts(p.id)
  const priv = f.filter((x) => x.visibility === 'private').length
  const pub = f.filter((x) => x.visibility === 'public').length
  console.log(`  ${p.name}（${p.id}）: ${f.length} 事实（private ${priv} / public ${pub}）`)
}
const episodes = loadEpisodes()
console.log(`  经历 ${episodes.length} 段`)
for (const e of episodes) console.log(`    [${e.scope}] ${e.title.slice(0, 34)}`)

console.log('\n=== 1. 私聊召回：不能出现别人的私事 ===')
for (const p of people) {
  const r = recall({
    personId: p.id,
    scope: `private:${p.id}`,
    query: '四级 熬夜 英语',
    limit: 50,
    weights,
    decay,
  })
  const mine = new Set(loadFacts(p.id).map((f) => f.text))
  const foreign = r.facts.filter((f) => !mine.has(f.text))
  check(`${p.name} 的私聊没混进别人的事实`, foreign.length === 0, `混进 ${foreign.length} 条`)

  // 经历：只该有 private:<自己> 和 shared。
  //
  // 注意 personId 是 `qq-<QQ>`，而 scope 是 `private:<QQ>` —— **不带 qq- 前缀**
  // （见 memory/scope.ts 的 scopeOf）。这里以前直接用 p.id 拼，拼出来的 scope
  // 永远对不上，于是所有自己的经历都被判成"别人的"。
  const account = p.id.replace(/^qq-/, '')
  const myScopes = new Set([`private:${account}`, 'shared'])
  const badEp = r.episodes.filter((e) => !myScopes.has(e.scope.replace(/^private:qq-/, 'private:')))
  check(`${p.name} 的私聊没混进别人的经历`, badEp.length === 0, badEp.map((e) => e.scope).join(','))
}

console.log('\n=== 2. 群聊召回：只能是 shared 或本群 ===')
{
  const gid = 'group:111111111'
  const r = recall({
    personId: 'qq-1234567890',
    scope: gid,
    query: '群里 夸 聊天',
    limit: 50,
    weights,
    decay,
  })
  const badEp = r.episodes.filter((e) => e.scope !== 'shared' && e.scope !== gid)
  check('群聊没混进私聊经历', badEp.length === 0, badEp.map((e) => `${e.scope}「${e.title.slice(0, 16)}」`).join(', '))
}

console.log('\n=== 3. 群聊里不该注入 private 事实 ===')
{
  // 构造：给主人加一条 public 和一条 private，看群聊召回
  const pid = 'qq-1234567890'
  const facts = loadFacts(pid)
  const priv = facts.filter((f) => f.visibility === 'private')
  const pub = facts.filter((f) => f.visibility === 'public')
  console.log(`  主人有 private ${priv.length} 条 / public ${pub.length} 条`)

  const r = recall({
    personId: pid,
    scope: 'group:111111111',
    query: priv.map((f) => f.text).join(' '),
    limit: 50,
    weights,
    decay,
  })
  // 群聊时，private 事实不该出现（前提是查得到）
  const leaked = r.facts.filter((f) => priv.some((p) => p.text === f.text))
  check('群里不会把私事说出来', leaked.length === 0, `漏了 ${leaked.length} 条：${leaked.map((f) => f.text.slice(0, 20)).join(', ')}`)
}

console.log('\n=== 4. 待办只属于本人 ===')
for (const p of people) {
  const open = loadOpen(p.id)
  const r = recall({
    personId: p.id,
    scope: `private:${p.id}`,
    query: '还没做的事',
    limit: 50,
    weights,
    decay,
  })
  const mine = new Set(open.map((o) => o.text))
  const foreign = r.open.filter((o) => !mine.has(o.text))
  check(`${p.name} 的待办只有自己的`, foreign.length === 0, `混进 ${foreign.length} 条`)
}

console.log('\n=== 5. 空数据不崩 ===')
{
  const r = recall({ personId: 'qq-000000', scope: 'private:qq-000000', query: '', limit: 10, weights, decay })
  check('空 person 不崩', Array.isArray(r.facts))
}

console.log('\n=== 6. 同一 query 结果稳定 ===')
{
  const opts = { personId: 'qq-1234567890', scope: 'private:qq-1234567890' as const, query: '四级', limit: 5, weights, decay, now: 1_760_000_000_000 }
  const a = recall(opts).facts.map((f) => f.text)
  const b = recall(opts).facts.map((f) => f.text)
  check('同样输入召回结果一致', JSON.stringify(a) === JSON.stringify(b))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
