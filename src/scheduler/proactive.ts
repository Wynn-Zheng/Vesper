import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { loadRules, stageOf } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { Transport } from '../core/transport.ts'
import type { Target } from '../core/types.ts'
import type { LlmOptions } from '../llm/types.ts'
import { chat } from '../llm/deepseek.ts'
import { appendRaw, loadEpisodes, memoryRoot, recentRaw } from '../memory/store.ts'
import { loadOpen } from '../people/open.ts'
import { personOfAccount, accountIdsOf } from '../people/store.ts'
import { loadMood, decayedMood } from '../persona/mood.ts'
import { buildPhaseBlock } from '../self/format.ts'
import { loadRelation } from '../relation/store.ts'
import { loadSelf, recentLife } from '../self/store.ts'
import { writeAtomic } from '../store/fs.ts'
import { effectiveWill } from '../self/will.ts'
import { say } from '../channel/send.ts'

interface ProactiveState {
  date: string
  count: number
  lastAt: number
  lastText: string
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
  const empty: ProactiveState = { date: todayKey(), count: 0, lastAt: 0, lastText: '' }
  if (!existsSync(f)) return empty
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<ProactiveState>
    const state: ProactiveState = {
      date: String(raw.date ?? empty.date),
      count: Number(raw.count ?? 0),
      lastAt: Number(raw.lastAt ?? 0),
      lastText: String(raw.lastText ?? ''),
    }
    // 跨天重置
    if (state.date !== todayKey()) return { ...empty, lastAt: state.lastAt, lastText: state.lastText }
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
  const [startS, endS] = rules.行为.静默时段
  const start = minutesOf(startS)
  const end = minutesOf(endS)
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

/** 各阶段允许的最小间隔（小时）与每日上限 */
export function proactiveBudget(stageName: string): { minGapHours: number; dailyMax: number } {
  switch (stageName) {
    case '陌生':
      // 用 0 而不是 Infinity：Infinity 过 JSON 会变成 null，控制台会显示 "null 小时"
      return { minGapHours: 0, dailyMax: 0 }
    case '眼熟':
      return { minGapHours: 48, dailyMax: 1 }
    case '朋友':
      return { minGapHours: 24, dailyMax: 2 }
    case '亲近':
      return { minGapHours: 12, dailyMax: 3 }
    case '亲密':
      return { minGapHours: 6, dailyMax: 4 }
    default:
      return { minGapHours: 4, dailyMax: 5 }
  }
}

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

export interface GateInput {
  rules: Rules
  now: Date
  stageName: string
  lastTalkAt: number
  lastProactiveAt: number
  todayCount: number
  openCount: number
}

export interface GateResult {
  ok: boolean
  reason: string
}

/** 该不该主动说话。纯函数，便于测试。 */
export function shouldProactive(i: GateInput): GateResult {
  const budget = proactiveBudget(i.stageName)
  if (budget.dailyMax === 0) return { ok: false, reason: `阶段「${i.stageName}」不主动` }
  if (inQuietHours(i.rules, i.now)) return { ok: false, reason: '静默时段' }
  if (i.todayCount >= budget.dailyMax) return { ok: false, reason: '今日额度用完' }

  const gapH = (i.now.getTime() - Math.max(i.lastTalkAt, i.lastProactiveAt)) / 3_600_000
  if (gapH < budget.minGapHours) return { ok: false, reason: `间隔不够（${gapH.toFixed(1)}h < ${budget.minGapHours}h）` }

  // 没有未完成的事、也没有新经历，就先不打扰
  if (i.openCount === 0 && i.lastTalkAt === 0) return { ok: false, reason: '没有可说的由头' }

  return { ok: true, reason: 'ok' }
}

const SYSTEM = `你要主动找他说一句话。只输出你要说的那句话，不要引号，不要解释，不要"在吗"这种开场白。

规则：
- 一句到两句话，总共不超过 30 个字。
- 像随口想到才说的，不是任务。
- 可以从"你记得的事"或"没做完的事"里找一个点。
- 如果你觉得现在没什么好说的，就只输出：不说`

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

  // 只看这个人的消息：别人在说话不代表你在和他聊
  const accounts = accountIdsOf(personId)
  const raw = recentRaw(3).filter((t) =>
    t.senderId ? accounts.includes(t.senderId) : accounts.some((a) => t.scope === `private:${a}`),
  )
  const lastTalkAt = raw.reduce((max, t) => Math.max(max, t.ts), 0)
  const open = loadOpen(personId).filter((o) => o.kind === 'todo')


  // 先问它自己想不想。意愿过期（超过 30 小时没盘）就按老规则走。
  const will = effectiveWill()
  if (will && !will.talk) {
    info(`今天它不想主动开口：${will.talkReason || '没说什么理由'}`)
    return
  }

  const gate = shouldProactive({
    rules,
    now: new Date(),
    stageName: stage.名,
    lastTalkAt,
    lastProactiveAt: state.lastAt,
    todayCount: state.count,
    openCount: open.length,
  })

  if (!gate.ok) return

  const hoursSinceTalk = lastTalkAt ? ((Date.now() - lastTalkAt) / 3_600_000).toFixed(1) : '很久'
  const self = loadSelf()
  const life = recentLife(3)

  // 很久没被想起来、但当时挺重要的事
  const oldButImportant = loadEpisodes()
    .filter((e) => accounts.some((a) => e.scope === `private:${a}`))
    .filter((e) => e.importance >= 7)
    .filter((e) => {
      const ref = e.lastRecalled && e.lastRecalled > 0 ? e.lastRecalled : Date.parse(`${e.date}T00:00:00`) || 0
      return Date.now() - ref > 7 * 86_400_000
    })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3)

  const mood = decayedMood(loadMood())
  const phase = buildPhaseBlock(rules)

  const context = [
    `你们的关系：${stage.名}（${Math.round(relation.closeness)}/100），你叫他「${stage.称呼}」`,
    mood ? `你现在的心情：${mood.emotion}（强度 ${mood.intensity.toFixed(1)}）` : '',
    phase ? `当下的状态：${phase}` : '',
    self.name ? `你叫「${self.name}」` : '你还没有名字',
    `距离上次说话：${hoursSinceTalk} 小时`,
    life.length ? `你自己最近在想的事：\n${life.map((l) => `- ${l}`).join('\n')}` : '',
    oldButImportant.length
      ? `很久没提、但你一直记着的事：\n${oldButImportant.map((e) => `- ${e.date}｜${e.title}`).join('\n')}`
      : '',
    open.length ? `没做完的事：\n${open.map((o) => `- ${o.text}`).join('\n')}` : '没有特别记着的事',
    raw.length ? `最近聊到：${raw.slice(-3).map((t) => t.text).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const res = await chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context },
    ],
    { ...opts.llm, maxTokens: 120, temperature: 0.9 },
  )

  const text = res.text.trim()
  if (!text || /^不说/.test(text)) {
    info('主动消息：选择不说')
    saveState({ ...state, lastAt: Date.now() })
    return
  }

  if (state.lastText && tooSimilar(state.lastText, text, Number(rules.行为.主动消息.去重相似度) || 0.6)) {
    info('主动消息：和上次太像，跳过', { text })
    saveState({ ...state, lastAt: Date.now() })
    return
  }

  // 和正常回复走同一条发送路径：分句、条间延迟，手感才一致
  await say(opts.transport, opts.target, text, rules)
  saveState({ date: todayKey(), count: state.count + 1, lastAt: Date.now(), lastText: text })
  info('主动消息已发送', { text })

  // 记进 raw，让它算作一次对话
  appendRaw({ ts: Date.now(), scope: `private:${opts.target.id}` as const, role: 'assistant', text })
}

/** 启动主动消息调度：每 30 分钟检查一次该不该开口 */
export function startProactive(opts: ProactiveOptions): () => void {
  const interval = opts.intervalMs ?? 30 * 60_000
  let stopped = false

  const run = () => {
    if (stopped) return
    void attempt(opts).catch((err) => warnAt('主动消息失败', { err: String(err) }))
  }

  const timer = setInterval(run, interval)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** 给控制台看：今天主动了几次、额度剩多少 */
export function proactiveStatus(stageName: string): {
  todayCount: number
  dailyMax: number
  lastAt: number
  lastText: string
  minGapHours: number
} {
  const s = loadState()
  const b = proactiveBudget(stageName)
  return { todayCount: s.count, dailyMax: b.dailyMax, lastAt: s.lastAt, lastText: s.lastText, minGapHours: b.minGapHours }
}