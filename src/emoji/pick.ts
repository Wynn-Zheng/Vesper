import type { IndexItem } from './store.ts'
import { moodGroup } from './tag.ts'

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
 * 优先级：
 *   ① mood 完全相同
 *   ② tags 里含这个情绪词
 *   ③ **同一个情绪组**（「有点烦」和「生气」算一组）
 *   ④ 随便一张（按最近使用加权）
 *
 * 第 ③ 级是补视觉打标之后加的：系统情绪是模型自由生成的（"有点烦"、"挺开心的"），
 * 而表情包的 mood 是固定词表（"生气"、"开心"）。没有归一化的话两边永远对不上，
 * 打完标也还是走第 ④ 级。
 *
 * 库空返回 null，调用方自己决定要不要发。
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

  // 同一个情绪组：这一级让"有点烦"也能翻出生气的表情包
  const group = moodGroup(mood)
  if (group) {
    const sameGroup = items.filter((item) => moodGroup(item.mood) === group)
    if (sameGroup.length > 0) return pickWeighted(sameGroup, rng)
  }

  return pickWeighted(items, rng)
}
