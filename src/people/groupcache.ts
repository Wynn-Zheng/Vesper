/**
 * 群成员名单：从"内存里凑合一下"改成"落盘 + 预热 + 过期不丢"。
 *
 * 修的问题：
 *   1. 纯内存，重启就空 —— 重启后第一条群消息进来时读不到名单
 *   2. TTL 只有 10 分钟，群里安静十分钟就"忘了"
 *   3. 刷新失败静默 —— 用户看到"这儿就我们俩"也不知道为什么
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  /** groupId → { at, members } */
  groups: Record<string, { at: number; members: CachedMember[] }>
}

const FILE = join('persona', 'groups.json')
/** 落盘的名单用一小时：群里安静一小时也不至于"忘了有谁" */
const DISK_TTL = 60 * 60_000
/** 内存里更快过期的意义不大，和磁盘一致省得两套逻辑 */
const MEM_TTL = DISK_TTL

let disk: CacheFile | null = null

/**
 * 读磁盘缓存。
 *
 * forceReload：内存里那份可能是空的（刚被 clear 过），
 * 这时候必须真去读文件，不能拿内存的空壳糊弄。
 */
function loadDisk(forceReload = false): CacheFile {
  if (!forceReload && disk) return disk
  if (!existsSync(FILE)) {
    disk = { groups: {} }
    return disk
  }
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      disk = { groups: {} }
      return disk
    }
    const groups = (raw as { groups?: unknown }).groups
    disk =
      groups && typeof groups === 'object' && !Array.isArray(groups)
        ? (raw as CacheFile)
        : { groups: {} }
  } catch {
    // 文件坏了就重来，但说一声，别静默
    warnAt('群成员缓存读不出来，按空的重建', { file: FILE })
    disk = { groups: {} }
  }
  return disk
}

function saveDisk(c: CacheFile): void {
  disk = c
  try {
    writeAtomic(FILE, JSON.stringify(c, null, 2))
  } catch (err) {
    warnAt('群成员缓存写不进去', { err: String(err).slice(0, 60) })
  }
}

/** 内存镜像，避免每次读都解析 JSON */
const mem = new Map<string, { at: number; members: CachedMember[] }>()

function hydrate(groupId: string): { at: number; members: CachedMember[] } | null {
  const hit = mem.get(groupId)
  if (hit) return hit
  // 内存没有就一定去读文件（loadDisk 内部有 memo，但被 clear 过会重读）
  const fromDisk = loadDisk(true).groups[groupId]
  if (fromDisk) {
    mem.set(groupId, fromDisk)
    return fromDisk
  }
  return null
}

/**
 * 清内存缓存。
 *
 * 注意：**不清盘**。盘上那份是重启后唯一的依靠，
 * 把它一起清掉的话，"重启后还记得群里有谁"这件事就白做了。
 * 想把盘也清掉用 resetMemberCacheEverywhere。
 */
export function clearMemberCache(): void {
  mem.clear()
  disk = null
}

/** 连盘一起清（测试或彻底重置时用） */
export function resetMemberCacheEverywhere(): void {
  mem.clear()
  disk = { groups: {} }
  try {
    writeAtomic(FILE, JSON.stringify(disk, null, 2))
  } catch {
    /* 清不掉就算了 */
  }
}

/**
 * 后台刷新群成员列表。
 *
 * 和以前不一样：
 *   - 拉到了就落盘，重启不丢
 *   - 拉失败但盘里有旧的，继续用旧的（不返回空）
 *   - 失败会 warn，不再静默
 */
export async function refreshGroupMembers(
  transport: { listGroupMembers?: (gid: string) => Promise<CachedMember[]> },
  groupId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!transport.listGroupMembers) {
    warnAt('当前通道不支持拉群成员，群名单用不了', { group: groupId })
    return
  }

  const hit = hydrate(groupId)
  // force：名单里出现了没见过的人，别等 TTL 过期，立刻去拉
  if (!opts.force && hit && Date.now() - hit.at < MEM_TTL) return

  try {
    const members = await transport.listGroupMembers(groupId)
    if (!members.length) {
      warnAt('群成员拉回来是空的', { group: groupId, 用了旧缓存: !!hit })
      return
    }
    const entry = { at: Date.now(), members }
    mem.set(groupId, entry)

    // 顺手把 people 里的名字同步成最新昵称。
    // 不同步的话，不常说话的人会一直挂着建档时的旧名字（比如"群代肝"其实是"我是菜鸟"），
    // 头像按名字首字画，看起来就"对不上"。
    try {
      const { syncPersonName } = await import('./store.ts')
      let renamed = 0
      for (const m of members) {
        // 用 QQ 昵称同步全局名，不用群名片 ——
        // 群名片每个群不一样，写进全局会出现"在群 A 叫这个、在群 B 叫那个"
        const globalName = m.nick || m.name
        if (m.id && globalName && syncPersonName('qq', m.id, globalName)) renamed += 1
      }
      if (renamed) info(`群里 ${renamed} 个人的名字更新了`, { group: groupId })
    } catch {
      /* 同步失败不影响名单 */
    }

    await serialized('groups', () => {
      const c = loadDisk()
      c.groups[groupId] = entry
      // 别让它无限涨：只留最近 30 个群
      const keys = Object.keys(c.groups)
      if (keys.length > 30) {
        const sorted = keys.sort((a, b) => (c.groups[a]!.at ?? 0) - (c.groups[b]!.at ?? 0))
        for (const k of sorted.slice(0, keys.length - 30)) delete c.groups[k]
      }
      saveDisk(c)
    })
  } catch (err) {
    warnAt('拉群成员失败', {
      group: groupId,
      err: String(err).slice(0, 80),
      用了旧缓存: !!hit,
    })
  }
}

/**
 * 同步读群里有谁。
 *
 * 过期也返回旧名单（标记 stale），不再返回空——
 * 返回空会让它以为"群里就我们俩"，比数据旧一点糟糕得多。
 */
export function groupMembers(groupId: string): CachedMember[] {
  const c = hydrate(groupId)
  if (!c) return []
  return c.members
}

/** 这份名单是不是已经旧了（一小时以上没更新） */
export function membersAreStale(groupId: string): boolean {
  const c = hydrate(groupId)
  if (!c) return true
  return Date.now() - c.at > DISK_TTL
}

/**
 * 从记忆目录里猜出"有哪些群"。
 * 预热用：不知道群号就没法提前拉名单。
 */
export function knownGroups(): string[] {
  const out = new Set<string>()

  // 1. 缓存里已有的
  for (const gid of Object.keys(loadDisk().groups)) out.add(gid)

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

/**
 * 名单里有这个人吗。
 *
 * 用途：群里冒出个名单外的人 → 可能是新成员 → 立刻刷新名单。
 * 名单本身是空的（还没拉到）时返回 true：
 * 那时"不认识"没有意义，别触发了无谓的刷新。
 */
export function isKnownMember(groupId: string, accountId: string): boolean {
  const c = hydrate(groupId)
  if (!c) return true
  if (!c.members.length) return true
  return c.members.some((m) => m.id === accountId)
}

/**
 * 把已知的群全部刷一遍。
 *
 * 谁调它：每天一次的定时任务。
 * 和"新成员检测"的分工：那个是事件驱动（来得快），这个是兜底（保证一天至少对一次）。
 */
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
      const m = groupMembers(gid)
      if (m.length) ok += 1
      else failed.push(gid)
    } catch {
      failed.push(gid)
    }
  }

  return { total: groups.length, ok, failed }
}
