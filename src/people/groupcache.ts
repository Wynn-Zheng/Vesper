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
import { memoryRoot } from '../memory/store.ts'

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

let ROOT = join('persona', 'groups')
/** 落盘名单一小时有效：群里安静一小时也不至于"忘了有谁" */
const TTL = 60 * 60_000

/**
 * 测试用：换掉群名单的根目录。
 *
 * 没有这个，测试会直接写 persona/groups/ —— 一跑就把真实群名单覆盖掉
 * （之前就踩过：52 人被写成 1 人）。
 */
export function setGroupsRoot(p: string): void {
  ROOT = p
  mem.clear()
}

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

    // 只拉回一个人也不可信：群里至少有你（bot）自己和其他人。
    // 实测踩过这个坑——NapCat 短暂连上时回了个只含 1 人的列表，
    // 直接把 52 人的名单覆盖成了 1 人，控制台看起来像"认不出任何人"。
    if (members.length === 1 && hit && hit.members.length > 1) {
      warnAt('群成员只拉回 1 个，像是拉错了，保留旧名单', {
        group: groupId,
        旧名单: hit.members.length,
      })
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
    // 有旧缓存 = 降级成功，用 info：这是启动早期 NapCat 还没连上的常态，
    // 记成 warn 会让它每天把"我这边老报错"挂进 prompt。
    // 真没缓存（名单彻底拉不到）才值得 warn。
    const extra = { group: groupId, err: String(err).slice(0, 80), 用了旧缓存: !!hit }
    if (hit) info('拉群成员失败，用旧缓存', extra)
    else warnAt('拉群成员失败（没有旧缓存）', extra)
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
    // 必须跟着当前角色卡的 memory 根走：写死 persona/memory 时，
    // 切到别的卡还会把上一张卡的群聊进来，群名单就串了。
    const dir = join(memoryRoot(), 'episodes')
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


/* ============================================================
 * 从快照恢复群名单
 * ============================================================ */

export interface RestoreReport {
  /** 恢复了哪些群 */
  restored: Array<{ groupId: string; from: number; to: number; snapshot: string }>
  /** 哪些群不用恢复（当前已经是最好的） */
  skipped: Array<{ groupId: string; current: number; best: number }>
  /** 扫了多少个快照 */
  scanned: number
}

/**
 * 扫 data/versions/ 里的快照，把每个群的名单恢复到**历史上最完整的那一份**。
 *
 * 为什么要这个：
 *   群名单被清空过（1 人 / 0 人），但 data/versions/ 里每天/每次改动都有快照。
 *   之前是手动跑脚本救回来的，做成按钮以后遇到不用找人。
 *
 * 为什么只恢复"更多人的"：
 *   快照里的名单可能比现在的旧（群里进过新人）。
 *   只在快照明显更完整时才覆盖，避免把新名单退回去。
 */
export function restoreGroupsFromSnapshots(opts: { snapshotRoot?: string; minGain?: number } = {}): RestoreReport {
  const root = opts.snapshotRoot ?? 'data/versions'
  // 至少要"多这么多人"才值得覆盖。默认 5：
  // 差一两个可能只是有人退群，差五个以上基本是名单被清过。
  const minGain = opts.minGain ?? 5

  const report: RestoreReport = { restored: [], skipped: [], scanned: 0 }

  let snaps: string[]
  try {
    snaps = readdirSync(root).sort()
  } catch {
    return report
  }
  report.scanned = snaps.length

  // 快照号 → 每个群的最好成绩
  const best = new Map<string, { count: number; path: string; snap: string }>()

  for (const snap of snaps) {
    const dir = join(root, snap, 'groups')
    let groups: string[]
    try {
      groups = readdirSync(dir)
    } catch {
      continue
    }
    for (const gid of groups) {
      const f = join(dir, gid, 'members.json')
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { members?: unknown[] }
        const count = Array.isArray(j.members) ? j.members.length : 0
        const cur = best.get(gid)
        if (!cur || count > cur.count) best.set(gid, { count, path: f, snap })
      } catch {
        /* 坏快照跳过 */
      }
    }
  }

  // 只处理"当前还存在"的群。
  // 快照里会留着测试造的假群（111111111 之类），没必去恢复它们。
  const live = new Set(knownGroups())

  for (const [gid, b] of best) {
    if (!live.has(gid)) continue
    const current = groupMembers(gid).length
    if (b.count < current + minGain) {
      report.skipped.push({ groupId: gid, current, best: b.count })
      continue
    }

    try {
      const raw = readFileSync(b.path, 'utf8')
      const parsed = JSON.parse(raw) as CacheFile
      if (!Array.isArray(parsed.members) || !parsed.members.length) continue

      mkdirSync(dirOf(gid), { recursive: true })
      // at 用当前时间：恢复后一小时 TTL 从头算，别刚从快照回来就又被判过期
      const entry: CacheFile = { groupId: gid, at: Date.now(), members: parsed.members }
      save(entry)

      report.restored.push({ groupId: gid, from: current, to: parsed.members.length, snapshot: b.snap })
      info(`群名单已从快照恢复：${gid} ${current} → ${parsed.members.length} 人（${b.snap}）`)
    } catch (err) {
      warnAt('从快照恢复群名单失败', { group: gid, err: String(err).slice(0, 80) })
    }
  }

  return report
}
