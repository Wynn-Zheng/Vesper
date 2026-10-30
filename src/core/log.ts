import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

export type Level = 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: number
  level: Level
  msg: string
  extra?: Record<string, unknown>
}

/** 控制台通过它订阅实时日志 */
export const logBus = new EventEmitter()
logBus.setMaxListeners(50)

const COLOR: Record<Level, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

let logDir = 'data/logs'
let toFile = true

export function initLog(dir = 'data/logs', file = true): void {
  logDir = dir
  toFile = file
  if (toFile) mkdirSync(logDir, { recursive: true })
}

function stamp(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`
}

function day(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const t = stamp()
  const tag = `${COLOR[level]}${level.padEnd(5)}${RESET}`
  const tail = extra ? ` ${DIM}${JSON.stringify(extra)}${RESET}` : ''
  console.log(`${DIM}[${t}]${RESET} ${tag} ${msg}${tail}`)

  const record: LogRecord = { ts: Date.now(), level, msg, ...(extra ? { extra } : {}) }
  // 某个订阅者（比如断掉的 SSE 连接）抛错不能把异常抛回业务代码
  try {
    logBus.emit('log', record)
  } catch {
    /* ignore */
  }

  if (!toFile) return
  try {
    const file = join(logDir, `${day()}.jsonl`)
    // 单文件超过 50MB 就轮转成 .1（覆盖上一份）：重连/心跳类的 warn 风暴
    // 一天能写几百 MB，没有上限的话打开日志页会卡死。
    try {
      if (statSync(file).size > 50 * 1024 * 1024) {
        const rotated = file + '.1'
        rmSync(rotated, { force: true })
        renameSync(file, rotated)
      }
    } catch {
      /* 文件还不存在时 stat 会抛，忽略 */
    }
  appendFileSync(file, `${JSON.stringify(record)}\n`)
  } catch {
    /* 落盘失败不该影响主流程 */
  }
}

export const info = (m: string, e?: Record<string, unknown>) => log('info', m, e)
export const warn = (m: string, e?: Record<string, unknown>) => log('warn', m, e)
export const error = (m: string, e?: Record<string, unknown>) => log('error', m, e)

/**
 * 从堆栈里找出"是哪个文件哪一行"。
 *
 * 别人（或它自己）看到 "fetch failed" 什么也干不了，
 * 但看到 "src/outward/bili.ts:47" 就能直接去改。
 * 所以 warn/error 要尽力带上位置。
 */
export function whereFromStack(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    const m2 = /\b(src[\\/][^\s():]+\.ts):(\d+):(\d+)/.exec(line)
    if (!m2) continue
    const file = m2[1]!.replace(/\\/g, '/')
    // 跳过日志模块自己：不然每条都报 "src/core/log.ts:xx"
    if (file === 'src/core/log.ts') continue
    return `${file}:${m2[2]}`
  }
  return ''
}

/** 带位置的警告：自动从当前调用栈找文件行号 */
export function warnAt(m: string, e?: Record<string, unknown>): void {
  const where = whereFromStack(new Error().stack)
  warn(m, { ...(e ?? {}), ...(where ? { where } : {}) })
}

/** 带位置的错误 */
export function errorAt(m: string, e?: Record<string, unknown>): void {
  const where = whereFromStack(new Error().stack) || whereFromStack(String((e as { stack?: string })?.stack ?? ''))
  error(m, { ...(e ?? {}), ...(where ? { where } : {}) })
}

/** 删掉超过 N 天的日志文件，避免无限增长 */
export function pruneLogs(days = 90): number {
  if (!toFile) return 0
  let removed = 0
  try {
    for (const f of readdirSync(logDir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (!m) continue
      const t = Date.parse(`${m[1]}T00:00:00`)
      if (!Number.isNaN(t) && Date.now() - t > days * 86_400_000) {
        rmSync(join(logDir, f), { force: true })
        removed++
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return removed
}
