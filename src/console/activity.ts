/**
 * 控制台访问记录（元信息）。
 *
 * 只记「什么时候聊过、聊了几轮」，**不记内容** ——
 * 这是给 QQ 那边的 prompt 用的：它得知道"他今天在控制台跟我聊过"，
 * 但不需要知道聊了什么（内容在 private:console-xxx 那个 scope 里，
 * QQ 那边读不到，这是设计的一部分）。
 *
 * 数据量很小：只保留最近 30 次访问。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../store/fs.ts'

const FILE = 'data/console/activity.json'
const MAX_VISITS = 30

export type ConsoleVisit = {
  /** 这次访问开始的时间 */
  at: number
  /** 这一轮聊了几句 */
  turns: number
}

export type ConsoleActivity = {
  visits: ConsoleVisit[]
  /** 最近一次结束的时间 */
  lastAt: number
}

const EMPTY: ConsoleActivity = { visits: [], lastAt: 0 }

export function loadConsoleActivity(): ConsoleActivity {
  try {
    if (!existsSync(FILE)) return { ...EMPTY, visits: [] }
    const raw = readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw) as Partial<ConsoleActivity>
    const visits = Array.isArray(j.visits)
      ? j.visits
          .filter((v): v is ConsoleVisit => Boolean(v) && typeof v.at === 'number')
          .map((v) => ({ at: Number(v.at) || 0, turns: Math.max(0, Number(v.turns) || 0) }))
      : []
    return { visits: visits.slice(-MAX_VISITS), lastAt: Number(j.lastAt) || 0 }
  } catch {
    return { ...EMPTY, visits: [] }
  }
}

/**
 * 记一次访问。
 *
 * 同一次会话里每说一句都会调 —— 所以按"最近 10 分钟算同一趟"合并，
 * 不然聊 20 句就变成 20 次访问，"聊过 3 次"这个数字就没意义了。
 */
export function recordConsoleTurn(now = Date.now()): void {
  const cur = loadConsoleActivity()
  const MERGE_MS = 10 * 60_000
  const last = cur.visits[cur.visits.length - 1]
  if (last && now - last.at < MERGE_MS) {
    last.turns += 1
  } else {
    cur.visits.push({ at: now, turns: 1 })
  }
  cur.visits = cur.visits.slice(-MAX_VISITS)
  cur.lastAt = now
  try {
    mkdirSync('data/console', { recursive: true })
    writeAtomic(FILE, JSON.stringify(cur, null, 2) + '\n')
  } catch {
    /* 记不上不影响聊天 */
  }
}

/** 给 prompt 用：只给次数和时间，不给内容 */
export function renderConsoleForPrompt(now = Date.now()): string {
  const { visits } = loadConsoleActivity()
  if (!visits.length) return ''

  const DAY = 86_400_000
  const today = visits.filter((v) => now - v.at < DAY)
  const last = visits[visits.length - 1]
  if (!last) return ''

  const mins = Math.floor((now - last.at) / 60_000)
  const when =
    mins < 5 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 24 * 60 ? `${Math.floor(mins / 60)} 小时前` : '昨天'

  if (today.length) {
    return `- 他今天在控制台跟你聊过 ${today.length} 次（最近一次 ${when}）`
  }
  return `- 他 ${when}在控制台跟你聊过（今天没有）`
}
