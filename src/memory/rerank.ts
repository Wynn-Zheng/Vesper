/**
 * 第二阶段重排（rerank）。
 *
 * 第一阶段（recall）负责"尽可能多地捞"，宁可多捞不要漏：
 * 语义分 + BM25 + 时间窗口加权求和，取 top N。
 *
 * 第二阶段（这里）负责"从捞到的里面挑最该给的"：
 * 用几条规则重新打分，并且**去重**——第一阶段经常把三件说同一件事的记忆
 * 一起带上来，占掉名额。
 *
 * 为什么不用模型 rerank：候选只有 20 条量级，一次模型调用要几百毫秒
 * 且要花钱；规则能覆盖的信号（标题命中、覆盖率、新鲜度、多样性）已经够用。
 * 等记忆到上千条再考虑 cross-encoder。
 */
import { similarity } from '../core/text.ts'

/** 高频虚词：算"关键词覆盖率"时要去掉，不然任何一句话都能覆盖一堆。 */
const STOP = new Set([
  '的', '了', '是', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '们',
  '这', '那', '个', '在', '有', '和', '就', '都', '也', '不', '很', '还', '要',
  '说', '过', '一', '上', '下', '去', '来', '得', '把', '被', '给', '让', '对',
  '什', '么', '怎', '样', '哪', '谁', '时', '候', '现', '在',
])

/** 从 query 里抽"实词"（按字，去停用词），用于算覆盖率 */
function contentChars(query: string): string[] {
  return [...query.replace(/\s+/g, '')].filter((c) => !STOP.has(c))
}

export type RerankOpts = {
  /** 最多返回几条 */
  limit: number
  /** 现在（算新鲜度用） */
  now?: number
  /** 标题字段怎么取（episode 用 title，fact 用 text） */
  titleOf?: (item: unknown) => string
  textOf?: (item: unknown) => string
}

export type RerankResult<T> = {
  item: T
  score: number
  /** 每条为什么被加分/减分，调试和"为什么想起这个"用 */
  why: string[]
}

const DAY = 86_400_000

/**
 * 重排。
 *
 * 输入：第一阶段的候选（带原始分），输出：挑好的、去重的、带理由的。
 *
 * 规则：
 *   1. 标题命中 —— query 的实词出现在标题里，说明这条就是在说这件事
 *   2. 覆盖率 —— 实词在正文里的覆盖比例（比 Jaccard 更贴近"聊到这事的程度"）
 *   3. 新鲜度 —— 7 天内的事更容易被想起（和人一样）
 *   4. 多样性 —— 和已选的重叠太高就跳过（避免三件同一件事占满名额）
 */
export function rerank<T>(
  query: string,
  candidates: Array<{ item: T; score: number }>,
  opts: RerankOpts,
): RerankResult<T>[] {
  const now = opts.now ?? Date.now()
  const chars = contentChars(query)
  const uniq = [...new Set(chars)]

  const titleOf = opts.titleOf ?? ((x: unknown) => String((x as { title?: string })?.title ?? ''))
  const textOf = opts.textOf ?? ((x: unknown) => String((x as { text?: string })?.text ?? ''))

  // 1) 先按规则重新打分
  const scored = candidates.map((c) => {
    const title = titleOf(c.item)
    const text = textOf(c.item)
    const why: string[] = []
    let bonus = 0

    // 标题命中：实词有多少出现在标题里
    if (uniq.length && title) {
      const hit = uniq.filter((ch) => title.includes(ch)).length
      const rate = hit / uniq.length
      if (rate >= 0.5) {
        bonus += 0.35 * rate
        why.push(`标题命中 ${hit}/${uniq.length}`)
      }
    }

    // 覆盖率：实词在正文里出现过的比例
    if (uniq.length && text) {
      const hit = uniq.filter((ch) => text.includes(ch)).length
      const rate = hit / uniq.length
      if (rate > 0) {
        bonus += 0.25 * rate
        if (rate >= 0.6) why.push(`覆盖 ${Math.round(rate * 100)}%`)
      }
    }

    // 新鲜度：7 天内 +0.15，30 天内 +0.06
    const dateStr = String((c.item as { date?: string })?.date ?? '')
    if (dateStr) {
      const t = Date.parse(`${dateStr}T00:00:00`)
      if (!Number.isNaN(t)) {
        const days = (now - t) / DAY
        if (days <= 7) {
          bonus += 0.15
          why.push('一周内')
        } else if (days <= 30) {
          bonus += 0.06
        }
      }
    }

    return { item: c.item, score: c.score + bonus, why }
  })

  // 2) 按新分排序
  scored.sort((a, b) => b.score - a.score)

  // 3) 贪心去重（MMR 的思路）：和已选的太像就跳过
  //    阈值 0.75 是实测出来的——同一件事换个说法 similarity 大概 0.6-0.85，
  //    不同的事一般低于 0.4。
  const picked: RerankResult<T>[] = []
  for (const s of scored) {
    if (picked.length >= opts.limit) break
    const text = textOf(s.item) || titleOf(s.item)
    const dup = picked.some((p) => {
      const other = textOf(p.item) || titleOf(p.item)
      return similarity(text, other) >= 0.75
    })
    if (dup) continue
    picked.push(s)
  }

  return picked
}
