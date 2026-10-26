/** 记忆条目的公共结构。scope 决定"谁能看见"。 */
import type { PersonFact } from './facts.ts'
import type { OpenItem } from '../people/open.ts'

export type Scope = `private:${string}` | `group:${string}` | 'shared'

export interface RawTurn {
  ts: number
  scope: Scope
  role: 'user' | 'assistant'
  text: string
  /** 群聊时是谁说的（QQ 号），私聊可省 */
  senderId?: string
}

export interface Episode {
  /** 文件名里的标识，如 2026-10-24-01 */
  id: string
  date: string
  scope: Scope
  /** 这件事有多重，1-10，检索时参与加权 */
  importance: number
  /** 当时的主要情绪，没有就空 */
  emotion?: string
  /** 一句话概括 */
  title: string
  /** 正文：发生了什么 + 我当时的想法 */
  body: string
  /** 上次被想起来的时间戳；没想起来过就是 0 */
  lastRecalled?: number
}

export interface Insight {
  id: string
  date: string
  scope: Scope
  text: string
  /** 支撑这条洞察的事件，便于回查 */
  evidence: string[]
}

export interface Recalled {
  facts: PersonFact[]
  episodes: Episode[]
  insights: Insight[]
  /** 还没问完 / 答应过的事 */
  open: OpenItem[]
  /** 最近原文，通常只取很少几条 */
  recent: RawTurn[]
}
