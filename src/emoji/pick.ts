import type { IndexItem } from './store.ts'

/** 从候选里随机取一个；rng 返回异常值时兜底到第一个。 */
function pickOne(items: IndexItem[], rng: () => number): IndexItem {
  const raw = rng()
  const v = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0
  return items[Math.floor(v * items.length)]!
}

/**
 * 按心情挑一张表情包。纯函数，不读盘。
 *
 * 优先级：mood 完全相同 → tags 里含 mood → 随便一张。
 * 库空返回 null，调用方自己决定要不要发。
 */
export function pickEmoji(
  items: IndexItem[],
  mood: string,
  rng: () => number = Math.random,
): IndexItem | null {
  if (items.length === 0) return null

  const exact = items.filter((item) => item.mood === mood)
  if (exact.length > 0) return pickOne(exact, rng)

  const tagged = items.filter((item) => item.tags.includes(mood))
  if (tagged.length > 0) return pickOne(tagged, rng)

  return pickOne(items, rng)
}
