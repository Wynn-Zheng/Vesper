import type { Episode, Insight, RawTurn, Recalled, Scope } from './types.ts'
import { loadFacts, effectiveConfidence } from './facts.ts'
import { loadEpisodes, loadInsights, recentRaw, saveEpisode } from './store.ts'
import { loadOpen, type OpenItem } from '../people/open.ts'

import { similarity } from '../core/text.ts'

export { similarity }

/**
 * 可见性规则（三个人以上的世界）：
 * - 私聊：自己的私聊 + 公共的。**绝不带出别人的私聊**
 * - 群聊：公共的 + 本群
 * 记住：scope 是会话，不是人。私聊 scope 里存的是"和这个人之间发生的事"。
 */
export function visible(scope: Scope, current: Scope): boolean {
  if (current.startsWith('private:')) {
    return scope === current || scope === 'shared'
  }
  return scope === 'shared' || scope === current
}

const DAY = 86_400_000

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 衰减速度由重要性决定：重要的事忘得慢。
 * 数值从 rules.yaml 的 记忆.衰减 读，不写死——不然改了配置不生效。
 */
export function lambdaOf(importance: number, decay?: Record<string, number>): number {
  const high = finiteOr(decay?.['高情绪'], 0.005)
  const normal = finiteOr(decay?.['普通'], 0.02)
  // 坏数据（NaN / 越界）按普通重要度算，至少还能正常排序
  const imp = Number.isFinite(importance) ? Math.min(10, Math.max(0, importance)) : 5
  if (imp >= 8) return high
  if (imp >= 5) return normal
  return normal * 2
}

function episodeRef(e: Episode): number {
  if (e.lastRecalled && e.lastRecalled > 0) return e.lastRecalled
  const t = Date.parse(`${e.date}T00:00:00`)
  return Number.isNaN(t) ? Date.now() - 30 * DAY : t
}

export interface Weights {
  新近: number
  相关: number
  重要: number
}

export interface RecallOptions {
  /** 当前说话的人；决定读谁的 facts / open */
  personId: string
  scope: Scope
  query: string
  limit: number
  weights: Weights
  /** 低于这个分数不返回 */
  minScore?: number
  /** 衰减速度，来自 rules.yaml 的 记忆.衰减 */
  decay?: Record<string, number>
  /** 群聊时：是否允许提到别人的公开事实 */
  allowOthers?: boolean
  now?: number
}

interface Scored<T> {
  item: T
  score: number
}

/**
 * 新近度：幂律衰减。
 *
 * 为什么不是指数：
 *   Wixted & Ebbesen (1991, Psychological Science 2(6):409-415) 比了 6 种函数
 *   （线性/指数/指数-幂/双曲/对数/幂），结论是**幂函数**最好地描述了遗忘，
 *   而且重分析 Ebbinghaus (1885) 的原始数据也是幂律。
 *   Murre & Dros (2015, PLOS ONE) 复现了这个结论。
 *
 * 实际差别：
 *   指数 e^(-0.02t)：30 天 0.55，90 天 0.17，365 天 0.0006（基本归零）
 *   幂律 (1+t)^(-0.16)：30 天 0.60，90 天 0.47，365 天 0.36（有长尾）
 *
 * 这解释了"很久以前的事虽然模糊，但还记得有那么回事"。
 *
 * 系数 8 是我拍的：让 lambda=0.02 时半衰期仍在 30 天附近，
 * 保持现有 rules.yaml 参数的手感。要调就调这个 8。
 */
function recencyOf(days: number, lambda: number, recallCount = 0): number {
  // 平滑项：幂律在 t=0 时是无穷，加 1 避免
  const base = Math.pow(1 + Math.max(0, days), -lambda * 8)

  // 回忆过 N 次的，衰减变慢（Roediger & Karpicke 2006 的"测试效应"：
  // 主动回忆比重复阅读对长期记忆有效得多）
  if (recallCount <= 0) return base
  const slowdown = 1 / (1 + Math.log(1 + recallCount) * 0.5)
  return Math.pow(1 + Math.max(0, days), -lambda * 8 * slowdown)
}

function scoreOf(
  refTs: number,
  lambda: number,
  text: string,
  importance: number,
  query: string,
  w: Weights,
  now: number,
  recallCount = 0,
): number {
  const days = Math.max(0, (now - refTs) / DAY)
  const recency = recencyOf(days, lambda, recallCount)
  const relevance = similarity(query, text)
  const impRaw = Number.isFinite(importance) ? importance : 5
  const imp = Math.min(1, Math.max(0, impRaw / 10))
  return recency * w.新近 + relevance * w.相关 + imp * w.重要
}

// ---- 召回记账：内存里攒，定期落盘 ----
// id 只在 scope 目录里唯一：同一天不同会话都可能叫 2026-10-26-01。
// 只按 id 记账会把别的会话/别人的经历一起标成"刚想起"。
function episodeKey(e: Episode): string {
  return `${e.scope}\u0000${e.id}`
}

const pendingMarks = new Map<string, number>()
let flushTimer: NodeJS.Timeout | null = null

function markRecalled(eps: Episode[], now: number): void {
  if (!eps.length) return
  for (const e of eps) pendingMarks.set(episodeKey(e), now)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushRecalls()
  }, 5 * 60_000)
  flushTimer.unref?.()
}

export function flushRecalls(): void {
  if (!pendingMarks.size) return
  const all = loadEpisodes()
  for (const e of all) {
    const ts = pendingMarks.get(episodeKey(e))
    if (ts) {
      e.lastRecalled = ts
      // 记次数，不只是记时间。
      // 每被想起一次，以后就忘得慢一点——这是"测试效应"的实现
      // （Roediger & Karpicke 2006）：主动回忆比重复阅读更能巩固长期记忆。
      e.recallCount = (e.recallCount ?? 0) + 1
      saveEpisode(e)
    }
  }
  pendingMarks.clear()
}

export function pendingRecallCount(): number {
  return pendingMarks.size
}

/** 按三维加权召回。返回的是"想起什么"，不是原文。 */
export function recall(opts: RecallOptions): Recalled {
  const { personId, scope, query, limit, weights } = opts
  const now = opts.now ?? Date.now()

  const allFacts = loadFacts(personId)
  // 按"有效置信度"排：越久没被提到的越靠后，太旧的不注入
  // 群聊里只注入公开的：私事在公共场合没有该出现的理由
  const isPrivateScope = scope.startsWith('private:')
  const facts = allFacts
    // 「重要」的事衰减慢（139 天半衰期），「平常」按正常节奏（35 天）。
    // 老数据没有 tier → 当 normal，和以前行为一致。
    .map((f) => ({ f, eff: effectiveConfidence(f, now, f.tier === 'major' ? 0.005 : 0.023) }))
    .filter((x) => x.eff >= 0.2)
    .filter((x) => isPrivateScope || x.f.visibility === 'public')
    .sort((a, b) => b.eff - a.eff)
    .slice(0, 8)
    .map((x) => x.f)

  const episodes = loadEpisodes().filter((e) => visible(e.scope, scope))
  const insights = loadInsights().filter((i) => visible(i.scope, scope))

  const epScored: Scored<Episode>[] = episodes
    .map((e) => ({
      item: e,
      score: scoreOf(
        episodeRef(e),
        // 高情绪的记忆衰减慢（McGaugh 2004：杏仁核在情绪唤起时加强巩固）
        lambdaOf(e.importance, opts.decay),
        `${e.title} ${e.body}`,
        e.importance,
        query,
        weights,
        now,
        // 被想起过几次，影响衰减速度
        e.recallCount ?? 0,
      ),
    }))
    .sort((a, b) => b.score - a.score)

  const inScored: Scored<Insight>[] = insights
    .map((i) => {
      const t = Date.parse(`${i.date}T00:00:00`)
      const ref = Number.isNaN(t) ? now - 30 * DAY : t
      return { item: i, score: scoreOf(ref, 0.02, i.text, 6, query, weights, now) }
    })
    .sort((a, b) => b.score - a.score)

  const picked = epScored
    .filter((s) => s.score >= (opts.minScore ?? 0))
    .slice(0, limit)
    .map((s) => s.item)

  // 最近三天的事无条件带上：人本来就会自然想起最近发生的事，跟话题无关
  // 顺序上放在高分的后面：相关的优先，最近的兜底
  const recentEps = episodes
    .filter((e) => {
      const t = Date.parse(`${e.date}T00:00:00`)
      return !Number.isNaN(t) && (now - t) / DAY <= 3
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 3)

  const merged: Episode[] = []
  const seen = new Set<string>()
  for (const e of [...picked, ...recentEps]) {
    const key = episodeKey(e)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(e)
    }
  }
  const finalEps = merged.slice(0, Math.max(limit, 3))

  markRecalled(finalEps, now)

  const recent: RawTurn[] = recentRaw(3)
    .filter((t) => visible(t.scope, scope))
    .slice(-4)

  // 待办按人：只有私聊才注入他自己的；群里不注入（那是私事清单）
  const open: OpenItem[] = scope.startsWith('private:') ? loadOpen(personId).slice(-5) : []

  return {
    facts,
    episodes: finalEps,
    insights: inScored.slice(0, Math.min(3, limit)).map((s) => s.item),
    open,
    recent,
  }
}

/** 把召回结果渲染成一段给模型看的文字。 */
export function renderRecalled(r: Recalled): string {
  const parts: string[] = []

  if (r.facts.length) {
    parts.push('【关于他，我记得】')
    for (const f of r.facts) {
      const tag = f.visibility === 'public' ? '' : f.visibility === 'private' ? '（私事，对着别人别说）' : '（还没确认能不能说）'
      parts.push(`- ${f.text}${tag}${f.source ? `（他当时说：${f.source}）` : ''}`)
    }
  }

  if (r.episodes.length) {
    parts.push('')
    parts.push('【我想起来的事】')
    for (const e of r.episodes) {
      parts.push(`- ${e.date}｜${e.title}${e.emotion ? `（当时：${e.emotion}）` : ''}`)
      if (e.body) parts.push(`  ${e.body}`)
    }
  }

  if (r.insights.length) {
    parts.push('')
    parts.push('【我对他的一些看法】')
    for (const i of r.insights) parts.push(`- ${i.text}`)
  }

  if (r.open.length) {
    parts.push('')
    parts.push('【还没问完 / 答应过的事】')
    for (const o of r.open) {
      parts.push(`- ${o.text}${o.kind === 'pending' ? '（我还没把握，想确认一下）' : ''}`)
    }
  }

  if (r.recent.length) {
    parts.push('')
    parts.push('【最近说过的话】')
    for (const t of r.recent) parts.push(`${t.role === 'user' ? '他' : '我'}：${t.text}`)
  }

  return parts.join('\n')
}
