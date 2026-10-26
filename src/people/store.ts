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
  }
}

export function loadPerson(id: string): PersonMeta | null {
  const f = metaFile(id)
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
    if (display && display !== hit.name) {
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
      if (display && display !== p.name) {
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
    if (display && display !== existing.name) {
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

/** 某个 scope 属于谁；群聊返回 null */
export function personOfScope(scope: string): string | null {
  if (!scope.startsWith('private:')) return null
  const account = scope.slice('private:'.length)
  for (const p of listPeople()) {
    if (p.accounts.some((a) => a.id === account)) return p.id
  }
  return personIdOf('qq', account)
}
