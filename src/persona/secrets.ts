/**
 * 秘密。
 *
 * 它想干什么、藏了什么，默认看不见。用户点「强行查看」之后：
 *   1. 标记 seenAt（页面上变成已看）
 *   2. 记一条经历（它会记住"你偷看了我的秘密"）
 *   3. 心情变差（被冒犯）
 *
 * 所以"看"是有代价的 —— 这是这个功能的设计意图，不是 bug。
 */
import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../store/fs.ts'

const FILE = 'persona/secrets.json'

export interface Secret {
  id: string
  text: string
  /** 写下的时间戳 */
  at: number
  /** 被偷看的时间戳（没有 = 还没被发现） */
  seenAt?: number
}

export function loadSecrets(): Secret[] {
  try {
    if (!existsSync(FILE)) return []
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string') as Secret[]
  } catch {
    return []
  }
}

function saveAll(list: Secret[]): void {
  writeAtomic(FILE, JSON.stringify(list, null, 2))
}

export function addSecret(text: string): Secret {
  const list = loadSecrets()
  const s: Secret = { id: 's' + Date.now().toString(36), text, at: Date.now() }
  list.push(s)
  saveAll(list)
  return s
}

/** 标记一条被看过，返回这条秘密（找不到返回 null） */
export function peekSecret(id: string): Secret | null {
  const list = loadSecrets()
  const s = list.find((x) => x.id === id)
  if (!s) return null
  if (!s.seenAt) {
    s.seenAt = Date.now()
    saveAll(list)
  }
  return s
}
