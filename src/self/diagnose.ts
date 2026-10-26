/**
 * 诊断：拿到"出在 src/xxx.ts:47"之后，自己决定看什么，最后给出判断。
 *
 * 参考 HolmesGPT 的做法：它靠 agentic loop（多轮查询）找根因，
 * 而一开始我们是一次读文件就下结论——只能看到那一段，看不到调用链。
 *
 * 这里给三个只读工具：读文件、搜代码、找调用方。
 * 最多 3 轮，每轮模型自己决定下一步看什么。
 *
 * 仍然只读。改是人做的事。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { Issue } from './observe.ts'

/* ---------- 只读工具 ---------- */

/** 只允许 src/ 下的文件，且必须在仓内 */
function safePath(where: string): string | null {
  if (!where) return null
  const file = where.split(':')[0] ?? ''
  if (!file.startsWith('src/')) return null
  if (file.includes('..')) return null
  const abs = resolve(file)
  if (!abs.includes('QQbot')) return null
  return existsSync(abs) ? abs : null
}

export interface SourceSlice {
  file: string
  from: number
  to: number
  code: string
  total: number
}

/** 读指定行区间 */
export function readSlice(file: string, from: number, to: number, maxLines = 80): SourceSlice | null {
  const abs = safePath(file)
  if (!abs) return null
  let lines: string[]
  try {
    lines = readFileSync(abs, 'utf8').split('\n')
  } catch {
    return null
  }
  const lo = Math.max(1, Math.min(from, to))
  // 起点超出文件末尾就没东西可读了：返回 null，别给个空字符串让人以为读到了
  if (lo > lines.length) return null
  const hi = Math.min(lines.length, Math.max(from, to), lo + maxLines - 1)
  const code = lines
    .slice(lo - 1, hi)
    .map((l, i) => `${String(lo + i).padStart(4)}| ${l}`)
    .join('\n')
  return { file, from: lo, to: hi, code, total: lines.length }
}

/** 读某个位置附近的代码 */
export function readSourceAt(where: string, around = 35): SourceSlice | null {
  const abs = safePath(where)
  if (!abs) return null
  const lineNo = Number(where.split(':')[1] ?? 0)
  if (!Number.isFinite(lineNo) || lineNo <= 0) return null
  return readSlice(where.split(':')[0]!, lineNo - around, lineNo + around)
}

function walkSrc(dir = 'src', out: string[] = []): string[] {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkSrc(p, out)
      else if (e.name.endsWith('.ts')) out.push(p.replace(/\\/g, '/'))
    }
  } catch {
    /* ignore */
  }
  return out
}

export interface SearchHit {
  file: string
  line: number
  text: string
}

/** 在 src/ 里搜关键词 */
export function searchCode(query: string, limit = 12): SearchHit[] {
  const q = query.trim()
  if (q.length < 2) return []
  const hits: SearchHit[] = []
  for (const file of walkSrc()) {
    let lines: string[]
    try {
      if (statSync(file).size > 400_000) continue
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      continue
    }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes(q)) continue
      hits.push({ file, line: i + 1, text: lines[i]!.trim().slice(0, 120) })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** 找某个函数被谁调用 */
export function findCallers(name: string, limit = 12): SearchHit[] {
  const n = name.trim()
  if (n.length < 2) return []
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![.\\w])${esc}\\s*\\(`)
  const hits: SearchHit[] = []
  for (const file of walkSrc()) {
    let lines: string[]
    try {
      if (statSync(file).size > 400_000) continue
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      continue
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!re.test(line)) continue
      if (/^\s*(export\s+)?(async\s+)?function\s/.test(line)) continue
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 120) })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/* ---------- 多轮诊断 ---------- */

const SYSTEM = `你在诊断一个 QQ 机器人的故障。你有三个只读工具，可以自己决定看什么。

每轮只输出一个 JSON，不要解释：

读文件：
{"action":"read","file":"src/xxx.ts","from":10,"to":60}

搜代码（找某个字符串出现在哪）：
{"action":"search","query":"随便什么关键词"}

找调用方（谁调用了这个函数）：
{"action":"callers","name":"函数名"}

看够了，给结论：
{"action":"done","这行在做什么":"一句话","可能的问题":"最可能的原因","有多确定":"确定|大概|猜的","怎么改":"一句话建议"}

规则：
- 最多看 3 轮，别浪费。
- 第一轮通常是看错误那一段代码。
- 如果怀疑是调用方传错参数，用 callers。
- 如果不确定某段逻辑，用 read 看完整函数。
- 光看代码看不出就直接说"看不出"，不要硬猜。
- 「有多确定」只有在代码里能直接看到缺陷时才写"确定"。`

export interface Diagnosis {
  what: string
  why: string
  certainty: '确定' | '大概' | '猜的'
  howToFix: string
}

interface Action {
  action?: string
  file?: string
  from?: number
  to?: number
  query?: string
  name?: string
  这行在做什么?: string
  可能的问题?: string
  有多确定?: string
  怎么改?: string
}

function parseAction(text: string): Action | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Action
  } catch {
    return null
  }
}

function toDiagnosis(a: Action): Diagnosis {
  const c = String(a.有多确定 ?? '')
  return {
    what: String(a.这行在做什么 ?? '').slice(0, 140),
    why: String(a.可能的问题 ?? '').slice(0, 180),
    certainty: (['确定', '大概', '猜的'].includes(c) ? c : '猜的') as Diagnosis['certainty'],
    howToFix: String(a.怎么改 ?? '').slice(0, 180),
  }
}

function renderHits(hits: SearchHit[]): string {
  if (!hits.length) return '（没找到）'
  return hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n')
}

export interface DiagnoseOptions {
  maxRounds?: number
}

/** 对一个问题做诊断：最多 maxRounds 轮工具调用 */
export async function diagnose(issue: Issue, llm: LlmOptions, opts: DiagnoseOptions = {}): Promise<Diagnosis | null> {
  if (!issue.where) return null
  const maxRounds = Math.min(5, Math.max(1, opts.maxRounds ?? 3))

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `错误消息：${issue.message}`,
        `出现次数：${issue.count}`,
        `代码位置：${issue.where}`,
        issue.samples.length ? `附加：${issue.samples[0]}` : '',
        '',
        '开始诊断。第一轮输出一个 JSON。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]

  for (let round = 0; round < maxRounds; round++) {
    let reply: string
    try {
      const res = await chat(messages, { ...llm, maxTokens: 300, temperature: 0.2 })
      reply = res.text
    } catch (err) {
      warnAt('诊断的模型调用失败', { err: String(err).slice(0, 60) })
      return null
    }

    const action = parseAction(reply)
    if (!action) {
      messages.push({ role: 'assistant', content: reply })
      messages.push({ role: 'user', content: '格式不对。直接给结论 JSON（action=done）。' })
      continue
    }

    if (action.action === 'done') return toDiagnosis(action)

    messages.push({ role: 'assistant', content: reply })

    let result: string
    if (action.action === 'read' && action.file) {
      const slice = readSlice(action.file, Number(action.from ?? 1), Number(action.to ?? 80))
      result = slice
        ? `文件 ${slice.file}（共 ${slice.total} 行），第 ${slice.from}-${slice.to} 行：\n${slice.code}`
        : '读不到这个文件'
    } else if (action.action === 'search' && action.query) {
      result = `搜「${action.query}」：\n${renderHits(searchCode(action.query))}`
    } else if (action.action === 'callers' && action.name) {
      result = `调用 ${action.name} 的地方：\n${renderHits(findCallers(action.name))}`
    } else {
      result = '参数不对或动作不支持。可用：read / search / callers / done'
    }

    messages.push({ role: 'user', content: result.slice(0, 4000) })
  }

  messages.push({ role: 'user', content: '轮数用完了。直接给结论 JSON（action=done），不要再调工具。' })
  try {
    const res = await chat(messages, { ...llm, maxTokens: 300, temperature: 0.2 })
    const a = parseAction(res.text)
    if (a) return toDiagnosis(a)
  } catch {
    /* 放弃 */
  }
  return null
}

/** 渲染成一句话 */
export function renderDiagnosis(d: Diagnosis): string {
  const trim = (s: string) => s.replace(/[。.!！]+$/, '').trim()
  const parts: string[] = []
  if (d.what) parts.push(trim(d.what))
  if (d.why && d.why !== '看不出') parts.push(`问题大概是：${trim(d.why)}`)
  if (d.howToFix) parts.push(`可以试试：${trim(d.howToFix)}`)
  return parts.join('。') + '。'
}
