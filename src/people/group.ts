import { loadRules, stageOf } from '../core/config.ts'
import type { Transport } from '../core/transport.ts'
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

interface MemberCache {
  at: number
  members: Array<{ id: string; name: string }>
}

const memberCache = new Map<string, MemberCache>()
const MEMBER_TTL = 10 * 60_000

export function clearMemberCache(): void {
  memberCache.clear()
}

/** 后台刷新群成员列表；失败就保持旧缓存 */
export async function refreshGroupMembers(transport: Transport, groupId: string): Promise<void> {
  if (!transport.listGroupMembers) return
  const hit = memberCache.get(groupId)
  if (hit && Date.now() - hit.at < MEMBER_TTL) return
  try {
    const members = await transport.listGroupMembers(groupId)
    if (members.length) memberCache.set(groupId, { at: Date.now(), members })
  } catch {
    /* 拉不到就继续用旧的 */
  }
}

/** 同步读缓存：群里有谁。没拉过就返回空 */
export function groupMembers(groupId: string): Array<{ id: string; name: string }> {
  const c = memberCache.get(groupId)
  if (!c || Date.now() - c.at > MEMBER_TTL) return []
  return c.members
}

/** 把「群里都有谁」和「我熟的有谁」分开渲染 */
export function renderGroupContext(groupId: string): string {
  const members = groupMembers(groupId)
  const mates = peopleInGroup(groupId)
  const lines: string[] = []

  if (members.length) {
    const names = members.map((m) => m.name).slice(0, 25)
    lines.push(`这个群一共 ${members.length} 人：${names.join('、')}${members.length > 25 ? '……' : ''}`)
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
