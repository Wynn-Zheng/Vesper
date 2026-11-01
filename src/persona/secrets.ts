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
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { cardScopedPath } from './card.ts'
import { writeAtomic } from '../store/fs.ts'

// 秘密按角色卡隔离
const LEGACY = 'persona/secrets.json'
function FILE(): string {
  return cardScopedPath('secrets.json', LEGACY)
}

export interface Secret {
  id: string
  text: string
  /** 写下的时间戳 */
  at: number
  /** 被偷看的时间戳（没有 = 还没被发现） */
  seenAt?: number
}

export function loadSecrets(): Secret[] {
  if (!existsSync(FILE())) return []
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8'))
    if (!Array.isArray(raw)) throw new Error('不是数组')
    return raw.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string') as Secret[]
  } catch {
    // 文件坏了：先留一份后缀备份再当空，避免下次写入把原数据彻底覆盖
    try {
      copyFileSync(FILE(), FILE + '.bad-' + Date.now())
    } catch {
      /* 备份不了就算了 */
    }
    return []
  }
}

function saveAll(list: Secret[]): void {
  writeAtomic(FILE(), JSON.stringify(list, null, 2))
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
