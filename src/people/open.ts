import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { personDir } from './store.ts'
import { writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'

export interface OpenItem {
  text: string
  date: string
  /** todo = 还没做的事；pending = 拿不准、想问他的事 */
  kind: 'todo' | 'pending'
}

function openFile(personId: string): string {
  return join(personDir(personId), 'open.md')
}

export function loadOpen(personId: string): OpenItem[] {
  const f = openFile(personId)
  if (!existsSync(f)) return []
  const out: OpenItem[] = []
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^-\s+\[(todo|pending)\]\s+(.+?)（(\d{4}-\d{2}-\d{2})）\s*$/.exec(line.trim())
    if (m) out.push({ kind: m[1] as OpenItem['kind'], text: m[2]!, date: m[3]! })
  }
  return out
}

export function appendOpen(personId: string, items: OpenItem[]): void {
  if (!items.length) return
  // 读-改-写排队，避免并发覆盖
  serialized(`open:${personId}`, () => {
    const f = openFile(personId)
    const existing = existsSync(f) ? readFileSync(f, 'utf8') : '# 还没做完 / 想问他的事\n\n'
    // 全角括号会破坏行格式，统一成半角
    const lines = items
      .map((i) => `- [${i.kind}] ${i.text.replace(/（/g, '(').replace(/）/g, ')').replace(/\r?\n/g, ' ')}（${i.date}）`)
      .join('\n')
    writeAtomic(f, `${existing.trimEnd()}\n${lines}\n`)
  })
}

export function openFilePath(personId: string): string {
  return openFile(personId)
}

/** 删掉一条待办（已完成或不想问了） */
export function removeOpen(personId: string, text: string): boolean {
  const f = openFile(personId)
  if (!existsSync(f)) return false
  const items = loadOpen(personId)
  const next = items.filter((x) => x.text !== text)
  if (next.length === items.length) return false
  const head = '# 还没做完 / 想问他的事\n\n'
  writeAtomic(f, `${head}${next.map((i) => `- [${i.kind}] ${i.text}（${i.date}）`).join('\n')}\n`)
  return true
}

/** 改一条待办的内容 */
export function editOpen(personId: string, oldText: string, newText: string): boolean {
  const f = openFile(personId)
  if (!existsSync(f)) return false
  const items = loadOpen(personId)
  let changed = false
  const next = items.map((x) => {
    if (x.text !== oldText) return x
    changed = true
    return { ...x, text: newText.trim() || x.text }
  })
  if (!changed) return false
  const head = '# 还没做完 / 想问他的事\n\n'
  writeAtomic(f, `${head}${next.map((i) => `- [${i.kind}] ${i.text}（${i.date}）`).join('\n')}\n`)
  return true
}