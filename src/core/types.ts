/** 内部消息模型。所有通道都必须转换成这里的类型，业务层只认它。 */

export type TargetKind = 'private' | 'group'

export interface Target {
  kind: TargetKind
  /** 私聊是 QQ 号，群聊是群号 */
  id: string
  /** 显示用，可以是昵称或群名 */
  name?: string
  /** 要引用的消息 id：群里"回某一句"比"接着说"更像人 */
  replyTo?: string
}

export interface Incoming {
  /** 平台侧消息 id，用于去重 */
  id: string
  /** 会话：私聊的那个人，或者那个群 */
  from: Target
  /** 机器人自己的账号 */
  selfId: string
  /** 已经剥掉图片/表情等段的纯文本 */
  text: string
  /** 毫秒时间戳 */
  at: number
  /**
   * 这个会话里上一次说话的时间（收消息时先取后写的快照）。0/undefined = 第一次。
   *
   * 用它算"隔了多久没说话"，别用 session.turns 的最后一条：
   * 那个会被 pruneSessions(2h) 清掉，而"隔了 2 小时以上"恰好是要显示的场景。
   */
  prevAt?: number
  /** 谁说的。群聊时是发言人，私聊时同 from.id */
  senderId?: string
  senderName?: string
  /**
   * QQ 昵称（全局唯一，和群名片无关）。
   *
   * 为什么要和 senderName 分开：
   *   senderName = card ?? nickname，群里是群名片、私聊是昵称。
   *   拿 senderName 当全局名的话，同一个人在群里叫「测试昵称A」、
   *   私聊叫「主人」，档案会被两边轮流覆盖。
   *   senderNick 永远是 QQ 昵称，用来做全局名。
   */
  senderNick?: string
  /** 这条消息里的图片地址（最多几张），有视觉模型时会被识别 */
  images?: string[]
  /** 群聊里没 @ 它、只是叫了名字 —— 要不要接话由业务层决定 */
  passive?: boolean
  /**
   * 只记录、不回复。
   *
   * 用在「群里必须 @ 才回」的时候：消息仍然要进历史（能学、能记、能算关系），
   * 但这一条不参与回复。
   *
   * 为什么需要这个字段：以前 `shouldHandle` 直接把这类消息丢掉，
   * 结果是群里 90% 的话它**根本没看见** —— distill 没有材料、
   * 「发言频率」永远不生效、`lastTalk` 不更新。
   */
  observeOnly?: boolean
  /**
   * 文本里已经按行写好了「谁：说了什么」，调用方不要再加一次名字前缀。
   *
   * 用在防抖合批时：一批里有多个人说话，原来的做法是 join('\n') 之后
   * 用**最后一个人**的名字冠一次前缀，结果 A 的话被记成 B 说的。
   * 现在合批时逐行写名字，这个标记告诉下游"名字已经在了"。
   */
  speakerInText?: boolean
  /** 原始事件，只用于调试与落盘 */
  raw?: unknown
}
