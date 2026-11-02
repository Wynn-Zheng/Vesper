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
  /**
   * 群里的「旁听」记录：没叫它、它也没回的那些话。
   *
   * 为什么要单独存、不塞进 turns：
   *   turns 是"对话"（一问一答），旁听是"背景"。混在一起模型会以为自己
   *   参与了那些对话，甚至在没人问它时接着答。
   *   但完全不存又不行 —— 它就成了"只在被叫的那一瞬间才存在"，
   *   接不上群里刚才在聊什么（用户反馈的"没联系上下文"）。
   */
  heard?: Turn[]
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

const KNOWN_FIELDS = new Set(['key', 'turns', 'heard', 'summary', 'summaryUpdatedAt', 'summaryCursor'])

function emptySession(key: string): Session {
  return {
    key,
    turns: [],
    heard: [],
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
    heard: Array.isArray(raw['heard'])
      ? raw['heard'].filter(isTurn).map((t) => ({ role: t.role, content: t.content, at: t.at }))
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
    heard: session.heard ?? [],
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

export function pushTurn(key: string, turn: Turn, maxTurns = 60): void {
  let session = sessions.get(key)
  if (!session) {
    // 内存里没有就先读盘：进程重启后 history 不该是空的。
    // 以前这里直接 emptySession，于是重启后连"上一句说了什么"都不知道，
    // 用户看到的就是"刚聊过的事它全忘了"。
    session = loadSession(key)
  }
  session.turns.push(turn)
  // 只保留最近 N 轮，防止上下文无限增长。
  //
  // ⚠️ 这个上限必须**大于**上下文压缩的摘要阈值（默认 40），
  // 否则 shouldCompress（history.length > 阈值）永远不成立：
  // 历史被窗口直接丢掉，滚动摘要一次都不会更新，等于把老对话静默删除。
  // 留一倍余量：压缩是先看完整历史再裁，这里提前裁到阈值以下的话，
  // 每次压缩周期都会先丢掉一轮、永远进不了摘要。
  const keep = Number.isFinite(maxTurns) ? Math.max(4, Math.floor(maxTurns) * 2) : 120
  while (session.turns.length > keep) session.turns.shift()

  // 落盘：以前只存在内存里，进程一重启历史就没了。
  // 文件很小（几十条短消息），同步写一次比"重启后失忆"值得。
  try {
    saveSession(session)
  } catch {
    /* 写不进去不影响这一轮，内存里还在 */
  }
}

export function clearSessions(): void {
  sessions.clear()
}

/**
 * 记一条「旁听」：群里别人说的话，没叫它、它也没回。
 *
 * 只保留最近 max 条。为什么不无限留：
 * 旁听是背景信息，越老越没用；而且群聊消息量远大于对话，不设上限会把
 * prompt 撑爆。
 *
 * 除条数外还要有时间窗：安静群里上午那三句话，晚上不该还被当成"刚才在聊"。
 */
export function pushHeard(key: string, turn: Turn, max = 12, maxAgeMs = 2 * 3_600_000): void {
  let session = sessions.get(key)
  if (!session) session = loadSession(key)
  const heard = session.heard ?? (session.heard = [])
  heard.push(turn)

  // 按时间排序再裁剪，不能按"插入位置"裁。
  //
  // 旁听有两条写入路径：观察模式在收到消息时**立刻**写，
  // 而合批之后"决定不说话"的出口是在处理完才写（用的还是批次的 at）。
  // 于是一条早几秒的消息可能后写进来 —— 按位置 shift() 砍掉的是队头，
  // 也就是**最新那条**，正好砍反了。
  heard.sort((a, b) => a.at - b.at)

  const keep = Math.max(1, Math.floor(max))
  while (heard.length > keep) heard.shift()

  // 一个人把 12 条刷满：群里有人连发十几条，旁听就只剩他一个人说的话，
  // 它再被问"刚才聊啥"只能复述那个人。按人限个额：
  // 每条旁听的格式是「名字：内容」，前缀就是发言人。
  // 超额的从**这个人最早的那条**开始删，别删别人的。
  const quota = Math.max(2, Math.floor(keep / 3))
  const senderOf = (t: Turn): string => {
    const i = t.content.indexOf('：')
    return i > 0 ? t.content.slice(0, i) : ''
  }
  const counts = new Map<string, number>()
  for (const t of heard) {
    const s = senderOf(t)
    // 没有「名字：」前缀的（老数据 / 私聊）不参与按人限额
    if (!s) continue
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  for (const [sender, n] of counts) {
    if (n <= quota) continue
    let over = n - quota
    for (let i = 0; i < heard.length && over > 0; i++) {
      if (senderOf(heard[i]!) !== sender) continue
      heard.splice(i, 1)
      i--
      over--
    }
  }
  // 顺手清掉过期的。用**当前时间**做锚，不是用最后一条的时间 ——
  // 那个锚等于"永远认为最新那条是现在"，隔天的记录永远清不掉。
  const now = Date.now()
  while (heard.length && now - (heard[0]?.at ?? now) > maxAgeMs) heard.shift()
  try {
    saveSession(session)
  } catch {
    /* 写不进去不影响这一轮 */
  }
}

/**
 * 撤掉最后一条「它说过的话」。
 *
 * 用在"回复生成了但最终没发出去"的时候（群限速、发送全失败）。
 * 不撤的话，历史里留着一条用户从没看到的话，下一轮它以为自己说过 ——
 * 会接着自己的话说，或者理直气壮地引用一句对方根本没看见的内容。
 */
export function popLastAssistant(key: string): boolean {
  const session = sessions.get(key)
  if (!session || !session.turns.length) return false
  const last = session.turns[session.turns.length - 1]
  if (!last || last.role !== 'assistant') return false
  session.turns.pop()
  try {
    saveSession(session)
  } catch {
    /* 写不进去也不影响内存里的正确性 */
  }
  return true
}

/** 取最近旁听到的几句话（老的在前，已按时间窗过滤） */
export function getHeard(key: string, maxAgeMs = 2 * 3_600_000): Turn[] {
  const heard = sessions.get(key)?.heard
  if (!heard?.length) return []
  const now = Date.now()
  return heard.filter((t) => now - t.at <= maxAgeMs)
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
