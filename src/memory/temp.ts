/**
 * 临时记忆：搜索到的、一次性的、会过时的。
 *
 * 和正式记忆的区别：
 *   临时 → 7 天删，不进 distill，不污染 facts
 *   正式 → 会被提炼、会衰减、长期留着
 *
 * 为什么分开：搜索结果通常是**别人的话**，不是"关于这个人的事实"。
 * 塞进 facts.md 会让它把维基百科的内容当成"他告诉我的"。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { info, warnAt } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'
import { similarity } from '../core/text.ts'

const ROOT = join('persona', 'memory', 'temp')

/** 保留天数 */
export const TTL_DAYS = 7
/** 最多存几条 */
const MAX_ITEMS = 100

export interface TempItem {
  /** 文件名（不含 .md） */
  id: string
  /** 查询词 */
  query: string
  /** 什么时候搜的 */
  at: number
  /** 从哪来的（brave / searxng / 手动） */
  source: string
  /** 搜索结果摘要 */
  results: Array<{ title: string; url: string; snippet: string }>
  /** 抓到的正文（可能没有） */
  body?: string
}

function fileOf(id: string): string {
  return join(ROOT, `${id}.md`)
}

function loadOne(id: string): TempItem | null {
  const f = fileOf(id)
  if (!existsSync(f)) return null
  try {
    return parse(readFileSync(f, 'utf8'), id)
  } catch {
    return null
  }
}

/** 从 markdown 解析（人能直接改，所以要容错） */
function parse(text: string, id: string): TempItem | null {
  const atM = /^at:\s*(\d+)$/m.exec(text)
  const queryM = /^query:\s*(.*)$/m.exec(text)
  const sourceM = /^source:\s*(.*)$/m.exec(text)

  const item: TempItem = {
    id,
    query: queryM?.[1]?.trim() ?? '',
    at: atM ? Number(atM[1]) : 0,
    source: sourceM?.[1]?.trim() ?? 'unknown',
    results: [],
  }

  // 结果段：1. 【标题】url\n   摘要
  const resultsPart = /##\s*结果\s*\n([\s\S]*?)(?=\n##\s|\n*$)/.exec(text)
  if (resultsPart) {
    for (const line of resultsPart[1]!.split(/\r?\n/)) {
      const m = /^\d+\.\s*【(.*?)】\s*(\S+)/.exec(line.trim())
      if (m) item.results.push({ title: m[1]!, url: m[2]!, snippet: '' })
    }
  }

  const bodyPart = /##\s*抓的正文\s*\n([\s\S]*)$/.exec(text)
  if (bodyPart) item.body = bodyPart[1]!.trim().slice(0, 3000)

  return item.query || item.results.length ? item : null
}

function render(item: TempItem): string {
  const lines: string[] = [
    '---',
    `at: ${item.at}`,
    `query: ${item.query}`,
    `source: ${item.source}`,
    `ttlDays: ${TTL_DAYS}`,
    '---',
    '',
    `# 搜：${item.query}`,
    '',
    '## 结果',
    '',
  ]

  if (!item.results.length) lines.push('（没有结果）')
  else {
    item.results.forEach((r, i) => {
      lines.push(`${i + 1}. 【${r.title}】${r.url}`)
      if (r.snippet) lines.push(`   ${r.snippet}`)
    })
  }

  if (item.body) {
    lines.push('', '## 抓的正文', '', item.body)
  }

  return lines.join('\n')
}

/** 存一条临时记忆 */
export function saveTemp(input: {
  query: string
  source: string
  results: Array<{ title: string; url: string; snippet: string }>
  body?: string
}): string | null {
  const query = input.query.trim().slice(0, 100)
  if (!query) return null

  prune()
  mkdirSync(ROOT, { recursive: true })

  // id：日期 + 查询词的安全化
  const day = new Date().toISOString().slice(0, 10)
  const slug = query.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30)
  let id = `${day}-${slug}`
  // 同一天同一个词搜两次，覆盖（最新的更准）
  const existing = loadOne(id)
  if (existing) id = `${day}-${slug}-${Date.now().toString(36).slice(-4)}`

  const item: TempItem = {
    id,
    query,
    at: Date.now(),
    source: input.source,
    results: input.results.slice(0, 10).map((r) => ({
      title: r.title.slice(0, 120),
      url: r.url.slice(0, 300),
      snippet: r.snippet.slice(0, 300),
    })),
    ...(input.body ? { body: input.body.slice(0, 3000) } : {}),
  }

  writeAtomic(fileOf(id), render(item))
  info('存了一条临时记忆', { query: query.slice(0, 20) })
  return id
}

/** 读全部临时记忆（控制台用） */
export function loadTemp(): TempItem[] {
  if (!existsSync(ROOT)) return []
  const out: TempItem[] = []
  try {
    for (const name of readdirSync(ROOT)) {
      if (!name.endsWith('.md')) continue
      const item = loadOne(name.slice(0, -3))
      if (item) out.push(item)
    }
  } catch {
    warnAt('临时记忆读不出来', { dir: ROOT })
  }
  // 新的在前
  return out.sort((a, b) => b.at - a.at)
}

/**
 * 按查询相关性取临时记忆。
 *
 * 注意：只用 similarity 粗筛，不做语义匹配（那要模型）。
 * 宁可少取，也别把不相关的塞进 prompt。
 */
export function relevantTemp(query: string, limit = 3): TempItem[] {
  if (!query.trim()) return []
  const all = loadTemp()
  if (!all.length) return []

  const scored = all
    .map((it) => ({ it, score: similarity(query, it.query) }))
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map((x) => x.it)
}

/** 删一条 */
export function dropTemp(id: string): boolean {
  const f = fileOf(id)
  if (!existsSync(f)) return false
  try {
    unlinkSync(f)
    return true
  } catch {
    return false
  }
}

/**
 * 清理过期的。启动时和每天调一次。
 *
 * 返回删了几条。
 */
export function prune(now = Date.now()): number {
  if (!existsSync(ROOT)) return 0
  const cutoff = now - TTL_DAYS * 86_400_000
  let removed = 0
  let total = 0

  try {
    for (const name of readdirSync(ROOT)) {
      if (!name.endsWith('.md')) continue
      total += 1
      const item = loadOne(name.slice(0, -3))
      // 解析不出来的也删（坏文件留着没用）
      if (!item || item.at < cutoff) {
        try {
          unlinkSync(join(ROOT, name))
          removed += 1
        } catch {
          /* 删不掉就算了 */
        }
      }
    }
  } catch {
    return 0
  }

  // 超过上限的，删最旧的
  if (total - removed > MAX_ITEMS) {
    const all = loadTemp()
    const excess = all.length - MAX_ITEMS
    for (let i = 0; i < excess; i++) {
      const oldest = all[all.length - 1 - i]
      if (oldest) {
        try {
          unlinkSync(fileOf(oldest.id))
          removed += 1
        } catch {
          /* 跳过 */
        }
      }
    }
  }

  if (removed) info(`临时记忆清掉了 ${removed} 条`, { 保留天数: TTL_DAYS })
  return removed
}

/** 渲染给 prompt：只说"我查到的"，明确标注可能过时 */
export function renderTempForPrompt(items: TempItem[]): string {
  if (!items.length) return ''
  const lines: string[] = ['【我查到的（可能过时，别当自己知道的）】']
  for (const it of items) {
    const days = Math.floor((Date.now() - it.at) / 86_400_000)
    lines.push(`搜「${it.query}」（${days === 0 ? '今天' : `${days} 天前`}）：`)
    for (const r of it.results.slice(0, 3)) {
      lines.push(`- ${r.title}${r.snippet ? `：${r.snippet.slice(0, 120)}` : ''}`)
    }
  }
  return lines.join('\n')
}
