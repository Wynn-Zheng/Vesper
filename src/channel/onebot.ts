import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { info, warnAt, errorAt } from '../core/log.ts'
import type { GroupMember, Transport } from '../core/transport.ts'
import type { AccessPolicy } from '../core/access.ts'
import { checkAccess } from '../core/access.ts'
import type { Rules } from '../core/config.ts'
import type { Incoming, Target } from '../core/types.ts'
import { MAX_EMOJI_BYTES, type EmojiStore } from '../emoji/store.ts'
import { isEmojiCandidate } from '../emoji/detect.ts'
import { setImageTransport, type OutgoingSegment } from './send.ts'

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
  /** 每次判断都取一次规则：用来读 表情包.开启；不传则不收表情包 */
  getRules?: () => Rules
  /** 表情包库；不传则不收表情包 */
  emojiStore?: EmojiStore
  /** 取图依赖：默认先下 URL，再走 get_image；测试可注入假实现 */
  getEmojiImage?: EmojiImageFetcher
}

/** 取到的一张图片：内容 + 扩展名（扩展名会写进表情包库的文件名） */
export interface EmojiImage {
  buffer: Uint8Array
  ext: string
}

/** 从 image 段取图。失败返回 null，不抛错，避免影响消息主流程。 */
export type EmojiImageFetcher = (seg: { type: string; data?: Record<string, string> }) => Promise<EmojiImage | null>

export interface EmojiCaptureOptions {
  enabled: boolean
  store: Pick<EmojiStore, 'add'>
  getImage: EmojiImageFetcher
  /** 一条消息最多收几张，防止有人连发几十张把库刷爆 */
  limit?: number
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

/** CQ 码里的转义字符，按 OneBot 规范还原。&amp; 最后处理，避免二次解码。 */
function unescapeCq(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

/** 解析 CQ 码参数：`[CQ:face,id=1]` → { id: '1' } */
function parseCqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq < 1) continue
    out[part.slice(0, eq).trim()] = unescapeCq(part.slice(eq + 1))
  }
  return out
}

/** 字符串格式的消息（CQ 码）拆成消息段，后续逻辑和数组格式共用一套。 */
function parseCqString(raw: string): Array<{ type: string; data: Record<string, string> }> {
  const out: Array<{ type: string; data: Record<string, string> }> = []
  const cq = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g
  let last = 0
  for (let m = cq.exec(raw); m; m = cq.exec(raw)) {
    if (m.index > last) {
      out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last, m.index)) } })
    }
    out.push({ type: (m[1] ?? '').toLowerCase(), data: parseCqParams(m[2] ?? '') })
    last = m.index + m[0].length
  }
  if (last < raw.length) {
    out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last)) } })
  }
  return out
}

/** 数组格式原样保留，字符串格式先转成段；坏数据直接跳过。 */
function messageSegments(message: OBEvent['message']): Array<{ type: string; data: Record<string, string> }> {
  if (typeof message === 'string') return parseCqString(message)
  if (!Array.isArray(message)) return []
  const out: Array<{ type: string; data: Record<string, string> }> = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object' || typeof seg.type !== 'string') continue
    const data: Record<string, string> = {}
    for (const [key, value] of Object.entries(seg.data ?? {})) {
      if (value !== undefined && value !== null) data[key] = String(value)
    }
    out.push({ type: seg.type, data })
  }
  return out
}

function atText(data: Record<string, string>): string {
  const qq = (data['qq'] ?? '').trim()
  if (qq === 'all') return '@全体成员'
  // 用昵称而不是 QQ 号：模型看到一串纯数字不知道那是谁
  const name = (data['name'] ?? '').trim()
  if (name) return `@${name}`
  return qq ? `@${qq}` : ''
}

/** 把 OneBot 的 message 段数组压成纯文本，非文本段留占位。 */
export function extractText(message: OBEvent['message']): string {
  const out: string[] = []
  for (const seg of messageSegments(message)) {
    if (seg.type === 'text') out.push(seg.data['text'] ?? '')
    else if (seg.type === 'face') out.push('[表情]')
    else if (seg.type === 'image') out.push('[图片]')
    else if (seg.type === 'record') out.push('[语音]')
    else if (seg.type === 'at') out.push(atText(seg.data))
  }
  return out.join('').trim()
}


/**
 * 从 message 段里抽出图片地址。
 * OneBot 的 image 段一般有 url（临时链接，有时效）或 file（本地路径）。
 * 没有地址的（只给了 file 名的）就跳过，宁可当没图也别传个坏链接。
 */
export function extractImages(message: OBEvent['message']): string[] {
  const out: string[] = []
  for (const seg of messageSegments(message)) {
    if (seg.type !== 'image') continue
    const url = (seg.data['url'] ?? '').trim()
    if (/^https?:\/\//i.test(url)) {
      out.push(url)
      continue
    }
    const file = (seg.data['file'] ?? '').trim()
    if (/^https?:\/\//i.test(file)) out.push(file)
  }
  // 一次最多看几张：多了又慢又贵
  return out.slice(0, 4)
}

const IMAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

/** 只认这几种常见图片扩展名，避免把奇怪后缀写进表情包库。 */
const KNOWN_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'])

function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return IMAGE_EXT_BY_MIME[base] ?? null
}

function extFromName(name: string): string | null {
  const clean = name.split(/[?#]/)[0] ?? ''
  const m = /\.([a-z0-9]{2,5})$/i.exec(clean)
  const ext = m?.[1]?.toLowerCase()
  if (!ext || !KNOWN_IMAGE_EXT.has(ext)) return null
  return ext === 'jpeg' ? 'jpg' : ext
}

/** 文件头识别：不少图床的 content-type 是 octet-stream。 */
function sniffImageExt(buf: Uint8Array): string {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp'
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return 'jpg'
}

function makeImage(buf: Uint8Array, ext?: string | null): EmojiImage | null {
  if (!buf.byteLength || buf.byteLength > MAX_EMOJI_BYTES) return null
  return { buffer: buf, ext: ext ?? sniffImageExt(buf) }
}

/** 直接把远程图片下下来。QQ 的链接有防盗链，所以带浏览器 UA。 */
async function downloadImage(url: string): Promise<EmojiImage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': IMAGE_UA,
        Referer: 'https://qzone.qq.com/',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return makeImage(buf, extFromMime(type) ?? extFromName(url))
  } catch {
    return null
  }
}

/** 解码 base64://、data:image/... 或裸 base64。 */
function imageFromBase64(raw: string): EmojiImage | null {
  let text = raw.trim()
  let mime = ''
  const dataUrl = /^data:([^;,]*)(?:;base64)?,([\s\S]*)$/.exec(text)
  if (dataUrl) {
    mime = dataUrl[1] ?? ''
    text = dataUrl[2] ?? ''
  } else if (text.startsWith('base64://')) {
    text = text.slice('base64://'.length)
  }
  if (!text) return null
  try {
    const buf = Buffer.from(text, 'base64')
    if (!buf.byteLength) return null
    return makeImage(buf, extFromMime(mime))
  } catch {
    return null
  }
}

/** get_image 有时返回本机临时文件路径 / file://。 */
async function readLocalImage(ref: string): Promise<EmojiImage | null> {
  let path = ref
  if (ref.startsWith('file://')) {
    try {
      path = fileURLToPath(ref)
    } catch {
      return null
    }
  }
  // 有 scheme 的（http/base64/data）不在这里处理
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null
  try {
    const buf = await readFile(path)
    return makeImage(buf, extFromName(path))
  } catch {
    return null
  }
}

async function imageFromRef(ref: string): Promise<EmojiImage | null> {
  const value = ref.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return downloadImage(value)
  if (value.startsWith('base64://') || value.startsWith('data:')) return imageFromBase64(value)
  return readLocalImage(value)
}

/** 解析 get_image 的返回：可能给 base64、file、url 中的任意一种。 */
async function imageFromActionResult(result: unknown): Promise<EmojiImage | null> {
  if (typeof result === 'string') return imageFromRef(result)
  if (typeof result !== 'object' || result === null) return null
  const o = result as Record<string, unknown>

  for (const key of ['base64', 'data']) {
    const value = o[key]
    if (typeof value === 'string') {
      const got = imageFromBase64(value)
      if (got) return got
    }
  }
  for (const key of ['file', 'url']) {
    const value = o[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const got = await imageFromRef(value)
    if (got) return got
  }
  return null
}

/** 把消息段里平台给的尺寸/体积转成数字；缺了就算 undefined。 */
function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function toStringRecord(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!data) return out
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) out[key] = String(value)
  }
  return out
}

/**
 * 从一条消息里挑出表情包候选，取图后入库。
 *
 * 失败只 warn：收表情包是锦上添花，绝不能拖慢/打断正常聊天。
 * 日志里只写 id、体积、原因，不写图片内容。
 */
export async function captureEmojiSegments(
  message: OBEvent['message'],
  opts: EmojiCaptureOptions,
): Promise<number> {
  if (!opts.enabled || !Array.isArray(message)) return 0

  let added = 0
  let seen = 0
  const limit = opts.limit ?? 4

  for (const rawSeg of message) {
    if (rawSeg.type !== 'image') continue
    if (seen >= limit) break
    seen++

    const data = toStringRecord(rawSeg.data)
    const meta = {
      size: toNumber(data['size']) ?? toNumber(data['file_size']),
      width: toNumber(data['width']),
      height: toNumber(data['height']),
    }
    const seg = { type: rawSeg.type, data }
    if (!isEmojiCandidate(seg, meta)) continue

    try {
      const image = await opts.getImage(seg)
      if (!image || !image.buffer.byteLength) continue
      const result = await opts.store.add({
        buffer: image.buffer,
        ext: image.ext,
        source: 'onebot',
      })
      if (result.added) {
        added++
        info('收到表情包，已入库', { id: result.id, size: image.buffer.byteLength })
      } else if (result.reason) {
        warnAt('表情包没有入库', { id: result.id, reason: result.reason })
      }
    } catch (err) {
      warnAt('表情包入库失败，不影响消息', {
        err: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      })
    }
  }

  return added
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
    // 让 sendImage(target, filePath) 这种两参数写法也能找到当前通道
    setImageTransport(this)
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  onMessage(fn: (m: Incoming) => void): void {
    this.handler = fn
  }

  /** 服务端监听失败的原因（端口被占用等），控制台能读到 */
  startError: string | null = null

  async start(): Promise<void> {
    const { host, port, path } = this.opts
    this.wss = new WebSocketServer({ host, port, path })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
    // 监听失败（端口被占用）不能只记一行日志：start() 已经 resolve，
    // 进程会一直显示"在线"但永远收不到消息，之后每次发送都报"NapCat 未连接"。
    this.wss.on('error', (err) => {
      this.startError = String(err)
      errorAt('WS 服务端启动失败（端口被占用？）', { err: String(err) })
    })
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
    // 旧连接还没断开时先把旧的关掉：不然两个 ws 并存，事件重复、socket 泄漏
    const prev = this.socket
    if (prev && prev !== ws) {
      try { prev.close(4000, 'replaced') } catch { /* ignore */ }
    }
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
    // 收表情包和"要不要回复"解耦：纯图片消息不触发模型，但也值得收。
    // 故意不 await：下载/入库再慢也不能卡住消息分发。
    const rules = this.opts.getRules?.()
    if (this.opts.emojiStore && rules) {
      void captureEmojiSegments(ev.message, {
        enabled: rules.表情包.开启,
        store: this.opts.emojiStore,
        getImage: this.opts.getEmojiImage ?? ((seg) => this.fetchEmojiImage(seg)),
      })
    }

    if (!shouldHandle(ev, this.opts)) {
      // 被 @ 了却没处理：这是异常，必须留痕，否则查不到原因。
      //
      // 光说「被过滤」没有用 —— 用户只会看到「它不理我」，然后去翻配置瞎猜。
      // 所以顺带把具体卡在哪一步也算出来。
      if (ev.message_type === 'group' && isAddressed(ev)) {
        warnAt('消息 @ 了我但被过滤', {
          群: ev.group_id,
          人: ev.user_id,
          原因: rejectReason(ev, this.opts),
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
      // QQ 昵称单独留一份：群名片每个群不同，全局名必须用它
      senderNick: ev.sender?.nickname ?? ev.sender?.card,
      passive: !isPrivate && !addressed && !followUp,
      ...(() => {
        const imgs = extractImages(ev.message)
        return imgs.length ? { images: imgs } : {}
      })(),
      raw: ev,
    })
  }

  /** 取一张表情包原图：先直接下 URL，不行再走 OneBot 的 get_image。 */
  private async fetchEmojiImage(seg: { type: string; data?: Record<string, string> }): Promise<EmojiImage | null> {
    const data = seg.data ?? {}
    for (const ref of [data['url'], data['file']]) {
      if (ref && /^https?:\/\//i.test(ref)) {
        const got = await downloadImage(ref)
        if (got) return got
      }
    }

    const ref = (data['file'] || data['url'] || '').trim()
    if (!ref) return null
    try {
      const result = await this.callAction('get_image', { file: ref })
      return await imageFromActionResult(result)
    } catch (err) {
      warnAt('get_image 取图失败，跳过这张', {
        err: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      })
      return null
    }
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

  /** 发任意消息段（图片用 base64:// 的 image 段），供 sendImage 复用。 */
  async sendSegment(to: Target, segment: OutgoingSegment): Promise<{ messageId?: string }> {
    const action = to.kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    const replyId = to.replyTo && /^\d+$/.test(to.replyTo) ? to.replyTo : ''
    const message: Array<{ type: string; data: Record<string, string> }> = []
    if (replyId) message.push({ type: 'reply', data: { id: replyId } })
    message.push({ type: segment.type, data: segment.data })

    const params =
      to.kind === 'private'
        ? { user_id: Number(to.id), message }
        : { group_id: Number(to.id), message }
    const data = (await this.callAction(action, params)) as { message_id?: number | string } | null
    const id = data?.message_id
    return id !== undefined && id !== null ? { messageId: String(id) } : {}
  }

  /**
   * 发 QQ 空间说说。
   *
   * NapCat 的扩展 action：send_qzone_msg
   * 参数 content / images / ugc_right / target_uins，返回 { tid }
   */
  async sendQzone(post: {
    content: string
    images?: string[]
    ugcRight?: number
    targetUins?: string[]
  }): Promise<{ tid: string }> {
    const payload: Record<string, unknown> = {
      content: post.content.slice(0, 2000),
      // 默认所有人可见
      ugc_right: post.ugcRight ?? 1,
    }
    if (post.images?.length) payload['images'] = post.images.slice(0, 9)
    if (post.targetUins?.length) payload['target_uins'] = post.targetUins

    const data = (await this.callAction('send_qzone_msg', payload)) as { tid?: string | number } | null
    const tid = data?.tid
    if (tid === undefined || tid === null) throw new Error('发说说没有返回 tid')
    return { tid: String(tid) }
  }

  /** 删说说。发错了能收回，这是敢自动发的底气。 */
  async deleteQzone(tid: string): Promise<boolean> {
    try {
      await this.callAction('delete_qzone_msg', { tid })
      return true
    } catch {
      return false
    }
  }

  /**
   * 显示/隐藏「正在输入」。
   *
   * event_type：1 = 开始输入，2 = 停止输入（参考 NapCat 的 sendShowInputStatusReq）。
   *
   * **只支持私聊**：NapCat 的这套 action 固定用 ChatType.KCHATTYPEC2C，
   * 群里显示"正在输入"是另一套机制（且普通号没有权限）。
   * 失败一律吞掉——打字状态是锦上添花，不能因为它坏了就发不出消息。
   */
  async setTyping(target: Target, on: boolean): Promise<void> {
    if (target.kind !== 'private') return
    try {
      await this.callAction('set_input_status', {
        user_id: String(target.id),
        event_type: on ? 1 : 2,
      })
    } catch {
      /* 静默失败 */
    }
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
      .map((m) => {
        const card = (m.card ?? '').toString().trim()
        const nick = (m.nickname ?? '').toString().trim()
        const id = String(m.user_id ?? '')
        return {
          id,
          // 群里显示的名字优先用群名片（他在这个群里的名字）
          name: card || nick || id,
          // QQ 昵称单独留着：全局名要用它，不能被群名片覆盖
          nick: nick || card || id,
        }
      })
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

/** 这个人是不是刚刚还在跟它说话 */
/**
 * 这条消息为什么被丢掉。
 *
 * 诊断用，**判断顺序必须和 shouldHandle 完全一致** —— 否则日志会撒谎，
 * 比没有日志更糟。
 *
 * 起因：用户群里 @ 了它没反应，日志只写「被过滤」，看不出是黑名单、
 * 群没开、还是别的。只能去翻配置猜。
 */
export function rejectReason(ev: OBEvent, opts: OnebotOptions): string {
  const text = extractText(ev.message)
  if (!text) return '没有文字（只有图片/表情/语音）'
  if (!text.replace(/\[[^\]]*\]/g, '').trim()) return '只有占位符，没有实际内容'

  const isPrivate = ev.message_type === 'private'
  const userId = String(ev.user_id ?? '')

  if (isPrivate) {
    if (opts.ownerQQ && userId !== opts.ownerQQ) {
      return `私聊不是主人（发件人 ${userId}，主人 ${opts.ownerQQ}）`
    }
    return '未知原因'
  }

  if (!opts.allowGroup) return '群聊总开关没开（.env 里 ALLOW_GROUP 不是 true）'

  const gid = String(ev.group_id ?? '')
  const names = (opts.botNames ?? []).filter((n) => n && n !== '未定')
  const called = names.some((n) => text.includes(n))
  const mustAt = opts.getPolicy ? opts.getPolicy().requireAt : opts.requireAt !== false

  if (opts.getPolicy) {
    const p = opts.getPolicy()
    const acc = checkAccess(p, gid, userId)
    // 白名单/黑名单的 reason 直接来自 checkAccess，和自己判断保持一致
    if (!acc.ok) return `${acc.reason ?? '权限拒绝'}（群 ${gid} / 人 ${userId}）`
    if (mustAt && !isAddressed(ev) && !called && !isRecentTalker(opts, gid, userId)) {
      return '要求 @ 或叫名字，这条既没 @ 也没叫（且不是刚聊过的人）'
    }
    return '未知原因'
  }

  if (opts.groupAllow?.length && !opts.groupAllow.includes(gid)) {
    return `群不在白名单（${gid}）`
  }
  if (opts.memberAllow?.length && !opts.memberAllow.includes(userId)) {
    return `人不在白名单（${userId}）`
  }
  if (mustAt && !isAddressed(ev) && !called && !isRecentTalker(opts, gid, userId)) {
    return '要求 @ 或叫名字，这条既没 @ 也没叫（且不是刚聊过的人）'
  }
  return '未知原因'
}


export function isRecentTalker(opts: OnebotOptions, groupId: string, userId: string): boolean {  const at = opts.recentTalkers?.get(`${groupId}:${userId}`) ?? 0
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

/** 这条消息有没有 @ 它。数组格式和字符串 CQ 码格式都认。 */
export function isAddressed(ev: OBEvent): boolean {
  if (ev.message_type === 'private') return true
  const selfId = String(ev.self_id ?? '').trim()
  // 连自己是谁都不知道，就别猜"@ 的是我"
  if (!selfId) return false
  return messageSegments(ev.message).some((s) => s.type === 'at' && (s.data['qq'] ?? '').trim() === selfId)
}
