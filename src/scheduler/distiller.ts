import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRules, type Rules } from '../core/config.ts'
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
  /**
   * 每个会话上次**尝试**整理的时间。
   *
   * 为什么不直接用游标：游标现在是"已整理到哪条消息"（数据时间），
   * 而"每天至少一次"的兜底要看"上次真正跑过是什么时候"。
   * 两者混在一起的话，低频聊天（一天三句）永远攒不够 20 条，
   * 兜底又因为"最后一条消息就在刚才"而不触发，记忆就一直不整理。
   */
  lastRun?: Record<string, number>
}

function stateFile(): string {
  return join(memoryRoot(), '.state.json')
}

function loadState(): State {
  const f = stateFile()
  if (!existsSync(f)) return { scopes: {} }
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<State> & { lastDistillAt?: number }
    if (raw.scopes && typeof raw.scopes === 'object') {
      const lastRun = raw.lastRun && typeof raw.lastRun === 'object' ? (raw.lastRun as Record<string, number>) : undefined
      return lastRun ? { scopes: raw.scopes, lastRun } : { scopes: raw.scopes }
    }
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
  /** 测试注入：不传就读 persona/rules.yaml */
  rules?: Rules
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

/** 跑一轮整理。导出是为了让测试能直接驱动（不等 30 分钟定时器）。 */
export async function tick(opts: DistillerOptions): Promise<void> {
  const state = loadState()
  const all = recentRaw(7)
  if (!all.length) return

  const rules = opts.rules ?? loadRules().rules
  const cutoff = (scope: string): number => state.scopes[scope] ?? state.scopes['*'] ?? 0

  // 按 scope 分组，各自判断该不该整理
  const groups = new Map<Scope, RawTurn[]>()
  for (const t of all) {
    if (t.ts <= cutoff(t.scope)) continue
    const list = groups.get(t.scope) ?? []
    list.push(t)
    groups.set(t.scope, list)
  }

  for (const [scope, list] of groups) {
    // 兜底判断看"上次真正跑过的时间"；没跑过就用游标（兼容老状态）。
    //
    // 从没整理过时（两者都没有）用**这批消息的第一条时间**当基准：
    // 兜底条件要求 lastAt > 0，直接传 0 就永远不触发 —— 新会话必须攒满
    // `记忆.反思.阈值`（默认 150）条才会第一次整理，而 recentRaw 只读 7 天，
    // 低频聊天（一天二三十条）可能永远等不到那一天，等于一条记忆都不产生。
    const firstTs = list[0]?.ts ?? 0
    const lastRun = state.lastRun?.[scope] ?? (cutoff(scope) || firstTs)
    if (!shouldDistill(list, lastRun, Date.now(), rules.记忆.反思)) continue

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
    if (!r.ok) {
      // 失败就**不动游标**：这批下次还会被读出来重试。
      // 原来的写法是无论成败都写 Date.now()，一次限流/网络抖动就让那批消息永久消失。
      warnAt('整理失败，这批下次重试（游标不动）', { scope, 条数: picked.length })
      continue
    }
    if (r.episodes || r.facts || r.open || r.insights) {
      info('整理结果', { person: personId, scope, ...r })
    }

    // 游标推进到这批**最后一条消息的时间**，不是 Date.now()。
    // 用 Date.now() 会把整理过程中新到的消息一起跳过（分组时 ts <= cutoff 被过滤掉）。
    const lastTs = list[list.length - 1]?.ts ?? cutoff(scope)
    state.scopes[scope] = lastTs
    state.lastRun = { ...(state.lastRun ?? {}), [scope]: Date.now() }
    // 每批就落盘：进程中途退出时不会重做已经成功的部分
    saveState(state)
  }
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
