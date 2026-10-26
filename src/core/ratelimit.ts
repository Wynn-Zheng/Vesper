/** 极简滑动窗口限流：按 key 记最近 N 毫秒内的时间戳 */
const buckets = new Map<string, number[]>()

export function allow(key: string, max: number, windowMs = 60_000): boolean {
  // 0 额度就是一次都不允许（配错成 NaN 之类也按拒绝处理，避免静默放开）。
  if (!Number.isFinite(max) || max <= 0) return false
  const now = Date.now()
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    buckets.set(key, recent)
    return false
  }
  recent.push(now)
  buckets.set(key, recent)
  return true
}

/** 定期清理空桶，避免长时间运行后 Map 膨胀 */
export function startRateLimitSweeper(intervalMs = 10 * 60_000): () => void {
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [k, arr] of buckets) {
      if (!arr.length || now - arr[arr.length - 1]! > 5 * 60_000) buckets.delete(k)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function resetRateLimit(): void {
  buckets.clear()
}
