import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { loadRules, stageOf } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { onceAtATime } from '../core/timer.ts'
import type { Transport } from '../core/transport.ts'
import type { Target } from '../core/types.ts'
import type { LlmOptions } from '../llm/types.ts'
import { chat } from '../llm/deepseek.ts'
import { appendRaw, loadEpisodes, memoryRoot, recentRaw } from '../memory/store.ts'
import { loadFacts } from '../memory/facts.ts'
import { loadOpen } from '../people/open.ts'
import { personOfAccount, accountIdsOf, loadPerson } from '../people/store.ts'
import { loadMood, decayedMood } from '../persona/mood.ts'
import { buildPhaseBlock } from '../self/format.ts'
import { loadRelation } from '../relation/store.ts'
import { salutationOf } from '../relation/format.ts'
import { loadSelf, recentLife } from '../self/store.ts'
import { writeAtomic } from '../store/fs.ts'
import { effectiveWill } from '../self/will.ts'
import { say } from '../channel/send.ts'
import { maybeSendEmojiTo } from '../loop/chat.ts'

/**
 * 主动消息。
 *
 * 设计依据（两条，来自真实社交网络的实证）：
 *
 * 1. **人是"由头驱动"的，不是"频率驱动"的。**
 *    关系再好也不会每天准时打卡；关系一般也会因为"看到个东西想到你"而开口。
 *    所以这里先算一个**由头分**（urge 0-10）——有没有具体的事想说；
 *    关系只决定"多容易开口"（门槛和间隔），不决定"能不能开口"。
 *
 * 2. **弱关系也会主动，只是更少、更谨慎。**
 *    Roberts & Dunbar (2015, Human Nature 26:426-450) 跟踪 18 个月的社交网络：
 *    朋友联系间隔的中位数从在校时的 1 天掉到毕业一年后的 27 天，而且
 *    "从外层进入内层"很少见（6.7%）、"从内层掉到外层"很常见（48.6%）。
 *    → 阶段频率应该以"天/周"为单位，不是"每天几次"；关系一旦冷掉很难再热，
 *      所以陌生阶段也不能完全闭嘴（原来 dailyMax=0 会造成永久死锁）。
 */

/**
 * 主动消息状态。
 *
 * ⚠️ 目前是**全局单份**，因为主动消息只对「主人私聊」一个 target 起调度
 * （`src/index.ts` 的 `startProactive`）。**加第二个对象时必须改成
 * `Record<targetId, {...}>`** —— 否则两个对象的每日额度、`noReply` 刹车
 * 和"上次说了什么"会互相污染，而且到那时再改要迁移已有数据。
 */
interface ProactiveState {
  date: string
  count: number
  lastAt: number
  lastText: string
  /**
   * 连续几次主动后对方都没回。
   *
   * 为什么需要：没有这个刹车，关系好的阶段会"每天两三次"地单方面说话。
   * 真实的关系维护是互惠的（Gouldner 1960 的互惠规范）；对方一直不回，
   * 正常人会先收一收、等对方开口。
   */
  noReply?: number
}

function stateFile(): string {
  return join(memoryRoot(), '.proactive.json')
}

/** 本地日期键：跨过午夜就会变，主动消息的每日额度靠它重置。 */
export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadState(): ProactiveState {
  const f = stateFile()
  const empty: ProactiveState = { date: todayKey(), count: 0, lastAt: 0, lastText: '', noReply: 0 }
  if (!existsSync(f)) return empty
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<ProactiveState>
    const state: ProactiveState = {
      date: String(raw.date ?? empty.date),
      count: Number(raw.count ?? 0),
      lastAt: Number(raw.lastAt ?? 0),
      lastText: String(raw.lastText ?? ''),
      noReply: Number(raw.noReply ?? 0),
    }
    // 跨天重置「今天发了几次」，但保留"上次主动时间"和"连续没回"
    if (state.date !== todayKey()) return { ...empty, lastAt: state.lastAt, lastText: state.lastText, noReply: state.noReply }
    return state
  } catch {
    return empty
  }
}

function saveState(s: ProactiveState): void {
  writeAtomic(stateFile(), `${JSON.stringify(s, null, 2)}\n`)
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 静默时段判断，支持跨午夜（23:30 → 08:30） */
export function inQuietHours(rules: Rules, now = new Date()): boolean {
  const span = rules.行为.静默时段
  // 配错形状（只写一个、写成数字）时当"没有静默时段"，而不是让 split 抛 TypeError ——
  // 那个异常会被上层 catch 吞掉，结果是主动消息永久失效，日志里只刷 warn。
  if (!Array.isArray(span) || span.length !== 2 || typeof span[0] !== 'string' || typeof span[1] !== 'string') {
    return false
  }
  const [startS, endS] = span
  const start = minutesOf(startS)
  const end = minutesOf(endS)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

/* ---------------- 阶段预算 ---------------- */

export interface StageBudget {
  /** 两次主动之间至少隔多久（小时） */
  minGapHours: number
  /** 每天最多主动几次 */
  dailyMax: number
  /** 由头分门槛：低于它不开口 */
  minUrge: number
}

/**
 * 内置兜底表。rules.yaml 里如果没写结构化字段就用它。
 *
 * 数值刻意比"直觉"稀疏：
 *   朋友 5 天一次、亲近 3 天、亲密 1.5 天——
 *   现实里朋友一个月联系一次都算正常，已经比真实社交密了。
 */
const FALLBACK_STAGE_BUDGET: Record<string, StageBudget> = {
  陌生: { minGapHours: 720, dailyMax: 1, minUrge: 7 },
  眼熟: { minGapHours: 336, dailyMax: 1, minUrge: 5 },
  朋友: { minGapHours: 120, dailyMax: 2, minUrge: 3 },
  亲近: { minGapHours: 72, dailyMax: 3, minUrge: 2 },
  亲密: { minGapHours: 36, dailyMax: 3, minUrge: 1 },
  很亲近: { minGapHours: 30, dailyMax: 3, minUrge: 1 },
  // 兼容老配置里还叫「离不开」的情况
  离不开: { minGapHours: 30, dailyMax: 3, minUrge: 1 },
}

// 名字对不上时用「朋友」兜底：中性、不会静默变成每天 3 条。
// 之前用的是「很亲近」——用户改个阶段名，主动消息就直接拉到最宽松的档位。
const LAST_RESORT: StageBudget = FALLBACK_STAGE_BUDGET['朋友']!

function pickNum(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 这个阶段允许多主动。以 rules.yaml 的结构化字段为准，
 * `行为.主动消息.每日上限` 配成数字时作为**全局硬上限**（0 = 完全关闭）。
 */
export function proactiveBudgetOf(rules: Rules, stageName: string): StageBudget {
  const stage = rules.关系.阶段.find((s) => s.名 === stageName)
  const base = FALLBACK_STAGE_BUDGET[stageName] ?? LAST_RESORT
  let dailyMax = pickNum(stage?.每日上限, base.dailyMax)

  const globalMax = rules.行为.主动消息.每日上限
  if (typeof globalMax === 'number' && Number.isFinite(globalMax) && globalMax >= 0) {
    dailyMax = Math.floor(globalMax)
  }

  return {
    minGapHours: pickNum(stage?.主动间隔小时, base.minGapHours),
    dailyMax,
    minUrge: pickNum(stage?.最小由头, base.minUrge),
  }
}

/** 只看阶段的兜底预算（测试 / 控制台没有 rules 时用） */
export function proactiveBudget(stageName: string): StageBudget {
  return FALLBACK_STAGE_BUDGET[stageName] ?? LAST_RESORT
}

/* ---------------- 由头 ---------------- */

export interface UrgeInput {
  rules: Rules
  stageName: string
  now: Date
  lastTalkAt: number
  /** 没做完 / 没问完的事有几条 */
  openTodos: number
  /** 最近一条新经历距今多少小时；没有就是 null */
  freshEpisodeHours: number | null
  /** 它自己那边有没有新的事 */
  hasLife: boolean
  /** 当前心情强度 0-1 */
  moodIntensity: number
  /** 有没有"重要但很久没提"的事实 */
  staleMajorFact: boolean
}

/**
 * 这次"想说话"的理由够不够（0-10）。
 *
 * 每一项都是**具体的事**，不是"该联系了"这种感觉——
 * 后者是人给自己找的理由，模型拿到只会说"好久没聊了"。
 */
export function computeUrge(i: UrgeInput): { score: number; reasons: string[]; greeting: boolean } {
  const budget = proactiveBudgetOf(i.rules, i.stageName)
  const reasons: string[] = []
  let score = 0

  // 有件具体没完的事：最强的由头
  if (i.openTodos > 0) {
    score += 3
    reasons.push('还有没做完的事')
  }

  // 这几天刚一起经历过事：趁热说
  if (i.freshEpisodeHours !== null && i.freshEpisodeHours <= 72) {
    score += 2
    reasons.push('这几天一起经历了点事')
  }

  // 隔了很久：关系维护的由头（只对聊过的人成立）
  const gapH = (i.now.getTime() - i.lastTalkAt) / 3_600_000
  if (i.lastTalkAt > 0 && gapH >= budget.minGapHours * 1.5) {
    score += 2
    reasons.push('有一阵子没聊了')
  }

  if (i.hasLife) {
    score += 1
    reasons.push('我这边有件小事想说')
  }

  if (i.moodIntensity >= 0.6) {
    score += 1
    reasons.push('心情起伏比较大')
  }

  if (i.staleMajorFact) {
    score += 1
    reasons.push('记得他提过一件重要的事')
  }

  // 早晚问候：今天还没说过话的早上 / 深夜，给一个轻声开口的由头。
  //
  // ⚠️ 光加 2 分是不够的：问候只在"今天没说过话"时成立（gap < 24h），
  // 而间隔门要求 minGapHours×0.3（朋友 36h×0.3 = 10.8h）—— 永远等不到。
  // 所以额外把 greeting 标出来，让调用方把间隔压到 8 小时内。
  // 窗口也要避开静默时段（默认 23:30–08:30），否则 7:00–8:29 那段根本走不到。
  const hour = i.now.getHours()
  const dayStart = new Date(i.now)
  dayStart.setHours(0, 0, 0, 0)
  const spokeToday = i.lastTalkAt >= dayStart.getTime()
  let greeting = false
  if (!spokeToday && hour >= 8 && hour < 11) {
    score += 2
    reasons.push('早上了，还没跟他说过话')
    greeting = true
  } else if (!spokeToday && (hour >= 22 || hour < 1)) {
    score += 2
    reasons.push('很晚了，他还没睡')
    greeting = true
  }

  return { score: Math.min(10, score), reasons, greeting }
}

/* ---------------- 相似度 ---------------- */

/** 二元组相似度，用来防止反复说同一句 */
export function tooSimilar(a: string, b: string, threshold = 0.6): boolean {
  const clean = (s: string): string => s.replace(/\s+/g, '')
  const ca = clean(a)
  const cb = clean(b)
  // 空串（或只有空白）没有可比内容
  if (!ca || !cb) return false
  // 完全一样就是重复。单字消息（"嗯"）没有二元组，靠这一步兜住。
  if (ca === cb) return true

  const grams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = grams(ca)
  const B = grams(cb)
  // 不同的单字没有二元组可算，不能判成重复
  if (!A.size || !B.size) return false
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter) > threshold
}

/* ---------------- 门控 ---------------- */

export interface GateInput {
  rules: Rules
  now: Date
  stageName: string
  lastTalkAt: number
  lastProactiveAt: number
  todayCount: number
  openCount: number
  /** 这次"想说话"的由头分 0-10 */
  urge: number
  /** 这次是由头里的「早晚问候」（今天还没说过话）—— 会把间隔压到 8 小时内 */
  greeting?: boolean
  /** 连续几次主动后对方没回 */
  noReply: number
  /**
   * 最近 24 小时有没有"聊深了"（关系锚点幅度 >= 2 且向上）。
   *
   * 现实里刚聊完一件私事，隔天想再说一句是很自然的——"趁热打铁"。
   * 没有这条的话，阶段间隔又把人拦住，热度就凉了。
   */
  justGrewCloser?: boolean
}

export interface GateResult {
  ok: boolean
  reason: string
}

/** 该不该主动说话。纯函数，便于测试。 */
export function shouldProactive(i: GateInput): GateResult {
  const budget = proactiveBudgetOf(i.rules, i.stageName)
  if (budget.dailyMax === 0) return { ok: false, reason: '主动消息已关闭' }
  if (inQuietHours(i.rules, i.now)) return { ok: false, reason: '静默时段' }
  if (i.todayCount >= budget.dailyMax) return { ok: false, reason: '今日额度用完' }

  // 连续没回：3 次就彻底停，等对方先开口；2 次时抬高门槛、拉长间隔
  if (i.noReply >= 3) return { ok: false, reason: `连续 ${i.noReply} 次没回，等对方先开口` }
  // 早晚问候只有 2 分，而"朋友"档的 minUrge 是 3 —— 不降门槛的话它永远不合格。
  // 降 2 分不是放水：问候本身是"今天还没说过话"才成立的由头，门槛该按这个场景算。
  const urgeNeeded = Math.max(
    0,
    budget.minUrge - (i.greeting ? 2 : 0) + (i.noReply >= 2 ? 2 : 0),
  )
  if (i.urge < urgeNeeded) return { ok: false, reason: `由头不够（${i.urge} < ${urgeNeeded}）` }

  /* ---- 由头足够硬时，可以突破间隔 ----
   *
   * 这个函数的设计前提是「由头驱动，不是频率驱动」——关系只决定"多容易开口"。
   * 但原来 interval 是硬门：由头算到 9 分（门槛 5）也照样被
   * 「间隔不够（57h < 336h）」拦住，实测就是这样整整一周没开口。
   *
   * 现实里也是：真碰到"看到个东西立刻就想到你"的事，隔三天也会说；
   * 没什么事的时候，隔一周也懒得开口。
   *
   * 所以按超出门槛的幅度给间隔打折：
   *   超 1 分 → 0.8 倍    超 2 分 → 0.6 倍
   *   超 3 分 → 0.45 倍   超 4 分以上 → 0.3 倍（最低三成，不至于天天说）
   * 「眼熟」14 天 × 0.3 = 4.2 天，由头很硬的话就是三四天开口一次。
   */
  const urgeOver = Math.max(0, i.urge - urgeNeeded)
  const gapScale = urgeOver >= 4 ? 0.3 : urgeOver >= 3 ? 0.45 : urgeOver >= 2 ? 0.6 : urgeOver >= 1 ? 0.8 : 1

  const gapH = (i.now.getTime() - Math.max(i.lastTalkAt, i.lastProactiveAt)) / 3_600_000
  let needH = budget.minGapHours * gapScale * (i.noReply >= 2 ? 1.5 : 1)

  // 早晚问候只在"今天还没说过话"时成立（gap < 24h），而间隔门要
  // minGapHours×0.3（朋友 36h×0.3 = 10.8h）—— 不压的话永远等不到。
  // 8 小时是折中：早上没说话、晚上想起他，中间隔了半天才像人。
  if (i.greeting) needH = Math.min(needH, 8)

  /* 由头够硬时，最长等多久。
   *
   * 光靠打折不够：眼熟阶段 336h 打三折还有 100h（4 天多），而"确实有事想说"
   * 卡在四天太不像人。超过三四天，那件事的鲜度就过去了，再提反而像硬找话题。
   *
   * 阈值按实测定的：主人的日志里由头是
   *   没做完的事(+3) + 这几天一起经历(+2) + 我这边有事(+1) + 心情起伏(+1) = 7
   * 所以 7 分对应的档位必须能开口，否则这个功能对他的日常场景就是不存在的。
   */
  if (i.urge >= 8 && needH > 72) needH = 72
  else if (i.urge >= 7 && needH > 96) needH = 96

  /* 刚聊深了 → 趁热。
   *
   * 24 小时内有"聊深了"的锚点（分享私事、道歉、说真话），
   * 隔天想再说一句是自然的。这时候直接把间隔压到 1/3，
   * 但保留 12 小时下限——不能刚聊完两小时又追着说。
   */
  let heatNote = ''
  if (i.justGrewCloser) {
    const before = needH
    needH = Math.max(12, needH / 3)
    if (needH < before) heatNote = '，刚聊深了趁热'
  }

  if (gapH < needH) {
    return {
      ok: false,
      reason: `间隔不够（${gapH.toFixed(1)}h < ${needH.toFixed(0)}h${gapScale < 1 ? `，由头超门槛 ${urgeOver} 分已打折` : ''}${heatNote}）`,
    }
  }

  // 从没聊过、也没有任何由头：不打扰
  if (i.openCount === 0 && i.lastTalkAt === 0 && i.urge === 0) return { ok: false, reason: '没有可说的由头' }

  return { ok: true, reason: 'ok' }
}

/* ---------------- 生成与发送 ---------------- */

/**
 * 主动消息的 system prompt。
 *
 * 「不超过 30 个字」以前是写死的：用户把「每条最多字数」改成 60 或 15 之后，
 * 主动消息还是 30 —— 这条配置对主动消息完全无效。
 */
function systemFor(rules: Rules): string {
  const raw = Number(rules.说话?.每条最多字数)
  const max = Number.isFinite(raw) && raw > 0 ? raw : 30
  return `你要主动找他说一句话。只输出你要说的那句话，不要引号，不要解释，不要"在吗"这种开场白。

规则：
- 一句到两句话，总共不超过 ${max} 个字。
- **说具体的事**：从"这次想说话的原因"里挑一件，提那个细节。
  不要只说"好久没聊了""在干嘛"——那是没话找话。
- 像随口想到才说的，不是任务。
- 如果你觉得现在没什么好说的，就只输出：不说`
}

export interface ProactiveOptions {
  llm: LlmOptions
  transport: Transport
  target: Target
  intervalMs?: number
}

async function attempt(opts: ProactiveOptions): Promise<void> {
  const rules = loadRules().rules
  const personId = personOfAccount('qq', opts.target.id)
  const state = loadState()
  const relation = loadRelation(personId)
  const stage = stageOf(rules, relation.closeness)

  // 窗口要覆盖阶段的主动间隔：陌生/眼熟是 30/14 天，只看 3 天的话
  // lastTalkAt 会变成 0，间隔门失效 → 对方 4 天前说过话也可能被主动。
  const minGapH = Number((stage as { 主动间隔小时?: number }).主动间隔小时) || 24
  const windowDays = Math.max(3, Math.ceil(minGapH / 24) + 2)
  const accounts = accountIdsOf(personId)
  const raw = recentRaw(windowDays).filter((t) =>
    t.senderId ? accounts.includes(t.senderId) : accounts.some((a) => t.scope === `private:${a}`),
  )
  const lastTalkAt = raw.reduce((max, t) => Math.max(max, t.ts), 0)
  const lastUserAt = raw.filter((t) => t.role === 'user').reduce((max, t) => Math.max(max, t.ts), 0)

  // 上次主动之后他说过话吗？说过就说明互惠成立，连续没回清零
  const replied = lastUserAt > state.lastAt

  /* 停了太久就自动解冻。
   *
   * 「连续 3 次没回就停」本意是别单方面刷屏，但它有个死角：
   * 对方正好忙了一周（出差、考试、生病），三次全部没回 → 永久停住，
   * 而恢复的唯一办法是"对方先开口"——可他不知道这边已经停了。
   * 结果是：一次忙 → 关系彻底沉默。
   *
   * 所以加个时间闸：距上次主动超过 7 天，把 noReply 归零重新算。
   * 7 天是按"一个人忙起来通常不会超过一周"定的，也跟 Dunbar 那层
   * "朋友联系中位数 27 天"对得上——停满一周还没动静，值得再试一次。
   */
  const STALE_MS = 7 * 86_400_000
  const stale = state.lastAt > 0 && Date.now() - state.lastAt > STALE_MS
  const noReply = replied || stale ? 0 : (state.noReply ?? 0)
  if ((replied || stale) && (state.noReply ?? 0) > 0) {
    saveState({ ...state, noReply: 0 })
    if (stale && !replied) info(`主动消息：停了 ${Math.floor((Date.now() - state.lastAt) / 86_400_000)} 天，重新开始算`)
  }

  const open = loadOpen(personId).filter((o) => o.kind === 'todo')

  // 先问它自己想不想。意愿过期（超过 30 小时没盘）就按老规则走。
  const will = effectiveWill()
  if (will && !will.talk) {
    info(`今天它不想主动开口：${will.talkReason || '没说什么理由'}`)
    return
  }

  const now = new Date()
  const eps = loadEpisodes().filter((e) => accounts.some((a) => e.scope === `private:${a}`))
  const newestEpisode = eps.reduce((best, e) => {
    const t = Date.parse(`${e.date}T00:00:00`)
    return Number.isNaN(t) ? best : Math.max(best, t)
  }, 0)
  const freshEpisodeHours = newestEpisode ? (now.getTime() - newestEpisode) / 3_600_000 : null
  const life = recentLife(3)
  const mood = decayedMood(loadMood())
  const personFacts = loadFacts(personId).filter((f) => !f.supersededAt)
  const staleMajorFact = personFacts.some((f) => {
    if (f.tier !== 'major') return false
    const ref = Date.parse(`${f.lastConfirmed ?? f.date}T00:00:00`)
    return !Number.isNaN(ref) && (now.getTime() - ref) / 86_400_000 >= 14
  })

  const urge = computeUrge({
    rules,
    stageName: stage.名,
    now,
    lastTalkAt,
    openTodos: open.length,
    freshEpisodeHours,
    hasLife: life.length > 0,
    moodIntensity: mood?.intensity ?? 0,
    staleMajorFact,
  })

  const gate = shouldProactive({
    greeting: urge.greeting,
    rules,
    now,
    stageName: stage.名,
    lastTalkAt,
    lastProactiveAt: state.lastAt,
    todayCount: state.count,
    openCount: open.length,
    urge: urge.score,
    noReply,
    // 24 小时内聊深了（关系锚点 >= 2 且向上）→ 趁热
    justGrewCloser: relation.anchors.some((a) => {
      if (a.direction !== 'up' || (a.amount ?? 0) < 2) return false
      const t = Date.parse(`${a.date}T00:00:00`)
      return !Number.isNaN(t) && now.getTime() - t <= 86_400_000
    }),
  })

  if (!gate.ok) {
    if (urge.score > 0) info(`主动消息：${gate.reason}`, { 由头: urge.reasons.join('、') })
    return
  }

  const hoursSinceTalk = lastTalkAt ? ((Date.now() - lastTalkAt) / 3_600_000).toFixed(1) : '很久'
  const self = loadSelf()

  // 很久没被想起来、但当时挺重要的事
  const oldButImportant = eps
    .filter((e) => e.importance >= 7)
    .filter((e) => {
      const ref = e.lastRecalled && e.lastRecalled > 0 ? e.lastRecalled : Date.parse(`${e.date}T00:00:00`) || 0
      return Date.now() - ref > 7 * 86_400_000
    })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3)

  const phase = buildPhaseBlock(rules)

  const context = [
    // 不报关系值：模型看到数字会去"刷分"，也容易直接说出来
    `你们的关系：${stage.名}`,
    // 称呼要传 callName：主动消息以前漏了这个参数，于是"它自己给这人起的叫法"
    // 在主动消息里失效，回落到 关系.昵称 / 阶段说明 —— 聊天里叫"阿鱼"、
    // 主动消息里叫"哎"，看起来像两个人。
    `称呼上：${salutationOf(rules, stage, false, loadPerson(personId)?.callName)}`,
    `这次想说话的原因：${urge.reasons.length ? urge.reasons.join('；') : '就是想找他'}`,
    mood ? `你现在的心情：${mood.emotion}（强度 ${mood.intensity.toFixed(1)}）` : '',
    phase ? `当下的状态：${phase}` : '',
    self.name ? `你叫「${self.name}」` : '你还没有名字',
    `距离上次说话：${hoursSinceTalk} 小时`,
    life.length ? `你自己最近在想的事：\n${life.map((l) => `- ${l}`).join('\n')}` : '',
    oldButImportant.length
      ? `很久没提、但你一直记着的事：\n${oldButImportant.map((e) => `- ${e.date}｜${e.title}`).join('\n')}`
      : '',
    personFacts.length
      ? `你记得关于他的事：\n${personFacts
          .slice(-3)
          .map((f) => `- ${f.text}`)
          .join('\n')}`
      : '',
    open.length ? `没做完的事：\n${open.map((o) => `- ${o.text}`).join('\n')}` : '没有特别记着的事',
    raw.length ? `最近聊到：${raw.slice(-3).map((t) => t.text).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const res = await chat(
    [
      { role: 'system', content: systemFor(loadRules().rules) },
      { role: 'user', content: context },
    ],
    { ...opts.llm, maxTokens: 120, temperature: 0.9 },
  )

  const text = res.text.trim()
  if (!text || /^不说/.test(text)) {
    info('主动消息：选择不说')
    saveState({ ...state, lastAt: Date.now(), noReply })
    return
  }

  if (state.lastText && tooSimilar(state.lastText, text, Number(rules.行为.主动消息.去重相似度) || 0.6)) {
    info('主动消息：和上次太像，跳过', { text })
    saveState({ ...state, lastAt: Date.now(), noReply })
    return
  }

  // 和正常回复走同一条发送路径：分句、条间延迟，手感才一致
  const { sent } = await say(opts.transport, opts.target, text, rules)
  // say 内部逐句 catch 只 warn，全失败时 sent 为 0。以前不看返回值：
  // NapCat 掉线/没连上时会**假装发成功** —— 额度被吃掉、raw 记了"我说过"、
  // 还照样补一张表情包，用户什么都没收到，它以为自己说过了。
  if (sent === 0) {
    warnAt('主动消息没发出去（通道没连？），本次不计入额度', { 文本: text.slice(0, 30) })
    saveState({ ...state, lastAt: Date.now(), noReply })
    return
  }
  // 主动消息也配表情包：和被动回复同一个概率门（心情越强越容易发）
  await maybeSendEmojiTo(opts.target, rules)
  saveState({ date: todayKey(), count: state.count + 1, lastAt: Date.now(), lastText: text, noReply: noReply + 1 })
  info('主动消息已发送', { text, 由头: urge.reasons.join('、'), 连续没回: noReply + 1 })

  // 记进 raw，让它算作一次对话
  appendRaw({ ts: Date.now(), scope: `private:${opts.target.id}` as const, role: 'assistant', text })
}

/** 启动主动消息调度：每 30 分钟检查一次该不该开口 */
export function startProactive(opts: ProactiveOptions): () => void {
  const interval = opts.intervalMs ?? 30 * 60_000
  let stopped = false

  // 同上：一次尝试要调模型挑由头、再生成，慢的时候会超过间隔。
  // 叠加起来的结果是**同一个人连着收到两条主动消息** —— 用户会觉得它抽风。
  const runOnce = onceAtATime(() => attempt(opts))
  const run = () => {
    if (stopped) return
    void runOnce().catch((err) => warnAt('主动消息失败', { err: String(err) }))
  }

  // 启动后 2 分钟先检查一次（错开其它定时器），不用等满 30 分钟
  const first = setTimeout(run, 120_000)
  first.unref?.()
  const timer = setInterval(run, interval)
  timer.unref?.()

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}

/** 给控制台看：今天主动了几次、额度剩多少、为什么没开口 */
export function proactiveStatus(
  rules: Rules,
  stageName: string,
): {
  todayCount: number
  dailyMax: number
  lastAt: number
  lastText: string
  minGapHours: number
  minUrge: number
  noReply: number
} {
  const s = loadState()
  const b = proactiveBudgetOf(rules, stageName)
  return {
    todayCount: s.count,
    dailyMax: b.dailyMax,
    lastAt: s.lastAt,
    lastText: s.lastText,
    minGapHours: b.minGapHours,
    minUrge: b.minUrge,
    noReply: s.noReply ?? 0,
  }
}
