/**
 * 一次性迁移：把旧的"单用户"数据搬到 people/<personId>/ 下。
 * 用法：node --env-file=.env scripts/migrate-people.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { initLog, info, warn } from '../src/core/log.ts'
import { ensurePerson, personDir, personIdOf } from '../src/people/store.ts'
import { appendFacts, loadFacts } from '../src/memory/facts.ts'
import { appendOpen, loadOpen } from '../src/people/open.ts'
import { saveMood } from '../src/persona/mood.ts'
import { writeAtomic } from '../src/store/fs.ts'

initLog('', false)

const owner = process.env['OWNER_QQ']
if (!owner) {
  console.error('缺少 OWNER_QQ')
  process.exit(1)
}

const pid = personIdOf('qq', owner)
ensurePerson('qq', owner, '主人')
mkdirSync(personDir(pid), { recursive: true })
info(`目标目录：${personDir(pid)}`)

/* ---------- facts ---------- */
const oldFacts = 'persona/memory/facts.md'
if (existsSync(oldFacts)) {
  if (loadFacts(pid).length > 0) {
    warn('新位置已有 facts，跳过迁移（避免重复）')
  } else {
    const lines = readFileSync(oldFacts, 'utf8').split(/\r?\n/)
    const items: Array<{ text: string; date: string; confidence: number; visibility: 'private'; source?: string }> = []
    for (const line of lines) {
      // 旧格式：- 内容（2026-10-25，置信 0.9）｜来源
      const m = /^-\s+(.+?)（(\d{4}-\d{2}-\d{2})，置信\s*([\d.]+)）(?:\｜(.+))?\s*$/.exec(line.trim())
      if (m) {
        items.push({
          text: m[1]!,
          date: m[2]!,
          confidence: Number(m[3]),
          visibility: 'private', // 旧数据全部按私密处理
          ...(m[4] ? { source: m[4].trim() } : {}),
        })
      }
    }
    if (items.length) {
      appendFacts(pid, items)
      info(`迁移事实 ${items.length} 条（全部标为私密）`)
    }
  }
}

/* ---------- open ---------- */
const oldOpen = 'persona/memory/open.md'
if (existsSync(oldOpen) && loadOpen(pid).length === 0) {
  const items: Array<{ text: string; date: string; kind: 'todo' | 'pending' }> = []
  for (const line of readFileSync(oldOpen, 'utf8').split(/\r?\n/)) {
    const m = /^-\s+\[(todo|pending)\]\s+(.+?)（(\d{4}-\d{2}-\d{2})）\s*$/.exec(line.trim())
    if (m) items.push({ kind: m[1] as 'todo' | 'pending', text: m[2]!, date: m[3]! })
  }
  if (items.length) {
    appendOpen(pid, items)
    info(`迁移待办 ${items.length} 条`)
  }
}

/* ---------- profile ---------- */
const oldProfile = 'persona/profile.md'
if (existsSync(oldProfile)) {
  const dest = join(personDir(pid), 'profile.md')
  if (!existsSync(dest)) {
    writeAtomic(dest, readFileSync(oldProfile, 'utf8'))
    info('迁移画像 1 份')
  }
}

/* ---------- relation + mood ---------- */
const oldRelation = 'persona/relation.yaml'
if (existsSync(oldRelation)) {
  const dest = join(personDir(pid), 'relation.yaml')
  if (!existsSync(dest)) {
    const raw = YAML.parse(readFileSync(oldRelation, 'utf8')) as Record<string, unknown>
    const mood = raw['当前心情'] as { 情绪?: string; 强度?: number; 时间?: string } | undefined

    // 关系本体搬过去，去掉心情
    const relation = {
      总关系值: Number(raw['总关系值'] ?? 0),
      锚点: raw['锚点'] ?? [],
      维度事件: raw['维度事件'] ?? {},
    }
    writeAtomic(dest, `${YAML.stringify(relation)}\n`)
    info('迁移关系 1 份')

    // 心情拆到全局
    if (mood?.情绪) {
      saveMood({
        emotion: mood.情绪,
        intensity: Number(mood.强度 ?? 0.3),
        at: typeof mood.时间 === 'string' ? Date.parse(mood.时间) || Date.now() : Date.now(),
      })
      info('心情已拆到 persona/mood.yaml')
    }
  }
}

/* ---------- 把旧文件改名留档 ---------- */
for (const f of ['persona/profile.md', 'persona/relation.yaml', 'persona/memory/facts.md', 'persona/memory/open.md']) {
  if (existsSync(f)) {
    try {
      renameSync(f, `${f}.migrated`)
      info(`旧文件已留档：${f}.migrated`)
    } catch {
      warn(`留档失败：${f}`)
    }
  }
}

info('迁移完成')
