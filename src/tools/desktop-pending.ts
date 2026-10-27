/**
 * 待确认的电脑操作。
 *
 * 为什么要有这个：点击/打字是真会改变你电脑状态的，
 * 不能让模型想点就点。所以危险操作先"排队"，你在控制台点一下才执行。
 *
 * 为什么不用"模型自己带 confirm 参数"：
 *   模型完全可以自己加上 confirm: true 然后重试 —— 那等于没有确认。
 *   真正的确认必须由**人**在某个界面上点，所以这里用磁盘队列 + 控制台审批。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = join('data', 'desktop-pending.json')
/** 队列最多这么多条，超了丢最旧的（防止模型刷一堆） */
const MAX_ITEMS = 20
/** 一条待确认记录多久失效：10 分钟没批就丢，省得你回来看到一堆过期的 */
const TTL_MS = 10 * 60_000

export interface PendingAction {
  id: string
  ts: number
  /** 哪个工具（click / type_text / ...） */
  tool: string
  /** 参数 */
  args: Record<string, unknown>
  /** 给用户看的一句话 */
  preview: string
  status: 'pending' | 'done' | 'rejected'
  /** done 之后的结果摘要 */
  result?: string
}

function readAll(): PendingAction[] {
  try {
    if (!existsSync(FILE)) return []
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is PendingAction => {
      return (
        !!x &&
        typeof x === 'object' &&
        typeof (x as PendingAction).id === 'string' &&
        typeof (x as PendingAction).ts === 'number' &&
        typeof (x as PendingAction).tool === 'string'
      )
    })
  } catch {
    return []
  }
}

function writeAll(items: PendingAction[]): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(items, null, 2), 'utf8')
}

function idOf(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 加一条待确认。返回它的 id。 */
export function queueAction(tool: string, args: Record<string, unknown>, preview: string): PendingAction {
  const items = readAll().filter((x) => x.status === 'pending')
  const item: PendingAction = {
    id: idOf(),
    ts: Date.now(),
    tool,
    args,
    preview,
    status: 'pending',
  }
  items.push(item)
  writeAll(items.slice(-MAX_ITEMS))
  return item
}

/** 列出还没处理的（顺手清掉过期的） */
export function listPending(): PendingAction[] {
  const now = Date.now()
  const all = readAll()
  const fresh = all.filter((x) => x.status !== 'pending' || now - x.ts < TTL_MS)
  if (fresh.length !== all.length) writeAll(fresh)
  return fresh.filter((x) => x.status === 'pending').sort((a, b) => b.ts - a.ts)
}

/** 标记成完成/拒绝，返回那条记录 */
export function settleAction(id: string, status: 'done' | 'rejected', result?: string): PendingAction | null {
  const all = readAll()
  const hit = all.find((x) => x.id === id)
  if (!hit) return null
  hit.status = status
  if (result) hit.result = result.slice(0, 200)
  writeAll(all)
  return hit
}

/** 取一条（不管状态），审批时要看参数 */
export function getAction(id: string): PendingAction | null {
  return readAll().find((x) => x.id === id) ?? null
}
