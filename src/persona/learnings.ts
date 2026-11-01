/**
 * 学习记录：它看到/学到的东西。
 *
 * 来源两类：
 *   1. 自己看到觉得有用（source = 'itself'，以后由模型写）
 *   2. 用户说"你去学一下 xxx"（source = 'user'）
 *
 * 和「学到的说话方式」(plays) 的区别：plays 是从"回得好的对话"里统计出来的话术；
 * learnings 是它主动记下的知识/道理/方法，更接近笔记。
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { cardScopedPath } from './card.ts'
import { writeAtomic } from '../store/fs.ts'
import { similarity } from '../core/text.ts'

// 学到的内容按角色卡隔离
const LEGACY = 'persona/learnings.json'
function FILE(): string {
  return cardScopedPath('learnings.json', LEGACY)
}

export const KINDS = ['说话方式', '道理', '知识', '用户指派'] as const
export type LearningKind = (typeof KINDS)[number]

export interface Learning {
  id: string
  /** 学到了什么（一句话或一段） */
  text: string
  kind: LearningKind
  /** itself = 自己看到的；user = 用户让它学的 */
  source: 'itself' | 'user'
  at: number
  /** 已经消化进自己的认知了没有 */
  digested?: boolean
}

export function loadLearnings(): Learning[] {
  if (!existsSync(FILE())) return []
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8'))
    if (!Array.isArray(raw)) throw new Error('不是数组')
    return raw.filter((x) => x && typeof x.text === 'string') as Learning[]
  } catch {
    try {
      copyFileSync(FILE(), FILE + '.bad-' + Date.now())
    } catch {
      /* 备份不了就算了 */
    }
    return []
  }
}

function saveAll(list: Learning[]): void {
  writeAtomic(FILE(), JSON.stringify(list, null, 2))
}

export function addLearning(text: string, kind: LearningKind, source: 'itself' | 'user'): Learning | null {
  const list = loadLearnings()
  const t = text.trim()
  // 去重：反思每 12 小时跑一次，同一条道理会被反复"学到"
  //
  // 用相似度而不是双向 includes：后者会让短词吞掉长句——
  // 「知识」已存在时，「知识就是力量」会被判成重复而永远学不进来
  // （两者 similarity 只有 0.20）。0.9 是很严的门槛，只挡真正重复的。
  const dup = list.find((x) => x.text === t || similarity(x.text, t) > 0.9)
  if (dup) return null
  const item: Learning = {
    id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim().slice(0, 500),
    kind: KINDS.includes(kind) ? kind : '知识',
    source,
    at: Date.now(),
  }
  list.push(item)
  saveAll(list)
  return item
}

export function dropLearning(id: string): boolean {
  const list = loadLearnings()
  const next = list.filter((x) => x.id !== id)
  if (next.length === list.length) return false
  saveAll(next)
  return true
}
