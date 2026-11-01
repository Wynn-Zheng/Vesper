/**
 * 它想改的东西 —— 通用申请。
 *
 * 背景：core.md 早就有"它只能申请、人来批"的机制，效果不错。
 * 现在把同一套推广到其它被锁住的字段（名字、自述、能力、规矩、人物档案）。
 *
 * 为什么不让它直接改：
 *   这些都是"用户定义"或"它的自我认知"，它自己改会漂。
 *   但完全不给改也不行 —— 它有自己的意愿，想改名、想修正对自己的描述，
 *   这本身是"像人"的一部分。
 *
 * 所以：给申请权、不给写入权。和 core 一个道理。
 *
 * 存储是人能直接读改的 markdown（见 renderRequests）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { cardScopedPath } from '../persona/card.ts'
import { writeAtomic } from '../store/fs.ts'

// 按角色卡隔离
const FILE_LEGACY = 'persona/requests.md'
function FILE(): string {
  return cardScopedPath('requests.md', FILE_LEGACY)
}

/** 每个字段最多挂几条待批。太多了人也不看。 */
const MAX_PER_TARGET = 3
/** 被忽略之后，同一字段多久内不许再提（毫秒）。防骚扰。 */
export const REJECT_COOLDOWN_MS = 24 * 3600_000

export type RequestTarget = 'name' | 'about' | 'abilities' | 'plays' | 'person' | 'card'

export interface ChangeRequest {
  /** 稳定 id（时间戳字符串） */
  id: string
  target: RequestTarget
  /** 目标是 person 时，指谁 */
  subject?: string
  /** 想改成什么 */
  content: string
  /** 为什么想改 */
  reason: string
  at: number
}

const LABEL: Record<RequestTarget, string> = {
  name: '名字',
  about: '我是谁',
  abilities: '我能做什么',
  plays: '说话方式',
  person: '人物档案',
  card: '角色卡',
}

const TARGETS = Object.keys(LABEL) as RequestTarget[]

export function labelOf(t: RequestTarget): string {
  return LABEL[t] ?? t
}

/* ============================================================
 * 解析 / 渲染
 * ============================================================ */

function parse(text: string): ChangeRequest[] {
  const out: ChangeRequest[] = []
  // 每块以 "## <时间> · <目标>" 开头
  const blocks = text.split(/^## /m).slice(1)
  for (const b of blocks) {
    const head = /^(.+?)\s*·\s*(\S+)/.exec(b.split('\n')[0] ?? '')
    if (!head) continue

    const tgtRaw = head[2]?.trim() ?? ''
    const tgt = TARGETS.find((t) => t === tgtRaw || LABEL[t] === tgtRaw)
    if (!tgt) continue

    const get = (k: string): string => {
      const m = new RegExp(`^-\\s*${k}[：:]\\s*(.+)$`, 'm').exec(b)
      return m ? (m[1] ?? '').trim() : ''
    }

    const content = get('想改成')
    if (!content) continue

    out.push({
      id: head[1]?.trim() ?? String(Date.now()),
      target: tgt,
      subject: get('谁') || undefined,
      content,
      reason: get('为什么'),
      at: Date.parse(head[1]?.trim() ?? '') || Date.now(),
    })
  }
  return out
}

function render(reqs: ChangeRequest[]): string {
  const lines = [
    '# 它想改的（等你批）',
    '',
    '> 这些是它自己觉得想改的地方，等你点头。',
    '> 批了就改过去；不要就删掉这节。删了之后它 24 小时内不会再提同一件事。',
    '',
  ]

  if (!reqs.length) {
    lines.push('（现在没有申请）', '')
    return lines.join('\n')
  }

  for (const r of reqs) {
    lines.push(`## ${r.id} · ${r.target}`)
    if (r.subject) lines.push(`- 谁：${r.subject}`)
    lines.push(`- 想改成：${r.content}`)
    if (r.reason) lines.push(`- 为什么：${r.reason}`)
    lines.push('')
  }
  return lines.join('\n')
}

/* ============================================================
 * 读写
 * ============================================================ */

export function loadRequests(): ChangeRequest[] {
  if (!existsSync(FILE())) return []
  try {
    return parse(readFileSync(FILE(), 'utf8'))
  } catch {
    return []
  }
}

function save(reqs: ChangeRequest[]): void {
  writeAtomic(FILE(), render(reqs))
}

/** 被忽略的记录（哪个字段、什么时候），用来做冷却 */
const REJECT_FILE = 'persona/requests-rejected.json'

function loadRejected(): Record<string, number> {
  if (!existsSync(REJECT_FILE)) return {}
  try {
    return JSON.parse(readFileSync(REJECT_FILE, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function saveRejected(map: Record<string, number>): void {
  writeAtomic(REJECT_FILE, JSON.stringify(map, null, 2))
}

/* ============================================================
 * 提申请
 * ============================================================ */

export function requestChange(
  target: RequestTarget,
  content: string,
  reason: string,
  subject?: string,
): { ok: boolean; why: string } {
  const body = content.trim().slice(0, 600)
  if (body.length < 2) return { ok: false, why: '太短，不知道你想改成什么' }
  if (!reason.trim()) return { ok: false, why: '得说清楚为什么想改' }

  const reqs = loadRequests()
  const key = subject ? `${target}:${subject}` : target

  // 冷却：刚被忽略过的字段，24 小时内不再提
  const rejected = loadRejected()
  const lastReject = rejected[key] ?? 0
  if (Date.now() - lastReject < REJECT_COOLDOWN_MS) {
    return { ok: false, why: '这个刚被忽略过，过一天再说' }
  }

  const same = reqs.filter((r) => r.target === target && (r.subject ?? '') === (subject ?? ''))
  if (same.length >= MAX_PER_TARGET) {
    return { ok: false, why: `这一项已经有 ${MAX_PER_TARGET} 条待批了，等主人处理一下` }
  }
  if (same.some((r) => r.content === body)) {
    return { ok: false, why: '已经提过同样的了' }
  }

  // id 必须唯一：同一分钟内提多条时，光用时间戳会撞，
  // 撞了 takeRequest 就会删错那一条（踩过）。
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  // 用「最大序号 + 1」，不是「数量 + 1」。
  // 用数量的话，删掉中间一条之后会重新排出已经存在的号，id 就撞了
  // （踩过：删掉 -1 后剩 -2 -3，再提一条又算出 -3，takeRequest 就删错）。
  const maxSeq = reqs
    .filter((r) => r.id.startsWith(stamp + '-'))
    .reduce((m, r) => Math.max(m, Number(r.id.slice(stamp.length + 1)) || 0), 0)
  const seq = maxSeq + 1
  reqs.push({
    id: `${stamp}-${seq}`,
    target,
    subject,
    content: body,
    reason: reason.trim().slice(0, 300),
    at: Date.now(),
  })
  save(reqs)
  return { ok: true, why: '提了，等主人批' }
}

/** 按 id 取一条并移除（批准/忽略时用） */
export function takeRequest(id: string): ChangeRequest | null {
  const reqs = loadRequests()
  const i = reqs.findIndex((r) => r.id === id)
  if (i < 0) return null
  const [one] = reqs.splice(i, 1)
  save(reqs)
  return one ?? null
}

/** 记一笔"被忽略"，用于冷却 */
export function markRejected(target: RequestTarget, subject?: string): void {
  const key = subject ? `${target}:${subject}` : target
  const map = loadRejected()
  map[key] = Date.now()
  // 只留最近 50 条，别无限涨
  const keys = Object.keys(map)
  if (keys.length > 50) {
    for (const k of keys.sort((a, b) => map[a]! - map[b]!).slice(0, keys.length - 50)) {
      delete map[k]
    }
  }
  saveRejected(map)
}

/** 渲染给 prompt 看的一行（让它在对话里知道自己有申请在等） */
export function renderPendingForPrompt(): string {
  const reqs = loadRequests()
  if (!reqs.length) return ''
  const lines = reqs.map((r) => `- ${labelOf(r.target)}${r.subject ? `（${r.subject}）` : ''}：想改成「${r.content.slice(0, 40)}」`)
  return `\n# 我已经提了、还在等你批的\n${lines.join('\n')}\n（这些还没生效，别当成已经改了）`
}
