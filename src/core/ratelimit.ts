/** 极简滑动窗口限流：按 key 记最近 N 毫秒内的时间戳 */
const buckets = new Map<string, number[]>()
/**
 * 每个 key 用的是多长的窗口。
 *
 * 必须有这个：sweeper 原来按固定的 5 分钟清理"最近没命中"的桶，
 * 而评估额度用的是 **1 天**窗口 —— 两次评估间隔通常就超过 5 分钟，
 * 桶被反复清空，`关系.评估.每天最多` 这个成本闸门等于不存在。
 */
const windows = new Map<string, number>()

/** 只看这个 key 还能不能放行，不计数 */
export function peek(key: string, max: number, windowMs = 60_000): boolean {
  if (!Number.isFinite(max) || max <= 0) return false
  const now = Date.now()
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  buckets.set(key, recent)
  return recent.length < max
}

/** 记一次命中（真的回了才调它） */
export function hit(key: string, windowMs = 60_000): void {
  const now = Date.now()
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  recent.push(now)
  buckets.set(key, recent)
  windows.set(key, windowMs)
}

export function allow(key: string, max: number, windowMs = 60_000): boolean {
  // 0 额度就是一次都不允许（配错成 NaN 之类也按拒绝处理，避免静默放开）。
  if (max <= 0 || !peek(key, max, windowMs)) return false
  hit(key, windowMs)
  return true
}
/** 定期清理空桶，避免长时间运行后 Map 膨胀 */
export function startRateLimitSweeper(intervalMs = 10 * 60_000): () => void {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [k, arr] of buckets) {
      // 按这个 key 自己的窗口清：窗口长的（比如评估的 1 天）不会被 5 分钟规则误删
      const win = windows.get(k) ?? 5 * 60_000
      if (!arr.length || now - arr[arr.length - 1]! > win) {
        buckets.delete(k)
        windows.delete(k)
      }
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function resetRateLimit(): void {
  buckets.clear()
}
