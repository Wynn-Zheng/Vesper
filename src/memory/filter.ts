/**
 * distill 的筛选：只把"值得提炼"的那部分喂给模型。
 *
 * 依据：Kumaran, Hassabis & McClelland (2016, Trends in Cognitive Sciences)
 * —— 海马不是把一天的流水账原样重播给皮层，**重播是有选择的**：
 *   优先重播"意外的""有奖励的""还没学会的"。
 *
 * 我们只取两个有依据的维度，不加"消息长度"那种猜测：
 *   1. 意外度（和已有记忆不相似）= "意外的"
 *   2. 约定/边界词            = "有奖励的"（答应了的事、划了线的事）
 *
 * 权重是我拍的，但要小：筛掉的是明显空的（"嗯""好""哈哈"），
 * 不是筛掉"看起来不重要的"——后者只有模型能判断。
 */

import { sharedBigrams } from '../core/text.ts'

export interface SinceRawTurn {
  ts: number
  text: string
}

/**
 * 低于这个分数就是明确废话（「嗯」「好的」「哈哈」），直接砍掉。
 *
 * -1 的依据：短于 4 个字扣 3 分，和已有记忆毫不相似最多加 2 分，
 * 所以纯语气词落在 -1 左右，而一句正常的话至少在 0 以上。
 */
const NOISE_FLOOR = -1

/** 纯语气词 / 纯笑：一个字的信息都没有，不管多长 */
const FILLER_RE = /^[哈嗯哦啊呀吧呢好对行没的了吗嘛噢诶哎，。！？~～\s]+$/

/** 约定 / 承诺 / 边界：这些话说出来就是要记的 */
const COMMIT_RE =
  /答应|说好|约定|一定|别忘|记得|不许|不准|不要|讨厌|不喜欢|受不了|以后别|下次别|我保证/

/**
 * 情绪 / 状态词：短句里有这些就**不该**当废话丢。
 *
 * "我好累""分手了""她走了""我病了" 都只有 3 个字，按 `length < 4` 扣 3 分 +
 * 不相干加 2 分 = -1，正好压到 NOISE_FLOOR 上被砍 —— 而这恰恰是最该记住的那些话。
 */
const EMOTION_RE =
  /累|困|难受|开心|难过|哭|难受|疼|病|分手|走了|离婚|辞职|失业|吵架|生气|烦|焦虑|害怕|紧张|失眠|睡不着|压力|崩溃|委屈|孤独|想哭/

/**
 * 一句话值不值得提炼。
 *
 * 分数只用来**排序**，不做硬阈值——最终留多少由调用方决定。
 */
export function worthDistilling(turn: SinceRawTurn, existingTexts: string[]): number {
  const text = turn.text.trim()
  if (!text) return 0

  let score = 0

  // 1. 意外度：和已有记忆越不像，越值得记（Kumaran 说的"意外的"）
  //    用共同 bigram 数而不是 ratio：ratio 对短句天然偏高，会把"嗯嗯"当新东西
  let maxShared = 0
  for (const t of existingTexts) {
    const n = sharedBigrams(text, t)
    if (n > maxShared) maxShared = n
  }
  // 共同 bigram 到 4 个基本就是同一件事了
  score += Math.max(0, 2 - maxShared * 0.5)

  // 2. 约定/边界：这类话必须记
  if (COMMIT_RE.test(text)) score += 3

  // 3. 纯语气词/纯笑：不管多长都没信息量
  //    "哈哈哈哈哈哈" 长度够，但一个字的信息都没有
  if (FILLER_RE.test(text)) score -= 5

  // 4. 太短的基本是"嗯""好""哈哈" —— 但情绪句除外
  //    "我好累""分手了""她走了" 只有 3 个字，却是最该记住的那类
  if (EMOTION_RE.test(text)) score += 2
  else if (text.length < 4) score -= 3
  else if (text.length < 8) score -= 1

  return score
}

/**
 * 从一批 turn 里挑出要提炼的。
 *
 * 两步：
 *   1. 先砍掉**明确的废话**（分数 < NOISE_FLOOR，就是"嗯""好""哈哈"这种）
 *   2. 剩下的再按比例取，保时间顺序
 *
 * @param keepRatio 保留比例。默认 0.75——只砍掉最差的四分之一，
 *                  因为权重没经过验证，宁可少砍。
 */
export function pickForDistill<T extends SinceRawTurn>(
  turns: T[],
  existingTexts: string[],
  keepRatio = 0.75,
  minKeep = 4,
): T[] {
  if (turns.length <= minKeep) return turns

  // 第一步：硬阈值。分数 <= -1 说明"短且没信息"，那是真废话。
  const meaningful = turns.filter((t) => worthDistilling(t, existingTexts) > NOISE_FLOOR)
  // 全被砍掉时不能返回空——那样 distill 会拿不到任何原料
  const pool = meaningful.length >= Math.min(minKeep, turns.length) ? meaningful : turns

  if (pool.length <= minKeep) return pool

  // 第二步：按分数取前 N 条
  const scored = pool.map((t) => ({ t, s: worthDistilling(t, existingTexts) }))
  const keep = Math.max(Math.min(minKeep, pool.length), Math.ceil(pool.length * keepRatio))

  // 按分数降序挑，但返回时保持原来的时间顺序（模型读起来才连贯）
  const pickedKeys = new Set(
    scored
      .slice()
      .sort((a, b) => b.s - a.s)
      .slice(0, keep)
      .map((x) => x.t),
  )

  return turns.filter((t) => pickedKeys.has(t))
}
