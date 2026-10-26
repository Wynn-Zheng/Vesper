import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../llm/types.ts'
import type { Target } from '../core/types.ts'
import { writeAtomic } from '../store/fs.ts'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
  at: number
}

/**
 * 一个会话的完整状态。
 *
 * 以前这里只存 Turn[]，现在把摘要也挂在同一个对象上：
 * summary 是滚动摘要，summaryCursor 记录已经压进摘要的原文条数，
 * summaryUpdatedAt 是摘要最后一次更新时间。
 *
 * 允许额外的未知字段（索引签名），这样旧文件里将来多出来的字段
 * 在读 → 改 → 写的过程中不会被丢掉。
 */
export interface Session {
  /** 会话键，形如 private:123 / group:456 */
  key: string
  /** 最近的历史原文 */
  turns: Turn[]
  /** 滚动摘要，默认空串 */
  summary: string
  /** 摘要最后更新时间（毫秒），默认 0 */
  summaryUpdatedAt: number
  /** 已经被压缩进摘要的原文条数，默认 0 */
  summaryCursor: number
  [field: string]: unknown
}

/** 默认和 data/ 下其它运行时数据放一起 */
let ROOT = 'data/sessions'

/** 测试用：把 session 根目录指向临时目录 */
export function setSessionRoot(p: string): void {
  ROOT = p
}

export function sessionRoot(): string {
  return ROOT
}

/**
 * 一个会话一个 JSON 文件。
 * 键里有冒号（private:123），Windows 文件名不允许，所以用 encodeURIComponent。
 */
export function sessionPath(key: string): string {
  return join(ROOT, `${encodeURIComponent(key)}.json`)
}

const sessions = new Map<string, Session>()

const KNOWN_FIELDS = new Set(['key', 'turns', 'summary', 'summaryUpdatedAt', 'summaryCursor'])

function emptySession(key: string): Session {
  return {
    key,
    turns: [],
    summary: '',
    summaryUpdatedAt: 0,
    summaryCursor: 0,
  }
}

function isTurn(v: unknown): v is Turn {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    (t['role'] === 'user' || t['role'] === 'assistant') &&
    typeof t['content'] === 'string' &&
    typeof t['at'] === 'number' &&
    Number.isFinite(t['at'])
  )
}

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 把任意旧格式/坏数据收敛成合法 Session，缺字段补默认值 */
function normalizeSession(key: string, raw: Record<string, unknown>): Session {
  const session: Session = {
    key,
    turns: Array.isArray(raw['turns'])
      ? raw['turns'].filter(isTurn).map((t) => ({ role: t.role, content: t.content, at: t.at }))
      : [],
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : '',
    summaryUpdatedAt: finiteNumber(raw['summaryUpdatedAt'], 0),
    summaryCursor: finiteNumber(raw['summaryCursor'], 0),
  }

  // 旧文件里的其它字段原样保留，写回时不丢
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(k)) session[k] = v
  }
  return session
}

/**
 * 从磁盘读一个会话。
 * 文件不存在、JSON 坏掉、字段缺失都不抛错，返回带默认值的会话。
 */
export function loadSession(key: string): Session {
  const file = sessionPath(key)
  let raw: unknown
  try {
    if (!existsSync(file)) return emptySession(key)
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptySession(key)
  }

  let session: Session
  if (Array.isArray(raw)) {
    // 更老的格式可能直接存了一个 turns 数组
    session = normalizeSession(key, { turns: raw })
  } else if (typeof raw === 'object' && raw !== null) {
    session = normalizeSession(key, raw as Record<string, unknown>)
  } else {
    return emptySession(key)
  }

  sessions.set(key, session)
  return session
}

/**
 * 原子写回会话。
 * 已知字段固定顺序，未知字段按原来的顺序追加在后面，
 * 所以同一份数据反复读写不会改变字段顺序。
 */
export function saveSession(session: Session): void {
  const ordered: Record<string, unknown> = {
    key: session.key,
    turns: session.turns,
    summary: session.summary,
    summaryUpdatedAt: session.summaryUpdatedAt,
    summaryCursor: session.summaryCursor,
  }
  for (const [k, v] of Object.entries(session)) {
    if (!(k in ordered)) ordered[k] = v
  }

  writeAtomic(sessionPath(session.key), `${JSON.stringify(ordered, null, 2)}\n`)
  sessions.set(session.key, session)
}

/** 取内存里的会话；没有就从磁盘加载（不存在则得到空会话） */
export function getSession(key: string): Session {
  const existing = sessions.get(key)
  if (existing) return existing
  return loadSession(key)
}

export function getSummary(session: Session): { summary: string; summaryCursor: number } {
  return { summary: session.summary, summaryCursor: session.summaryCursor }
}

/** 更新摘要并立即写回磁盘 */
export function setSummary(session: Session, summary: string, compressedCount: number): void {
  session.summary = summary
  session.summaryUpdatedAt = Date.now()
  session.summaryCursor = Number.isFinite(compressedCount) ? Math.max(0, Math.trunc(compressedCount)) : 0
  saveSession(session)
}

/** 每个对话对象（私聊某人 / 某个群）一个键 */
export function sessionKey(t: Target): string {
  return `${t.kind}:${t.id}`
}

export function getTurns(key: string): Turn[] {
  return sessions.get(key)?.turns ?? []
}

export function pushTurn(key: string, turn: Turn): void {
  let session = sessions.get(key)
  if (!session) {
    // 这里不主动读盘：历史原文原本就是内存态，摘要的持久化由 loadSession 负责
    session = emptySession(key)
    sessions.set(key, session)
  }
  session.turns.push(turn)
  // 只保留最近 N 轮，防止上下文无限增长
  const MAX = 40
  while (session.turns.length > MAX) session.turns.shift()
}

export function clearSessions(): void {
  sessions.clear()
}

/** 清理长时间没说话的会话，防止 Map 无限增长 */
export function pruneSessions(maxKeys = 200, ttlMs = 2 * 3_600_000): number {
  const now = Date.now()
  let removed = 0
  for (const [k, session] of sessions) {
    const lastAt = session.turns[session.turns.length - 1]?.at ?? 0
    if (!lastAt || now - lastAt > ttlMs) {
      sessions.delete(k)
      removed++
    }
  }
  // 还超上限就删最久没动的
  while (sessions.size > maxKeys) {
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [k, session] of sessions) {
      const at = session.turns[session.turns.length - 1]?.at ?? 0
      if (at < oldestAt) {
        oldestAt = at
        oldestKey = k
      }
    }
    if (!oldestKey) break
    sessions.delete(oldestKey)
    removed++
  }
  return removed
}

export function sessionCount(): number {
  return sessions.size
}

/**
 * 把历史轮次转成模型消息：从最近往前装，单条超预算就跳过它，
 * 但继续看更早的（它们可能更短），绝不把一条消息截成半条。
 *
 * 这里只返回历史原文；滚动摘要由 buildPrompt 单独作为【前情摘要】注入，
 * 所以 summary 设置与否都不会改变原文的条数和顺序。
 */
export function historyMessages(key: string, maxChars = 6000): ChatMessage[] {
  const turns = getTurns(key)
  const out: ChatMessage[] = []
  let budget = maxChars
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    // 单条太长：跳过它本身，不能截断，也不能连累更早的短消息
    if (t.content.length > budget) continue
    budget -= t.content.length
    out.unshift({ role: t.role, content: t.content })
  }
  return out
}
