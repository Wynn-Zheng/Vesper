import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { info, warnAt, errorAt } from '../core/log.ts'
import type { GroupMember, Transport } from '../core/transport.ts'
import type { AccessPolicy } from '../core/access.ts'
import { checkAccess } from '../core/access.ts'
import type { Incoming, Target } from '../core/types.ts'

export interface OnebotOptions {
  host: string
  port: number
  path: string
  token: string
  /** 私聊白名单：只处理这个号发来的私聊；留空则不过滤 */
  ownerQQ?: string
  /** 是否处理群消息。默认 false —— 只在私聊工作 */
  allowGroup?: boolean
  /** 群号白名单；留空表示不限制（仍需 allowGroup 为 true） */
  groupAllow?: string[]
  /** 群成员白名单：只有这些人说话才触发；留空表示不限制 */
  memberAllow?: string[]
  /** 群聊里是否必须 @ 机器人。默认 true，避免它突然插话 */
  requireAt?: boolean
  /** 它的名字（self.md / rules.yaml），群里没 @ 但叫了名字时算"被叫到" */
  botNames?: string[]
  /** 每次判断都取一次权限策略，这样控制台改完立即生效 */
  getPolicy?: () => AccessPolicy
  /** 最近和它说过话的人（`群号:QQ号` → 时间戳），由 transport 自己维护 */
  recentTalkers?: Map<string, number>
  /** 连续对话窗口：多久之内不算"突然插话"，默认 2 分钟 */
  followUpWindowMs?: number
  /** 调用 action 的超时（毫秒） */
  timeoutMs?: number
}

interface Pending {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface OBEvent {
  post_type?: string
  message_type?: 'private' | 'group'
  self_id?: number | string
  user_id?: number | string
  group_id?: number | string
  message_id?: number | string
  sender?: { nickname?: string; card?: string }
  message?: Array<{ type: string; data?: Record<string, unknown> }> | string
  raw_message?: string
}

/** 把 OneBot 的 message 段数组压成纯文本，非文本段留占位。 */
export function extractText(message: OBEvent['message']): string {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  const out: string[] = []
  for (const seg of message) {
    if (seg.type === 'text') out.push(String(seg.data?.['text'] ?? ''))
    else if (seg.type === 'face') out.push('[表情]')
    else if (seg.type === 'image') out.push('[图片]')
    else if (seg.type === 'record') out.push('[语音]')
    else if (seg.type === 'at') {
      // 用昵称而不是 QQ 号：模型看到 @552388771 不知道那是谁
      const qq = String(seg.data?.['qq'] ?? '')
      const name = String(seg.data?.['name'] ?? '').trim()
      out.push(`@${name || qq}`)
    }
  }
  return out.join('').trim()
}


/**
 * 从 message 段里抽出图片地址。
 * OneBot 的 image 段一般有 url（临时链接，有时效）或 file（本地路径）。
 * 没有地址的（只给了 file 名的）就跳过，宁可当没图也别传个坏链接。
 */
export function extractImages(message: OBEvent['message']): string[] {
  if (!Array.isArray(message)) return []
  const out: string[] = []
  for (const seg of message) {
    if (seg.type !== 'image') continue
    const url = String(seg.data?.['url'] ?? '').trim()
    if (/^https?:\/\//i.test(url)) {
      out.push(url)
      continue
    }
    const file = String(seg.data?.['file'] ?? '').trim()
    if (/^https?:\/\//i.test(file)) out.push(file)
  }
  // 一次最多看几张：多了又慢又贵
  return out.slice(0, 4)
}

export class OnebotTransport implements Transport {
  readonly kind = 'onebot'
  private readonly opts: OnebotOptions
  private wss: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private handler: ((m: Incoming) => void) | null = null

  constructor(opts: OnebotOptions) {
    this.opts = opts
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  onMessage(fn: (m: Incoming) => void): void {
    this.handler = fn
  }

  async start(): Promise<void> {
    const { host, port, path } = this.opts
    this.wss = new WebSocketServer({ host, port, path })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
    this.wss.on('error', (err) => errorAt('WS 服务端错误', { err: String(err) }))
    info(`等待 NapCat 连接 ws://${host}:${port}${path}`)
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('通道已关闭'))
    }
    this.pending.clear()
    this.socket?.close()
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
    this.wss = null
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.opts.token) return true
    const url = new URL(req.url ?? '/', 'http://localhost')
    const fromQuery = url.searchParams.get('access_token') ?? url.searchParams.get('token')
    const auth = req.headers.authorization ?? ''
    const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : auth
    const given = fromQuery ?? fromHeader
    if (!given) return false
    const a = Buffer.from(given)
    const b = Buffer.from(this.opts.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.checkAuth(req)) {
      warnAt('拒绝未授权连接')
      ws.close(4001, 'unauthorized')
      return
    }
    info('NapCat 已连接')
    this.socket = ws
    void this.loadSelfInfo()

    ws.on('message', (data) => this.onFrame(data))
    ws.on('close', () => {
      info('NapCat 断开')
      if (this.socket === ws) this.socket = null
    })
    ws.on('error', (err) => errorAt('WS 连接错误', { err: String(err) }))
  }

  /** 拉自己的 QQ 昵称：群里直接叫这个名字也算叫它 */
  private async loadSelfInfo(): Promise<void> {
    try {
      const d = (await this.callAction('get_login_info', {})) as { nickname?: string; user_id?: number } | null
      const nick = (d?.nickname ?? '').trim()
      if (nick) {
        const names = this.opts.botNames ?? []
        if (!names.includes(nick)) {
          names.push(nick)
          this.opts.botNames = names
        }
        info(`它的 QQ 昵称是「${nick}」，群里直接叫这个名字也算叫它`)
      }
    } catch {
      /* 拉不到就用配置里的名字 */
    }
  }

  private onFrame(data: RawData): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      warnAt('收到非 JSON 帧，已忽略')
      return
    }

    // action 回包
    if (typeof obj['echo'] === 'string') {
      const p = this.pending.get(obj['echo'])
      if (!p) return
      this.pending.delete(obj['echo'])
      clearTimeout(p.timer)
      if (obj['status'] === 'failed' || obj['retcode'] !== 0) p.reject(new Error(`action 失败：${String(obj['message'] ?? obj['wording'] ?? '')}`))
      else p.resolve(obj['data'])
      return
    }

    // 事件
    if (obj['post_type'] === 'message') this.onEvent(obj as OBEvent)
  }

  private onEvent(ev: OBEvent): void {
    if (!shouldHandle(ev, this.opts)) {
      // 被 @ 了却没处理：这是异常，必须留痕，否则查不到原因
      if (ev.message_type === 'group' && isAddressed(ev)) {
        warnAt('消息 @ 了我但被过滤', {
          群: ev.group_id,
          人: ev.user_id,
          内容: extractText(ev.message).slice(0, 30),
        })
      }
      return
    }

    const text = extractText(ev.message)
    const isPrivate = ev.message_type === 'private'
    const gid = String(ev.group_id ?? '')
    const uid = String(ev.user_id ?? '')
    const addressed = isPrivate || isAddressed(ev)
    // 刚才正在跟它说话的人，不 @ 也算接着聊，不算"突然插话"
    const followUp = !isPrivate && !addressed && isRecentTalker(this.opts, gid, uid)
    if (!isPrivate) markTalker(this.opts, gid, uid)

    const from: Target = isPrivate
      ? { kind: 'private', id: uid, name: ev.sender?.nickname }
      : { kind: 'group', id: gid, name: ev.sender?.card ?? ev.sender?.nickname }

    this.handler?.({
      id: String(ev.message_id ?? ''),
      from,
      selfId: String(ev.self_id ?? ''),
      text,
      at: Date.now(),
      senderId: uid,
      senderName: ev.sender?.card ?? ev.sender?.nickname,
      passive: !isPrivate && !addressed && !followUp,
      ...(() => {
        const imgs = extractImages(ev.message)
        return imgs.length ? { images: imgs } : {}
      })(),
      raw: ev,
    })
  }

  private callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NapCat 未连接'))
    const echo = `e${Date.now()}${Math.random().toString(16).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`action ${action} 超时`))
      }, this.opts.timeoutMs ?? 10000)
      this.pending.set(echo, { resolve, reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  async send(to: Target, text: string): Promise<{ messageId?: string }> {
    const action = to.kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    // 模型吐出来的 CQ 码一律当普通文字：不然一句话能诱导它 @全体成员
    const plain = text.replace(/\[CQ:[^\]]*\]/gi, '')
    // 引用某一条再回：群聊里这是最像人的细节之一
    const replyId = to.replyTo && /^\d+$/.test(to.replyTo) ? to.replyTo : ''
    const message = replyId ? `[CQ:reply,id=${replyId}]${plain}` : plain
    const params = to.kind === 'private' ? { user_id: Number(to.id), message } : { group_id: Number(to.id), message }
    const data = (await this.callAction(action, params)) as { message_id?: number | string } | null
    const id = data?.message_id
    return id !== undefined && id !== null ? { messageId: String(id) } : {}
  }

  async recall(messageId: string): Promise<boolean> {
    try {
      await this.callAction('delete_msg', { message_id: Number(messageId) })
      return true
    } catch {
      return false
    }
  }

  /** 拉群成员列表：这是"知道群里有谁"的唯一来源 */
  async listGroupMembers(groupId: string): Promise<GroupMember[]> {
    const data = (await this.callAction('get_group_member_list', { group_id: Number(groupId) })) as
      | Array<{ user_id?: number | string; nickname?: string; card?: string }>
      | null
    if (!Array.isArray(data)) return []
    return data
      .map((m) => ({
        id: String(m.user_id ?? ''),
        name: (m.card || m.nickname || String(m.user_id ?? '')).toString(),
      }))
      .filter((m) => m.id && m.id !== 'undefined')
  }
}

/**
 * 决定一条事件要不要交给业务层。纯函数，便于测试。
 * 默认行为：只处理私聊，且只认 ownerQQ；群聊必须显式开启。
 */
export function shouldHandle(ev: OBEvent, opts: OnebotOptions): boolean {
  const text = extractText(ev.message)
  if (!text) return false
  // 只有占位符（[图片]/[表情]/[语音]）的消息不触发模型
  if (!text.replace(/\[[^\]]*\]/g, '').trim()) return false

  const isPrivate = ev.message_type === 'private'
  const userId = String(ev.user_id ?? '')

  if (!isPrivate) {
    if (!opts.allowGroup) return false
    const gid = String(ev.group_id ?? '')
    // 优先用动态策略（控制台可改）；没注入就退回静态配置
    if (opts.getPolicy) {
      const p = opts.getPolicy()
      if (!checkAccess(p, gid, userId).ok) return false
      if (p.requireAt && !isAddressed(ev)) {
        const names = (opts.botNames ?? []).filter((n) => n && n !== '未定')
        const called = names.some((n) => text.includes(n))
        // 没 @ 也没叫名字，但刚才正在跟它说话：这是连续对话，不算突然插话
        if (!called && !isRecentTalker(opts, gid, userId)) return false
      }
      return true
    }

    if (opts.groupAllow?.length && !opts.groupAllow.includes(gid)) return false
    if (opts.memberAllow?.length && !opts.memberAllow.includes(userId)) return false
    // 群里默认必须 @ 它；没 @ 的话，叫了名字或者刚聊过才放行
    if (opts.requireAt !== false && !isAddressed(ev)) {
      const names = (opts.botNames ?? []).filter((n) => n && n !== '未定')
      const called = names.some((n) => text.includes(n))
      if (!called && !isRecentTalker(opts, gid, userId)) return false
    }
  } else if (opts.ownerQQ && userId !== opts.ownerQQ) {
    return false
  }

  return true
}

/** 这条消息有没有 @ 它 */

/** 这个人是不是刚刚还在跟它说话 */
export function isRecentTalker(opts: OnebotOptions, groupId: string, userId: string): boolean {
  const at = opts.recentTalkers?.get(`${groupId}:${userId}`) ?? 0
  return Date.now() - at < (opts.followUpWindowMs ?? 120_000)
}

/** 记一笔"刚跟它说过话" */
function markTalker(opts: OnebotOptions, groupId: string, userId: string): void {
  if (!opts.recentTalkers) return
  const key = `${groupId}:${userId}`
  opts.recentTalkers.set(key, Date.now())
  // 顺手清掉太旧的，别让 Map 一直涨
  if (opts.recentTalkers.size > 200) {
    const cutoff = Date.now() - 30 * 60_000
    for (const [k, v] of opts.recentTalkers) if (v < cutoff) opts.recentTalkers.delete(k)
  }
}
export function isAddressed(ev: OBEvent): boolean {
  if (ev.message_type === 'private') return true
  const selfId = String(ev.self_id ?? '')
  const ats = Array.isArray(ev.message)
    ? ev.message.filter((s) => s.type === 'at').map((s) => String(s.data?.['qq'] ?? ''))
    : []
  return ats.includes(selfId)
}