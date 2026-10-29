import { existsSync, readFileSync } from 'node:fs'
import { loadFacts } from '../memory/facts.ts'
import { loadEpisodes, readRaw } from '../memory/store.ts'
import { loadOpen } from '../people/open.ts'
import { accountIdsOf, listPeople } from '../people/store.ts'
import { similarity } from '../core/text.ts'
import { loadLearnings } from '../persona/learnings.ts'

/** 一条搜索结果 */
export interface Hit {
  kind: 'fact' | 'open' | 'episode' | 'raw' | 'log' | 'learn'
  /** 展示用标题 */
  title: string
  /** 展示用正文 */
  body?: string
  /** 定位信息：日期、id 等 */
  meta: string
  /** 相关度，排序用 */
  score: number
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface SearchOptions {
  query: string
  /** 当前看的人；空表示搜全部 */
  personId?: string
  types?: Array<Hit['kind']>
  limit?: number
  /** 原文和日志往前找几天 */
  days?: number
}

/**
 * 跨记忆和日志搜一遍。
 * 不是语义搜索——就是"我记得大概这么说过"这种场景，
 * 关键词 + 相似度足够了，不需要引向量库。
 */
export function search(opts: SearchOptions): Hit[] {
  const q = opts.query.trim()
  if (!q) return []
  const types = new Set(opts.types?.length ? opts.types : (['fact', 'open', 'episode', 'raw', 'log', 'learn'] as const))
  const limit = opts.limit ?? 60
  const days = Math.min(30, Math.max(1, opts.days ?? 7))
  const hits: Hit[] = []

  const people = opts.personId ? listPeople().filter((p) => p.id === opts.personId) : listPeople()

  for (const p of people) {
    if (types.has('fact')) {
      for (const f of loadFacts(p.id)) {
        const s = similarity(q, f.text)
        if (s > 0.1 || f.text.includes(q)) {
          hits.push({
            kind: 'fact',
            title: f.text,
            meta: `${p.name} · ${f.date} · ${f.visibility === 'public' ? '公开' : f.visibility === 'private' ? '私密' : '待确认'}`,
            score: s,
          })
        }
      }
    }
    if (types.has('open')) {
      for (const o of loadOpen(p.id)) {
        const s = similarity(q, o.text)
        if (s > 0.1 || o.text.includes(q)) {
          hits.push({ kind: 'open', title: o.text, meta: `${p.name} · ${o.date} · ${o.kind === 'todo' ? '待办' : '待确认'}`, score: s })
        }
      }
    }
  }

  if (types.has('episode')) {
    const accounts = new Set<string>()
    for (const p of people) for (const a of accountIdsOf(p.id)) accounts.add(`private:${a}`)
    for (const e of loadEpisodes()) {
      if (opts.personId && !accounts.has(e.scope) && e.scope !== 'shared') continue
      const s = similarity(q, `${e.title} ${e.body}`)
      if (s > 0.1 || e.title.includes(q) || e.body.includes(q)) {
        hits.push({ kind: 'episode', title: e.title, body: e.body.slice(0, 160), meta: `${e.date} · ${e.scope}`, score: s })
      }
    }
  }

  // 它自己学到的东西（知识/道理/说话方式/用户指派）
  if (types.has('learn')) {
    for (const l of loadLearnings()) {
      const s = similarity(q, l.text)
      if (s > 0.1 || l.text.includes(q)) {
        hits.push({
          kind: 'learn',
          title: l.text,
          meta: `${l.kind} · ${new Date(l.at).toLocaleDateString('zh-CN')} · ${l.source === 'user' ? '你让它学的' : '它自己记的'}`,
          score: s,
        })
      }
    }
  }
  if (types.has('raw') || types.has('log')) {
    for (let i = 0; i < days; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = ymd(d)

      if (types.has('raw')) {
        for (const t of readRaw(key)) {
          if (opts.personId && !t.scope.startsWith('private:') && t.scope !== 'shared') {
            // 群聊原文不按人过滤
          }
          if (!t.text.includes(q)) continue
          hits.push({ kind: 'raw', title: t.text.slice(0, 120), meta: `${key} ${new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${t.role === 'user' ? '他' : '我'}`, score: 0.5 })
        }
      }

      if (types.has('log')) {
        const file = `data/logs/${key}.jsonl`
        if (!existsSync(file)) continue
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes(q)) continue
          try {
            const r = JSON.parse(line) as { ts: number; level: string; msg: string; extra?: Record<string, unknown> }
            hits.push({
              kind: 'log',
              title: r.msg + (r.extra ? ' ' + JSON.stringify(r.extra).slice(0, 100) : ''),
              meta: `${key} ${new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${r.level}`,
              score: 0.4,
            })
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** 最近几天的日期（给"按天浏览"用） */
export function recentDates(days = 7): string[] {
  const out: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(ymd(d))
  }
  return out
}


