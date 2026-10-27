/**
 * 电脑操作日志。
 *
 * 为什么要单独记一份：ai-desktop 自己有日志（~/.ai-desktop/logs），
 * 但那是它自己的格式，而且只记"命令执行了"，不记"模型为什么这么做"。
 *
 * 这里记的是：模型想干什么、参数是什么、你批没批、结果如何。
 * 排查"它为什么点了那个地方"时看这份。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = join('data', 'desktop-log.jsonl')
/** 最多留这么多条，超了从旧的开删（每次写时顺手裁，不用定时任务） */
const MAX_LINES = 2000

export interface DesktopLogEntry {
  ts: number
  /** 哪个工具 */
  tool: string
  /** 参数（已经去掉可能的敏感内容） */
  args: Record<string, unknown>
  /** ok / blocked / need-confirm / failed */
  outcome: 'ok' | 'blocked' | 'need-confirm' | 'failed'
  /** 一句话说明 */
  detail?: string
}

export function logDesktopAction(e: DesktopLogEntry): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    appendFileSync(FILE, `${JSON.stringify(e)}\n`, 'utf8')
    pruneIfNeeded()
  } catch {
    /* 记不上不影响操作本身 */
  }
}

function pruneIfNeeded(): void {
  try {
    if (!existsSync(FILE)) return
    const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
    if (lines.length <= MAX_LINES) return
    // 只留后面一半：一次裁 1000 行，不用每写一行都重写整个文件
    const keep = lines.slice(-Math.floor(MAX_LINES / 2))
    appendFileSync(FILE, '', 'utf8')
    // 用 writeFileSync 覆盖（这里引入一次，不常走到）
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(FILE, `${keep.join('\n')}\n`, 'utf8')
  } catch {
    /* 裁不掉就算了，继续追加 */
  }
}

export interface DesktopLogRow extends DesktopLogEntry {
  /** 多久以前 */
  ago: string
}

function agoText(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 读最近 N 条（新的在前） */
export function readDesktopLog(limit = 50): DesktopLogRow[] {
  try {
    if (!existsSync(FILE)) return []
    const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          const e = JSON.parse(l) as DesktopLogEntry
          return { ...e, ago: agoText(e.ts) }
        } catch {
          return null
        }
      })
      .filter((x): x is DesktopLogRow => x !== null)
  } catch {
    return []
  }
}
