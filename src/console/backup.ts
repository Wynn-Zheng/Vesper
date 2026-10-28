import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendJsonl, ensureDir, writeAtomic } from '../store/fs.ts'
import { appendFacts, loadDeleted, loadFacts, type PersonFact } from '../memory/facts.ts'
import { appendInsights, appendRawAt, loadEpisodes, loadInsights, readRaw, saveEpisode } from '../memory/store.ts'
import { appendOpen, loadOpen, type OpenItem } from '../people/open.ts'
import { isValidPersonId, listPeople, personDir, savePerson, type PersonMeta } from '../people/store.ts'
import { loadRelation, saveRelation } from '../relation/store.ts'
import { loadProfile, profilePath, saveProfile } from '../persona/profile.ts'
import { clearSessions, loadSession, saveSession, sessionRoot } from '../loop/session.ts'
import { snapshot } from '../persona/version.ts'
import type { Insight, RawTurn, Scope } from '../memory/types.ts'
import type { RelationState } from '../relation/types.ts'

/**
 * 备份：导出全部 + 从备份恢复。
 *
 * 设计原则：
 *
 * 1. **导出必须能被导入**。原来只有导出（`/api/export`），没有导入——
 *    等于备份文件只能看、不能用，那备份就没意义。
 *
 * 2. **默认"合并"，不"覆盖"**。恢复场景比"换机迁移"多得多：
 *    误删了某个人、记错了一条事实，用户想补回来，不想把现有数据冲掉。
 *    所以默认只补缺；要整体替换得显式传 overwrite。
 *
 * 3. **人格/规则/核心记忆默认不导入**。`rules.yaml`、`access.yaml`、`core.md`
 *    是用户手调的配置，从旧备份覆盖回去往往是灾难。要导得显式开启。
 *
 * 4. **导入前自动拍快照**（`persona/version.ts`），出事能回滚。
 */

/** 备份格式版本。旧版没有这个字段，导入时按 v1 容忍。 */
export const BACKUP_SCHEMA = 'qqbot-backup/2'

/** 这些文件是"人手工维护的配置/人格"，默认不导入 */
const CONFIG_FILES: Array<[string, string]> = [
  ['rules', 'persona/rules.yaml'],
  ['access', 'persona/access.yaml'],
  ['core', 'persona/core.md'],
]

/** 这些是"它长出来的东西"，恢复时默认导入（人格相关） */
const CONTENT_FILES: Array<[string, string]> = [
  ['self', 'persona/self.md'],
  ['life', 'persona/life.md'],
  ['jargon', 'persona/jargon.yaml'],
  ['mood', 'persona/mood.yaml'],
  ['plays', 'persona/learned/plays.md'],
]

function readIf(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export interface BackupPerson {
  meta: PersonMeta
  facts: PersonFact[]
  open: OpenItem[]
  /** 关系状态（v1 备份里永远是 null，因为旧代码用 JSON.parse 读 YAML） */
  relation: RelationState | null
  profile: string | null
  impression: string | null
  deleted: string[]
}

export interface BackupV2 {
  schema: string
  exportedAt: string
  people: BackupPerson[]
  episodes: Array<Record<string, unknown>>
  insights: Insight[]
  raw: RawTurn[]
  sessions: Array<Record<string, unknown>>
  files: Record<string, string | null>
  versions: string[]
}

/** 本地日期键 */
function dateKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 导出：所有人 + 记忆 + 最近原始对话 + 会话 + 人格文件，一个 JSON。
 *
 * 比旧版多导了：insights（洞察）、core.md、mood.yaml、sessions（会话历史/摘要）、
 * 每个人的 impression/deleted（删过的黑名单）。
 */
export function exportAll(days = 30): BackupV2 {
  const people: BackupPerson[] = listPeople().map((p) => ({
    meta: p,
    facts: loadFacts(p.id),
    open: loadOpen(p.id),
    relation: (() => {
      try {
        return loadRelation(p.id)
      } catch {
        return null
      }
    })(),
    profile: loadProfile(p.id) || null,
    impression: readIf(join(personDir(p.id), 'impression.md')),
    deleted: loadDeleted(p.id),
  }))

  const raw: RawTurn[] = []
  for (let i = 0; i < Math.min(90, Math.max(1, days)); i++) {
    raw.push(...readRaw(dateKeyOf(Date.now() - i * 86_400_000)))
  }

  const sessions: Array<Record<string, unknown>> = []
  try {
    for (const f of readdirSync(sessionRoot())) {
      if (!f.endsWith('.json')) continue
      try {
        const s = JSON.parse(readFileSync(join(sessionRoot(), f), 'utf8')) as Record<string, unknown>
        sessions.push({ key: decodeURIComponent(f.replace(/\.json$/, '')), ...s })
      } catch {
        /* 坏文件跳过 */
      }
    }
  } catch {
    /* 没有会话目录 */
  }

  const files: Record<string, string | null> = {}
  for (const [name, p] of [...CONTENT_FILES, ...CONFIG_FILES]) files[name] = readIf(p)

  return {
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    people,
    episodes: loadEpisodes() as unknown as Array<Record<string, unknown>>,
    insights: loadInsights(),
    raw,
    sessions,
    files,
    versions: existsSync('data/versions')
      ? readdirSync('data/versions').filter((n) => !n.startsWith('.'))
      : [],
  }
}

/** 解析 + 结构校验。旧版（没有 schema）也认，字段缺的当空。 */
export function parseBackup(text: string): BackupV2 {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文件')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份文件结构不对')
  const d = data as Partial<BackupV2>
  if (d.schema !== BACKUP_SCHEMA && !Array.isArray(d.people)) {
    throw new Error('这不是本程序导出的备份（缺 schema 和 people）')
  }
  return {
    schema: typeof d.schema === 'string' ? d.schema : 'qqbot-backup/1',
    exportedAt: typeof d.exportedAt === 'string' ? d.exportedAt : '',
    people: Array.isArray(d.people) ? (d.people as BackupPerson[]) : [],
    episodes: Array.isArray(d.episodes) ? d.episodes : [],
    insights: Array.isArray(d.insights) ? (d.insights as Insight[]) : [],
    raw: Array.isArray(d.raw) ? (d.raw as RawTurn[]) : [],
    sessions: Array.isArray(d.sessions) ? (d.sessions as Array<Record<string, unknown>>) : [],
    files: d.files && typeof d.files === 'object' ? (d.files as Record<string, string | null>) : {},
    versions: Array.isArray(d.versions) ? (d.versions as string[]) : [],
  }
}

export interface ImportOptions {
  /** 覆盖同名条目（默认只补缺） */
  overwrite?: boolean
  /** 连 rules/access/core 一起导入（默认不导，怕冲掉你手调的配置） */
  includeConfig?: boolean
  /** 只统计不落盘 */
  dryRun?: boolean
}

export interface ImportStats {
  people: number
  facts: number
  open: number
  episodes: number
  insights: number
  raw: number
  sessions: number
  files: string[]
  skipped: number
  snapshot: string | null
}

function emptyStats(): ImportStats {
  return { people: 0, facts: 0, open: 0, episodes: 0, insights: 0, raw: 0, sessions: 0, files: [], skipped: 0, snapshot: null }
}

/**
 * 从备份恢复。默认合并：只补缺，不覆盖已有数据。
 *
 * 重复导入是幂等的（facts 按文本、episodes 按 id、insights 按相似度、raw 按 ts 去重）。
 */
export function importBackup(data: BackupV2, opts: ImportOptions = {}): ImportStats {
  const stats = emptyStats()
  const overwrite = opts.overwrite === true
  const dryRun = opts.dryRun === true

  if (!dryRun) {
    // 导入前拍快照：恢复错了还能回去。
    // 全新环境里 persona/ 可能还不存在，先建个空目录，否则快照会失败（cpSync 找不到源）。
    try {
      ensureDir('persona')
      stats.snapshot = snapshot('导入备份前')
    } catch {
      stats.snapshot = null
    }
  }

  /* ---------- 人 ---------- */
  for (const p of data.people) {
    const id = p?.meta?.id
    if (!id || !isValidPersonId(id) || typeof p.meta !== 'object') {
      stats.skipped++
      continue
    }

    const exists = listPeople().some((x) => x.id === id)
    if (!exists || overwrite) {
      if (!dryRun) savePerson(p.meta)
      stats.people++
    }

    // 事实：appendFacts 自带"同文本合并不重复"和删过的不回流
    const incomingFacts = Array.isArray(p.facts) ? p.facts : []
    if (incomingFacts.length) {
      const have = new Set(loadFacts(id).map((f) => f.text))
      const add = overwrite ? incomingFacts : incomingFacts.filter((f) => f.text && !have.has(f.text))
      if (add.length) {
        if (!dryRun) appendFacts(id, add)
        stats.facts += add.length
      }
    }

    // 待办：appendOpen 自带去重
    const incomingOpen = Array.isArray(p.open) ? p.open : []
    if (incomingOpen.length) {
      const have = new Set(loadOpen(id).map((o) => o.text))
      const add = overwrite ? incomingOpen : incomingOpen.filter((o) => o.text && !have.has(o.text))
      if (add.length) {
        if (!dryRun) appendOpen(id, add)
        stats.open += add.length
      }
    }

    // 关系：只有"当前是空的"才恢复（否则会把现在的关系冲掉）
    const rel = p.relation
    if (rel && typeof rel.closeness === 'number') {
      const cur = loadRelation(id)
      const isEmpty = cur.closeness <= 0 && cur.anchors.length === 0
      if (overwrite || isEmpty) {
        if (!dryRun) saveRelation(id, rel)
      } else {
        stats.skipped++
      }
    }

    // 画像 / 印象：文件不存在才写
    if (typeof p.profile === 'string' && p.profile.trim()) {
      const has = existsSync(profilePath(id))
      if (overwrite || !has) {
        if (!dryRun) saveProfile(id, p.profile)
      }
    }
    if (typeof p.impression === 'string' && p.impression.trim()) {
      const target = join(personDir(id), 'impression.md')
      if (overwrite || !existsSync(target)) {
        if (!dryRun) {
          ensureDir(personDir(id))
          writeAtomic(target, p.impression.endsWith('\n') ? p.impression : `${p.impression}\n`)
        }
      }
    }

    // 删过的黑名单：补进去，免得恢复后又被模型记回来
    if (Array.isArray(p.deleted) && p.deleted.length) {
      const have = new Set(loadDeleted(id))
      const add = p.deleted.filter((t) => typeof t === 'string' && t.trim() && !have.has(t))
      if (add.length && !dryRun) {
        ensureDir(personDir(id))
        for (const text of add) appendJsonl(join(personDir(id), 'deleted.jsonl'), { at: Date.now(), text })
      }
    }
  }

  /* ---------- 经历 ---------- */
  const existing = new Set(loadEpisodes().map((e) => `${e.scope}\u0000${e.id}`))
  for (const ep of data.episodes) {
    const id = typeof ep['id'] === 'string' ? ep['id'] : ''
    const scope = typeof ep['scope'] === 'string' ? (ep['scope'] as Scope) : ''
    const title = typeof ep['title'] === 'string' ? ep['title'] : ''
    if (!id || !scope || !title) {
      stats.skipped++
      continue
    }
    const key = `${scope}\u0000${id}`
    if (!overwrite && existing.has(key)) continue
    if (!dryRun) {
      saveEpisode({
        id,
        date: typeof ep['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep['date']) ? ep['date'] : dateKeyOf(Date.now()),
        scope,
        importance: Math.min(10, Math.max(1, Number(ep['importance'] ?? 5))),
        ...(typeof ep['emotion'] === 'string' ? { emotion: ep['emotion'] } : {}),
        title,
        body: typeof ep['body'] === 'string' ? ep['body'] : '',
        ...(Array.isArray(ep['related']) ? { related: ep['related'] as string[] } : {}),
      })
    }
    existing.add(key)
    stats.episodes++
  }

  /* ---------- 洞察 ---------- */
  const validInsights = data.insights.filter((i) => i && typeof i.text === 'string' && i.text.trim().length > 1)
  if (validInsights.length) {
    if (!dryRun) appendInsights(validInsights)
    stats.insights += validInsights.length
  }

  /* ---------- 原始对话 ---------- */
  // 按 ts 落在哪一天写哪个文件（appendRaw 固定写今天，会写错日期）
  const seenRaw = new Set<string>()
  for (const t of data.raw) {
    if (!t || typeof t.ts !== 'number' || !Number.isFinite(t.ts) || typeof t.text !== 'string') {
      stats.skipped++
      continue
    }
    const key = `${t.ts}\u0000${t.scope}\u0000${t.text}`
    if (seenRaw.has(key)) continue
    seenRaw.add(key)
    if (!dryRun) {
      appendRawAt({
        ts: t.ts,
        scope: typeof t.scope === 'string' ? (t.scope as Scope) : 'shared',
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: t.text,
        ...(typeof t.senderId === 'string' ? { senderId: t.senderId } : {}),
      })
    }
    stats.raw++
  }

  /* ---------- 会话 ---------- */
  for (const s of data.sessions) {
    const key = typeof s['key'] === 'string' ? s['key'] : ''
    if (!key) continue
    const cur = loadSession(key)
    const incomingTurns = Array.isArray(s['turns']) ? (s['turns'] as unknown[]) : []
    const merged = mergeTurns(cur.turns, incomingTurns, overwrite)
    const incomingSummary = typeof s['summary'] === 'string' ? s['summary'] : ''
    const summary = overwrite ? incomingSummary : pickLongerSummary(cur.summary, incomingSummary)
    if (!dryRun) saveSession({ ...cur, key, turns: merged, summary })
    stats.sessions++
  }
  if (stats.sessions && !dryRun) clearSessions()

  /* ---------- 人格 / 配置文件 ---------- */
  const fileList = opts.includeConfig ? [...CONTENT_FILES, ...CONFIG_FILES] : CONTENT_FILES
  for (const [name, target] of fileList) {
    const content = data.files[name]
    if (typeof content !== 'string' || !content.trim()) continue
    if (!dryRun) {
      ensureDir(dirname(target))
      writeAtomic(target, content)
    }
    stats.files.push(name)
  }

  return stats
}

type Turn = { role: 'user' | 'assistant'; content: string; at: number }

function mergeTurns(current: Turn[], incoming: unknown[], overwrite: boolean): Turn[] {
  const valid = incoming.filter((t): t is Turn => {
    if (!t || typeof t !== 'object') return false
    const x = t as { role?: unknown; content?: unknown; at?: unknown }
    return (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && typeof x.at === 'number'
  })

  if (overwrite) return valid
  const seen = new Set(current.map((t) => `${t.at}\u0000${t.role}\u0000${t.content}`))
  const add = valid.filter((t) => !seen.has(`${t.at}\u0000${t.role}\u0000${t.content}`))
  return [...current, ...add].sort((a, b) => a.at - b.at).slice(-60)
}

function pickLongerSummary(a: string, b: string): string {
  // 两份摘要都"对"，长的那份信息更多；硬拼两份容易变成流水账
  return (b ?? '').length > (a ?? '').length ? b : a
}
