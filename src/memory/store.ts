import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, readJsonl, writeAtomic } from '../store/fs.ts'
import type { Episode, Insight, RawTurn, Scope } from './types.ts'

let ROOT = 'persona/memory'

/** 测试用：把记忆根目录指向临时目录 */
export function setMemoryRoot(p: string): void {
  ROOT = p
}

export function memoryRoot(): string {
  return ROOT
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
  return join(ROOT, 'raw', `${date}.jsonl`)
}

export function appendRaw(turn: RawTurn): void {
  appendJsonl(rawFile(), turn)
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
  if (scope === 'shared') return join(ROOT, 'episodes', 'shared')
  const idx = scope.indexOf(':')
  const kind = scope.slice(0, idx)
  const id = scope.slice(idx + 1)
  return join(ROOT, 'episodes', kind === 'group' ? `group-${id}` : `private-${id}`)
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
    `title: ${ep.title}`,
    '---',
    '',
    ep.body.trim(),
    '',
  ].join('\n')
  writeAtomic(file, text)
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

export function loadEpisodes(): Episode[] {
  const base = join(ROOT, 'episodes')
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
      })
    }
  }
  return out
}

/* ---------------- insights ---------------- */

function insightsFile(): string {
  return join(ROOT, 'insights.jsonl')
}

export function appendInsights(items: Insight[]): void {
  for (const i of items) appendJsonl(insightsFile(), i)
}

export function loadInsights(): Insight[] {
  return readJsonl<Insight>(insightsFile())
}

/** 删掉一段经历（记错了、或者不该留） */
export function deleteEpisode(id: string, scope: Scope): boolean {
  const file = join(episodeDir(scope), `${id}.md`)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}