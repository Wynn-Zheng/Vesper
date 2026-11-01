import type { Episode, Insight, RawTurn, Recalled, Scope } from './types.ts'
import { loadFacts, effectiveConfidence } from './facts.ts'
import { loadEpisodes, loadInsights, readRaw, saveEpisode } from './store.ts'
import { loadOpen, type OpenItem } from '../people/open.ts'
// 从 QQ 号查显示名：raw 里只存 senderId，渲染给模型看时要能对上人，
// 否则一串「他：」分不清谁说的。实现在 people/store（原来这里抄了一份）。
import { displayNameOfAccount } from '../people/store.ts'

import { bm25, parseTimeHint, sharedBigrams, similarity } from '../core/text.ts'
import { rerank } from './rerank.ts'

export { similarity }

/**
 * 可见性规则（三个人以上的世界）：
 * - 私聊：自己的私聊 + 公共的。**绝不带出别人的私聊**
 * - 群聊：公共的 + 本群
 * - 控制台：主人私聊的 + 自己的 + 公共的
 *
 * 记住：scope 是会话，不是人。私聊 scope 里存的是"和这个人之间发生的事"。
 *
 * 控制台的 scope 是 `private:console-<主人QQ>`：
 *   - **读**放开到主人私聊——用户要的是"能想起之前在 QQ 里聊过什么"
 *   - **写**只写自己——控制台说的话不污染正式记忆
 * 写那边的隔离不靠这个函数，靠调用方传的 scope（永远是 private:console-xxx）。
 */
/**
 * 私聊 scope 归一化。
 *
 * 盘上同时存在两种拼写：`private:<QQ>`（现行，scopeOf 产出）和
 * `private:qq-<QQ>`（历史 episodes 的 frontmatter）。不做归一化的话
 * `visible()` 的全等比较会让当前私聊**一条旧经历都读不到**——
 * 它想不起以前聊过什么，而且不会有任何报错。
 */
function normScope(s: Scope): string {
  return s.replace(/^private:qq-/, 'private:')
}

export function visible(scope: Scope, current: Scope): boolean {
  const consoleMatch = /^private:console-(.+)$/.exec(current)
  if (consoleMatch) {
    const owner = consoleMatch[1]!
    // 主人私聊、控制台自己的历史、公共的，都读。
    // 私聊 scope 的两种历史拼写都要认（见 normScope）。
    return (
      scope === 'shared' ||
      scope === current ||
      normScope(scope) === `private:${owner}` ||
      normScope(scope) === `private:qq-${owner}`
    )
  }
  if (current.startsWith('private:')) {
    // 两种历史拼写视为同一会话（见 normScope）
    return scope === 'shared' || normScope(scope) === normScope(current)
  }
  return scope === 'shared' || scope === current
}

const DAY = 86_400_000

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 取最近 want 条"这个会话能看见"的原文。
 *
 * 原来是 `recentRaw(3).filter(...).slice(-8)`：把三天所有会话的记录全读出来，
 * 只留 8 条。群多、人多的时候是纯 IO 浪费。现在从今天往前逐天读，凑够就停。
 */
function recentVisible(scope: Scope, want: number, maxDays = 3): RawTurn[] {
  const days: RawTurn[][] = []
  let total = 0
  for (let i = 0; i < maxDays && total < want; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const vis = readRaw(dateKey(d)).filter((t) => visible(t.scope, scope))
    if (vis.length) {
      days.push(vis)
      total += vis.length
    }
  }
  // 从今天往前读，翻回来才是时间正序
  return days.reverse().flat().sort((a, b) => a.ts - b.ts).slice(-want)
}

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

/**
 * episode 专用的衰减速率。
 *
 * 和 lambdaOf 的区别：**看 emotion 字段，不只看 importance**。
 *
 * 为什么必须区分：
 *   实测 9 条 episode 的 importance 全是 2-3（分布 {2:2, 3:7}），
 *   而 lambdaOf 要求 >= 8 才算高情绪 —— **那条分支一次都没触发过**，
 *   所有 episode 都在用 17 天半衰期，包括「凌晨两点他失眠说想看我成长」。
 *   但 9 条 episode 的 emotion **100% 有值**。
 *
 * 依据：McGaugh (2004, Annual Review of Neuroscience) —— 杏仁核在**情绪唤起**时
 * 加强海马对这段经历的巩固，剂量相关。文献说的是情绪，不是主观评分。
 */
export function lambdaOfEpisode(e: Episode, decay?: Record<string, number>): number {
  const high = finiteOr(decay?.['高情绪'], 0.005)
  const normal = finiteOr(decay?.['普通'], 0.02)
  const imp = Number.isFinite(e.importance) ? Math.min(10, Math.max(0, e.importance)) : 5

  // 有情绪记录 + 至少有点重要性 → 高情绪档。
  // 门槛定 3：现有数据 7 条是 3、2 条是 2，刚好分开。
  if (e.emotion?.trim() && imp >= 3) return high

  // 没有情绪记录但重要性很高 → 也进高档
  if (imp >= 8) return high

  return imp >= 5 ? normal : normal * 2
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
  // 关键词召回：事实也过一遍 BM25（和 episodes 一个道理）
  const factBm25 = bm25(query, allFacts.map((f) => f.text))
  const factBmMax = Math.max(0, ...factBm25)
  const scoredFacts = allFacts
    // 被新说法取代的旧事实不再注入（文件里留着，能人工恢复）
    .filter((f) => !f.supersededAt)
    // 「重要」的事衰减慢（139 天半衰期），「平常」按正常节奏（35 天）。
    // 老数据没有 tier → 当 normal，和以前行为一致。
    .map((f, i) => ({
      f,
      eff: effectiveConfidence(f, now, f.tier === 'major' ? 0.005 : 0.023),
      bm: factBmMax > 0 ? (factBm25[i] ?? 0) / factBmMax : 0,
    }))
    .filter((x) => isPrivateScope || x.f.visibility === 'public')

  // 能正常调出来的：置信度高 **或** 关键词命中强
  // （后者是为了「问折纸能想起折纸那条」——它可能置信度已经掉到阈值以下了）
  const strong = scoredFacts
    .filter((x) => x.eff >= 0.2 || x.bm >= 0.6)
    .sort((a, b) => b.eff + b.bm * 0.4 - (a.eff + a.bm * 0.4))
    .slice(0, 8)
    .map((x) => x.f)

  // 很久没提、置信度已经掉到 0.2 以下的——
  // **不删，只是默认调不出来**（Bjork 的「新失用理论」：遗忘是提取失败，不是痕迹消失）。
  // 但如果这次的话题和它高度相关，仍然能捞出来，让"提到老事还能想起来"成立。
  //
  // 判据用「共同 bigram 数 >= 2」而不是相似度，实测数据：
  //   「你那只猫豆豆还好吗」vs「他养过一只猫叫豆豆」  sim 0.143 / 共同 2  ← 相关
  //   「四级考得怎么样」  vs「他养过一只猫叫豆豆」  sim 0.000 / 共同 0  ← 无关
  //   「你还在学英语吗」  vs「他在学英语，也在学计算机」sim 0.231 / 共同 3  ← 相关
  // bigram Jaccard 对短句天然偏低，用相似度当门槛会全部漏掉。
  const faint = query.trim()
    ? scoredFacts
        .filter((x) => x.eff < 0.2)
        .map((x) => ({ f: x.f, shared: sharedBigrams(query, x.f.text) }))
        .filter((x) => x.shared >= 2)
        .sort((a, b) => b.shared - a.shared)
        .slice(0, 2)
        .map((x) => x.f)
    : []

  // 合并去重（faint 可能和 strong 重叠，虽然理论上不会）
  //
  // 除了完全相同，还要挡住"说法几乎一样的重复事实"——distill 有时会把
  // 同一件事分两次写进来（「他十点有课」/「他十点钟上课」）。这类只留一条，
  // 否则 8 个名额被同一件事占掉两个。
  const strongTexts = new Set(strong.map((f) => f.text))
  const facts: typeof strong = []
  const seenFactTexts: string[] = []
  for (const f of [...strong, ...faint.filter((x) => !strongTexts.has(x.text))]) {
    if (seenFactTexts.some((t) => similarity(t, f.text) >= 0.85)) continue
    seenFactTexts.push(f.text)
    facts.push(f)
  }
  // 给捞回来的老事实打个标记，渲染时说明"很久没提了"
  const faintTexts = new Set(faint.map((f) => f.text))
  for (const f of facts) if (faintTexts.has(f.text)) f.faint = true

  const episodes = loadEpisodes().filter((e) => visible(e.scope, scope))
  const insights = loadInsights().filter((i) => visible(i.scope, scope))

  /* ---- 三路召回：语义（scoreOf） + 关键词（BM25） + 时间窗口 ----
   *
   * 只有语义的问题：问「折纸那事」时，记忆里写的是「厚纸折之前先用指甲划一道」，
   * Jaccard 相似度很低 → 排不上去。BM25 靠单字+bigram 能抓到。
   *
   * 只有时间的：问「昨天说的」时，相似度算的是"内容像不像"，
   * 但用户问的是"什么时间的事"——得单独按日期过滤。
   */
  const timeHint = parseTimeHint(query, now)
  const epTexts = episodes.map((e) => `${e.title} ${e.body}`)
  const epBm25 = bm25(query, epTexts)
  const epBmMax = Math.max(0, ...epBm25)

  const epScored: Scored<Episode>[] = episodes
    .map((e, i) => {
      let score = scoreOf(
        episodeRef(e),
        // 高情绪的记忆衰减慢（McGaugh 2004：杏仁核在情绪唤起时加强巩固）
        lambdaOfEpisode(e, opts.decay),
        epTexts[i]!,
        e.importance,
        query,
        weights,
        now,
        // 被想起过几次，影响衰减速度
        e.recallCount ?? 0,
      )
      // 关键词加成：归一化到 0-1 再加，权重 0.35
      // （不直接加原始 BM25 分：它的量纲跟语义分差一个数量级，会把语义完全压掉）
      if (epBmMax > 0) score += ((epBm25[i] ?? 0) / epBmMax) * 0.35
      // 时间窗口加成：用户明确问"昨天/上周"时，落在窗口里的才该排前面
      if (timeHint) {
        const t = Date.parse(`${e.date}T00:00:00`)
        if (!Number.isNaN(t) && t >= timeHint.from && t <= timeHint.to) score *= 1.3
      }
      // 时序方向："后来呢"要把近的排前面，"最早那次"要把早的排前面。
      // 幅度得够大（±25%）：实测 ±12% 会被相关性分数盖过去，排序看不出来。
      // 用 30 天做尺度——超过一个月就算"很早以前"，不再继续加大差别。
      if (timeHint?.order) {
        const t = Date.parse(`${e.date}T00:00:00`)
        if (!Number.isNaN(t)) {
          const days = Math.max(0, (now - t) / DAY)
          const tilt = Math.min(1, days / 30)
          score *= timeHint.order === 'desc' ? 1.25 - tilt * 0.5 : 0.75 + tilt * 0.5
        }
      }
      return { item: e, score }
    })
    .sort((a, b) => b.score - a.score)

  const inScored: Scored<Insight>[] = insights
    .map((i) => {
      const t = Date.parse(`${i.date}T00:00:00`)
      const ref = Number.isNaN(t) ? now - 30 * DAY : t
      let score = scoreOf(ref, 0.02, i.text, 6, query, weights, now)
      // 洞察也补关键词分：它比 episode 短，一条常常就是一句判断，
      // 关键词命中的信号比"语义相似"更准。
      const bm = bm25(query, [i.text])[0] ?? 0
      if (bm > 0) score += Math.min(1, bm) * 0.3
      return { item: i, score }
    })
    .sort((a, b) => b.score - a.score)

  // 第一阶段捞得多一点（20 条），第二阶段再挑 —— 只取 limit 就没什么好挑的
  /* ---- 关联链加权（1-hop 图扩展）----
   *
   * episode 的 `related` 字段记的是"这件事和哪几件事有关"
   * （同一件事的不同片段、前后因果）。原来它只在"名额没满"时补位，
   * 等于完全不参与排序。
   *
   * 但人想起一件事，经常是顺带想起和它连着的事。所以：
   *   先看排前面几条都关联到谁 → 给那些关联对象加一笔分 → 重新排
   *
   * 幅度 0.18，比相关性（0.5 权重）小得多——保证"直接命中的永远优先",
   * 关联只是让"顺带想起来的"能挤进名额。
   */
  {
    const seedIds = new Set(
      [...epScored.slice(0, 3)].flatMap((s) => s.item.related ?? []),
    )
    if (seedIds.size) {
      for (const s of epScored) if (seedIds.has(s.item.id)) s.score += 0.18
      epScored.sort((a, b) => b.score - a.score)
    }
  }

  const picked = rerank(query, epScored.filter((s) => s.score >= (opts.minScore ?? 0)), {
    limit,
    now,
    titleOf: (x) => String((x as Episode).title ?? ''),
    textOf: (x) => `${(x as Episode).title} ${(x as Episode).body}`,
  }).map((r) => r.item)

  // 有明确时序方向词时（"后来呢""最开始那次"），最终结果按时间排。
  //
  // 为什么不靠分数加权：实测 ±25% 也压不过相关性——「后来呢」问的是
  // 时间顺序，而含"记忆"三个字的那条相关性分数高得多，加权排不出来。
  // 用户说"后来"就是想知道"接着发生了什么"，这时候时间顺序本身就是答案。
  if (timeHint?.order) {
    picked.sort((a, b) => {
      const ta = Date.parse(`${a.date}T00:00:00`)
      const tb = Date.parse(`${b.date}T00:00:00`)
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
      return timeHint.order === 'desc' ? tb - ta : ta - tb
    })
  }

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

  // 顺着 related 带出一层——但不能喧宾夺主：
  // 只在名额没满时补，最多补 2 条，而且必须是同 scope 里真实存在的。
  // 这就是 Hintzman 多痕迹模型里"相似的不合并、靠链接串起来"的用法。
  const linked: Episode[] = []
  if (merged.length < Math.max(limit, 3)) {
    const linkedIds = new Set(merged.flatMap((e) => e.related ?? []))
    for (const e of episodes) {
      if (linked.length >= 2) break
      if (!linkedIds.has(e.id)) continue
      if (seen.has(episodeKey(e))) continue
      seen.add(episodeKey(e))
      linked.push(e)
    }
  }

  const finalEps = [...merged, ...linked].slice(0, Math.max(limit, 3))

  markRecalled(finalEps, now)

  // 取最近 8 条而不是 4 条：群里两个人你来我往，"突然 @ 你"之前
  // 至少得看到完整的一轮，4 条经常只截到半句话。
  const recent: RawTurn[] = recentVisible(scope, 8)
    .filter((t) => visible(t.scope, scope))
    .slice(-8)
    // 补发言人名字（只用于渲染）。raw 里只有 senderId，
    // 直接渲染出来会变成一串「他：」——分不清是谁说的。
    .map((t) => {
      if (t.role !== 'user' || !t.senderId) return t
      const name = displayNameOfAccount(t.senderId)
      return name ? { ...t, speakerName: name } : t
    })

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
      // faint = 很久没提、靠话题才捞回来的。标一下，
      // 但别让它因此张口就说"你很久没跟我提这个了"（那很怪）。
      const faintTag = f.faint ? '（很久没提了，我可能记得不全）' : ''
      parts.push(`- ${f.text}${tag}${faintTag}${f.source ? `（他当时说：${f.source}）` : ''}`)
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

    // 同一个 block 里出现重名时，加上 QQ 号才分得清。
    //
    // 依据：NousResearch/hermes-agent 的做法是每条都带 "[from NAME (uid:ID)]"，
    // 理由是"平台 user_id 才是权威身份，名字只是标签"。
    // 我们折中一下：**只在群聊、且真的重名时才加**，不然每条挂一坨数字也太吵。
    //
    // ⚠️ "重名" = 同一个名字对应**多个不同 QQ 号**。
    //    不能只看"这个名字出现了几次"——同一个人说三句话也是三次，
    //    那样每条都会挂上 uid（踩过）。
    const isGroup = r.recent.some((x) => x.scope.startsWith('group:'))
    const idsOfName = new Map<string, Set<string>>()
    for (const t of r.recent) {
      if (!isGroup || t.role !== 'user') continue
      const n = t.speakerName || ''
      const id = t.senderId || ''
      if (!n || !id) continue
      const set = idsOfName.get(n) ?? new Set<string>()
      set.add(id)
      idsOfName.set(n, set)
    }

    for (const t of r.recent) {
      // 用真名而不是"他"：群里两个人对话后突然 @ 你，
      // 必须能分清上一句是谁说的、上上句是谁说的。
      const who = t.role === 'user' ? t.speakerName || '他' : '我'
      const dup = isGroup && t.role === 'user' && !!t.speakerName && (idsOfName.get(t.speakerName)?.size ?? 0) > 1
      const tag = dup && t.senderId ? `(${t.senderId})` : ''
      parts.push(`${who}${tag}：${t.text}`)
    }
  }

  return parts.join('\n')
}
