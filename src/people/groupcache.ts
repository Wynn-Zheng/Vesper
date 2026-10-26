/**
 * 群成员名单：按群分目录存。
 *
 * 目录结构：
 *   persona/groups/<群号>/members.json
 *
 * 和 people 的分工（这是关键）：
 *   persona/people/  = **真正认识的人**（聊过、有 facts / 关系 / 印象）
 *   persona/groups/  = **每个群有谁**（只是名单，不代表认识）
 *
 * 之前把所有群成员都塞进 people，91 个档案里 87 个是空壳，
 * 既占地方又让人看不出"到底认识几个"。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { info, warnAt } from '../core/log.ts'
import { serialized } from '../store/serialize.ts'
import { writeAtomic } from '../store/fs.ts'

export interface CachedMember {
  id: string
  /** 群名片（这个群里显示的名字） */
  name: string
  /** QQ 昵称（全局名用这个，各群一致） */
  nick?: string
}

interface CacheFile {
  groupId: string
  at: number
  members: CachedMember[]
}

const ROOT = join('persona', 'groups')
/** 落盘名单一小时有效：群里安静一小时也不至于"忘了有谁" */
const TTL = 60 * 60_000

/** groupId → 内存镜像 */
const mem = new Map<string, CacheFile>()

function dirOf(groupId: string): string {
  // 群号只允许数字，防路径穿越
  const safe = String(groupId).replace(/\D/g, '')
  if (!safe) throw new Error(`群号不合法：${groupId}`)
  return join(ROOT, safe)
}

function fileOf(groupId: string): string {
  return join(dirOf(groupId), 'members.json')
}

function load(groupId: string): CacheFile | null {
  const hit = mem.get(groupId)
  if (hit) return hit
  const f = fileOf(groupId)
  if (!existsSync(f)) return null
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const c = raw as CacheFile
    if (!Array.isArray(c.members)) return null
    mem.set(groupId, c)
    return c
  } catch {
    warnAt('群成员名单读不出来，按空的处理', { group: groupId })
    return null
  }
}

function save(c: CacheFile): void {
  mem.set(c.groupId, c)
  try {
    mkdirSync(dirOf(c.groupId), { recursive: true })
    writeAtomic(fileOf(c.groupId), JSON.stringify(c, null, 2))
  } catch (err) {
    warnAt('群成员名单写不进去', { group: c.groupId, err: String(err).slice(0, 60) })
  }
}

/** 这份名单是不是已经旧了（一小时以上没更新） */
export function membersAreStale(groupId: string): boolean {
  const c = load(groupId)
  if (!c) return true
  return Date.now() - c.at > TTL
}

/**
 * 同步读群里有谁。
 *
 * 过期也返回旧名单，不返回空——
 * 返回空会让它以为"群里就我们俩"，比数据旧一点糟糕得多。
 */
export function groupMembers(groupId: string): CachedMember[] {
  const c = load(groupId)
  if (!c) return []
  return c.members
}

/**
 * 名单里有这个人吗。
 *
 * 名单是空的时候返回 true：那时"不认识"没有意义，
 * 别触发了无谓的强制刷新。
 */
export function isKnownMember(groupId: string, accountId: string): boolean {
  const c = load(groupId)
  if (!c) return true
  if (!c.members.length) return true
  return c.members.some((m) => m.id === accountId)
}

/** 后台刷新群成员列表 */
export async function refreshGroupMembers(
  transport: { listGroupMembers?: (gid: string) => Promise<CachedMember[]> },
  groupId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!transport.listGroupMembers) {
    warnAt('当前通道不支持拉群成员，群名单用不了', { group: groupId })
    return
  }

  const hit = load(groupId)
  // force：名单里出现了没见过的人，别等 TTL 过期，立刻去拉
  if (!opts.force && hit && Date.now() - hit.at < TTL) return

  try {
    const members = await transport.listGroupMembers(groupId)
    if (!members.length) {
      warnAt('群成员拉回来是空的', { group: groupId, 用了旧缓存: !!hit })
      return
    }
    const entry: CacheFile = { groupId, at: Date.now(), members }

    await serialized(`groups:${groupId}`, () => {
      save(entry)
    })

    // 只更新**已经认识的人**的名字，不给名单里的人建档。
    // 在不在群里和认不认识是两件事。
    try {
      const { syncPersonName } = await import('./store.ts')
      let renamed = 0
      for (const m of members) {
        const globalName = m.nick || m.name
        if (m.id && globalName && syncPersonName('qq', m.id, globalName)) renamed += 1
      }
      if (renamed) info(`认识的 ${renamed} 个人的名字更新了`, { group: groupId })
    } catch {
      /* 同步失败不影响名单 */
    }
  } catch (err) {
    warnAt('拉群成员失败', {
      group: groupId,
      err: String(err).slice(0, 80),
      用了旧缓存: !!hit,
    })
  }
}

/** 从记忆目录 + 已有名单里猜出"有哪些群" */
export function knownGroups(): string[] {
  const out = new Set<string>()

  // 1. persona/groups/ 下已有的
  try {
    for (const name of readdirSync(ROOT)) out.add(name)
  } catch {
    /* 没有就算了 */
  }

  // 2. 记忆目录里有群聊记录的
  try {
    const dir = join('persona', 'memory', 'episodes')
    for (const name of readdirSync(dir)) {
      const m = /^group-(\d+)$/.exec(name)
      if (m) out.add(m[1]!)
    }
  } catch {
    /* 没有就算了 */
  }

  return [...out]
}

/** 把已知的群全部刷一遍（每日定时用） */
export async function refreshAllGroups(
  transport: { listGroupMembers?: (gid: string) => Promise<CachedMember[]> },
  opts: { force?: boolean } = {},
): Promise<{ total: number; ok: number; failed: string[] }> {
  const groups = knownGroups()
  let ok = 0
  const failed: string[] = []

  for (const gid of groups) {
    try {
      await refreshGroupMembers(transport, gid, { force: opts.force ?? false })
      if (groupMembers(gid).length) ok += 1
      else failed.push(gid)
    } catch {
      failed.push(gid)
    }
  }

  return { total: groups.length, ok, failed }
}

/** 清内存缓存（不清盘） */
export function clearMemberCache(): void {
  mem.clear()
}

/** 连盘一起清（测试用） */
export function resetMemberCacheEverywhere(): void {
  mem.clear()
  try {
    for (const gid of knownGroups()) {
      const f = fileOf(gid)
      if (existsSync(f)) writeAtomic(f, JSON.stringify({ groupId: gid, at: 0, members: [] }))
    }
  } catch {
    /* 清不掉就算了 */
  }
}
