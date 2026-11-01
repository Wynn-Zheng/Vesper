/**
 * 自己找问题。
 *
 * 目标不是"自己改代码"，是"能说出哪里不对、大概是什么问题、有多确定"，
 * 然后由人改。所以这里只做三件事：
 *
 *   1. 从日志里捞 warn / error
 *   2. 按"错误指纹"合并（同一个错出现 20 次是一个问题，不是 20 个）
 *   3. 判断确定程度：有代码位置 + 反复出现 = 确定；只有消息 = 可能
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { info } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'
import type { LlmOptions } from '../llm/types.ts'

export interface Issue {
  /** 合并用的指纹 */
  key: string
  /** 原始消息 */
  message: string
  /** 代码位置 src/xxx.ts:47；空表示不知道在哪 */
  where: string
  level: 'warn' | 'error'
  /** 出现了几次 */
  count: number
  firstAt: number
  lastAt: number
  /** 确定 / 可能 */
  confidence: '确定' | '可能'
  /** 一些原始样本（最多 3 条 extra） */
  samples: string[]
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readDayLog(date: string): Array<{ ts: number; level: string; msg: string; extra?: Record<string, unknown> }> {
  const f = join('data/logs', `${date}.jsonl`)
  if (!existsSync(f)) return []
  const out: Array<{ ts: number; level: string; msg: string; extra?: Record<string, unknown> }> = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      // 坏行不止"不是 JSON"这一种：null、数组、裸字符串都能解析成功，
      // 但后面按字段读会炸。统一在这里收成日志记录的形状。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const rec = parsed as { ts?: unknown; level?: unknown; msg?: unknown; extra?: unknown }
      out.push({
        ts: Number(rec.ts) || 0,
        level: typeof rec.level === 'string' ? rec.level : '',
        msg: typeof rec.msg === 'string' ? rec.msg : String(rec.msg ?? ''),
        ...(rec.extra && typeof rec.extra === 'object' && !Array.isArray(rec.extra)
          ? { extra: rec.extra as Record<string, unknown> }
          : {}),
      })
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 把消息里的易变部分抹掉，好做指纹 */
function normalize(msg: string): string {
  return msg
    .replace(/\d{2}:\d{2}:\d{2}/g, '<时间>')
    .replace(/\b\d{10,13}\b/g, '<时间戳>')
    .replace(/\b\d{4,}\b/g, '<数字>')
    .replace(/"[^"]{40,}"/g, '"<长文本>"')
    .slice(0, 120)
}

export interface ObserveOptions {
  /** 往前看几天 */
  days?: number
  /** 至少出现几次才算问题 */
  minCount?: number
  /**
   * 只看最近多少小时（默认 12）。
   *
   * 不加这个的话，**一次启动失败会挂在 prompt 里一整天**：旧进程抢端口失败的
   * error 留在日志里，哪怕后来 WS 早就连上了，它也会跟用户说"我这边有个地方老报错"。
   */
  sinceHours?: number
}

/**
 * 扫最近几天的日志，找出反复出问题的地方。
 * 只挑 warn / error——info 是正常流水。
 */
/** 这些是测试或正常行为，不算问题 */
const NOISE = [
  /工具重名，已覆盖/,
  /控制台请求出错/,
  // 重试是正常机制：最终失败会单独记一条，重试警告不该算问题
  /重试（第 \d+ 次）/,
  // 单条消息被跳过属于正常过滤
  /重复消息，已跳过/,
  // 测试插件（scripts/_plugin-test-guard.ts 里那批）被禁用是预期行为
  /\[plugin:(demo|edge-|probe-|e2e-)/,
  // 看门狗关着是配置选择，不是故障 —— 别让它进 prompt 说"我这边老报错"
  /看门狗未启用/,
  // 启动早期 NapCat 还没连上时拉不到群成员是常态（后续会降级用缓存）。
  // 旧日志的 msg 是纯"拉群成员失败"；新代码已经把"有缓存"降成 info，
  // 只有"没有旧缓存"才 warn（那条 msg 带后缀，不会被这里吃掉）。
  /^拉群成员失败$/,
]

export function findIssues(opts: ObserveOptions = {}): Issue[] {
  const days = Math.min(14, Math.max(1, opts.days ?? 3))
  const minCount = Math.max(1, opts.minCount ?? 2)
  const sinceMs = Date.now() - Math.max(1, opts.sinceHours ?? 12) * 3_600_000

  const buckets = new Map<string, Issue>()

  for (let i = 0; i < days; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    for (const rec of readDayLog(dayKey(d))) {
      if (rec.level !== 'warn' && rec.level !== 'error') continue
      if (NOISE.some((re) => re.test(rec.msg))) continue
      // 时间窗：太久以前的错误可能早就恢复了，不该一直挂在 prompt 里
      if (Number(rec.ts) && Number(rec.ts) < sinceMs) continue

      // where 只认字符串；对象/数字当没有位置，免得拼出 "[object Object]" 这样的指纹
      const where = typeof rec.extra?.where === 'string' ? rec.extra.where : ''
      // 指纹只按「级别 + 归一化后的消息」算，**不含行号**：
            // 同一个错误在不同行号报，对用户来说是同一件事，拆成多条只会淹没真正的问题。
            // 行号作为「最近一次出现的位置」留着展示。
            const key = `${rec.level}|${normalize(rec.msg)}`
      const existing = buckets.get(key)
      const extraText = rec.extra ? JSON.stringify(rec.extra).slice(0, 120) : ''

      const ts = Number(rec.ts) || 0
      if (existing) {
        existing.count++
        if (ts) {
          existing.lastAt = Math.max(existing.lastAt, ts)
          existing.firstAt = existing.firstAt ? Math.min(existing.firstAt, ts) : ts
        }
        if (existing.samples.length < 3 && extraText && !existing.samples.includes(extraText)) {
          existing.samples.push(extraText)
        }
      } else {
        buckets.set(key, {
          key,
          message: rec.msg,
          where,
          level: rec.level,
          count: 1,
          firstAt: ts,
          lastAt: ts,
          confidence: '可能',
          samples: extraText ? [extraText] : [],
        })
      }
    }
  }

  // 有位置的按 minCount 收；没位置的必须出现更多次才值得报——
  // 不然一堆"不知道在哪"的噪声，看的人也没法处理。
  // 测试造的错不该进"它发现的问题"：
  //   probe-/e2e-/edge- 是测试插件的 id（见 scripts/_plugin-test-guard.ts），
  //   qqbot-* 临时目录是测试的沙盒。
  // 这些会经日志漏进来，导致它在聊天里跟用户报"我这套程序有地方报错"，其实是测试。
  const TEST_NOISE = /(?:\[plugin:(?:probe-|e2e-|edge-))|(?:qqbot-(?:probe|plugin|health|store|emoji)-)|(?:Temp[\\\\/]qqbot)/
  const isTestNoise = (m: string): boolean => TEST_NOISE.test(m)

  const issues = [...buckets.values()]
    .filter((i) => (i.where ? i.count >= minCount : i.count >= Math.max(5, minCount)))
    // 测试造的错不算"它发现的问题"
    .filter((i) => !isTestNoise(i.message) && !isTestNoise((i.samples || []).join(' ')))

  for (const issue of issues) {
    issue.confidence = issue.where ? '确定' : '可能'
  }

  return issues.sort((a, b) => {
    // 确定的排前面，然后按出现次数
    if (a.confidence !== b.confidence) return a.confidence === '确定' ? -1 : 1
    return b.count - a.count
  })
}



/* ============ 定时扫 + 待提 ============ */

const ISSUES_FILE = 'persona/issues.json'

export interface StoredIssue extends Issue {
  /** 提过的时间；0 = 还没提 */
  mentionedAt: number
  /** 它读了代码之后的判断（诊断过才有） */
  guess?: {
    what: string
    why: string
    certainty: '确定' | '大概' | '猜的'
    howToFix: string
  }
}

interface IssueStore {
  at: number
  items: StoredIssue[]
}

export function loadIssueStore(): IssueStore {
  const f = ISSUES_FILE
  if (!existsSync(f)) return { at: 0, items: [] }
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as { at?: unknown; items?: unknown }
    return {
      at: Number(data.at ?? 0) || 0,
      // 手改坏的文件里 items 可能是 null/对象/夹着 null，别让一条脏数据拖垮整个待提列表
      items: Array.isArray(data.items)
        ? data.items.filter(
            (i): i is StoredIssue =>
              !!i && typeof i === 'object' && !Array.isArray(i) && typeof (i as StoredIssue).key === 'string',
          )
        : [],
    }
  } catch {
    return { at: 0, items: [] }
  }
}

function saveIssueStore(s: IssueStore): void {
  writeAtomic(ISSUES_FILE, JSON.stringify(s, null, 2))
}

/**
 * 扫一次，把"确定的"问题存下来。
 * 已经在库里的保留 mentionedAt（别重复骚扰），新出现的 mentionedAt = 0。
 */
export function refreshIssues(): StoredIssue[] {
  const found = findIssues({ days: 3, minCount: 2 })
  const old = loadIssueStore()
  const oldMap = new Map(old.items.map((i) => [i.key, i]))

  const items: StoredIssue[] = found.map((i) => {
    const prev = oldMap.get(i.key)
    return {
      ...i,
      mentionedAt: prev?.mentionedAt ?? 0,
      // 诊断结果留着：代码没变的话不用重新读一遍
      ...(prev?.guess ? { guess: prev.guess } : {}),
    }
  })

  saveIssueStore({ at: Date.now(), items })
  return items
}

/** 还没跟人提过的、确定的那些 */
export function unmentionedIssues(): StoredIssue[] {
  return loadIssueStore()
    .items.filter((i) => i.confidence === '确定' && i.mentionedAt === 0)
    .slice(0, 2)
}

/** 标记这些已经给过说话的机会了（不在下次重复注入） */
export function markMentioned(keys: string[]): void {
  if (!keys.length) return
  const s = loadIssueStore()
  const now = Date.now()
  for (const i of s.items) {
    if (keys.includes(i.key)) i.mentionedAt = now
  }
  saveIssueStore(s)
}

/** 每 N 小时扫一次 */
export function startObserving(getLlm: () => LlmOptions, intervalMs = 6 * 3600_000): () => void {
  const run = async () => {
    try {
      const items = refreshIssues()
      const sure = items.filter((i) => i.confidence === '确定')
      if (!sure.length) return
      info(`扫了一遍日志，${sure.length} 个确定的问题`)

      // 有位置但还没诊断过的，读一下代码猜原因
      const todo = sure.filter((i) => !i.guess && i.where).slice(0, 2)
      if (!todo.length) return
      const { diagnose } = await import('./diagnose.ts')
      for (const issue of todo) {
        const d = await diagnose(issue, getLlm())
        if (!d) continue
        const cur = loadIssueStore()
        const hit = cur.items.find((x) => x.key === issue.key)
        if (hit) hit.guess = d
        saveIssueStore(cur)
        info(`诊断了 ${issue.where}：${d.why.slice(0, 40)}`)
      }
    } catch {
      /* 扫失败不影响主流程 */
    }
  }
  setTimeout(() => void run(), 2 * 60_000)
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
