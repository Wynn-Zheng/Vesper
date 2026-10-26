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
