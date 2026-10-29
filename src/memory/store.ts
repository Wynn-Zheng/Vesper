import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { similarity } from '../core/text.ts'
import { appendJsonl, readJsonl, writeAtomic } from '../store/fs.ts'
import { cardMemoryRoot } from '../persona/card.ts'
import type { Episode, Insight, RawTurn, Scope } from './types.ts'

// 记忆根目录按角色卡走：换卡就是换人，经历/洞察/原文都是这个人的。
// 没有卡或测试覆盖时回退到老路径。
let rootOverride: string | null = null

/** 测试用：把记忆根目录指向临时目录 */
export function setMemoryRoot(p: string): void {
  rootOverride = p
  epCache = null
}

function currentRoot(): string {
  if (rootOverride) return rootOverride
  try {
    return cardMemoryRoot()
  } catch {
    return 'persona/memory'
  }
}

export function memoryRoot(): string {
  return currentRoot()
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ensure(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}

/* ---------------- raw ---------------- */

function rawFile(date = today()): string {
  return join(currentRoot(), 'raw', `${date}.jsonl`)
}

export function appendRaw(turn: RawTurn): void {
  appendJsonl(rawFile(), turn)
}

/**
 * 按记录自己的时间戳写对应日期的文件。
 *
 * `appendRaw` 固定写"今天"——恢复正常说话时这是对的，
 * 但**导入备份**时会把前几天的对话全塞进今天，日期就错了。
 */
export function appendRawAt(turn: RawTurn): void {
  const d = new Date(turn.ts)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  appendJsonl(rawFile(key), turn)
}

export function readRaw(date: string): RawTurn[] {
  return readJsonl<RawTurn>(rawFile(date))
}

/** 最近 n 天的原文，按时间正序 */
export function recentRaw(days = 7): RawTurn[] {
  const out: RawTurn[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push(...readRaw(key))
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/* ---------------- episodes ---------------- */

function episodeDir(scope: Scope): string {
  if (scope === 'shared') return join(currentRoot(), 'episodes', 'shared')
  const idx = scope.indexOf(':')
  const kind = scope.slice(0, idx)
  const id = scope.slice(idx + 1)
  return join(currentRoot(), 'episodes', kind === 'group' ? `group-${id}` : `private-${id}`)
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return {}
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  meta['__body'] = m[2] ?? ''
  return meta
}

/** 解析 "related: [a, b, c]" 里的 id 列表 */
function parseIdList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const m = /\[([^\]]*)\]/.exec(raw)
  const body = m ? m[1]! : raw
  const ids = body
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return ids.length ? ids : undefined
}

export function saveEpisode(ep: Episode): string {
  const dir = ensure(episodeDir(ep.scope))
  const file = join(dir, `${ep.id}.md`)
  const text = [
    '---',
    `date: ${ep.date}`,
    `scope: ${ep.scope}`,
    `importance: ${ep.importance}`,
    ...(ep.emotion ? [`emotion: ${ep.emotion}`] : []),
    ...(ep.lastRecalled ? [`lastRecalled: ${ep.lastRecalled}`] : []),
    // 只在有链接时才写这一行，避免空数组污染 frontmatter
    ...(ep.related?.length ? [`related: [${ep.related.join(', ')}]`] : []),
    ...(ep.recallCount ? [`recallCount: ${ep.recallCount}`] : []),
    `title: ${ep.title}`,
    '---',
    '',
    ep.body.trim(),
    '',
  ].join('\n')
  writeAtomic(file, text)
  epCache = null
  return file
}

/** 下一条 episode 的 id：查目录里已有的最大序号 +1，避免同一天多次整理互相覆盖 */
export function nextEpisodeId(scope: Scope, date: string): string {
  const dir = episodeDir(scope)
  if (!existsSync(dir)) return `${date}-01`
  const nums = readdirSync(dir)
    .filter((f) => f.startsWith(`${date}-`) && f.endsWith('.md'))
    .map((f) => Number(f.slice(date.length + 1, -3)))
    .filter((n) => !Number.isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `${date}-${String(next).padStart(2, '0')}`
}

/**
 * episode 缓存。
 *
 * 为什么需要：实测 1000 条时一次 loadEpisodes 要 45ms，2000 条 88ms，
 * 而 recall 每次都全量扫、flushRecalls 还要再扫一遍——纯 IO 放大。
 *
 * 为什么用 5 秒 TTL 而不是"写到就更新"：记忆文件是给人直接改的，
 * 只靠写操作失效的话，手工编辑要等进程重启才生效。5 秒是折中：
 * 一次回复里多次 loadEpisodes 共享缓存，手改最多 5 秒后可见。
 */
let epCache: { at: number; list: Episode[] } | null = null
const EP_CACHE_MS = 5000

export function invalidateEpisodes(): void {
  epCache = null
}

export function loadEpisodes(): Episode[] {
  const now = Date.now()
  if (epCache && now - epCache.at < EP_CACHE_MS) {
    // 返回浅拷贝：调用方会改 lastRecalled / recallCount，不能让它污染缓存
    return epCache.list.map((e) => ({ ...e }))
  }
  const list = readEpisodes()
  epCache = { at: now, list }
  return list.map((e) => ({ ...e }))
}

function readEpisodes(): Episode[] {
  const base = join(currentRoot(), 'episodes')
  if (!existsSync(base)) return []
  const out: Episode[] = []
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const full = join(base, dir.name)
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.md')) continue
      const meta = parseFrontmatter(readFileSync(join(full, f), 'utf8'))
      if (!meta['title']) continue
      out.push({
        id: f.replace(/\.md$/, ''),
        date: meta['date'] ?? '',
        scope: (meta['scope'] as Scope) ?? 'shared',
        importance: Number(meta['importance'] ?? 5),
        emotion: meta['emotion'],
        title: meta['title']!,
        body: (meta['__body'] ?? '').trim(),
        lastRecalled: meta['lastRecalled'] ? Number(meta['lastRecalled']) : undefined,
        recallCount: meta['recallCount'] ? Number(meta['recallCount']) : undefined,
        related: parseIdList(meta['related']),
      })
    }
  }
  return out
}

/**
 * 清理过期的原始对话。
 *
 * 原来 raw/ 只增不删（一年约 8MB，不致命，但会一直涨）。
 * 保留 35 天：distill 读 7 天、recall 读 3 天、关系降温读 30 天，
 * 35 是留出余量后的最小安全值。
 */
export function pruneRaw(keepDays = 35): number {
  const base = join(currentRoot(), 'raw')
  if (!existsSync(base)) return 0
  const cutoff = Date.now() - Math.max(1, keepDays) * 86_400_000
  let removed = 0
  for (const f of readdirSync(base)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
    if (!m) continue
    const t = Date.parse(`${m[1]}T00:00:00`)
    if (Number.isNaN(t) || t >= cutoff) continue
    try {
      rmSync(join(base, f), { force: true })
      removed++
    } catch {
      /* 删不掉就下次再说 */
    }
  }
  return removed
}

/* ---------------- insights ---------------- */

function insightsFile(): string {
  return join(currentRoot(), 'insights.jsonl')
}

/** 同一条看法换个说法也算重复（0.75 只抓"基本一样的句子"） */
const INSIGHT_DUP_SIM = 0.75
/**
 * 洞察总条数上限，保留最近的。
 *
 * 原来只 append：同样的看法反复出现，会把 recall 的前 3 个名额占满。
 * 500 条约够一两年（一天一两条），超了才裁。
 */
const INSIGHT_CAP = 500

export function appendInsights(items: Insight[]): void {
  const fresh = items.filter((i) => i.text.trim().length > 1)
  if (!fresh.length) return

  const existing = loadInsights()
  const kept: Insight[] = []
  for (const i of fresh) {
    const dup =
      existing.some((old) => similarity(old.text, i.text) >= INSIGHT_DUP_SIM) ||
      kept.some((old) => similarity(old.text, i.text) >= INSIGHT_DUP_SIM)
    if (!dup) kept.push(i)
  }
  if (!kept.length) return

  for (const i of kept) appendJsonl(insightsFile(), i)

  // 超过上限就整体重写（JSONL 追加没法删头部）：保留最近的
  if (existing.length + kept.length > INSIGHT_CAP) {
    const all = [...existing, ...kept].slice(-INSIGHT_CAP)
    writeAtomic(insightsFile(), all.map((x) => `${JSON.stringify(x)}\n`).join(''))
  }
}

export function loadInsights(): Insight[] {
  return readJsonl<Insight>(insightsFile())
}

/** 删掉一段经历（记错了、或者不该留） */
export function deleteEpisode(id: string, scope: Scope): boolean {
  const file = join(episodeDir(scope), `${id}.md`)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  epCache = null
  return true
}