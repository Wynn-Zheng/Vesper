import type { ChatMessage } from '../llm/types.ts'

/**
 * 历史压缩：把老的那截对话交给模型揉成一段滚动摘要，
 * 最近的几轮原样留着。
 *
 * 这里不碰网络，也不碰 persona/ 和 data/：
 * 调模型这件事由调用方通过 callLLM 注进来。
 */

/** 摘要长度上限（合并后） */
const SUMMARY_LIMIT = 400
/** 单次滚动摘要的目标字数，写进 prompt */
const DIGEST_LIMIT = 200

/** 历史超过阈值才值得压缩 */
export function shouldCompress(history: ChatMessage[], threshold: number, keepRecent: number): boolean {
  return history.length > threshold
}

/**
 * 从中间切开：最老的那截要被压掉，最后 keepRecent 条原样保留。
 * 纯函数，不碰入参。
 */
export function takeOldest(
  history: ChatMessage[],
  threshold: number,
  keepRecent: number,
): { oldest: ChatMessage[]; recent: ChatMessage[] } {
  const keep = Math.max(0, Math.floor(keepRecent))
  const keepCount = Math.min(keep, history.length)
  const split = history.length - keepCount
  return { oldest: history.slice(0, split), recent: history.slice(split) }
}

/** 把多模态 content 压成纯文字，图片只留个占位 */
function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' ? p.text : '[图片]'))
    .join(' ')
    .trim()
}

/** 摘要里用第几人称标一下谁说的 */
function speakerOf(role: ChatMessage['role']): string {
  if (role === 'user') return '对方'
  if (role === 'assistant') return '我'
  if (role === 'tool') return '工具'
  return '系统'
}

/** 把要压缩的轮次渲染成一行一句的文本 */
function renderTurns(turns: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of turns) {
    const text = contentText(m.content)
    if (!text) continue
    lines.push(`${speakerOf(m.role)}：${text}`)
  }
  return lines.join('\n')
}

/** 生成让模型合并滚动摘要的 prompt。只输出摘要正文。 */
export function buildSummaryPrompt(prevSummary: string | null, turns: ChatMessage[]): string {
  const prev = (prevSummary ?? '').trim()
  const lines: string[] = []
  lines.push('把下面这段聊天记录合并成一段滚动摘要，供以后接着聊时参考。')
  lines.push('')
  lines.push('要求：')
  lines.push(`- 全文不超过 ${DIGEST_LIMIT} 字。`)
  lines.push('- 必须保留：人物身份与关系、发生的事件、情绪基调、未完成的话题。')
  lines.push('- 丢掉寒暄、客套和重复内容。')
  lines.push('- 只输出摘要正文，不要标题、不要列表、不要解释你在做什么。')
  lines.push('')
  lines.push('已有的旧摘要：')
  lines.push(prev || '（无）')
  lines.push('')
  lines.push('需要并入的对话：')
  lines.push(renderTurns(turns) || '（无）')
  return lines.join('\n')
}

/** 去掉多余空白，避免摘要里攒出一堆换行 */
function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const summaryGraphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/**
 * 按字素边界截断，避免把 emoji / 组合字切成半个。
 * 先保证结果不超过上限（text.length 是 UTF-16 长度），
 * 再保证不会留下半个代理对或拆开的组合字符。
 */
function truncateSummary(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  let out = ''
  for (const { segment } of summaryGraphemes.segment(text)) {
    if (out.length + segment.length > limit) break
    out += segment
  }
  return out
}

/**
 * 把这次的新摘要接到旧摘要后面。
 * 旧摘要为空就直接用新的；否则用「；」拼起来。
 *
 * 超长时优先完整保留新摘要：它代表这次刚从 history 里移除的内容，
 * 丢掉就等于那几轮对话彻底没了。让旧摘要从尾部让位；
 * 只有新摘要自己就超过上限时才截新摘要，截的时候按字素切。
 */
export function mergeSummary(prevSummary: string | null, digest: string): string {
  const prev = squeeze(prevSummary ?? '')
  const next = squeeze(digest ?? '')

  if (!next) return truncateSummary(prev, SUMMARY_LIMIT)
  const nextPart = truncateSummary(next, SUMMARY_LIMIT)
  if (!prev) return nextPart

  // 「；」占 1 个字符；剩下的空间才轮到旧摘要
  const room = SUMMARY_LIMIT - nextPart.length - 1
  if (room <= 0) return nextPart

  const prevPart = truncateSummary(prev, room)
  return prevPart ? `${prevPart}；${nextPart}` : nextPart
}

export interface CompressOptions {
  /** 超过这么多条才压缩 */
  threshold: number
  /** 原样保留的最近条数 */
  keepRecent: number
  /** 上一轮的滚动摘要，没有就是 null */
  prevSummary: string | null
  /** 调模型。失败要抛出来，这里会兜住 */
  callLLM: (prompt: string) => Promise<string>
}

export interface CompressResult {
  /** 压缩后的滚动摘要；没压成就是原来的 prevSummary */
  summary: string
  /** 原样保留的最近消息 */
  recent: ChatMessage[]
  /** 这次到底压没压 */
  compressed: boolean
}

/**
 * 需要压缩时调一次 callLLM 拿摘要。
 * 调模型失败、或回了空串，就当没压过：summary 保持 prevSummary，不往上抛。
 */
export async function compressHistory(history: ChatMessage[], opts: CompressOptions): Promise<CompressResult> {
  const prev = opts.prevSummary ?? ''

  if (!shouldCompress(history, opts.threshold, opts.keepRecent)) {
    return { summary: prev, recent: history.slice(), compressed: false }
  }

  const { oldest, recent } = takeOldest(history, opts.threshold, opts.keepRecent)
  if (!oldest.length) {
    return { summary: prev, recent, compressed: false }
  }

  let digest = ''
  try {
    digest = await opts.callLLM(buildSummaryPrompt(opts.prevSummary, oldest))
  } catch {
    return { summary: prev, recent, compressed: false }
  }

  const text = typeof digest === 'string' ? digest.trim() : ''
  if (!text) {
    return { summary: prev, recent, compressed: false }
  }

  return { summary: mergeSummary(opts.prevSummary, text), recent, compressed: true }
}
