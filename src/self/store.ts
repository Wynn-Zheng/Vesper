import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { similarity } from '../core/text.ts'
import { appendJsonl } from '../store/fs.ts'
import { writeAtomic } from '../store/fs.ts'

const SELF_FILE = 'persona/self.md'
const LIFE_FILE = 'persona/life.md'

let selfPath = SELF_FILE
let lifePath = LIFE_FILE

/** 测试用 */
export function setSelfFiles(self: string, life: string): void {
  selfPath = self
  lifePath = life
}

export interface SelfDoc {
  name: string
  nameReason: string
  /** 正文：我是谁 */
  about: string
  /** 最近在想的事 */
  thinking: string
  /** 结构化的自我特征：进 prompt 时当约束，不只是描述 */
  traits: Record<string, string>
  /** 它自己总结的"我能做什么"——不是我们写的 */
  abilities: string
}

const EMPTY: SelfDoc = { name: '', nameReason: '', about: '', thinking: '', traits: {}, abilities: '' }

function splitFront(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: m[2] ?? '' }
}

/** 从正文里取出某一节（一级或二级标题都认） */
function section(body: string, title: string): string {
  const re = new RegExp(`(?:^|\\n)#{1,2}\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n#{1,2}\\s|$)`)
  const m = re.exec(body)
  return m ? (m[1] ?? '').trim() : ''
}

/** frontmatter 里以「我·」开头的是特征 */
function parseTraits(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith('我·')) continue
    const key = k.slice(2).trim()
    if (key && v) out[key] = v
  }
  return out
}

export function loadSelf(): SelfDoc {
  if (!existsSync(selfPath)) return { ...EMPTY }
  const { meta, body } = splitFront(readFileSync(selfPath, 'utf8'))
  return {
    name: meta['名字'] ?? '',
    nameReason: meta['取名原因'] ?? '',
    about: section(body, '我是谁') || body.trim(),
    thinking: section(body, '我最近在想'),
    abilities: section(body, '我能做什么'),
    traits: parseTraits(meta),
  }
}

/** 历史目录：每次改动前留一份，人格变了能回看 */
function historyDir(): string {
  return join(dirname(selfPath), 'self-history')
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface SelfVersion {
  id: string
  /** 文件里的日期（如果记得） */
  at: string
}

/** 列出历史版本，新的在前 */
export function listSelfVersions(limit = 20): SelfVersion[] {
  const dir = historyDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((n) => ({ id: n.replace(/\.md$/, ''), at: n.slice(0, 8) }))
}

/** 读某一版历史 */
export function loadSelfVersion(id: string): SelfDoc | null {
  const f = join(historyDir(), `${id}.md`)
  if (!existsSync(f)) return null
  const { meta, body } = splitFront(readFileSync(f, 'utf8'))
  return {
    name: meta['名字'] ?? '',
    nameReason: meta['取名原因'] ?? '',
    about: section(body, '我是谁') || body.trim(),
    thinking: section(body, '我最近在想'),
    abilities: section(body, '我能做什么'),
    traits: parseTraits(meta),
  }
}

export function saveSelf(doc: SelfDoc): void {
  // 写之前把旧版留一份，不然人格漂了没法回看
  if (existsSync(selfPath)) {
    try {
      const dir = historyDir()
      mkdirSync(dir, { recursive: true })
      writeAtomic(join(dir, `${stamp()}.md`), readFileSync(selfPath, 'utf8'))
      // 最多留 60 版
      const all = readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
      for (const old of all.slice(0, Math.max(0, all.length - 60))) {
        try {
          rmSync(join(dir, old), { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 历史没存上也不该挡住当前写入 */
    }
  }

  const traitLines = Object.entries(doc.traits ?? {})
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `我·${k}: ${v.trim()}`)

  const lines = [
    '---',
    `名字: ${doc.name}`,
    doc.nameReason ? `取名原因: ${doc.nameReason}` : '取名原因: ',
    ...traitLines,
    '---',
    '',
    '# 我是谁',
    '',
    doc.about.trim() || '（还没想清楚。）',
    '',
    '## 我能做什么',
    '',
    doc.abilities.trim() || '（还没盘点过。）',
    '',
    '## 我最近在想',
    '',
    doc.thinking.trim() || '（还没有。）',
    '',
  ]
  writeAtomic(selfPath, lines.join('\n'))
}

const DRIFT_LOG = 'persona/self-history/drift.jsonl'

/**
 * 和上一版比，自述变了多少。
 * 相似度低于 0.45 视为"明显变了"——不是不让你变，是变的时候留个记号。
 */
export function detectDrift(): { changed: boolean; from: string; to: string; sim: number } | null {
  const versions = listSelfVersions(2)
  if (versions.length < 2) return null
  const cur = loadSelf()
  const prev = loadSelfVersion(versions[1]!.id)
  if (!prev || !prev.about || !cur.about) return null
  if (prev.about === cur.about) return { changed: false, from: prev.about, to: cur.about, sim: 1 }
  const sim = similarity(prev.about, cur.about)
  return { changed: sim < 0.45, from: prev.about, to: cur.about, sim }
}

/** 记一条漂移事件，控制台能看到"它什么时候变了个样" */
export function logDrift(to: string, from: string, sim: number): void {
  appendJsonl(DRIFT_LOG, { at: Date.now(), from: from.slice(0, 200), to: to.slice(0, 200), sim })
}

export function loadDrifts(limit = 20): Array<{ at: number; from: string; to: string; sim: number }> {
  if (!existsSync(DRIFT_LOG)) return []
  const out: Array<{ at: number; from: string; to: string; sim: number }> = []
  for (const line of readFileSync(DRIFT_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as { at: number; from: string; to: string; sim: number })
    } catch {
      /* skip */
    }
  }
  return out.slice(-limit).reverse()
}

export function selfFile(): string {
  return selfPath
}

export function lifeFile(): string {
  return lifePath
}

export interface LifeEntry {
  date: string
  lines: string[]
}

export function loadLife(): LifeEntry[] {
  if (!existsSync(lifePath)) return []
  const text = readFileSync(lifePath, 'utf8')
  const entries: LifeEntry[] = []
  let cur: LifeEntry | null = null
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim())
    if (h) {
      cur = { date: h[1]!, lines: [] }
      entries.push(cur)
      continue
    }
    const b = /^-\s+(.+)$/.exec(line.trim())
    if (b && cur) cur.lines.push(b[1]!)
  }
  return entries
}

/**
 * 追加一天的生活记录；同一天已有就追加到那一天。
 * 会去重——不然反思反复说同一件事，life.md 会变成复读机。
 */
export function appendLife(date: string, lines: string[]): void {
  if (!lines.length) return
  const entries = loadLife()

  // 已经说过的就不再记（跨天也算，同一件事不该每天写一遍）
  const known = entries.flatMap((e) => e.lines)
  const fresh = lines.filter((l) => {
    const t = l.trim()
    if (!t) return false
    return !known.some((k) => k === t || similarity(k, t) > 0.7)
  })
  if (!fresh.length) return

  const idx = entries.findIndex((e) => e.date === date)
  if (idx >= 0) entries[idx]!.lines.push(...fresh)
  else entries.push({ date, lines: [...fresh] })

  // 最多留 40 条：人也会反复想同一件事，但不能让它无限涨。
  // 字符相似度分不清"换个说法"和"真的说了新的"，所以靠条数兜底。
  let total = entries.reduce((a, e) => a + e.lines.length, 0)
  while (total > 40 && entries.length) {
    const first = entries.find((e) => e.lines.length)
    if (!first) break
    first.lines.shift()
    total--
  }

  const body = entries
    .filter((e) => e.lines.length)
    .map((e) => [`## ${e.date}`, ...e.lines.map((l) => `- ${l}`)].join('\n'))
    .join('\n\n')
  writeAtomic(lifePath, `# 我自己的事\n\n${body}\n`)
}

/** 最近 n 条"自己的事"，新的在前 */
export function recentLife(n = 3): string[] {
  const entries = loadLife()
  const out: string[] = []
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    for (let j = entries[i]!.lines.length - 1; j >= 0 && out.length < n; j--) {
      out.push(entries[i]!.lines[j]!)
    }
  }
  return out
}
