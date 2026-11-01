import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'

export type Platform = 'qq' | 'wechat'

export interface Account {
  platform: Platform
  /** 平台内部 id：QQ 号 / wxid */
  id: string
}

export interface PersonMeta {
  /** 目录名，也是唯一 id，如 qq-1234567890 */
  id: string
  /** 显示名，会随聊天更新 */
  name: string
  accounts: Account[]
  firstSeen: number
  /** 和这个人的关系：主人/朋友/同事/网友/陌生人 */
  role?: string
  /** 名字被用户锁住了：群名单同步时不要覆盖 */
  nameLocked?: boolean
  /**
   * 它给这个人起的称呼（不是真名）。
   *
   * 由自我反思时自己取。你填的 `callNameSuggested` 只是建议 ——
   * 它可以不采用，用自己想叫的。群里不渲染称呼。
   */
  callName?: string
  /** 你填的称呼建议（它可以选择不用） */
  callNameSuggested?: string
}

/** 关系只允许这几档，别让模型或前端随手写别的 */
export const PERSON_ROLES = ['主人', '朋友', '同事', '网友', '陌生人'] as const

export function isPersonRole(v: unknown): v is (typeof PERSON_ROLES)[number] {
  return typeof v === 'string' && (PERSON_ROLES as readonly string[]).includes(v)
}

let ROOT = 'persona/people'

/** 测试用 */
export function setPeopleRoot(p: string): void {
  ROOT = p
  // 换根之后缓存里的 PersonMeta 属于上一个目录，必须一起丢掉，
  // 否则测试之间、dev 与正式数据之间会互相串人。
  cache.clear()
}

export function peopleRoot(): string {
  return ROOT
}

/** 合法的 personId：平台-账号，只允许字母数字下划线横线 */
const ID_RE = /^[a-z]{2,12}-[A-Za-z0-9_-]{1,40}$/

export function isValidPersonId(id: string): boolean {
  // 从 JSON / HTTP 里来的值不一定是字符串，先挡掉再交给正则
  if (typeof id !== 'string') return false
  return ID_RE.test(id) && !id.includes('..')
}

/** 平台账号 → personId。第一版用第一个账号命名，之后绑定的账号都指向它。 */
export function personIdOf(platform: Platform, accountId: string): string {
  // 账号里出现路径分隔符或 .. 一律视为非法，直接替换掉，绝不让它拼进路径。
  // 空账号替换完会变成空串，那样拼出来是 "qq-"，过不了 isValidPersonId；
  // 用 "_" 占位，保证这个函数的返回值永远能拿去拼路径。
  const safe = String(accountId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
  // platform 正常只可能是 qq / wechat；万一运行时传坏值，别生成非法 id
  const plat = /^[a-z]{2,12}$/.test(String(platform)) ? String(platform) : 'qq'
  return `${plat}-${safe}`
}

export function personDir(id: string): string {
  if (!isValidPersonId(id)) throw new Error(`非法的 personId：${id}`)
  return join(ROOT, id)
}

function metaFile(id: string): string {
  return join(personDir(id), 'meta.json')
}

function isAccount(v: unknown): v is Account {
  if (!v || typeof v !== 'object') return false
  const a = v as { platform?: unknown; id?: unknown }
  return (a.platform === 'qq' || a.platform === 'wechat') && typeof a.id === 'string' && a.id.length > 0
}

/**
 * 容忍手工改过的 meta.json：缺字段补默认值、坏账号丢掉，
 * 但别因为一个字段写错就让整个人从 listPeople 里消失。
 */
function normalizeMeta(id: string, raw: unknown): PersonMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Partial<PersonMeta>
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name : id,
    accounts: Array.isArray(r.accounts) ? r.accounts.filter(isAccount) : [],
    firstSeen: typeof r.firstSeen === 'number' && Number.isFinite(r.firstSeen) ? r.firstSeen : 0,
    // 这几个是用户/它自己设的，原样读回来；类型不对就当没写过，别把整份档案判坏。
    ...(typeof r.role === 'string' ? { role: r.role } : {}),
    ...(typeof r.nameLocked === 'boolean' ? { nameLocked: r.nameLocked } : {}),
    // callName / callNameSuggested 之前漏在这里 —— 结果 reflect 写进 meta.json 的
    // 称呼每次 loadPerson 都被丢掉，"它给每个人起称呼"整条链路等于没生效。
    ...(typeof r.callName === 'string' && r.callName.trim() ? { callName: r.callName } : {}),
    ...(typeof r.callNameSuggested === 'string' && r.callNameSuggested.trim()
      ? { callNameSuggested: r.callNameSuggested }
      : {}),
  }
}

export function loadPerson(id: string): PersonMeta | null {
  // 先校验 id 再拼路径：personDir 对非法 id 会抛错，
  // 以前是先 metaFile→personDir 再 existsSync，一个脏目录就能让 listPeople 整条崩掉。
  if (!isValidPersonId(id)) return null
  let f: string
  try {
    f = metaFile(id)
  } catch {
    return null
  }
  if (!existsSync(f)) return null
  try {
    return normalizeMeta(id, JSON.parse(readFileSync(f, 'utf8')) as unknown)
  } catch {
    return null
  }
}

export function savePerson(meta: PersonMeta): void {
  mkdirSync(personDir(meta.id), { recursive: true })
  writeAtomic(metaFile(meta.id), `${JSON.stringify(meta, null, 2)}\n`)
  // 缓存里可能还挂着旧对象：savePerson 之后如果不换掉，下一次 ensurePerson /
  // syncPersonName 会拿旧对象写盘，把刚存的 role / nameLocked 又抹掉。
  for (const [key, cached] of cache) {
    if (cached.id === meta.id) cache.set(key, meta)
  }
}

/** 账号 → 人 的内存缓存，避免每条消息都扫目录 */
const cache = new Map<string, PersonMeta>()

export function clearPersonCache(): void {
  cache.clear()
}

/** 把账号补进人物的账号列表；已经有就返回 false */
function bindAccount(meta: PersonMeta, platform: Platform, accountId: string): boolean {
  if (meta.accounts.some((a) => a.platform === platform && a.id === accountId)) return false
  meta.accounts.push({ platform, id: accountId })
  return true
}

/** 找到或创建一个人。同一个账号再来就是同一个人。 */
export function ensurePerson(platform: Platform, accountId: string, name?: string): PersonMeta {
  const key = `${platform}:${accountId}`
  const display = name?.trim() || ''
  const hit = cache.get(key)
  if (hit) {
    let dirty = bindAccount(hit, platform, accountId)
    // 用户锁了名字就不自动改，账号该补还得补
    if (display && !hit.nameLocked && display !== hit.name) {
      hit.name = display
      dirty = true
    }
    if (dirty) savePerson(hit)
    return hit
  }

  const id = personIdOf(platform, accountId)

  // 先看有没有别的目录已经绑定了这个账号（微信/QQ 双入口的情况）
  for (const p of listPeople()) {
    if (p.accounts.some((a) => a.platform === platform && a.id === accountId)) {
      if (display && !p.nameLocked && display !== p.name) {
        p.name = display
        savePerson(p)
      }
      cache.set(key, p)
      return p
    }
  }

  const existing = loadPerson(id)
  if (existing) {
    // 目录名对得上，但 accounts 里可能还没有这个账号（手改过 meta、老数据迁移），
    // 必须补上，否则重启后 findPersonByAccount 又找不到它。
    let dirty = bindAccount(existing, platform, accountId)
    if (display && !existing.nameLocked && display !== existing.name) {
      existing.name = display
      dirty = true
    }
    if (dirty) savePerson(existing)
    cache.set(key, existing)
    return existing
  }

  const meta: PersonMeta = {
    id,
    // 空字符串也要回落到账号 / id，否则会留下没有名字的人
    name: name?.trim() || accountId || id,
    accounts: [{ platform, id: accountId }],
    firstSeen: Date.now(),
  }
  savePerson(meta)
  cache.set(key, meta)
  return meta
}

export function listPeople(): PersonMeta[] {
  if (!existsSync(ROOT)) return []
  const out: PersonMeta[] = []
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (!isValidPersonId(e.name)) continue
    const meta = loadPerson(e.name)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => a.firstSeen - b.firstSeen)
}

/** 按平台账号找人；找不到返回 null */
export function findPersonByAccount(platform: Platform, accountId: string): PersonMeta | null {
  const cached = cache.get(`${platform}:${accountId}`)
  if (cached) return cached
  for (const p of listPeople()) {
    if (p.accounts.some((a) => a.platform === platform && a.id === accountId)) {
      cache.set(`${platform}:${accountId}`, p)
      return p
    }
  }
  return null
}

/** 这个人的主账号，用于私聊场景（优先 QQ，没有就用第一个） */
export function primaryAccount(personId: string): string {
  const meta = loadPerson(personId)
  if (meta?.accounts.length) {
    const qq = meta.accounts.find((a) => a.platform === 'qq')
    return (qq ?? meta.accounts[0]!).id
  }
  // 没有 meta（异常情况）才退回从 personId 推。
  // personId 的格式是 "平台-账号"，任何平台都要把前缀剥掉，不能只认 qq-。
  const dash = personId.indexOf('-')
  return dash >= 0 ? personId.slice(dash + 1) : personId
}

/** 这个人的全部账号 id（并集，去重） */
export function accountIdsOf(personId: string): string[] {
  const meta = loadPerson(personId)
  const ids = (meta?.accounts ?? []).map((a) => a.id).filter((x) => x.length > 0)
  if (ids.length) return [...new Set(ids)]
  const fallback = primaryAccount(personId)
  return fallback ? [fallback] : []
}

/**
 * 账号 → 人的唯一正确入口。
 * 先查这个账号是否已绑到某人（微信和 QQ 是一个人时不能各算一份），查不到才新建。
 * 任何"从账号推人"的地方都必须走这里，不能直接调 personIdOf。
 */
export function personOfAccount(platform: Platform, accountId: string): string {
  const known = findPersonByAccount(platform, accountId)
  return known ? known.id : personIdOf(platform, accountId)
}


/**
 * 按群名单里看到的名字对齐档案。
 *
 * 和 ensurePerson 的区别：这个不要求"这个人正在说话"，
 * 拉群名单时顺手调一遍就能把旧昵称改掉。
 *
 * **没有档案的会建一个**——只是 meta.json（名字+账号），
 * 不会有 facts/episodes 那些。这样"群里有谁"能对上号，
 * 等真聊过再往上长。
 */
export function syncPersonName(platform: Platform, accountId: string, name: string): boolean {
  const display = name.trim()
  if (!display) return false
  if (!accountId.trim()) return false

  const key = `${platform}:${accountId}`
  const hit =
    cache.get(key) ?? listPeople().find((p) => p.accounts.some((a) => a.platform === platform && a.id === accountId))

  // 没档案就不建：名单里的人不等于认识的人。
  // 真聊过之后 ensurePerson 会建档。
  if (!hit) return false
  // 用户锁定名字后，群名单只用来对号，不再覆盖显示名。
  if (hit.nameLocked) return false

  if (hit.name === display) return false
  hit.name = display
  savePerson(hit)
  cache.set(key, hit)
  return true
}

/**
 * 按账号 ID 找显示名（跨平台匹配）。
 *
 * 用途：raw 里只存 senderId（精确），但渲染给模型看时要能对上人——
 * 群里两个人对话后突然 @ 你，必须知道上一句是谁说的。
 *
 * 查不到就返回空串，调用方回落到「他」。
 * 原来 `memory/recall.ts` 和 `relation/evaluate.ts` 各抄了一份逐行相同的实现。
 */
export function displayNameOfAccount(accountId: string): string {
  try {
    for (const person of listPeople()) {
      if (person.accounts.some((a) => a.id === accountId)) return person.name?.trim() ?? ''
    }
  } catch {
    /* 查不到就算了 */
  }
  return ''
}
