/**
 * 数据体检：检查 persona/ 下的档案是否一致、有没有孤儿或坏数据。
 * 用法：node scripts/check-data.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { initLog } from '../src/core/log.ts'
import { loadFacts } from '../src/memory/facts.ts'
import { loadOpen } from '../src/people/open.ts'
import { accountIdsOf, isValidPersonId, listPeople, loadPerson, personDir } from '../src/people/store.ts'
import { loadRelation } from '../src/relation/store.ts'
import { loadEpisodes } from '../src/memory/store.ts'
import { loadMood } from '../src/persona/mood.ts'
import { loadAccess } from '../src/core/access.ts'

initLog('', false)

let problems = 0
const ok = (msg: string) => console.log(`\x1b[32m✓\x1b[0m ${msg}`)
const bad = (msg: string) => {
  problems++
  console.log(`\x1b[31m✗\x1b[0m ${msg}`)
}
const warn = (msg: string) => console.log(`\x1b[33m!\x1b[0m ${msg}`)

/* ---------- 1. 人物目录 ---------- */
const people = listPeople()
console.log(`\n人物档案：${people.length} 份`)
for (const p of people) {
  if (!isValidPersonId(p.id)) {
    bad(`${p.id} 不是合法 personId`)
    continue
  }
  if (!p.accounts.length) {
    bad(`${p.id} 没有任何账号，这个档案永远对不上人`)
    continue
  }
  if (!p.name || p.name === p.id) warn(`${p.id} 没有显示名（可能是从群成员拉的，没拿到昵称）`)

  let size = 0
  for (const f of ['facts.md', 'relation.yaml', 'open.md', 'profile.md']) {
    if (existsSync(join(personDir(p.id), f))) size++
  }
  ok(`${p.id}（${p.name}）账号 ${p.accounts.length} 个 · 文件 ${size}/4`)
}

/* ---------- 2. 孤儿目录 ---------- */
if (existsSync('persona/people')) {
  for (const e of readdirSync('persona/people', { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (!loadPerson(e.name)) bad(`孤儿目录：persona/people/${e.name}（没有 meta.json）`)
  }
}

/* ---------- 3. 事实可解析 ---------- */
console.log('\n事实：')
for (const p of people) {
  const file = join(personDir(p.id), 'facts.md')
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- '))
  const parsed = loadFacts(p.id)
  if (raw.length !== parsed.length) {
    bad(`${p.id}：文件里 ${raw.length} 行，只解析出 ${parsed.length} 条（有坏行）`)
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('- ') && !loadFacts(p.id).some((f) => line.includes(f.text.slice(0, 8)))) {
        warn(`  坏行：${line.slice(0, 80)}`)
      }
    }
  } else {
    ok(`${p.id}：${parsed.length} 条事实全部可解析`)
  }
}

/* ---------- 4. 待办可解析 ---------- */
console.log('\n待办：')
for (const p of people) {
  const file = join(personDir(p.id), 'open.md')
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- ['));
  const parsed = loadOpen(p.id)
  if (raw.length !== parsed.length) bad(`${p.id}：${raw.length} 行 → 解析出 ${parsed.length} 条`)
  else ok(`${p.id}：${parsed.length} 条`)
}

/* ---------- 5. 关系文件 ---------- */
console.log('\n关系：')
for (const p of people) {
  const file = join(personDir(p.id), 'relation.yaml')
  if (!existsSync(file)) {
    warn(`${p.id}：没有关系文件（新人还没触发过评估）`)
    continue
  }
  try {
    YAML.parse(readFileSync(file, 'utf8'))
    const r = loadRelation(p.id)
    if (r.closeness < 0 || r.closeness > 100) bad(`${p.id}：关系值越界 ${r.closeness}`)
    else ok(`${p.id}：${r.closeness}/100，${r.anchors.length} 个锚点`)
  } catch {
    bad(`${p.id}：relation.yaml 解析失败`)
  }
}

/* ---------- 6. 经历归属 ---------- */
console.log('\n经历：')
const episodes = loadEpisodes()
const knownScopes = new Set<string>(['shared'])
for (const p of people) for (const a of accountIdsOf(p.id)) knownScopes.add(`private:${a}`)
for (const e of episodes) knownScopes.add(e.scope)

const orphanEpisodes = episodes.filter((e) => !knownScopes.has(e.scope))
if (orphanEpisodes.length) {
  for (const e of orphanEpisodes) bad(`孤儿经历 ${e.id}：scope=${e.scope}`)
} else {
  ok(`${episodes.length} 段经历，scope 全部能对上人/群`)
}

// 每段经历是否属于某个人
const byScope = new Map<string, number>()
for (const e of episodes) byScope.set(e.scope, (byScope.get(e.scope) ?? 0) + 1)
for (const [scope, n] of byScope) ok(`  ${scope}：${n} 段`)

/* ---------- 7. 心情 / 权限 ---------- */
console.log('\n全局文件：')
const mood = loadMood()
if (mood) ok(`心情：${mood.emotion}（${mood.intensity.toFixed(2)}）`)
else warn('心情：空（可能是还没生成，或文件被改坏了）')

const access = loadAccess()
ok(
  `权限：群白 ${access.groupAllow.length || '不限'} / 群黑 ${access.groupDeny.length} / 成员白 ${access.memberAllow.length || '不限'} / 成员黑 ${access.memberDeny.length}`,
)

/* ---------- 8. 跨人一致性 ---------- */
console.log('\n一致性：')
const accountToPerson = new Map<string, string>()
let conflict = false
for (const p of people) {
  for (const a of p.accounts) {
    const key = `${a.platform}:${a.id}`
    const prev = accountToPerson.get(key)
    if (prev && prev !== p.id) {
      bad(`账号 ${key} 同时属于 ${prev} 和 ${p.id}`)
      conflict = true
    }
    accountToPerson.set(key, p.id)
  }
}
if (!conflict) ok('每个账号只属于一个人')

/* ---------- 汇总 ---------- */
console.log('')
if (problems) {
  console.log(`\x1b[31m发现 ${problems} 个问题\x1b[0m`)
  process.exit(1)
}
console.log('\x1b[32m数据检查通过\x1b[0m')
