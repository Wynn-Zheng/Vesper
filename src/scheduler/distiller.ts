import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { LlmOptions } from '../llm/types.ts'
import { distill } from '../memory/distill.ts'
import { pickForDistill } from '../memory/filter.ts'
import { loadEpisodes, memoryRoot, recentRaw } from '../memory/store.ts'
import { personIdOf, personOfAccount } from '../people/store.ts'
import type { RawTurn, Scope } from '../memory/types.ts'
import { writeAtomic } from '../store/fs.ts'

import { refreshCodeMap } from '../self/codemap.ts'

interface State {
  /** 每个会话各自的整理游标：A 聊完不该把 B 的进度也推掉 */
  scopes: Record<string, number>
}

function stateFile(): string {
  return join(memoryRoot(), '.state.json')
}

function loadState(): State {
  const f = stateFile()
  if (!existsSync(f)) return { scopes: {} }
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<State> & { lastDistillAt?: number }
    if (raw.scopes && typeof raw.scopes === 'object') return { scopes: raw.scopes }
    // 兼容旧格式：一个全局游标
    return { scopes: raw.lastDistillAt ? { '*': Number(raw.lastDistillAt) } : {} }
  } catch {
    return { scopes: {} }
  }
}

function saveState(s: State): void {
  writeAtomic(stateFile(), `${JSON.stringify(s, null, 2)}\n`)
}

export interface DistillerOptions {
  llm: LlmOptions
  /** 攒够多少轮才整理 */
  minTurns?: number
  /** 检查间隔（毫秒），默认 30 分钟 */
  intervalMs?: number
}

/** 判断该不该整理：攒够了，或者离上次已经超过一天且有新内容 */
export interface DistillThresholds {
  /** 攒够多少轮就整理 */
  阈值: number
  /** 是否启用"每天至少一次"的兜底 */
  /** 每天至少兜底几次，0 表示不兜底 */
  每天至少: number
}

const DEFAULT_THRESHOLD: DistillThresholds = { 阈值: 20, 每天至少: 1 }

export function shouldDistill(
  turns: RawTurn[],
  lastAt: number,
  now = Date.now(),
  minTurnsOrOpts: number | DistillThresholds = 20,
): boolean {
  const cfg: DistillThresholds =
    typeof minTurnsOrOpts === 'number' ? { ...DEFAULT_THRESHOLD, 阈值: minTurnsOrOpts } : minTurnsOrOpts
  const minTurns = Math.max(1, cfg.阈值 || DEFAULT_THRESHOLD.阈值)
  if (!turns.length) return false
  if (turns.length >= minTurns) return true
  const hours = (now - lastAt) / 3_600_000
  return (cfg.每天至少 ?? 1) > 0 && lastAt > 0 && hours >= 24 && turns.length >= 4
}

async function tick(opts: DistillerOptions): Promise<void> {
  const state = loadState()
  const all = recentRaw(7)
  if (!all.length) return

  const rules = loadRules().rules
  const cutoff = (scope: string): number => state.scopes[scope] ?? state.scopes['*'] ?? 0

  // 按 scope 分组，各自判断该不该整理
  const groups = new Map<Scope, RawTurn[]>()
  for (const t of all) {
    if (t.ts <= cutoff(t.scope)) continue
    const list = groups.get(t.scope) ?? []
    list.push(t)
    groups.set(t.scope, list)
  }

  let did = 0
  for (const [scope, list] of groups) {
    if (!shouldDistill(list, cutoff(scope), Date.now(), rules.记忆.反思)) continue

    const personId = scope.startsWith('private:')
      ? personOfAccount('qq', scope.slice('private:'.length))
      : personIdOf('qq', 'group')

    // 只把"值得提炼"的喂给模型（Kumaran 2016：重播是有选择的，
    // 优先挑意外的、有奖励的，不是把流水账原样重放）。
    // 但要保留原始条数用于"今天有多少话"的判断——筛选只影响喂什么，不影响该不该整理。
    const existingEps = loadEpisodes()
      .filter((e) => e.scope === scope)
      .map((e) => `${e.title} ${e.body}`)
    const picked = pickForDistill(list, existingEps)

    if (picked.length < list.length) {
      info(`整理前筛掉 ${list.length - picked.length} 条废话`, { scope, 留下: picked.length })
    }

    info(`开始自动整理：${scope}，${picked.length} 条`)
    const r = await distill({ personId, scope, turns: picked, llm: opts.llm, rules })
    if (r.episodes || r.facts || r.open || r.insights) {
      info('整理结果', { person: personId, scope, ...r })
    }
    state.scopes[scope] = Date.now()
    did++
  }

  if (did) saveState(state)
}

/** 启动后台整理器：启动时先跑一次，之后按间隔检查 */
export function startDistiller(opts: DistillerOptions): () => void {
  const interval = opts.intervalMs ?? 30 * 60_000
  let stopped = false

  const run = () => {
    if (stopped) return
    void tick(opts).catch((err) => warnAt('自动整理失败', { err: String(err) }))
  }

  // 启动后延迟 1 分钟再第一次跑，避免和启动日志抢
  const first = setTimeout(run, 60_000)
  const timer = setInterval(run, interval)

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}

/**
 * 代码地图每天刷一次。
 *
 * 为什么不用"每次改代码就刷"：它读的是缓存，慢一点没关系；
 * 但每次请求都扫一遍 60 多个文件太浪费。
 * 用户说"你重新扫一遍"时会强制刷新，不用等定时。
 */
export function startCodeMapRefresher(intervalMs = 24 * 3600_000): () => void {
  let stopped = false

  const run = () => {
    if (stopped) return
    try {

      refreshCodeMap(false)
    } catch {
      /* 刷不了就算了，下次再说 */
    }
  }

  // 启动后 2 分钟跑第一次（错开别的定时器）
  const first = setTimeout(run, 120_000)
  const timer = setInterval(run, intervalMs)

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
