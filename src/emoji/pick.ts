import type { IndexItem } from './store.ts'

/**
 * 从候选里按权重取一个。
 *
 * 为什么不是纯随机：纯随机会连着发同一张——真人不会这么干。
 * 权重按「多久没用了」算，久没用的更可能被挑中。
 *
 * 用累积权重而不是轮盘赌的浮点：候选少的时候浮点误差会把最后一张永远排除。
 */
function pickWeighted(items: IndexItem[], rng: () => number, now = Date.now()): IndexItem {
  if (items.length === 1) return items[0]!

  const DAY = 86_400_000
  const weights = items.map((it) => {
    // 没用过 = 1 天前的权重；用得越近权重越低，但不为 0
    const usedAt = it.lastUsedAt > 0 ? it.lastUsedAt : now - DAY
    const days = Math.max(0, (now - usedAt) / DAY)
    return 1 + Math.min(days, 30) / 10
  })

  const total = weights.reduce((a, b) => a + b, 0)
  const raw = rng()
  const v = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0
  let acc = v * total
  for (let i = 0; i < items.length; i++) {
    acc -= weights[i]!
    if (acc <= 0) return items[i]!
  }
  return items[items.length - 1]!
}

/**
 * 按心情挑一张表情包。纯函数，不读盘。
 *
 * 优先级：mood 完全相同 → tags 里含 mood → 随便一张（按最近使用加权）。
 * 库空返回 null，调用方自己决定要不要发。
 *
 * ⚠ 现实提醒：收集表情包时 NapCat 不带 mood/tags，所以前两级通常匹配不到，
 * 实际走的是第三级。这不影响"能用"，只影响"按心情挑"这件事做不到——
 * 要真按心情挑，得在入库时补语义标签（用视觉模型或消息上下文）。
 */
export function pickEmoji(
  items: IndexItem[],
  mood: string,
  rng: () => number = Math.random,
): IndexItem | null {
  if (items.length === 0) return null

  const exact = items.filter((item) => item.mood === mood)
  if (exact.length > 0) return pickWeighted(exact, rng)

  const tagged = items.filter((item) => item.tags.includes(mood))
  if (tagged.length > 0) return pickWeighted(tagged, rng)

  return pickWeighted(items, rng)
}
