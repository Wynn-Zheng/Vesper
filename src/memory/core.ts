/**
 * 核心记忆：一定不能忘的。
 *
 * 和 fact 的区别是**性质**，不是程度：
 *   fact = "关于他的一件事"（会过时、会变）
 *   core = "不能弄错的东西"（身份、边界、诺言）
 *
 * 两个文件，权限不同：
 *   persona/core.md           只能人改。它只读。
 *   persona/core-requests.md  它写申请，人审。
 *
 * 为什么它不能直接写：现在它给对方打 importance 分都是 5-7 一片，
 * 让它自己判断"什么该永远记住"必然膨胀。给申请权、不给写入权。
 */
import { existsSync, readFileSync } from 'node:fs'
import { info, warnAt } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'
import { cardScopedPath } from '../persona/card.ts'
import { sharedBigrams, similarity } from '../core/text.ts'

// 「不能越的线」和它的申请都按角色卡隔离
const CORE_LEGACY = 'persona/core.md'
const REQ_LEGACY = 'persona/core-requests.md'
function CORE_FILE(): string {
  return cardScopedPath('core.md', CORE_LEGACY)
}
function REQ_FILE(): string {
  return cardScopedPath('core-requests.md', REQ_LEGACY)
}

/** 核心条目上限。到顶了就拒绝，逼人删一条。 */
const MAX_CORE = 30
/** 申请上限。太多了人也不会看。 */
const MAX_REQUESTS = 10

export type CoreKind = '身份' | '边界' | '诺言' | '偏好'

export interface CoreItem {
  /** 条目正文 */
  text: string
  /** 哪一类，决定它在 prompt 里怎么被强调 */
  kind: CoreKind
  /** 加进去的日期 */
  at: string
}

export interface CoreRequest {
  /** 它想记的话 */
  text: string
  /** 它给的类别 */
  kind: CoreKind
  /** 为什么想记成核心（它自己的一句话） */
  reason: string
  /** 提交时间 */
  at: number
}

const KINDS: CoreKind[] = ['身份', '边界', '诺言', '偏好']

function parseKind(raw: string | undefined): CoreKind {
  const t = (raw ?? '').trim()
  return (KINDS.find((k) => k === t) ?? '身份') as CoreKind
}

/* ============================================================
 * 读：core.md
 * ============================================================ */

/**
 * 解析 core.md。
 *
 * 格式（人能直接改，所以容错）：
 *   ## 身份
 *   - 他叫「欲辨已妄言」
 *   ## 边界
 *   - 他讨厌被追问感受
 *
 * 也接受平铺（没有 ## 的），一律当「身份」。
 */
export function parseCore(text: string): CoreItem[] {
  const out: CoreItem[] = []
  let curKind: CoreKind = '身份'

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      // 分段标题
      const m = /^##\s*(身份|边界|诺言|偏好)/.exec(line)
      if (m) curKind = m[1] as CoreKind
      continue
    }
    // 列表项：- xxx  /  * xxx  /  1. xxx
    const m = /^[-*]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line)
    if (!m) continue
    const item = m[1]!.trim()
    if (item.length < 2) continue
    // 条目可以带日期后缀 ｜2026-10-26
    const parts = item.split('｜')
    const body = parts[0]!.trim()
    const at = parts[1]?.trim() ?? ''
    if (body) out.push({ text: body, kind: curKind, at })
  }

  return out
}

/** 读核心记忆。文件不存在返回空。 */
export function loadCore(): CoreItem[] {
  if (!existsSync(CORE_FILE())) return []
  try {
    return parseCore(readFileSync(CORE_FILE(), 'utf8'))
  } catch {
    warnAt('核心记忆读不出来，按空的处理', { file: CORE_FILE() })
    return []
  }
}

function renderCore(items: CoreItem[]): string {
  const lines: string[] = [
    '# 我一定不能忘的',
    '',
    '> 这个文件**只有我能改**。它只读。',
    '> 它可以提申请（在 core-requests.md），批准了才写进这里。',
    '> 分四类：身份 / 边界 / 诺言 / 偏好。直接改这个文件就行，格式别丢 `- `。',
    '',
  ]

  const byKind = new Map<CoreKind, CoreItem[]>()
  for (const it of items) {
    const list = byKind.get(it.kind) ?? []
    list.push(it)
    byKind.set(it.kind, list)
  }

  for (const kind of KINDS) {
    const list = byKind.get(kind)
    if (!list?.length) continue
    lines.push(`## ${kind}`, '')
    for (const it of list) {
      lines.push(`- ${it.text}${it.at ? `｜${it.at}` : ''}`)
    }
    lines.push('')
  }

  if (!items.length) lines.push('（还没有核心记忆）', '')

  return lines.join('\n')
}

/** 直接写核心记忆（人操作时用） */
export function saveCore(items: CoreItem[]): boolean {
  if (items.length > MAX_CORE) {
    info('核心记忆超过上限，没写', { 数量: items.length, 上限: MAX_CORE })
    return false
  }
  writeAtomic(CORE_FILE(), renderCore(items))
  return true
}

/* ============================================================
 * 申请：core-requests.md
 * ============================================================ */

/**
 * 解析申请书。
 *
 * 格式：
 *   ## 2026-10-26 23:50
 *   - 类别：边界
 *   - 想记成核心的：他讨厌被追问感受
 *   - 为什么：这是他明确说过的边界，我要是忘了会反复踩
 */
export function parseRequests(text: string): CoreRequest[] {
  const out: CoreRequest[] = []
  // 用标题切块
  const blocks = text.split(/^##\s+/m).slice(1)

  for (const block of blocks) {
    const t = block.trim()
    if (!t) continue

    const head = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/.exec(t)
    const at = head ? Date.parse(`${head[1]}T${head[2]}`) || Date.now() : Date.now()

    const kindM = /^-\s*类别：\s*(.*)$/m.exec(t)
    const textM = /^-\s*想记成核心的：\s*(.*)$/m.exec(t)
    const reasonM = /^-\s*为什么：\s*(.*)$/m.exec(t)

    const body = textM?.[1]?.trim()
    if (!body || body.length < 2) continue

    out.push({
      text: body,
      kind: parseKind(kindM?.[1]),
      reason: reasonM?.[1]?.trim() ?? '',
      at,
    })
  }

  return out
}

export function loadRequests(): CoreRequest[] {
  if (!existsSync(REQ_FILE())) return []
  try {
    return parseRequests(readFileSync(REQ_FILE(), 'utf8'))
  } catch {
    warnAt('核心记忆申请读不出来，按空的处理', { file: REQ_FILE() })
    return []
  }
}

function renderRequests(reqs: CoreRequest[]): string {
  const lines: string[] = [
    '# 我想记成核心的（等你批）',
    '',
    '> 这些是我觉得"不能弄错"的事，但我不敢自己往 core.md 里写，等你批。',
    '> 批了就移到 core.md；不要就删掉。',
    '',
  ]

  if (!reqs.length) {
    lines.push('（现在没有申请）', '')
    return lines.join('\n')
  }

  for (const r of reqs) {
    const when = new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(`## ${when}`)
    lines.push(`- 类别：${r.kind}`)
    lines.push(`- 想记成核心的：${r.text}`)
    if (r.reason) lines.push(`- 为什么：${r.reason}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 它提一条申请。
 *
 * 会被去重：和已有核心、已有申请太像的不收（不然它会反复提同一条）。
 */
export function requestCore(text: string, kind: CoreKind, reason: string): { ok: boolean; why: string } {
  const body = text.trim().slice(0, 200)
  if (body.length < 3) return { ok: false, why: '太短' }

  const core = loadCore()
  const reqs = loadRequests()

  const tooClose = (a: string, b: string): boolean => {
    if (a === b) return true
    if (similarity(a, b) > 0.55) return true
    const need = Math.max(4, Math.floor(Math.min(a.length, b.length) / 4))
    return sharedBigrams(a, b) >= need
  }

  if (core.some((c) => tooClose(c.text, body))) {
    return { ok: false, why: '已经是核心记忆了' }
  }
  if (reqs.some((r) => tooClose(r.text, body))) {
    return { ok: false, why: '已经提过这条了，等你批' }
  }
  if (reqs.length >= MAX_REQUESTS) {
    return { ok: false, why: `待批的申请已经有 ${MAX_REQUESTS} 条了，先让人处理一下` }
  }

  reqs.push({ text: body, kind, reason: reason.trim().slice(0, 120), at: Date.now() })
  writeAtomic(REQ_FILE(), renderRequests(reqs))
  info('它提了一条核心记忆申请', { 类别: kind, 内容: body.slice(0, 30) })
  return { ok: true, why: '已提交，等人批' }
}

/** 批准第 i 条申请 */
export function approveRequest(index: number): { ok: boolean; item?: CoreItem } {
  const reqs = loadRequests()
  const r = reqs[index]
  if (!r) return { ok: false }

  const core = loadCore()
  if (core.length >= MAX_CORE) {
    warnAt('核心记忆到上限了，先删一条', { 上限: MAX_CORE })
    return { ok: false }
  }

  const item: CoreItem = { text: r.text, kind: r.kind, at: new Date().toISOString().slice(0, 10) }
  core.push(item)
  reqs.splice(index, 1)

  writeAtomic(CORE_FILE(), renderCore(core))
  writeAtomic(REQ_FILE(), renderRequests(reqs))
  info('批准了一条核心记忆', { 内容: r.text.slice(0, 30) })
  return { ok: true, item }
}

/** 拒绝第 i 条申请 */
export function rejectRequest(index: number): boolean {
  const reqs = loadRequests()
  if (!reqs[index]) return false
  reqs.splice(index, 1)
  writeAtomic(REQ_FILE(), renderRequests(reqs))
  return true
}

/** 手动加一条核心（人在控制台加） */
export function addCore(text: string, kind: CoreKind): { ok: boolean; why: string } {
  const body = text.trim().slice(0, 200)
  if (body.length < 2) return { ok: false, why: '太短' }
  const core = loadCore()
  if (core.length >= MAX_CORE) return { ok: false, why: `已经有 ${MAX_CORE} 条了，先删一条` }
  if (core.some((c) => c.text === body)) return { ok: false, why: '已经有了' }

  core.push({ text: body, kind, at: new Date().toISOString().slice(0, 10) })
  writeAtomic(CORE_FILE(), renderCore(core))
  return { ok: true, why: '加了' }
}

/** 删一条核心 */
export function dropCore(index: number): boolean {
  const core = loadCore()
  if (!core[index]) return false
  core.splice(index, 1)
  writeAtomic(CORE_FILE(), renderCore(core))
  return true
}

/**
 * 渲染核心记忆给 prompt 用。
 *
 * 顺序有讲究：身份 → 边界 → 诺言 → 偏好。
 * 边界放前面，因为"不许干什么"比"喜欢什么"更不能弄错。
 */
export function renderCoreForPrompt(): string {
  const items = loadCore()
  if (!items.length) return ''

  const order: CoreKind[] = ['身份', '边界', '诺言', '偏好']
  const lines: string[] = ['【我一定不能弄错的】']

  for (const kind of order) {
    const list = items.filter((i) => i.kind === kind)
    if (!list.length) continue
    lines.push(`${kind}：`)
    for (const it of list) lines.push(`- ${it.text}`)
  }

  return lines.join('\n')
}
