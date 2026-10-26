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
}

export function peopleRoot(): string {
  return ROOT
}

/** 合法的 personId：平台-账号，只允许字母数字下划线横线 */
const ID_RE = /^[a-z]{2,12}-[A-Za-z0-9_-]{1,40}$/

export function isValidPersonId(id: string): boolean {
  return ID_RE.test(id) && !id.includes('..')
}

/** 平台账号 → personId。第一版用第一个账号命名，之后绑定的账号都指向它。 */
export function personIdOf(platform: Platform, accountId: string): string {
  // 账号里出现路径分隔符或 .. 一律视为非法，直接替换掉，绝不让它拼进路径
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `${platform}-${safe}`
}

export function personDir(id: string): string {
  if (!isValidPersonId(id)) throw new Error(`非法的 personId：${id}`)
  return join(ROOT, id)
}

function metaFile(id: string): string {
  return join(personDir(id), 'meta.json')
}

export function loadPerson(id: string): PersonMeta | null {
  const f = metaFile(id)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as PersonMeta
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

/** 找到或创建一个人。同一个账号再来就是同一个人。 */
export function ensurePerson(platform: Platform, accountId: string, name?: string): PersonMeta {
  const key = `${platform}:${accountId}`
  const display = name?.trim() || ''
  const hit = cache.get(key)
  if (hit) {
    if (display && display !== hit.name) {
      hit.name = display
      savePerson(hit)
    }
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
    if (display && display !== existing.name) {
      existing.name = display
      savePerson(existing)
    }
    cache.set(key, existing)
    return existing
  }

  const meta: PersonMeta = {
    id,
    // 空字符串也要回落到账号，否则会留下没有名字的人
    name: name?.trim() || accountId,
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
  // 没有 meta（异常情况）才退回从 personId 推
  return personId.startsWith('qq-') ? personId.slice(3) : personId
}

/** 这个人的全部账号 id */
export function accountIdsOf(personId: string): string[] {
  const meta = loadPerson(personId)
  if (meta?.accounts.length) return meta.accounts.map((a) => a.id)
  return [primaryAccount(personId)]
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
