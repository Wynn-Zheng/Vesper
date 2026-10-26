import { loadRules, stageOf } from '../core/config.ts'
import { recentRaw } from '../memory/store.ts'
import { loadRelation } from '../relation/store.ts'
import { personOfAccount, loadPerson } from './store.ts'

export interface GroupMate {
  name: string
  stage: string
}

/**
 * 这个群里我认识的人。
 * 从最近的群聊记录里找发言者，再看我和他们各自的关系。
 */
export function peopleInGroup(groupId: string, opts: { days?: number; limit?: number } = {}): GroupMate[] {
  const days = opts.days ?? 7
  const limit = opts.limit ?? 8
  const scope = `group:${groupId}`

  const seen = new Set<string>()
  for (const t of recentRaw(days)) {
    if (t.scope !== scope || t.role !== 'user') continue
    if (t.senderId) seen.add(t.senderId)
  }

  const rules = loadRules().rules
  const out: GroupMate[] = []
  for (const account of seen) {
    if (out.length >= limit) break
    const personId = personOfAccount('qq', account)
    const meta = loadPerson(personId)
    if (!meta) continue
    const stage = stageOf(rules, loadRelation(personId).closeness)
    out.push({ name: meta.name || account, stage: stage.名 })
  }
  return out
}

/* ---------------- 群成员名单（含没说过话的人） ---------------- */

// 名单缓存挪到 groupcache.ts：落盘、一小时、过期也返回旧数据。
// 原来是内存 Map + 10 分钟，重启就空、安静十分钟就"忘了"，于是它以为群里只有两个人。
import { groupMembers } from './groupcache.ts'
export {
  clearMemberCache,
  groupMembers,
  knownGroups,
  resetMemberCacheEverywhere,
  membersAreStale,
  refreshGroupMembers,
} from './groupcache.ts'

/** 名单为空时的补救钩子：boot 里注入"去拉一次"，渲染这边只管踢一脚 */
let onGroupMembersMissing: ((groupId: string) => Promise<void>) | null = null

export function setGroupMembersMissingHook(fn: (groupId: string) => Promise<void>): void {
  onGroupMembersMissing = fn
}

/** 把「群里都有谁」和「我熟的有谁」分开渲染 */
export function renderGroupContext(groupId: string): string {
  const members = groupMembers(groupId)
  const mates = peopleInGroup(groupId)
  const lines: string[] = []

  if (members.length) {
    const names = members.map((m) => m.name).slice(0, 25)
    lines.push(`这个群一共 ${members.length} 人：${names.join('、')}${members.length > 25 ? '……' : ''}`)
    // 关键：名单里大部分人你没打过交道。不说这句，它会以为"群里就我们俩"。
    const known = new Set(mates.map((m) => m.name))
    const others = members.filter((m) => !known.has(m.name)).length
    if (others > 0) {
      lines.push(`这 ${members.length} 人里，你实际聊过的只有 ${mates.length} 个，另外 ${others} 个你还不认识。`)
    }
  } else {
    // 没拉到名单，也要说清楚是"不知道"而不是"就我们俩"
    lines.push('这个群有多少人你不清楚（名单还没拉到）。别以为群里只有你们俩。')
    // 顺手踢一次后台刷新，下一轮就有了。
    // 这里不能 await：渲染是同步的，等它会把回复拖慢好几秒。
    void onGroupMembersMissing?.(groupId)
  }

  if (mates.length) {
    lines.push('')
    lines.push('其中我和这些人打过交道：')
    for (const m of mates) lines.push(`- ${m.name}（${m.stage}）`)
  }

  if (!lines.length) return ''
  lines.push('')
  lines.push('名单只是让你知道有谁，不代表你了解他们。没聊过的人，你对他们一无所知。')
  return lines.join('\n')
}
