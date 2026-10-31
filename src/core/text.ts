/** 中文没有空格，用字符二元组 Jaccard 近似相关度。 */

/** 把文本切成 bigram 集合（去掉空白） */
function grams(s: string): Set<string> {
  const clean = s.replace(/\s+/g, '')
  const set = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  // 调用方偶尔会拿到空值（比如还没生成的自述/标题）。这里直接当成不相似，
  // 不要让一次缺字段把整条链路崩掉。
  if (typeof a !== 'string' || typeof b !== 'string') return 0

  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const score = inter / (A.size + B.size - inter)
  // Jaccard 天然在 [0,1]；这里再夹一次，防止以后改算法时把越界值漏出去。
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0
}

/**
 * 两条文本共有多少个 bigram（不算占比，只算个数）。
 *
 * 为什么单独要这个：Jaccard 相似度 = 交集/并集，长句稍微一改，并集就变大、
 * 相似度掉下去。但"共同的内容"其实没变。
 * 实测：同一件事换个说法，similarity 只有 0.16，但共同 bigram 有 12 个。
 */
export function sharedBigrams(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return 0
  const A = grams(a)
  const B = grams(b)
  let n = 0
  for (const g of A) if (B.has(g)) n++
  return n
}

/** bigram 列表（BM25 要重复计数，不能用 Set） */
function gramList(s: string): string[] {
  const clean = s.replace(/\s+/g, '')
  const out: string[] = []
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2))
  return out
}

/**
 * 索引用的切词：bigram + 单字。
 *
 * 为什么要单字：bigram 对**词序**敏感。「折纸」的 bigram 是 `折纸`，
 * 而记忆里写的是「厚纸折之前」——那里的 bigram 是 `纸折`/`折之`，
 * 一个都对不上，纯 bigram 会漏掉。加单字就稳了（高频字靠 IDF 自然压下去）。
 */
function indexTerms(s: string): string[] {
  const clean = s.replace(/\s+/g, '')
  const out: string[] = [...gramList(s)]
  for (const ch of clean) out.push(ch)
  return out
}

/**
 * BM25 关键词打分。
 *
 * 为什么要它：`similarity` 是 Jaccard——两个短句有一半字不一样就掉到 0 附近，
 * 但"折纸""豆豆""四级"这种**具体的词**恰恰是关键词召回最该抓的。
 * 实测过：搜「折纸」时纯语义召回 0 条，因为那条记忆写的是「厚纸折之前先用指甲划一道」——
 * 语义上有关系，字面上只有「纸」一个字重合。
 *
 * 实现是教科书版 BM25（k1=1.5, b=0.75），中文按 bigram 当词。
 * 返回的是**每条文档的分数**（和 docs 对齐），没命中的是 0。
 */
export function bm25(
  query: string,
  docs: string[],
  opts: { k1?: number; b?: number } = {},
): number[] {
  const k1 = opts.k1 ?? 1.5
  const b = opts.b ?? 0.75
  if (!docs.length) return []

  const qTerms = [...new Set(indexTerms(query))]
  if (!qTerms.length) return docs.map(() => 0)

  const docTerms = docs.map((d) => indexTerms(d))
  const avgLen = docTerms.reduce((s, t) => s + t.length, 0) / docTerms.length || 1
  const N = docs.length

  // df：有多少文档含这个词
  const df = new Map<string, number>()
  for (const terms of docTerms) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1)
  }

  // idf：log((N - df + 0.5) / (df + 0.5) + 1)，+1 防止负数
  const idf = new Map<string, number>()
  for (const t of qTerms) {
    const d = df.get(t) ?? 0
    idf.set(t, Math.log((N - d + 0.5) / (d + 0.5) + 1))
  }

  return docTerms.map((terms) => {
    if (!terms.length) return 0
    let score = 0
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of qTerms) {
      const f = tf.get(t)
      if (!f) continue
      const denom = f + k1 * (1 - b + (b * terms.length) / avgLen)
      score += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / denom)
    }
    return score
  })
}

/**
 * 解析查询里的相对时间词，返回一个时间窗口。
 *
 * "上次说的那个""昨天聊的"——这种查询光靠语义召回没用，
 * 因为相似度算的是"内容像不像"，而用户问的是"什么时间的事"。
 *
 * 返回 null = 没有时间词，不过滤。
 */
export function parseTimeHint(
  query: string,
  now = Date.now(),
): { from: number; to: number; label: string; order?: 'asc' | 'desc' } | null {
  const DAY = 86_400_000
  const q = query

  // 「今天」「刚才」「刚刚」
  if (/刚才|刚刚/.test(q)) return { from: now - 3600_000, to: now, label: '刚才' }
  if (/今天|今日/.test(q)) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return { from: d.getTime(), to: now, label: '今天' }
  }
  if (/昨天|昨日/.test(q)) return { from: now - 2 * DAY, to: now - DAY, label: '昨天' }
  if (/前天/.test(q)) return { from: now - 3 * DAY, to: now - 2 * DAY, label: '前天' }

  // 「上周」「这周」
  if (/上周|上星期/.test(q)) return { from: now - 14 * DAY, to: now - 7 * DAY, label: '上周' }
  if (/这周|本周|这星期/.test(q)) return { from: now - 7 * DAY, to: now, label: '这周' }

  // 「上个月」「这个月」
  if (/上个月|上月/.test(q)) return { from: now - 60 * DAY, to: now - 30 * DAY, label: '上个月' }
  if (/这个月|本月/.test(q)) return { from: now - 30 * DAY, to: now, label: '这个月' }

  // 「最近」
  if (/最近|这几天/.test(q)) return { from: now - 7 * DAY, to: now, label: '最近' }

  // 只有方向词的（"后来呢""一开始那次"）—— 窗口给宽，主要靠 order 排
  // 先判方向，因为它和"昨天"这类窗口词可以同时出现（"昨天之后"）
  const wantsLate = /后来|之后|然后|接着|再后来|最后/.test(q)
  const wantsEarly = /最早|一开始|第一次|起初|最开始/.test(q)
  if (wantsLate) return { from: now - 90 * DAY, to: now, label: '之后', order: 'desc' }
  if (wantsEarly) return { from: now - 365 * DAY, to: now, label: '最早', order: 'asc' }

  // 「上次」「之前」「以前」——范围给宽，只是加权重不是硬过滤
  if (/上次|上一次|之前|以前/.test(q)) return { from: now - 90 * DAY, to: now, label: '之前' }

  return null
}
