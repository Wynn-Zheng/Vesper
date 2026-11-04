/**
 * 单条消息最多看几张图的**硬上限**。
 *
 * 这是成本保护，不是"可调配置"：rules.视觉.最多张数 只能把它调小（比如 2），
 * 调大不会突破这条线。以前这个 4 分别写在 channel/onebot.ts 和 llm/vision.ts 两处，
 * 改一处漏一处就会出现"通道收 6 张、视觉只认 4 张"的不一致。
 */
export const MAX_IMAGES_PER_MESSAGE = 4
