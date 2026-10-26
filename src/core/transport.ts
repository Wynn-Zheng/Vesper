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

export interface Transport {
  readonly kind: string
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
