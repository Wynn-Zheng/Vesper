import { readFile, stat } from 'node:fs/promises'
import type { Rules } from '../core/config.ts'
import type { SendResult, Transport } from '../core/transport.ts'
import type { Target } from '../core/types.ts'
import { MAX_EMOJI_BYTES } from '../emoji/store.ts'
import { warnAt } from '../core/log.ts'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function rand([min, max]: [number, number]): number {
  // 配置写反了也要落在区间里；取整保证是整数毫秒
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return Math.floor(lo + Math.random() * (hi - lo))
}

const HARD_BREAK = /([。！？!?～~…]+|[\n]+)/
const SOFT_BREAK = /([，,、；;：:]+)/

/** 只有标点/空白的片段：不该单独成为一条消息 */
const PUNCT_ONLY = /^[\s。！？!?～~…，,、；;：:]+$/

/**
 * 按"字素簇"切分：emoji、组合字符（e + ́）、ZWJ 家庭、肤色、旗帜都算一个整体。
 * 没有 Intl.Segmenter 时退回按码点切，至少不会切出半个代理对。
 */
const graphemeSegmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function graphemes(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text)
  const out: string[] = []
  for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment)
  return out
}

/** 硬切：按字素累加，绝不把一个 emoji / 组合字符切成两半。 */
function hardSplit(text: string, maxLen: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const g of graphemes(text)) {
    if (cur && cur.length + g.length > maxLen) {
      out.push(cur)
      cur = ''
    }
    // 单个字素本身就超上限（maxLen 很小时）只能整块留着，不切半个
    cur += g
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 按逗号类软标点切，但标点跟着前一段走。
 * 以前是直接 split，结果 "， " 自己成了一条消息。
 */
function splitSoft(sentence: string): string[] {
  const pieces: string[] = []
  let lead = ''
  for (const chunk of sentence.split(SOFT_BREAK)) {
    if (!chunk) continue
    if (SOFT_BREAK.test(chunk)) {
      if (pieces.length) pieces[pieces.length - 1] += chunk
      else lead += chunk
    } else {
      pieces.push(lead + chunk)
      lead = ''
    }
  }
  if (lead) {
    if (pieces.length) pieces[pieces.length - 1] += lead
    else pieces.push(lead)
  }
  return pieces.map((p) => p.trim()).filter(Boolean)
}

/**
 * 按语义切句，不按字数硬切。
 * 1) 先按句末标点和换行切
 * 2) 单句仍超长，按逗号类切（标点跟着前一段）
 * 3) 还超长，才按字素硬切
 * 4) 超过 maxParts 的部分截掉，不把剩下的全塞进最后一条
 */
export function splitBySentence(text: string, maxLen: number, maxParts: number): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (!clean) return []

  // 上限非法时不能退回 1：rules.yaml 写 "40字"（字符串）时 Number.isFinite 失败，
  // limit 变 1 → 整段回复被切成单个字，只发前几条（实测过）。
  const rawLimit = Number(maxLen)
  const limit = Number.isFinite(rawLimit) && rawLimit >= 4 ? Math.floor(rawLimit) : 40

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
  const push = (part: string): void => {
    const p = part.trim()
    if (!p) return
    // 只有标点的尾巴并回上一条，宁可多一个标点也别单独发一条 "，"
    // 上一条本身也只有标点时就不合并了，否则会长到超过上限
    if (PUNCT_ONLY.test(p) && sized.length && !PUNCT_ONLY.test(sized[sized.length - 1]!)) {
      const merged = sized[sized.length - 1]! + p
      // 只并回还能装下的部分：模型爱发长省略号/句号串，
      // 无限并回会把单条撑到 60 多个字、远超「每条最多字数」。
      if (merged.length <= limit) {
        sized[sized.length - 1] = merged
      }
      // 装不下就丢掉这截纯标点（它本来也没有信息量）
      return
    }
    sized.push(p)
  }

  for (const s of sentences) {
    if (s.length <= limit) {
      push(s)
      continue
    }
    for (const piece of splitSoft(s)) {
      if (piece.length <= limit) push(piece)
      else for (const part of hardSplit(piece, limit)) push(part)
    }
  }

  // 条数上限也要兜底：NaN/0/负数会让 slice(0,0) 返回空数组，整轮回复静默丢失。
  const partsMax = Number.isFinite(Number(maxParts)) && Number(maxParts) >= 1 ? Math.floor(Number(maxParts)) : 3
  if (sized.length <= partsMax) return sized

  // 超了条数上限：只发前 maxParts 条。
  // 以前是"剩下全拼进最后一条"，结果最后一条能有几百字，违背每条不超过 maxLen 的约束。
  // 模型本来就不该说这么多，截掉比发一坨更像人。
  return sized.slice(0, partsMax)
}

/**
 * 出站兜底：只拦「疑似泄漏凭据」，不改写正常回复。
 *
 * 为什么只拦凭据、不拦"自曝是 AI"：
 *   `persona/rules.yaml` 的 `人格.不假装: true` 明确允许它承认自己不是人
 *   （不知道就说不知道）。拦"我是 AI"会和这条设定打架。
 *
 * 为什么不拦脏话：入站 `消息过滤.屏蔽词` 是给"用户骂它"用的；
 *   出站拦脏话很容易把"它复述用户的话"误杀，等有真需求再加。
 *
 * 命中就替换成 [已隐藏]，不整条丢弃 —— 一句话里夹了个 key，
 * 不该让整句话消失（用户会以为它掉线了）。
 */
const LEAK_PATTERNS: RegExp[] = [
  // OpenAI / DeepSeek 风格的 key
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // KEY=VALUE / api_key: value
  /\b[A-Z][A-Z0-9_]*_?(?:API_?KEY|TOKEN|SECRET)\s*[:=]\s*\S+/gi,
  // PEM 私钥
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redactSecrets(text: string): string {
  let out = text
  for (const re of LEAK_PATTERNS) out = out.replace(re, '[已隐藏]')
  return out
}

/**
 * 去掉它自己想 @ 人的企图。
 *
 * 中文群里 @ 是「加急 + 强义务」：被 @ 的人有立刻回应的压力，滥用还会让 @ 失效。
 * 它是个在群里待着的角色，不该有"点名要求别人"的权力 —— 那不是它的位置。
 *
 * 两种来源都要挡：
 *   - 模型直接吐 CQ 码（`[CQ:at,qq=123]`）；
 *   - 模型写 `@某人` 这种纯文本（有些平台/插件会把它渲染成真 @）。
 * 保留 @全体成员 的拦截同理，而且更严格：那是管理员才该做的事。
 */
export function stripMentions(text: string): string {
  return text
    // CQ 码形态：整段删掉
    .replace(/\[CQ:at,[^\]]*\]/gi, '')
    // 文本形态的 @所有人 / @全体成员 / @everyone
    // 注意别加 \b：CJK 字符不是 \w，"员" 和后面的空格之间没有词边界，
    // 加了 \b 这条永远匹配不上（实测 "@全体成员 开会了" 会漏）。
    .replace(/@(?:全体成员|所有人|everyone|all)/gi, '')
    // 文本形态的 @昵称：只去掉 @ 符号，名字留着 —— 可能是在说"@小明 刚才那句"，
    // 直接删名字会把句子弄断。去掉 @ 就不构成点名。
    //
    // 左边不能只认空白：中文标点后面紧跟 @ 是最常见的写法
    // （"好的。@小明"、"行啊，@小明"）。只写 (^|\s) 的话这些全漏，
    // @ 会原样发到群里 —— 等于允许它点名。
    .replace(/(^|[\s，。！？、；：,.!?;:（）【】「」『』])@([^\s@，。！？,.!?]{1,20})/g, '$1$2')
}

/** 分句 + 间隔发送。返回实际发出的每条消息 id（平台支持时）。 */
export async function say(t: Transport, to: Target, text: string, rules: Rules): Promise<string[]> {
  // 出站兜底：模型被套话时可能吐出 key / 私钥，发出去就收不回了
  const safe = stripMentions(redactSecrets(text))
  const parts = splitBySentence(safe, rules.说话.每条最多字数, rules.说话.每轮最多条数)
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(rand(rules.说话.条间延迟))
    // 只有第一条引用：不然分句发 3 条会引用同一条三次，像刷屏
    const here = i === 0 ? to : { ...to, replyTo: undefined }
    try {
      const res = await t.send(here, parts[i]!)
      if (res && typeof res === 'object' && res.messageId) ids.push(res.messageId)
    } catch (err) {
      // 某一句失败不能把后面几句一起丢：之前 throw 出去后，
      // 用户只收到前半句，剩下的全没了，界面上也没有任何提示。
      warnAt('这一句发送失败，跳过继续', { 第几句: i + 1, err: String(err).slice(0, 120) })
    }
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
