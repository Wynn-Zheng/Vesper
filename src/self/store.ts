import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sharedBigrams, similarity } from '../core/text.ts'
import { cardScopedPath } from '../persona/card.ts'
import { appendJsonl } from '../store/fs.ts'
import { writeAtomic } from '../store/fs.ts'

const SELF_FILE = 'persona/self.md'
const LIFE_FILE = 'persona/life.md'

let selfPath = SELF_FILE
let lifePath = LIFE_FILE
/** 测试用：历史目录默认跟着角色卡走（相对路径），测试要能指到临时目录 */
let historyOverride: string | null = null

/** 测试用 */
export function setSelfFiles(self: string, life: string): void {
  selfPath = self
  lifePath = life
}

/** 测试用：把 self-history 也指到临时目录，免得测试往真实数据里写快照 */
export function setSelfHistoryDir(dir: string | null): void {
  historyOverride = dir
}

/**
 * 测试用：恢复成默认路径。
 *
 * 为什么需要它：`--test-isolation=none` 下所有测试共用一个进程，
 * 而好几个测试文件在**导入时**就把路径指到了各自的临时目录。
 * 一个文件里的用例改了路径之后如果不还原，会污染后面文件里的用例
 * （实测把 self.test.ts 的一条用例弄挂了：它看到的是别人存的 self.md）。
 */
export function resetSelfFiles(): void {
  selfPath = SELF_FILE
  lifePath = LIFE_FILE
  historyOverride = null
}

/**
 * 自述正文的长度上限。
 *
 * 以前三处各写各的：apply.ts 用 1200，reflect.ts 和 distill.ts 用 600。
 * 同一句话走不同入口，截断位置不一样 —— 用户会觉得"我写的东西被吃掉一截"。
 * 统一到 1200（取松的那个，已存在的内容不会被截短）。
 */
export const SELF_ABOUT_MAX = 1200

export interface SelfDoc {
  name: string
  nameReason: string
  /**
   * about 归谁。
   *
   * 'me' = 用户写的，它只读 —— reflect/distill 不许覆盖；
   * 'it' = 它自己写，反思和整理记忆时会更新。
   *
   * 加这个是因为：用户改了「我是谁」，12 小时后自我反思又把模型写的版本盖回去，
   * 看起来就像"刚写的东西被清空了"。
   */
  aboutOwner: 'me' | 'it'
  /**
   * 它补充的自述片段。
   *
   * 只在 aboutOwner === 'me' 时有意义：用户写的那段（about）它不能碰，
   * 但可以在下面追加"最近新发现的"。
   * 切回 'it' 时这两段会合并，交回给它整体改写。
   */
  aboutExtra: string
  /** 正文：我是谁 */
  about: string
  /** 最近在想的事 */
  thinking: string
  /** 它自己总结的"我能做什么"——不是我们写的 */
  abilities: string
}

// 注：self.md 里原本还有一组 `traits`（说话倾向 / 对陌生人 / 喜欢 / 不喜欢），
// 和角色卡的「性格 / 语言风格 / 喜欢 / 讨厌」完全撞车。2026-11-01 起以角色卡为准，
// self.md 不再存这类"特征"；旧文件里的 `我·xxx` 行读的时候直接忽略。

const EMPTY: SelfDoc = { name: '', nameReason: '', about: '', thinking: '', abilities: '', aboutOwner: 'it', aboutExtra: '' }

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

// 认识的几个顶层章节。只有它们才算「下一节」的开始：
// 之前用通用的 `#{1,2}\s` 当边界，用户粘贴带标题的 markdown（或模型自述里带 ## 小标题）
// 会被当成新章节，load 出来只剩前半段，下一次 saveSelf 就把后半段永久写没了。
const SELF_SECTIONS = ['我是谁', '它补充的', '我能做什么', '我最近在想'] as const

function section(body: string, title: string): string {
  const boundary = SELF_SECTIONS.filter((s) => s !== title)
    .map((s) => `#{1,2}\\s*${s}`)
    .join('|')
  const re = new RegExp(`(?:^|\\n)#{1,2}\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n(?:${boundary})\\s|$)`)
  const m = re.exec(body)
  return m ? (m[1] ?? '').trim() : ''
}

export function loadSelf(): SelfDoc {
  if (!existsSync(selfPath)) return { ...EMPTY }
  const { meta, body } = splitFront(readFileSync(selfPath, 'utf8'))
  return {
    name: meta['名字'] ?? '',
    nameReason: meta['取名原因'] ?? '',
    about: section(body, '我是谁') || body.trim(),
    thinking: section(body, '我最近在想'),
    aboutExtra: section(body, '它补充的'),
    abilities: section(body, '我能做什么'),
    // 默认 'it'：老文件没这个字段，保持原来的行为（它能改自述）
    aboutOwner: meta['所有权'] === '我写' ? 'me' : 'it',
  }
}

/** 历史目录：每次改动前留一份，人格变了能回看 */
function historyDir(): string {
  // 按角色卡隔离：换卡就是换人，历史不该混在一起
  if (historyOverride) return historyOverride
  return cardScopedPath('self-history', 'persona/self-history')
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
    aboutExtra: section(body, '它补充的'),
    abilities: section(body, '我能做什么'),
    aboutOwner: meta['所有权'] === '我写' ? 'me' : 'it',
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

  const lines = [
    '---',
    `名字: ${doc.name}`,
    `所有权: ${doc.aboutOwner === 'me' ? '我写' : '它写'}`,
    doc.nameReason ? `取名原因: ${doc.nameReason}` : '取名原因: ',
    '---',
    '',
    '# 我是谁',
    '',
    doc.about.trim() || '（还没想清楚。）',

    // 只有「我写」模式才有这一段：它只能在用户写的内容下面补充
    ...(doc.aboutOwner === 'me' && (doc.aboutExtra ?? '').trim()
      ? ['', '## 它补充的', '', (doc.aboutExtra ?? '').trim()]
      : []),
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

const DRIFT_LOG_LEGACY = 'persona/self-history/drift.jsonl'
function driftLogFile(): string {
  return cardScopedPath(join('self-history', 'drift.jsonl'), DRIFT_LOG_LEGACY)
}

/** 记一条漂移事件，控制台能看到"它什么时候变了个样" */
export function logDrift(to: string, from: string, sim: number): void {
  appendJsonl(driftLogFile(), { at: Date.now(), from: from.slice(0, 200), to: to.slice(0, 200), sim })
}

/**
 * 两份自述的行级对比。
 *
 * 用于「人格变化」：让人看见它到底哪几句变了，而不是只给一个相似度。
 * 自己实现 LCS，不引依赖 —— 项目运行时依赖只有 ws / yaml。
 *
 * 超过 2000 行直接退化成「全删 + 全加」：自述不可能这么长，
 * 真到这么长就是数据出问题了，没必要为它跑 O(n²)。
 */
export function lineDiff(
  a: string,
  b: string,
): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const A = a.split(/\r?\n/)
  const B = b.split(/\r?\n/)

  if (A.length > 2000 || B.length > 2000) {
    return [
      ...A.map((text) => ({ type: 'del' as const, text })),
      ...B.map((text) => ({ type: 'add' as const, text })),
    ]
  }

  // 经典 LCS 表。A.length*B.length 最多 4e6，可接受。
  const n = A.length
  const m = B.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  let i2 = 0
  let j2 = 0
  while (i2 < n && j2 < m) {
    if (A[i2] === B[j2]) {
      out.push({ type: 'same', text: A[i2]! })
      i2++
      j2++
    } else if (dp[i2 + 1]![j2]! >= dp[i2]![j2 + 1]!) {
      out.push({ type: 'del', text: A[i2]! })
      i2++
    } else {
      out.push({ type: 'add', text: B[j2]! })
      j2++
    }
  }
  while (i2 < n) out.push({ type: 'del', text: A[i2++]! })
  while (j2 < m) out.push({ type: 'add', text: B[j2++]! })

  return out
}


export function loadDrifts(limit = 20): Array<{ at: number; from: string; to: string; sim: number }> {
  if (!existsSync(driftLogFile())) return []
  const out: Array<{ at: number; from: string; to: string; sim: number }> = []
  for (const line of readFileSync(driftLogFile(), 'utf8').split('\n')) {
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
  //
  // 两道判据一起用：
  //   1. Jaccard 相似度 > 0.5 —— 抓"几乎一样"
  //   2. 共同 bigram >= 10 —— 抓"换个说法但说的是同一件事"
  //      （实测：同一件事改写后 Jaccard 只有 0.16，但共同 bigram 有 12 个）
  const known = entries.flatMap((e) => e.lines)
  const fresh = lines.filter((l) => {
    const t = l.trim()
    if (!t) return false
    return !known.some((k) => {
      if (k === t) return true
      if (similarity(k, t) > 0.5) return true
      // 短句共同 bigram 天然少，门槛按长度缩放
      const need = Math.max(5, Math.floor(Math.min(k.length, t.length) / 4))
      return sharedBigrams(k, t) >= need
    })
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
