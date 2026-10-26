/** 中文没有空格，用字符二元组 Jaccard 近似相关度。 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  // 调用方偶尔会拿到空值（比如还没生成的自述/标题）。这里直接当成不相似，
  // 不要让一次缺字段把整条链路崩掉。
  if (typeof a !== 'string' || typeof b !== 'string') return 0

  const grams = (s: string): Set<string> => {
    const clean = s.replace(/\s+/g, '')
    const set = new Set<string>()
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
    return set
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const score = inter / (A.size + B.size - inter)
  // Jaccard 天然在 [0,1]；这里再夹一次，防止以后改算法时把越界值漏出去。
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0
}
