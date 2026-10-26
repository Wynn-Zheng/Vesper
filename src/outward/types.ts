/** 自己出去看东西的数据结构 */

export interface VideoBrief {
  bvid: string
  title: string
  up: string
  /** 播放量 */
  play: number
  /** 秒 */
  duration: number
}

export interface VideoDetail extends VideoBrief {
  desc: string
  /** 有字幕就带上，没有就是空 */
  subtitle: string
  /** 分区名 */
  zone: string
}

/** 看过的一个视频，记下来避免重复 */
export interface Watched {
  bvid: string
  title: string
  at: number
  /** 它看完想到的那句话；没感觉就是空 */
  thought: string
}

/** 一次"出去看东西"的结果 */
export interface WatchResult {
  ok: boolean
  bvid?: string
  title?: string
  /** 它想到的话 */
  thought?: string
  /** 为什么没看成 */
  reason?: string
}
