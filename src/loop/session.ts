import type { ChatMessage } from '../llm/types.ts'
import type { Target } from '../core/types.ts'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
  at: number
}

const sessions = new Map<string, Turn[]>()

/** 每个对话对象（私聊某人 / 某个群）一个键 */
export function sessionKey(t: Target): string {
  return `${t.kind}:${t.id}`
}

export function getTurns(key: string): Turn[] {
  return sessions.get(key) ?? []
}

export function pushTurn(key: string, turn: Turn): void {
  const list = sessions.get(key) ?? []
  list.push(turn)
  // 只保留最近 N 轮，防止上下文无限增长
  const MAX = 40
  while (list.length > MAX) list.shift()
  sessions.set(key, list)
}

export function clearSessions(): void {
  sessions.clear()
}

/** 清理长时间没说话的会话，防止 Map 无限增长 */
export function pruneSessions(maxKeys = 200, ttlMs = 2 * 3_600_000): number {
  const now = Date.now()
  let removed = 0
  for (const [k, list] of sessions) {
    const lastAt = list[list.length - 1]?.at ?? 0
    if (!lastAt || now - lastAt > ttlMs) {
      sessions.delete(k)
      removed++
    }
  }
  // 还超上限就删最久没动的
  while (sessions.size > maxKeys) {
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [k, list] of sessions) {
      const at = list[list.length - 1]?.at ?? 0
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

/** 把历史轮次转成模型消息（跳过过长的，避免爆上下文） */
export function historyMessages(key: string, maxChars = 6000): ChatMessage[] {
  const turns = getTurns(key)
  const out: ChatMessage[] = []
  let budget = maxChars
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.content.length > budget) break
    budget -= t.content.length
    out.unshift({ role: t.role, content: t.content })
  }
  return out
}
