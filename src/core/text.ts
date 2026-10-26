/** 中文没有空格，用字符二元组 Jaccard 近似相关度。 */
export function similarity(a: string, b: string): number {
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
  return inter / (A.size + B.size - inter)
}
