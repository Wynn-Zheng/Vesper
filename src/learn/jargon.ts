import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'
import { info } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { RawTurn } from '../memory/types.ts'
import { writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'
import { cardScopedPath } from '../persona/card.ts'

/**
 * 学这个群里的"黑话"：只有这里的人才懂的词和梗。
 *
 * 关键是别把普通词当黑话。判断方法借自 MaiBot：
 *   ① 结合上下文猜一次意思
 *   ② 假装没有上下文，单看这个词再猜一次
 *   ③ 两次猜的差不多 → 不依赖上下文，不是黑话，丢掉
 *      差很多 → 只有这个群才懂，是真黑话
 */

export interface Jargon {
  word: string
  meaning: string
  /** 在原句里是怎么用的 */
  evidence: string
  count: number
  date: string
}

// 黑话是按角色走的：换卡就是换人。
const FILE_LEGACY = 'persona/jargon.yaml'
function FILE(): string {
  return cardScopedPath('jargon.yaml', FILE_LEGACY)
}

interface Store {
  [groupId: string]: Jargon[]
}

const SYSTEM = `你在分析一段群聊，找出其中"只有这个群才懂的词或梗"。

对每个候选词，按这个顺序判断：
1. 先结合上下文，猜它在这个群里是什么意思
2. 再假装没有上下文，单独看这个词本身，猜它通常是什么意思
3. 对比两次结果：
   - 两次猜的差不多 → 它不依赖上下文，是普通词 → **丢掉**
   - 两次差很多 → 它靠这个群的语境才能懂 → **是真黑话，留下**

只输出 JSON 数组，不要解释：
[{"词": "原样的写法", "意思": "在这个群里的意思", "依据": "它在原句里怎么用的"}]

如果拿不准或者没有，就返回 []。不要凑数。`

function parse(text: string): Array<{ 词?: string; 意思?: string; 依据?: string }> {
  const m = /\[[\s\S]*\]/.exec(text)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    return Array.isArray(arr) ? (arr as Array<{ 词?: string; 意思?: string; 依据?: string }>) : []
  } catch {
    return []
  }
}

export function loadJargon(groupId: string): Jargon[] {
  if (!existsSync(FILE())) return []
  try {
    const store = YAML.parse(readFileSync(FILE(), 'utf8')) as Store | null
    return store?.[groupId] ?? []
  } catch {
    return []
  }
}

function loadAll(): Store {
  if (!existsSync(FILE())) return {}
  try {
    return (YAML.parse(readFileSync(FILE(), 'utf8')) as Store | null) ?? {}
  } catch {
    return {}
  }
}

export function saveJargon(groupId: string, items: Jargon[]): void {
  const store = loadAll()
  store[groupId] = items.slice(-80)
  writeAtomic(FILE(), `${YAML.stringify(store)}\n`)
}

/** 从一段群聊里学新词，和已有的合并 */
export async function learnJargon(turns: RawTurn[], llm: LlmOptions, groupId: string): Promise<number> {
  const text = turns
    .filter((t) => t.role === 'user')
    .map((t) => t.text)
    .join('\n')
  if (text.length < 30) return 0

  const existing = loadJargon(groupId)
  const known = new Set(existing.map((j) => j.word))
  const material = existing.length
    ? `已经认识的词（不用再记）：${existing.map((j) => j.word).join('、')}\n\n本段聊天：\n${text}`
    : `本段聊天：\n${text}`

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 600, temperature: 0.3 },
    )

    const today = new Date().toISOString().slice(0, 10)
    let added = 0
    // 与 expression 同样的问题：全是重复命中时 added 为 0，
    // count 涨在内存里却没落盘，下次读回来还是旧次数。
    let counted = 0
    for (const item of parse(res.text)) {
      const word = (item.词 ?? '').trim()
      const meaning = (item.意思 ?? '').trim()
      if (!word || !meaning || word.length > 12) continue
      if (known.has(word)) {
        const old = existing.find((j) => j.word === word)!
        old.count += 1
        counted++
        continue
      }
      existing.push({ word, meaning, evidence: (item.依据 ?? '').trim().slice(0, 60), count: 1, date: today })
      known.add(word)
      added++
    }

    if (added || counted) {
      // saveJargon 是"读出整份 store → 改本群 → 整体写回"，
      // 两个群同时学的时候后写的会把先写的那群整段吃掉。按 key 串行。
      serialized('jargon', () => saveJargon(groupId, existing))
      if (added) info(`学到 ${added} 个群内黑话`, { 群: groupId })
    }
    return added
  } catch {
    return 0
  }
}

/** 这段话里有没有我认识的词；有就返回它们的含义 */
export function explainJargon(text: string, groupId: string): Jargon[] {
  const list = loadJargon(groupId)
  if (!list.length) return []
  return list.filter((j) => text.includes(j.word))
}

/** 拼成给模型看的一小段 */
export function renderJargon(items: Jargon[]): string {
  if (!items.length) return ''
  return ['这个群里几个人在用的词：', ...items.map((j) => `- 「${j.word}」= ${j.meaning}`)].join('\n')
}

