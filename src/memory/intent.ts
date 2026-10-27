/**
 * 它自己准备做的事（待办）。
 *
 * 和 open.md 的区别（很容易混，所以写清楚）：
 *   open.md   = **等对方回答**的事（"他爱听什么歌，我还没问到"）
 *   intent.md = **它自己要去做**的事（"明天问问他四级考得怎么样"）
 *
 * 为什么单独一个文件而不是塞进 open.md：
 *   两件事的"完成条件"不一样。open 是"他答了"，intent 是"我做了"。
 *   混在一起的话，模型分不清"这条要不要催"。
 *
 * 四个来源（都能写）：
 *   - 它反思时自己加（reflect.ts）
 *   - 从对话里提炼（distill 识别"记得做 X"）
 *   - 你手动加（控制台）
 *   - 它写你审（走 pending，你批了才进"待办"）
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'

const FILE = join('persona', 'intent.md')

export type IntentSource = '他说的' | '我自己想到的' | '你加的'

export interface IntentItem {
  text: string
  /** 哪来的 */
  source: IntentSource
  /** 哪天加的 YYYY-MM-DD */
  date: string
  /** 是不是走审批的（true = 它提的，还没批） */
  pending?: boolean
}

export interface IntentDoc {
  todo: IntentItem[]
  done: IntentItem[]
}

const EMPTY: IntentDoc = { todo: [], done: [] }

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 解析一行 `- 内容｜来源：X｜日期` */
function parseLine(line: string): IntentItem | null {
  const m = /^-\s+(.+)$/.exec(line.trim())
  if (!m) return null
  const parts = m[1]!.split('｜').map((s) => s.trim())
  const text = parts[0] ?? ''
  if (!text) return null

  let source: IntentSource = '我自己想到的'
  let date = today()
  for (const p of parts.slice(1)) {
    const sm = /^来源：(.*)$/.exec(p)
    if (sm) {
      const v = sm[1]!.trim()
      if (v === '他说的' || v === '我自己想到的' || v === '你加的') source = v
      continue
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) date = p
  }
  return { text, source, date }
}

export function loadIntent(): IntentDoc {
  if (!existsSync(FILE)) return { ...EMPTY, todo: [], done: [] }

  let raw = ''
  try {
    raw = readFileSync(FILE, 'utf8')
  } catch {
    return { ...EMPTY, todo: [], done: [] }
  }

  const doc: IntentDoc = { todo: [], done: [] }
  let section: 'todo' | 'done' | null = null
  for (const line of raw.split('\n')) {
    if (/^##\s*待办/.test(line)) {
      section = 'todo'
      continue
    }
    if (/^##\s*已完成/.test(line)) {
      section = 'done'
      continue
    }
    if (line.startsWith('#')) {
      section = null
      continue
    }
    if (!section) continue
    const item = parseLine(line)
    if (item) doc[section].push(item)
  }
  return doc
}

/** 只取"要做"的（渲染给 prompt 用） */
export function todoForPrompt(limit = 8): string {
  const doc = loadIntent()
  const todo = doc.todo.filter((x) => !x.pending).slice(0, limit)
  if (!todo.length) return ''
  const lines = ['【我准备做的事】']
  for (const x of todo) lines.push(`- ${x.text}（${x.date}）`)
  lines.push('这些是我自己记着要做的。合适的时候做，别硬提。')
  return lines.join('\n')
}

function render(doc: IntentDoc): string {
  const lines = [
    '# 我准备做的事',
    '',
    '> 记录我自己定下的待办。**和「待问」不同**：这里是我要做，不是等回答。',
    '> 格式：`- 内容｜来源：X｜日期`。改的时候别丢 `- `。',
    '',
    '## 待办',
    '',
  ]
  for (const x of doc.todo) {
    const pending = x.pending ? '｜待批' : ''
    lines.push(`- ${x.text}｜来源：${x.source}｜${x.date}${pending}`)
  }
  if (!doc.todo.length) lines.push('')

  lines.push('', '## 已完成', '')
  for (const x of doc.done) lines.push(`- ${x.text}｜来源：${x.source}｜${x.date}`)
  if (!doc.done.length) lines.push('')

  return `${lines.join('\n')}\n`
}

export function saveIntent(doc: IntentDoc): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeAtomic(FILE, render(doc))
}

/** 加一条待办（直接进 todo） */
export function addIntent(text: string, source: IntentSource = '我自己想到的'): boolean {
  const t = text.trim()
  if (!t) return false

  const doc = loadIntent()
  // 同一条不要重复加
  if (doc.todo.some((x) => x.text === t)) return false

  doc.todo.push({ text: t.slice(0, 120), source, date: today() })
  // 最多 40 条待办，多了丢最旧的
  if (doc.todo.length > 40) doc.todo = doc.todo.slice(-40)

  saveIntent(doc)
  return true
}

/** 标记完成（从 todo 挪到 done） */
export function completeIntent(text: string): boolean {
  const doc = loadIntent()
  const i = doc.todo.findIndex((x) => x.text === text)
  if (i < 0) return false

  const [item] = doc.todo.splice(i, 1)
  doc.done.push({ ...item!, date: today() })
  // 已完成最多 60 条
  if (doc.done.length > 60) doc.done = doc.done.slice(-60)

  saveIntent(doc)
  return true
}

/** 删掉（不标记完成，直接不要了） */
export function dropIntent(text: string): boolean {
  const doc = loadIntent()
  const before = doc.todo.length + doc.done.length
  doc.todo = doc.todo.filter((x) => x.text !== text)
  doc.done = doc.done.filter((x) => x.text !== text)
  if (doc.todo.length + doc.done.length === before) return false
  saveIntent(doc)
  return true
}
