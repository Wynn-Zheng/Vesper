import { sharedBigrams } from '../core/text.ts'
import type { ChatMessage } from '../llm/types.ts'

/**
 * 历史压缩：把老的那截对话交给模型揉成一段滚动摘要，
 * 最近的几轮原样留着。
 *
 * 这里不碰网络，也不碰 persona/ 和 data/：
 * 调模型这件事由调用方通过 callLLM 注进来。
 */

/**
 * 摘要长度上限（合并后）。
 *
 * 原来是 400：聊两小时的群，历史就被压成 400 字 + 6 条原文，
 * 真人记得住昨天的具体对话，它记不住。1500 字大约是一屏，还在可控范围。
 */
export const SUMMARY_LIMIT = 1500
/** 单次滚动摘要的目标字数，写进 prompt（比上限低一点，留截断余量） */
export const DIGEST_LIMIT = 1100

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
  lines.push('- 旧摘要里仍然重要的内容要并进来，但**不要原句重复**。')
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
 * 按字素边界**保留尾部**地截断。
 *
 * 为什么保留尾部：摘要按时间顺序写，尾部才是最近发生的。
 * 超长时该丢的是最老的头部，原来的实现截的是尾部 ——
 * 实测跑 6 轮后的结果：最老的 300 字永远在，中间段落永久消失，最新只留 100 字。
 *
 * 先保证结果不超过上限（text.length 是 UTF-16 长度），
 * 再保证不会留下半个代理对或拆开的组合字符。
 */
function truncateTail(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const segments = [...summaryGraphemes.segment(text)]
  let out = ''
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!.segment
    if (out.length + seg.length > limit) break
    out = seg + out
  }
  return out
}

/**
 * 合并滚动摘要。
 *
 * **正常情况下不再拼 prev**：`buildSummaryPrompt` 已经把旧摘要喂给模型，
 * 模型输出的本来就是合并结果。再拼一次会让同一件事说两遍，
 * 白占一半预算（实测摘要开头是「他说最近工作压力很大…；他说最近工作压力很大…」）。
 *
 * 安全网：模型偶尔会忽略旧摘要、只总结这段新对话。
 * 判据用「旧摘要的 bigram 有多少出现在新摘要里」—— 完全不相关才算没合并。
 * 阈值故意定得很低（0.05）：正常聊天本来就会重复提到旧摘要里的事，
 * 判得太敏感会把"模型真的合并了"误判成"没合并"，白拼一次又变回重复。
 * prev 很短（<= 40 字）时不兜底：丢了损失也不大，不值得引入复杂判断。
 */
export function mergeSummary(prevSummary: string | null, digest: string): string {
  const prev = squeeze(prevSummary ?? '')
  const next = squeeze(digest ?? '')

  if (!next) return truncateTail(prev, SUMMARY_LIMIT)
  if (!prev) return truncateTail(next, SUMMARY_LIMIT)

  const cover = sharedBigrams(prev, next) / Math.max(1, prev.length - 1)
  const modelMerged = prev.length <= 40 || cover >= 0.05
  if (modelMerged) return truncateTail(next, SUMMARY_LIMIT)

  // 模型显然只写了新对话：接上旧摘要（保留较新的尾部，从头部让位）
  const nextPart = truncateTail(next, SUMMARY_LIMIT)
  const room = SUMMARY_LIMIT - nextPart.length - 1
  if (room <= 0) return nextPart
  const prevPart = truncateTail(prev, room)
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
