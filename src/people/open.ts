import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { similarity } from '../core/text.ts'
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

/**
 * 一行 → 一条待办。认不出就返回 null，不让一行脏数据废掉整个文件。
 * 手工编辑常见的情况都兼容：BOM、行尾空格、半角括号、多余空行。
 */
function parseLine(raw: string): OpenItem | null {
  const line = raw.replace(/^\uFEFF/, '').trim()
  const m = /^-\s*\[([^\]]+)\]\s*(.+?)\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]\s*$/.exec(line)
  if (!m) return null
  const kind = m[1]!.trim().toLowerCase()
  if (kind !== 'todo' && kind !== 'pending') return null
  const text = m[2]!.trim()
  if (!text) return null
  return { text, kind, date: m[3]! }
}

/** 一条待办压成单行：换行和全角括号都会破坏行格式 */
function oneLine(text: string): string {
  return text
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .trim()
}

function formatItem(item: OpenItem): string {
  return `- [${item.kind}] ${oneLine(item.text)}（${item.date}）`
}

export function loadOpen(personId: string): OpenItem[] {
  const f = openFile(personId)
  if (!existsSync(f)) return []
  let raw: string
  try {
    raw = readFileSync(f, 'utf8')
  } catch {
    // 文件刚好被删 / 没权限：当作没有待办，别让读路径把页面炸掉
    return []
  }
  const out: OpenItem[] = []
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const item = parseLine(line)
    if (item) out.push(item)
  }
  return out
}

export function appendOpen(personId: string, items: OpenItem[]): void {
  // 空文本写成 "- [todo] （date）" 就再也解析不回来了，直接丢掉
  const valid = items.filter((i) => oneLine(i.text).length > 0)
  if (!valid.length) return
  // 读-改-写排队，避免并发覆盖
  serialized(`open:${personId}`, () => {
    const f = openFile(personId)
    const existingRaw = existsSync(f) ? readFileSync(f, 'utf8') : '# 还没做完 / 想问他的事\n\n'

    // 去重：整理时可能反复生成同一件事（尤其"想问问他能不能说"这类 pending），
    // 不去重的话 open.md 会一行行堆同样的句子，而 recall 只取最后 5 条。
    // 相似度阈值定 0.9：只吞"几乎是同一句"的，不同的待办不会被误并。
    const existing = loadOpen(personId).map((x) => x.text)
    const fresh = valid.filter(
      (i) => !existing.some((t) => t === i.text || similarity(t, i.text) > 0.9),
    )
    if (!fresh.length) return

    const lines = fresh.map(formatItem).join('\n')
    const head = existingRaw.trimEnd()
    writeAtomic(f, `${head ? `${head}\n` : ''}${lines}\n`)
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
  writeAtomic(f, `${head}${next.map(formatItem).join('\n')}\n`)
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
    // 新文本也要压成单行，否则换行/全角括号会把这条待办写坏
    return { ...x, text: oneLine(newText) || x.text }
  })
  if (!changed) return false
  const head = '# 还没做完 / 想问他的事\n\n'
  writeAtomic(f, `${head}${next.map(formatItem).join('\n')}\n`)
  return true
}