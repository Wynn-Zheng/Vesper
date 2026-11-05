import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { info, warnAt, errorAt } from '../core/log.ts'
import { MAX_IMAGES_PER_MESSAGE } from '../core/limits.ts'
import type { GroupMember, Transport } from '../core/transport.ts'
import type { AccessPolicy } from '../core/access.ts'
import { checkAccess } from '../core/access.ts'
import type { GroupChatMode } from '../core/config.ts'
import type { Rules } from '../core/config.ts'
import type { Incoming, Target } from '../core/types.ts'
import { MAX_EMOJI_BYTES, type EmojiStore } from '../emoji/store.ts'
import { EMOJI_MAX_SIZE, isEmojiCandidate } from '../emoji/detect.ts'
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
  /**
   * 群聊模式（三档）。由 index.ts 接到 rules.yaml 的 `行为.群聊模式`，
   * 改了配置下一条消息就生效。不注入时按老开关 requireAt 推断，
   * 保证嵌入/测试场景还能跑。
   */
  getGroupMode?: () => GroupChatMode
  /**
   * 它自己发过的消息 id。
   *
   * 由 transport 在构造时自己填，外部不用管。作用：OneBot 的 reply 段只给
   * 被引用消息的 id，不给发送人 —— 有这份记录才知道"引的是它说的话"。
   */
  ownIds?: Set<string>
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

/**
 * 这条消息引用（回复）的是哪条消息的 id。
 *
 * OneBot v11 的 reply 段只有 `id`，没有发送人 —— 谁被引用了得靠调用方
 * 拿自己发过的消息 id 去反查（见 OnebotTransport.ownIds）。
 * 拿不到就返回空串。
 */
export function replyTargetId(message: OBEvent['message']): string {
  for (const seg of messageSegments(message)) {
    if (seg.type !== 'reply') continue
    const id = (seg.data['id'] ?? '').trim()
    if (id) return id
  }
  return ''
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
 * 这个引用是不是本机文件路径（而不是 URL / base64）。
 *
 * OneBot 的 image 段里 `file` 大多数时候只是个文件名（`a1b2c3.jpg`），
 * 那拼不出能读的路径，只能靠 `url`；但 NapCat 在本地缓存/下载过之后
 * 会给绝对路径（`C:\...\nt_temp\x.jpg`、`/root/.../x.png`、`file:///...`），
 * 这种能直接读，而且不像 QQ 的临时链接那样两小时就过期。
 */
function isLocalImageRef(ref: string): boolean {
  const v = ref.trim()
  if (!v) return false
  if (/^file:\/\//i.test(v)) return true
  // Windows 盘符要先判，不然会被当成 `c:` 这种 scheme
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true
  // 其它带 scheme 的（http/ftp/base64/data…）不归本地读管
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false
  if (v.startsWith('\\\\')) return true // UNC 路径
  if (v.startsWith('/')) return true // POSIX 绝对路径
  return /[\\/]/.test(v) // ./a.png、cache/a.png
}

/**
 * 从 message 段里抽出图片引用（最多 4 条）。
 *
 * 每张图的顺序是**先本地、后 URL**：`file` 是本机路径就直接收，
 * 紧跟其后才是 `url`（QQ 临时链接，两小时失效）。消费方按顺序尝试，
 * 本地读不到（文件不在本机 / 已被清掉）还能退回 URL。
 *
 * 以前只认 http(s)，链接一过期这张图就彻底废了——用户发图那条路径
 * 明明有本地原图，却被当成"没图"跳过。
 *
 * 只有文件名、没有路径的 `file` 仍然跳过：那不是能读的路径，
 * 硬传下去只会得到一次失败请求。
 */
export function extractImages(message: OBEvent['message']): string[] {
  const out: string[] = []
  const push = (ref: string): void => {
    const v = ref.trim()
    if (!v || out.includes(v)) return
    out.push(v)
  }
  for (const seg of messageSegments(message)) {
    if (seg.type !== 'image') continue
    const file = (seg.data['file'] ?? '').trim()
    const url = (seg.data['url'] ?? '').trim()
    // 本地原图优先：不会过期，也不受防盗链影响。
    //
    // 每段只出**一个**引用：之前同时出「本地 + URL」两条，看着是"本地失败再兜 URL"，
    // 但消费方（vision）是按引用下标逐个看的，一张图占两个名额 = 4 张图只能看 2 张。
    // 本地读不到的概率远低于"多图只看一半"的确定损失，所以这里只取一个。
    if (isLocalImageRef(file)) push(file)
    else if (/^https?:\/\//i.test(url)) push(url)
    else if (/^https?:\/\//i.test(file)) push(file)
  }
  // 这里是成本硬上限（见 core/limits.ts），不是"一次看几张"的配置：
  // 那些由 rules.视觉.最多张数 在 chat 层切，只能调小。
  return out.slice(0, MAX_IMAGES_PER_MESSAGE)
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
    if (!isEmojiCandidate(seg, meta)) {
      /*
       * 没通过。区分两种原因，别让它们在日志里混成一种：
       *
       *   1) 明确是大图 / 普通照片 → 正常，不收（常见，不用记）
       *   2) 缺宽高 → 判不出来。NapCat 的表情包一般带 subType=1，
       *      那条路已经收了；这里只记"看着小但没宽高"的，
       *      方便以后排查「为什么表情包没进库」。
       */
      const small = typeof meta.size === 'number' && meta.size > 0 && meta.size <= EMOJI_MAX_SIZE
      const noDims = !meta.width || !meta.height
      if (small && noDims) {
        info('一张小图缺宽高，判不准是不是表情包，跳过', {
          size: meta.size,
          file: (data['file'] ?? '').slice(0, 40),
        })
      }
      continue
    }

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
  /**
   * 自己发出去的消息 id（有上限）。
   *
   * 用来判断「有人引用了一条消息」到底引的是谁的：
   *   - 引的是自己刚说的话 → 这就是在跟它说，哪怕没 @；
   *   - 引的是别人的话   → 多半是在跟别人说，不该抢答。
   * OneBot 的 reply 段只给消息 id，不给发送人，所以只能靠这份记录反查。
   */
  private readonly ownIds = new Set<string>()

  /** 记一条自己发的消息（超过 300 条丢最早的，够覆盖一次对话的引用范围） */
  private rememberOwn(id: string | undefined): void {
    if (!id) return
    this.ownIds.add(id)
    if (this.ownIds.size > 300) {
      const first = this.ownIds.values().next().value
      if (first !== undefined) this.ownIds.delete(first)
    }
  }

  constructor(opts: OnebotOptions) {
    this.opts = opts
    // 把自己发过的消息表挂到 opts 上，判定函数就能看到。
    // 传同一个 Set 引用，后续 send 往里加，判定侧实时可见。
    if (!opts.ownIds) opts.ownIds = this.ownIds
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
  /** 把所有在飞的调用快速失败（断线/停止时用） */
  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /** 未连接时等一会儿（NapCat 重连窗口内），超时才报错 */
  private async waitConnected(timeoutMs = 8_000): Promise<WebSocket> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const ws = this.socket
      if (ws && ws.readyState === WebSocket.OPEN) return ws
      await new Promise((r) => setTimeout(r, 150))
    }
    throw new Error('NapCat 未连接')
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
      try {
        // 必须**摘监听 + terminate**，不能只 close：
        //   · 旧 socket 在关闭完成前还会 onFrame → 同一条消息被派发两次（重复收）
        //   · 旧 socket 的 close 处理器会无条件 failPending，把新连接上
        //     刚发出的请求（含 loadSelfInfo）一起拒掉 → 昵称拉不到、发送误判失败
        prev.removeAllListeners()
        prev.terminate()
      } catch {
        /* ignore */
      }
    }
    this.socket = ws
    void this.loadSelfInfo()

    ws.on('message', (data) => this.onFrame(data))
    // ws 在 socket 错误时会 emit('error')，没有监听者就变成未捕获异常
    // （靠全局 uncaughtException 兜住，但那已经是"崩了一次"的语义了）
    ws.on('error', (err) => {
      warnAt('NapCat 连接出错', { err: String(err).slice(0, 120) })
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    })
    // 心跳：NapCat 掉线但 TCP 半开时 readyState 仍是 OPEN，
    // 没有 ping/pong 就永远"显示已连接"，每次发送等满 10s 超时、回复全丢。
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const hb = setInterval(() => {
      if (!alive) {
        warnAt('NapCat 心跳超时（TCP 半开），主动断开等待重连')
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        /* ignore */
      }
    }, 30_000)
    hb.unref?.()
    ws.on('close', () => {
      clearInterval(hb)
      info('NapCat 断开')
      // 只清**自己的**：旧 socket 的 close 不该把新连接的在飞请求也拒掉
      if (this.socket === ws) {
        this.socket = null
        // 断线时把在飞请求立刻失败，别让它们各自等满 10s
        this.failPending('NapCat 断开')
      }
    })
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
      // retcode 判空：有些实现（或代理/网关包装）回包里根本没有 retcode，
      // `undefined !== 0` 会把成功判成失败 → 触发"去掉引用重发"，消息发两遍。
      const failed = obj['status'] === 'failed' || (obj['retcode'] !== undefined && obj['retcode'] !== 0)
      if (failed) p.reject(new Error(`action 失败：${String(obj['message'] ?? obj['wording'] ?? '')}`))
      else p.resolve(obj['data'])
      return
    }

    // 事件
    if (obj['post_type'] === 'message') this.onEvent(obj as OBEvent)
  }

  private onEvent(ev: OBEvent): void {
    // 畸形事件先挡掉：**不是私聊就必须有数字群号**。
    //
    // 下游的判断是"只要不是 private 就当群"（shouldHandle / boot 都这么分），
    // 所以这里的准入标准必须和它一致 —— 之前写成"message_type === 'group'
    // 才检查群号"，结果 discuss（讨论组）、guild（频道）、以及干脆没有
    // message_type 的事件都从缝里漏了进去，带着空群号一路走到
    // groupcache.dirOf('') 抛「群号不合法」。一条坏数据就能把消息回调打断。
    // 顺带挡住 group_id:'abc' 这种非数字：dirOf 会把非数字剔除成空。
    if (ev.message_type !== 'private' && !/^\d+$/.test(String(ev.group_id ?? '').trim())) {
      warnAt('收到没有有效群号的消息，已丢弃', {
        类型: ev.message_type ?? '(缺失)',
        群: ev.group_id,
        人: ev.user_id,
      })
      return
    }

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
      if (ev.message_type === 'group' && isAddressed(ev, this.opts.botNames, this.opts.ownIds)) {
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
    const addressed = isPrivate || isAddressed(ev, this.opts.botNames, this.opts.ownIds)
    // 刚才正在跟它说话的人，不 @ 也算接着聊，不算"突然插话"
    const followUp = !isPrivate && !addressed && isRecentTalker(this.opts, gid, uid)
    // 只在**它要回应这条**时才记"刚跟它说过话"。
    //
    // 以前是无条件记：11-01 起所有群消息都进 onEvent（为了学群里的说法），
    // 于是任何人随便说一句，2 分钟内他的非 @ 消息都会被 isObserveOnly 当成
    // "接着聊"直接回 —— 「必须 @」形同虚设，还会插话/连回。
    //
    // 再往前一步：**followUp 命中的这条不再续期**（原来也 mark，等于自证）。
    // 后果是一次 @ 换来两分钟内每句都必回，群里显得黏人 —— 人不会这样，
    // 说完会等对方接，没人接就自然停下。只有"真的被叫到"才续期。
    if (!isPrivate && addressed) markTalker(this.opts, gid, uid)

    // 「必须 @」现在只决定**回不回复**，不决定**看不看得见**。
    //
    // 这条消息照样要进 raw：这样 distill 有材料学这个群怎么说话、
    // lastTalk 会更新、"群里刚才热不热闹"判断得准。
    // 唯一区别是它不参与这一轮的生成。
    const observeOnly = isObserveOnly(ev, this.opts)

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
      // 群名片可能是**空串**（QQ 允许），?? 不会回落到昵称 → 群历史里就丢了名字前缀，
      // 模型看到一串没有主人的话。用 || 并且 trim。
      senderName: (ev.sender?.card ?? '').trim() || (ev.sender?.nickname ?? '').trim() || uid,
      // QQ 昵称单独留一份：群名片每个群不同，全局名必须用它
      senderNick: (ev.sender?.nickname ?? '').trim() || (ev.sender?.card ?? '').trim() || uid,
      passive: !isPrivate && !addressed && !followUp,
      addressed: isPrivate || addressed,
      followUp: !isPrivate && followUp,
      ...(observeOnly ? { observeOnly: true } : {}),
      ...(() => {
        const imgs = extractImages(ev.message)
        return imgs.length ? { images: imgs } : {}
      })(),
      raw: ev,
    })
  }

  /** 取一张表情包原图：先读本地文件，再下 URL，最后走 OneBot 的 get_image。 */
  private async fetchEmojiImage(seg: { type: string; data?: Record<string, string> }): Promise<EmojiImage | null> {
    const data = seg.data ?? {}
    // 本地路径优先：NapCat 缓存里的原图不会过期，也不受防盗链影响
    for (const ref of [data['file'], data['url']]) {
      const v = (ref ?? '').trim()
      if (!v || !isLocalImageRef(v)) continue
      const got = await readLocalImage(v)
      if (got) return got
    }
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

  private async callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    // 未连接时先等一会儿（NapCat 重连通常几秒），而不是立刻 reject：
    // 之前重连窗口内的回复全部直接丢掉，用户那边就是"它没反应"。
    const ws = await this.waitConnected()
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
    try {
      const data = (await this.callAction(action, params)) as { message_id?: number | string } | null
      const id = data?.message_id
      this.rememberOwn(id !== undefined && id !== null ? String(id) : undefined)
      return id !== undefined && id !== null ? { messageId: String(id) } : {}
    } catch (err) {
      // 引用失败（被引用那条已撤回/删除，retcode≠0）时去掉引用重发一次：
      // 不然第一条就失败，say() 抛错，整轮回复全丢。
      //
      // ⚠ 超时**不能**重发：超时意味着"不知道对方收没收到"，
      // 重发很可能让同一句话在群里出现两遍。只有明确的业务失败
      // （retcode≠0，说明这条确实没发出去）才值得重试。
      const msg = err instanceof Error ? err.message : String(err)
      if (!replyId || !shouldRetryWithoutReply(err)) throw err
      warnAt('引用发送失败，去掉引用重发', { err: msg.slice(0, 120) })
      const data = (await this.callAction(action, { ...params, message: plain })) as { message_id?: number | string } | null
      const id = data?.message_id
      this.rememberOwn(id !== undefined && id !== null ? String(id) : undefined)
      return id !== undefined && id !== null ? { messageId: String(id) } : {}
    }
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
    this.rememberOwn(id !== undefined && id !== null ? String(id) : undefined)
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
  // 只有占位符（[图片]/[表情]/[语音]）的消息一般不触发模型。
  //
  // 例外是**有图**的：图里的信息只能靠视觉模型看，以前「只发一张图、
  // 不配字」在这里就被丢了，用户那边看到的就是"它收不到"。
  // 纯表情 / 纯语音照旧丢（C3：刷表情包不该召唤它）。
  const hasText = Boolean(text.replace(/\[[^\]]*\]/g, '').trim())
  if (!hasText && extractImages(ev.message).length === 0) return false

  const isPrivate = ev.message_type === 'private'
  const userId = String(ev.user_id ?? '')

  if (!isPrivate) {
    // 群聊总开关：优先用动态策略（控制台可改），没注入才退回静态配置。
    // 以前只看 opts.allowGroup，而它来自 .env —— 桌面版 .env 里根本没有这一项，
    // 于是「装好、连上、群里 @ 它」一条都不回，界面上也没地方能打开。
    const allowGroup = opts.getPolicy ? opts.getPolicy().allowGroup : opts.allowGroup !== false
    if (!allowGroup) return false
    const gid = String(ev.group_id ?? '')
    // 优先用动态策略（控制台可改）；没注入就退回静态配置
    if (opts.getPolicy) {
      const p = opts.getPolicy()
      if (!checkAccess(p, gid, userId).ok) return false
      // 「必须 @」不在这里拦了。
      //
      // 以前这里 return false，等于群里的普通聊天**整条都进不来**：
      // 不进 raw（distill 没材料、学不到群里的说法）、不更新 lastTalk
      // （"安静/活跃"判断失真）、`passive` 分支永远走不到
      // （所以「发言频率」在群里从来没生效过）。
      //
      // 现在的分工：这里只判"能不能进来"，"要不要回复"由 onEvent 打
      // observeOnly 标记、boot 里决定。消息全进历史，只是不一定回。
      return true
    }

    if (opts.groupAllow?.length && !opts.groupAllow.includes(gid)) return false
    if (opts.memberAllow?.length && !opts.memberAllow.includes(userId)) return false
    return true
  } else if (opts.ownerQQ && userId !== opts.ownerQQ) {
    return false
  }

  return true
}

/**
 * 这段文字里有没有"叫它的名字"。
 *
 * 为什么要词边界：原来一律 `text.includes(name)`，名字短就会天天误触发 ——
 * 叫「小鱼」的，"小鱼干」"小鱼儿"全算叫它；叫「小满」的，"满意""满满"都算。
 * 群里因此会突然插一句完全不搭的话，比不回还怪。
 *
 * 规则（宁可漏一次，也别乱接）：
 *   - 名字单独成词：句首/句尾、两边是空白或标点；
 *   - 名字后面紧跟呼语标点（在吗 / 呢 / 啊 …）也算 —— 中文里"小鱼在吗"没有空格；
 *   - 单字名字更严格：前后都要边界或呼语。
 *
 * 曾经的做法是一律 `text.includes(name)`，于是"小鱼干""小鱼儿"全算叫它 ——
 * 那是已经修掉的 bug，别改回去。
 */
export function mentionsName(text: string, names: string[]): boolean {
  const valid = names.map((n) => n.trim()).filter((n) => n && n !== '未定')
  if (!valid.length) return false
  for (const name of valid) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (name.length <= 1) {
      // 单字名字只认"单独出现"：前后都得是边界或呼语。
      // 不然叫「满」的，"圆满""满足""满了"全算叫她（实测 '圆满' 曾命中）。
      const single =
        '(^|[\\s，。！？、,.!?~～:：;；"\'「」『』（）()\\[\\]【】])' +
        esc +
        '($|[\\s，。！？、,.!?~～:：;；"\'「」『』（）()\\[\\]【】]|在|呢|啊|呀|吗|吧|嘛|哦|噢)'
      if (new RegExp(single, 'i').test(text)) return true
      continue
    }
    // 中文没有空格，"问一下小鱼"也该算叫她 —— 所以左边**不设约束**。
    // 全部严格性放在右边：名字后面如果紧跟别的字，多半是另一个词
    // （小鱼干 / 小鱼儿 / 满意 / 满满的），不该触发。
    //
    // 但中文最常见的呼语恰恰是"名字 + 你/帮/觉…"，没有标点也没空格：
    //   小满你在吗 / 小满帮我看下 / 小满你觉得呢
    // 不认这些的话它们全被当成"没叫它"，只进旁听不回 ——
    // 用户看到的是"叫了也不理"，这是最伤体验的一类。
    // 注意仍然不含 干/儿/意/满 这类能拼成别的词的字。
    const right =
      '($|[\\s，。！？、,.!?~～:：;；"\'「」『』（）()\\[\\]【】]|在|呢|啊|呀|吗|吧|嘛|哦|噢|你好|早|晚安|醒着|睡了|出来|过来|[你您帮能会快别来看似想说觉请])'
    if (new RegExp(esc + right, 'i').test(text)) return true
  }
  return false
}

/**
 * 当前生效的群聊模式。
 *
 * 优先用注入的 getGroupMode（rules.yaml 热重载）；没注入就按老开关
 * requireAt 推断 —— 老配置 requireAt=false 等价于「自己判断」，
 * true 等价于「熟人续话」。这样测试和嵌入场景不用改。
 */
export function groupModeOf(opts: OnebotOptions): GroupChatMode {
  const m = opts.getGroupMode?.()
  if (m) return m
  return opts.requireAt === false ? '自己判断' : '熟人续话'
}

/**
 * 这条群消息是不是「只记录、不回复」。
 *
 * 和 `shouldHandle` 分工：
 *   shouldHandle  → 能不能进来（黑白名单、群开关）
 *   这个函数      → 进来之后回不回复（群里是不是在叫它）
 *
 * 以前两件事都塞在 shouldHandle 里，后果是群里没 @ 它的话
 * **整条都进不来**：raw 没材料、distill 学不到这个群怎么说话、
 * lastTalk 不更新、「发言频率」永远不生效。
 */
export function isObserveOnly(ev: OBEvent, opts: OnebotOptions): boolean {
  if (ev.message_type === 'private') return false
  if (isAddressed(ev, opts.botNames, opts.ownIds)) return false

  // 明确 @ 了别人：这是在跟那个人说话，不该插嘴。
  // 放在 "刚聊过" 之前 —— 否则上一句刚问过它，下一句「@小明 你试试」
  // 也会被当成接着聊，它回一句"试什么"，对方一脸问号。
  if (isAtOthers(ev, opts.ownIds)) return true

  const mode = groupModeOf(opts)

  // 「只听」：连"刚聊过"都不算。用户明确要求群里只在被叫时出现。
  if (mode === '只听') return true

  const gid = String(ev.group_id ?? '')
  const uid = String(ev.user_id ?? '')
  // 刚跟它说过话的人：这是接着聊，不是突然插话
  if (isRecentTalker(opts, gid, uid)) return false

  const text = extractText(ev.message)
  const names = (opts.botNames ?? []).filter((n) => n && n !== '未定')
  if (mentionsName(text, names)) return false

  // 纯图片（只发一张图、不配字）也会走到这里，而且这里**故意不放行**：
  // 它已经被 shouldHandle 放进来了（能进历史），但没 @ 就是没叫它，
  // 不能因为"发了图"就变成必回，否则群里一有人发图它就得接话。
  // 要不要看图由业务层在真正生成那一轮决定，通道层不替它做主。
  //
  // 「自己判断」：这里放行，交给 boot 的 scoreReply 打分决定。
  // 以前这条路只有 requireAt=false 才走得到，而默认是 true ——
  // 于是「发言频率」「退避」「偶尔不回」在群里从来没生效过。
  if (mode === '自己判断') return false

  // 走到这里只剩「熟人续话」：没被叫到、也不是刚聊过 → 不回复。
  //
  // 这里**不再读 policy.requireAt**：模式和 access.yaml 的「必须 @」是同一件事
  // 的两个入口，两边都读就会打架 —— 用户手改 access.yaml 或从权限页保存时，
  // 实际生效的和界面上显示的可能不是一回事（BUG-13）。
  // 现在模式是唯一权威：熟人续话 = 必须 @ 或被叫到。
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
  // 判断顺序和 shouldHandle 保持一致：纯图片是被放行的，不算"只有占位符"。
  // 只有既没有文字、也没有能看的图（纯表情/语音，或 file 只是个文件名）才拦。
  if (!text.replace(/\[[^\]]*\]/g, '').trim() && extractImages(ev.message).length === 0) {
    return '只有占位符（表情/语音），或图片只有文件名没有地址'
  }

  const isPrivate = ev.message_type === 'private'
  const userId = String(ev.user_id ?? '')

  if (isPrivate) {
    if (opts.ownerQQ && userId !== opts.ownerQQ) {
      return `私聊不是主人（发件人 ${userId}，主人 ${opts.ownerQQ}）`
    }
    return '未知原因'
  }

  const allowGroup = opts.getPolicy ? opts.getPolicy().allowGroup : opts.allowGroup !== false
  if (!allowGroup) return '群聊总开关没开（控制台「设置 → 权限」里打开）'

  const gid = String(ev.group_id ?? '')

  // ⚠ 只保留**真实可达**的原因。
  //
  // 这个函数只在 shouldHandle 返回 false 时被调用，而 shouldHandle 在
  // "权限通过 + 有内容"之后就 return true 了 —— 也就是说
  // 「群聊模式是只听/自己判断」「要求 @ 或叫名字」这些分支**永远走不到**。
  // 以前留着它们，日志里就永远只可能是黑名单/群开关/纯图这类原因，
  // 而排障的人会以为"是模式挡的"（其实真实原因在 boot 那条「这次不接（N 分）」）。
  // 「这一轮为什么没回」的诊断统一由 boot 输出。
  if (opts.getPolicy) {
    const p = opts.getPolicy()
    const acc = checkAccess(p, gid, userId)
    if (!acc.ok) return `${acc.reason ?? '权限拒绝'}（群 ${gid} / 人 ${userId}）`
    return '未知原因（能进来但没处理，看 boot 日志）'
  }

  if (opts.groupAllow?.length && !opts.groupAllow.includes(gid)) {
    return `群不在白名单（${gid}）`
  }
  if (opts.memberAllow?.length && !opts.memberAllow.includes(userId)) {
    return `人不在白名单（${userId}）`
  }
  return '未知原因'
}


export function isRecentTalker(opts: OnebotOptions, groupId: string, userId: string): boolean {
  const at = opts.recentTalkers?.get(`${groupId}:${userId}`) ?? 0
  return Date.now() - at < (opts.followUpWindowMs ?? 120_000)
}

/**
 * 记一笔"刚跟它说过话"。
 *
 * 两个地方会调：被叫到时（开始一段对话），以及**成功发出一条回复后**
 * （boot 里）。后者是关键 —— 窗口锚在"它最后一次真说话"才像人：
 * 只锚 @ 的话，连聊三分钟会突然断掉。
 */
export function markTalker(opts: OnebotOptions, groupId: string, userId: string): void {
  if (!opts.recentTalkers) return
  const key = `${groupId}:${userId}`
  opts.recentTalkers.set(key, Date.now())
  // 顺手清掉太旧的，别让 Map 一直涨
  if (opts.recentTalkers.size > 200) {
    const cutoff = Date.now() - 30 * 60_000
    for (const [k, v] of opts.recentTalkers) if (v < cutoff) opts.recentTalkers.delete(k)
  }
}

/**
 * 这条消息有没有 @ 它 / 叫它名字 / 引用它说过的话。
 *
 * 引用这一条是后加的：群里有人直接「回复」它刚才那句、但不 @，
 * 按原来的判断算"没叫它"，于是永远不回 —— 而这在 QQ 群里是最常见的
 * 追问方式之一。谁被引用了只能靠 ownIds 反查（reply 段不带发送人）。
 */
export function isAddressed(ev: OBEvent, botNames: string[] = [], ownIds?: Set<string>): boolean {
  if (ev.message_type === 'private') return true
  const selfId = String(ev.self_id ?? '').trim()
  const segs = messageSegments(ev.message)
  // 连自己是谁都不知道，就别猜"@ 的是我"（但名字判断不受影响）
  if (selfId && segs.some((s) => s.type === 'at' && (s.data['qq'] ?? '').trim() === selfId)) {
    return true
  }
  // 引用的是它自己发过的消息 → 等于在跟它说话
  const replyId = replyTargetId(ev.message)
  if (replyId && ownIds?.has(replyId)) return true
  // 群里**直接叫它的名字**也算被叫到，和 @ 同级。
  // 以前名字只参与 rejectReason 的"要不要 @ 才能说话"，不参与 addressed，
  // 所以"小鲸鱼在吗"这种被当成普通群聊去打分，它可能装没看见。
  const names = botNames.filter((n) => n && n !== '未定')
  if (names.length) {
    const text = extractText(ev.message)
    if (mentionsName(text, names)) return true
  }
  return false
}

/**
 * 这条消息有没有明确 @ 了**别人**（不是它）。
 *
 * 为什么需要这个：`isRecentTalker` 那个「刚跟它说过话的人，2 分钟内不 @ 也算接着聊」
 * 本来是为了让对话自然，但它不看这条消息 @ 的是谁。于是群里紧接着来一句
 * 「@小明 你试试」，它也会当成跟自己说的，回一句「试什么」——对方根本没问它。
 *
 * @全体成员 也算"不是单独叫它"：群公告式消息不该触发它接话。
 */
export function isAtOthers(ev: OBEvent, ownIds?: Set<string>): boolean {
  if (ev.message_type === 'private') return false
  // 注意：这里**故意不**用 reply 段做否定判断。
  //
  // "引用了一条我不知道是谁的消息" 不等于 "在跟别人说" ——
  // ownIds 是进程内存里的（重启就空），重启后引用它昨天说的话会
  // 被误判成"引用别人"，于是它装没看见，比不判还差。
  // 正向判断（引用我自己 → 算叫我）放在 isAddressed 里，那个方向错了也只是"多看一眼"。
  const selfId = String(ev.self_id ?? '').trim()
  for (const s of messageSegments(ev.message)) {
    if (s.type !== 'at') continue
    const qq = (s.data['qq'] ?? '').trim()
    // 空 qq 是坏数据，不能据此判断"@ 了别人"
    if (!qq) continue
    if (selfId && qq === selfId) continue
    return true
  }
  return false
}
/**
 * 引用发送失败后，要不要去掉引用重发一次。
 *
 * 只有"这条确实没发出去"才值得重试：
 *   - retcode≠0 的业务失败（比如被引用的那条已经被撤回/删掉了）→ 重发
 *   - 超时 → **不重发**。超时意味着"不知道对方收没收到"，
 *     重发很可能让同一句话在群里出现两遍 —— 比丢一句话更难解释。
 */
export function shouldRetryWithoutReply(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return !msg.includes('超时')
}
