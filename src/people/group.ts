import { loadRules, stageOf } from '../core/config.ts'
import { recentRaw } from '../memory/store.ts'
import { loadRelation } from '../relation/store.ts'
import { personOfAccount, loadPerson } from './store.ts'

export interface GroupMate {
  /** QQ 号。按 id 匹配才靠得住——名字在群里是群名片、在档案里是昵称，对不上 */
  id: string
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
    out.push({ id: account, name: meta.name || account, stage: stage.名 })
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
  isKnownMember,
  knownGroups,
  resetMemberCacheEverywhere,
  membersAreStale,
  refreshAllGroups,
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

  // 群聊记录的格式：「说话人：内容」。
  // prompt 里的历史就是这么存的（见 formatUserText），但从来没跟模型解释过，
  // 于是它偶尔分不清"这句是谁说的"，也会把自己的回复当成别人说的。
  lines.push('群里的聊天记录写成「说话人：内容」。带名字前缀的是**别人**说的；没有前缀的是**你自己**刚说过的。')

  if (members.length) {
    const names = members.map((m) => m.name).slice(0, 25)
    lines.push(`这个群一共 ${members.length} 人：${names.join('、')}${members.length > 25 ? '……' : ''}`)
    // 群名片每个群不一样：说明一下，免得它把"群里叫这个"当成"这个人就叫这个"
    lines.push('（这些是他们在群里的名字，可能和私聊时不一样）')
    // 关键：名单里大部分人你没打过交道。不说这句，它会以为"群里就我们俩"。
    //
    // ⚠️ 必须按 QQ 号匹配，不能按名字：
    //    members[].name 是**群名片**（群里显示的名字）
    //    mates[].name   是**QQ 昵称**（档案里的全局名）
    //    这两个本来就不一样，按名字比会导致 others 永远等于总人数。
    const known = new Set(mates.map((m) => m.id))
    const others = members.filter((m) => !known.has(m.id)).length
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
    for (const m of mates) {
      // 群里优先用群名片：它在这一轮看到的是群名片，用昵称会显得"换了一个人"
      const inGroup = members.find((x) => x.id === m.id)?.name
      const label = inGroup && inGroup !== m.name ? `${inGroup}（你记的名字是「${m.name}」）` : m.name
      lines.push(`- ${label}（${m.stage}）`)
    }
  }

  if (!lines.length) return ''
  lines.push('')
  lines.push('名单只是让你知道有谁，不代表你了解他们。没聊过的人，你对他们一无所知。')
  return lines.join('\n')
}
