import type { Incoming, Target } from './types.ts'

/**
 * 通道抽象。真假通道都只实现这 4 个方法。
 * 分句、延迟、限速、去重一律不在这里——它们在业务层，这样两个实现的行为不可能不一致。
 */
export interface SendResult {
  /** 平台侧消息 id，能拿到就能撤回 */
  messageId?: string
}

export interface GroupMember {
  id: string
  /** 群里显示的名字（群名片优先） */
  name: string
  /**
   * QQ 昵称。群名片每个群可能不一样，全局名要用这个，
   * 不然同一个人在不同群会互相覆盖。
   */
  nick?: string
}

/** 发说说的参数 */
export interface QzonePost {
  /** 正文 */
  content: string
  /** 图片地址（http(s) / file:// / base64://），可以不传 */
  images?: string[]
  /** 1所有人 4好友 16部分好友 64仅自己 128部分好友不可见 */
  ugcRight?: number
  /** ugcRight 为 16/128 时，权限作用的 QQ 号 */
  targetUins?: string[]
}

export interface Transport {
  readonly kind: string

  /**
   * 发一条 QQ 空间说说。
   * 不是所有通道都支持——不支持的返回 undefined，调用方要判空。
   */
  sendQzone?(post: QzonePost): Promise<{ tid: string }>

  /** 删一条自己发的说说（发错了能收回） */
  deleteQzone?(tid: string): Promise<boolean>
  /** 链路是否可用。可选，给控制台展示用 */
  readonly connected?: boolean
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(fn: (m: Incoming) => void): void
  /** 发送一段完整文本（调用方已经切好句），失败应抛错 */
  send(to: Target, text: string): Promise<SendResult | void>
  /** 撤回自己发过的消息，不支持就返回 false */
  recall?(messageId: string): Promise<boolean>
  /** 拉群成员列表。不支持的通道可以不实现 */
  listGroupMembers?(groupId: string): Promise<GroupMember[]>
}
