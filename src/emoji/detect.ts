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
 * 1) 平台明确标了表情包 → 是；
 * 2) 否则按体积和尺寸做启发式：小图才有可能是表情包。
 *
 * 纯函数：meta 由调用方从消息段里取，不读盘、不联网。
 */
export function isEmojiCandidate(seg: SegmentLike, meta: EmojiMeta): boolean {
  if (isEmojiSegment(seg)) return true

  const { size, width, height } = meta
  const sizeOk = typeof size === 'number' && Number.isFinite(size) && size <= EMOJI_MAX_SIZE
  const widthOk = typeof width === 'number' && Number.isFinite(width) && width <= EMOJI_MAX_EDGE
  const heightOk = typeof height === 'number' && Number.isFinite(height) && height <= EMOJI_MAX_EDGE
  return sizeOk && widthOk && heightOk
}
