/**
 * 判断一条 OneBot 消息段是不是表情包。
 *
 * 只看消息段里平台已经给出的信息，不下载图片、不调模型：
 * 表情包判定发生在收消息的入口，网络慢一点也不能卡住聊天。
 */

export interface SegmentLike {
  type: string
  data?: Record<string, string>
}

export interface EmojiMeta {
  size?: number
  width?: number
  height?: number
}

/** 一张普通图片最多这么大才可能是表情包：512KB。再大基本是照片/截图。 */
export const EMOJI_MAX_SIZE = 512 * 1024
/** 表情包一般不会太大：长宽都不超过 512。 */
export const EMOJI_MAX_EDGE = 512

/** 平台直接标明是表情包（subType=1 或 summary 含"表情"）。 */
export function isEmojiSegment(seg: SegmentLike): boolean {
  if (seg.type !== 'image') return false
  const data = seg.data ?? {}
  if (data['subType'] === '1' || data['sub_type'] === '1') return true
  const summary = data['summary'] ?? ''
  if (summary.includes('表情') || summary.includes('动画表情')) return true
  return false
}

/**
 * 是不是值得收进表情包库的候选。
 *
 * 1) 不是 image 段 → 一定不是；
 * 2) 平台明确标了表情包 → 是；
 * 3) 否则按体积和尺寸做启发式：小图才有可能是表情包。
 *
 * 纯函数：meta 由调用方从消息段里取，不读盘、不联网。
 */
export function isEmojiCandidate(seg: SegmentLike, meta: EmojiMeta): boolean {
  if (seg.type !== 'image') return false
  if (isEmojiSegment(seg)) return true

  const { size, width, height } = meta
  // 0 / 负数 / NaN / Infinity 不是有效的图片元信息
  const sizeOk = typeof size === 'number' && Number.isFinite(size) && size > 0 && size <= EMOJI_MAX_SIZE
  const widthOk = typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= EMOJI_MAX_EDGE
  const heightOk = typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= EMOJI_MAX_EDGE
  if (!sizeOk) return false

  // 给了但给错（0 / 负数 / Infinity）→ 明确不是候选
  if (width !== undefined && width !== null && !widthOk) return false
  if (height !== undefined && height !== null && !heightOk) return false

  // NapCat 有些版本只给 size，完全不给宽高。以前这里一律 false，
  // 于是那些群的表情包一张都进不了库（用户只看到"库存是空的"）。
  // 缺尺寸时退回按体积判断：上限的一半（256KB）作为更保守的门槛。
  const dimsKnown =
    typeof width === 'number' && Number.isFinite(width) && width > 0 &&
    typeof height === 'number' && Number.isFinite(height) && height > 0
  if (!dimsKnown) return (size as number) < EMOJI_MAX_SIZE / 2

  return true
}
