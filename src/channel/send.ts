import { readFile, stat } from 'node:fs/promises'
import type { Rules } from '../core/config.ts'
import type { SendResult, Transport } from '../core/transport.ts'
import type { Target } from '../core/types.ts'
import { MAX_EMOJI_BYTES } from '../emoji/store.ts'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function rand([min, max]: [number, number]): number {
  return Math.floor(min + Math.random() * (max - min))
}

const HARD_BREAK = /([。！？!?～~…]+|[\n]+)/
const SOFT_BREAK = /([，,、；;：:]+)/

/**
 * 按语义切句，不按字数硬切。
 * 1) 先按句末标点和换行切
 * 2) 单句仍超长，按逗号类切
 * 3) 还超长，才硬切
 * 4) 超过 maxParts 的合并进最后一条（宁可长一点，也别发一串）
 */
export function splitBySentence(text: string, maxLen: number, maxParts: number): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (!clean) return []

  const sentences: string[] = []
  let buf = ''
  for (const chunk of clean.split(HARD_BREAK)) {
    if (!chunk) continue
    if (HARD_BREAK.test(chunk)) {
      buf += chunk
      if (buf.trim()) sentences.push(buf.trim())
      buf = ''
    } else {
      buf += chunk
    }
  }
  if (buf.trim()) sentences.push(buf.trim())

  const sized: string[] = []
  for (const s of sentences) {
    if (s.length <= maxLen) {
      sized.push(s)
      continue
    }
    for (const piece of s.split(SOFT_BREAK)) {
      const p = piece.trim()
      if (!p) continue
      if (p.length <= maxLen) sized.push(p)
      else for (let i = 0; i < p.length; i += maxLen) sized.push(p.slice(i, i + maxLen))
    }
  }

  if (sized.length <= maxParts) return sized

  // 超了条数上限：只发前 maxParts 条。
  // 以前是"剩下全拼进最后一条"，结果最后一条能有几百字，违背每条不超过 maxLen 的约束。
  // 模型本来就不该说这么多，截掉比发一坨更像人。
  return sized.slice(0, maxParts)
}

/** 分句 + 间隔发送。返回实际发出的每条消息 id（平台支持时）。 */
export async function say(t: Transport, to: Target, text: string, rules: Rules): Promise<string[]> {
  const parts = splitBySentence(text, rules.说话.每条最多字数, rules.说话.每轮最多条数)
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(rand(rules.说话.条间延迟))
    // 只有第一条引用：不然分句发 3 条会引用同一条三次，像刷屏
    const here = i === 0 ? to : { ...to, replyTo: undefined }
    const res = await t.send(here, parts[i]!)
    if (res && typeof res === 'object' && res.messageId) ids.push(res.messageId)
  }
  return ids
}

/** 单张图片上限：2MB。和表情包库保持一致，超了平台也多半不收。 */
export const MAX_IMAGE_BYTES = MAX_EMOJI_BYTES

/** OneBot 的消息段。图片用 base64://，不依赖本机路径对端能不能读到。 */
export interface OutgoingSegment {
  type: string
  data: Record<string, string>
}

/**
 * 会发消息段的通道。
 * 核心 Transport 只声明了 send(text)，这里用可选方法扩展：
 * 有 sendSegment 就走段，没有就退回 CQ 码文本。
 */
export interface SegmentAwareTransport extends Transport {
  sendSegment?: (to: Target, segment: OutgoingSegment) => Promise<SendResult | void>
}

/**
 * 两参数 sendImage(target, filePath) 用的默认通道。
 * OnebotTransport 构造时登记自己；测试可以注入一个对象字面量。
 */
let defaultTransport: SegmentAwareTransport | null = null

/** 注入/清除发图通道。传 null 只影响两参数形式，三参数形式始终以入参为准。 */
export function setImageTransport(t: SegmentAwareTransport | null): void {
  defaultTransport = t
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/** 读本地图片并检查大小；错误信息写清楚是哪一步、哪个文件。 */
async function loadImageBytes(filePath: string): Promise<Uint8Array> {
  if (!filePath.trim()) throw new Error('发送图片失败：文件路径为空')

  let info
  try {
    info = await stat(filePath)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') throw new Error(`发送图片失败：文件不存在（${filePath}）`)
    throw new Error(`发送图片失败：无法访问文件 ${filePath}（${errorText(err)}）`)
  }

  if (!info.isFile()) throw new Error(`发送图片失败：不是普通文件（${filePath}）`)
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`发送图片失败：文件超过 2MB 上限（${filePath}，${formatSize(info.size)}）`)
  }

  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (err) {
    throw new Error(`发送图片失败：读取文件失败 ${filePath}（${errorText(err)}）`)
  }

  // stat 和 readFile 之间文件可能被替换，读出来再确认一次
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`发送图片失败：文件超过 2MB 上限（${filePath}，${formatSize(bytes.byteLength)}）`)
  }
  return bytes
}

/** 把本地图片组装成 OneBot 的 image 消息段。导出便于测试/复用。 */
export function buildImageSegment(bytes: Uint8Array): OutgoingSegment {
  return {
    type: 'image',
    data: { file: `base64://${Buffer.from(bytes).toString('base64')}` },
  }
}

/**
 * 发一张本地图片。
 *
 * 两种调用方式：
 *   sendImage(transport, target, filePath)  —— 显式指定通道，适合测试/多通道
 *   sendImage(target, filePath)             —— 用 setImageTransport 登记的默认通道
 *
 * 文件不存在或超过 2MB 时抛中文错误，调用方自己决定是否忽略。
 */
export async function sendImage(target: Target, filePath: string): Promise<SendResult | void>
export async function sendImage(t: Transport, target: Target, filePath: string): Promise<SendResult | void>
export async function sendImage(
  first: Transport | Target,
  second: Target | string,
  third?: string,
): Promise<SendResult | void> {
  let transport: SegmentAwareTransport
  let target: Target
  let filePath: string

  if (typeof second === 'string') {
    if (!defaultTransport) {
      throw new Error('发送图片失败：没有可用通道（请先调用 setImageTransport 注入 transport）')
    }
    transport = defaultTransport
    target = first as Target
    filePath = second
  } else {
    transport = first as SegmentAwareTransport
    target = second
    if (third === undefined) throw new Error('发送图片失败：缺少文件路径')
    filePath = third
  }

  const segment = buildImageSegment(await loadImageBytes(filePath))

  if (typeof transport.sendSegment === 'function') return transport.sendSegment(target, segment)
  // 兼容只实现 send(text) 的旧通道；OneBot 那边有 sendSegment，不会走这里
  return transport.send(target, `[CQ:image,file=${segment.data['file']}]`)
}
