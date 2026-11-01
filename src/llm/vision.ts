/**
 * 看图。
 *
 * 为什么单独一个模块：我们的主模型是 deepseek-chat（纯文本），
 * 硬把图塞给它会被忽略或报错。所以先用视觉模型把图"看"成一段文字，
 * 再把这句描述混进对话——主模型不用换。
 *
 * 一张图最多 384 token，价格跟 V4-Flash 一样，成本可以接受。
 *
 * 并发：一次消息里的几张图同时看，整批有一个总预算（默认 8s）。
 * 以前是串行，最坏 4 张 × (15s 下载 + 模型调用)，回复要等一分钟以上。
 * 并发之后总耗时约等于最慢的那一张，超预算的图直接放弃并标记"没加载出来"。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { warnAt } from '../core/log.ts'
import { chat } from './deepseek.ts'
import type { LlmOptions } from './types.ts'

export interface ImageNote {
  /** 图的地址 */
  url: string
  /** 看到了什么；识别失败就是空 */
  text: string
  /**
   * 在原始图片列表里的位置（0 起）。
   *
   * 并发跑完顺序是乱的，renderImages 靠它把描述放回原位，
   * 保证"第 2 张的描述"确实对应"第 2 张图"。
   * 可选：老调用方只传 { url, text } 也能用（按数组顺序排）。
   */
  index?: number
}

/** 一张图为什么没看成 */
export type ImageFailReason =
  /** 下载失败（网络、非 200、不是图片、太大……） */
  | 'download'
  /** 下载成功，但视觉模型调用失败/返回空 */
  | 'vision'
  /** 不是可读的图片引用（既不是 http，也不是本地路径） */
  | 'unsupported'
  /** 超过了整批预算，被放弃 */
  | 'timeout'

/** 没看成的那张图；调用方据此在 prompt 里说明"这张没加载出来" */
export interface ImageFailure {
  /** 在原始图片列表里的位置（0 起），和 ImageNote.index 同一套坐标 */
  index: number
  url: string
  reason: ImageFailReason
}

/** describeImagesDetailed 的结果：成功的按原顺序，失败的也按原顺序 */
export interface VisionBatch {
  notes: ImageNote[]
  failed: ImageFailure[]
}

const SYSTEM = `你在帮一个聊天机器人看图。只描述，不评价。规则：

- 一两条短句，总共不超过 60 字。
- 先说是哪类图：照片 / 截图 / 表情包 / 图表 / 聊天记录 / 二次元图。
- 讲清楚"这幅图里有什么"，尤其是人在做什么、表情如何、有没有文字。
- 如果是梗图或表情包，说明它的情绪（嘲讽、委屈、开心……）。
- 不要猜图外的事，不要编。看不出就说"这张图看不太清"。`


/** 单张图最多 5MB。超过就不看，免得拖慢整个回复。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 一次最多看几张。配置层还有 视觉.最多张数，这里只是最后一道闸。 */
const MAX_IMAGES = 4

/** 单次下载的超时。 */
const DOWNLOAD_TIMEOUT_MS = 15_000

/** 下载失败后重试一次，中间等 300ms（图床抖一下很常见）。 */
const RETRY_DELAY_MS = 300

/** 整批图片的总预算：到点就收工，没看完的算失败，不拖住回复。 */
export const DEFAULT_BUDGET_MS = 8_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 读完响应体，但最多只收 max 字节。
 *
 * 不能直接 arrayBuffer：一张几十 MB 的图会先被完整读进内存再被拒。
 * 这里边读边数，超了立刻取消，顺便也守住 Content-Length 撒谎的情况。
 */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > max ? null : buf
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

interface FetchOutcome {
  dataUrl: string | null
  /** 值不值得再试一次：网络、非 200、内容不是图片 = 值得；超过大小上限 = 不值得 */
  retryable: boolean
}

/** 下载一次（不重试）。 */
async function fetchImageOnce(url: string, timeoutMs: number): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      headers: {
        // 有些图床会看 UA / Referer，装得像浏览器
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://qzone.qq.com/',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
    if (!res.ok) return { dataUrl: null, retryable: true }

    // content-type 可能带 charset，也可能大小写不统一。
    // 200 但正文是 HTML（防盗链/过期页）走的就是这一条，算失败、值得重试。
    const type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase()
    if (!type.startsWith('image/')) return { dataUrl: null, retryable: true }

    // 先看声明的长度，明显超限就不下载了；重试也还是这么大，不重试
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return { dataUrl: null, retryable: false }
    }

    const buf = await readCapped(res, MAX_IMAGE_BYTES)
    if (!buf) return { dataUrl: null, retryable: false }
    // 0 字节不可能是图，当网络抖动处理
    if (!buf.length) return { dataUrl: null, retryable: true }
    return { dataUrl: `data:${type};base64,${buf.toString('base64')}`, retryable: false }
  } catch {
    return { dataUrl: null, retryable: true }
  }
}

/**
 * 下载一张图，失败重试一次（300ms 退避）。
 *
 * deadline 是整批的截止时间：每次尝试的超时不会超过剩余预算，
 * 预算快用完时干脆不重试，免得白等 300ms 又什么都拿不到。
 */
async function download(url: string, deadline: number): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now()
    if (left <= 0) return null

    const out = await fetchImageOnce(url, Math.min(DOWNLOAD_TIMEOUT_MS, left))
    if (out.dataUrl) return out.dataUrl
    if (!out.retryable || attempt === 1) return null

    // 退避之后还得留点时间给第二次下载，不然只是空转
    if (deadline - Date.now() <= RETRY_DELAY_MS + 100) return null
    await sleep(RETRY_DELAY_MS)
  }
  return null
}

/**
 * 把远程图下载下来转成 data URL。
 *
 * 为什么要自己下：实测 DeepSeek 服务器下载维基百科的图会失败
 * （Failed to download image）。QQ 的图片链接有防盗链和有效期，
 * 让对面去下更不可靠。自己下完用 base64 内联，最稳。
 *
 * 导出给体检脚本用；正常调用只经过 describeImages。
 * 失败会重试一次（300ms 退避），所以最坏耗时约 30s。
 */
export async function toDataUrl(url: string): Promise<string | null> {
  return download(url, Date.now() + DOWNLOAD_TIMEOUT_MS * 2 + RETRY_DELAY_MS)
}

/** 本地图片引用：file://、Windows 盘符、POSIX 绝对路径。 */
function isLocalImageRef(u: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('file://') || u.startsWith('/')
}

/**
 * 图片引用能不能看：http(s) 或本地路径。
 *
 * 之前只认 http(s)，通道层好不容易送的本地原图（不会过期）会被这里静默滤掉，
 * 「取图优先本地」等于白做。
 */
function isImageUrl(u: string): boolean {
  return /^https?:\/\//i.test(u) || isLocalImageRef(u)
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/** 本地文件 → data URL。读不到/太大都返回 null（按"没加载出来"处理）。 */
function localToDataUrl(ref: string): string | null {
  try {
    const p = ref.startsWith('file://') ? fileURLToPath(ref) : ref
    if (!existsSync(p)) return null
    const buf = readFileSync(p)
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null
    const ext = p.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext] ?? 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

interface Slot {
  note: ImageNote | null
  failure: ImageFailure | null
}

/** 把单张图的处理包在整批截止时间里：到点就按超时算，不再等它。 */
function withDeadline<T>(work: Promise<T>, deadline: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(fallback), Math.max(0, deadline - Date.now()))
    // 两个分支都接住：到点后 work 再失败也不会变成 unhandled rejection
    work.then(finish, () => finish(fallback))
  })
}

/** 看一张图：下载 → 视觉模型。任何一步失败都返回一个带原因的失败槽位。 */
async function describeOne(
  url: string,
  index: number,
  opts: LlmOptions,
  deadline: number,
): Promise<Slot> {
  const dataUrl = isLocalImageRef(url) ? localToDataUrl(url) : await download(url, deadline)
  if (!dataUrl) {
    warnAt('图片拉不下来，跳过', { url: url.slice(0, 60) })
    return { note: null, failure: { index, url, reason: 'download' } }
  }

  const left = deadline - Date.now()
  if (left <= 0) {
    return { note: null, failure: { index, url, reason: 'timeout' } }
  }

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里是什么？' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      {
        ...opts,
        maxTokens: 160,
        temperature: 0.3,
        // 模型调用也不能超出整批预算
        timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, left)),
      },
    )
    const text = res.text.trim().replace(/\s+/g, ' ').slice(0, 120)
    if (!text) return { note: null, failure: { index, url, reason: 'vision' } }
    return { note: { url, text, index }, failure: null }
  } catch (err) {
    warnAt('看图失败', { err: String(err).slice(0, 60) })
    return { note: null, failure: { index, url, reason: 'vision' } }
  }
}

/**
 * 把一批图片并发变成文字描述，并告诉调用方哪几张没看成。
 *
 * - 所有图同时开始，总耗时受 budgetMs 约束（默认 8s）
 * - 结果按原始 index 归位：notes / failed 都保持原图顺序
 * - 视觉没配置（apiKey/baseUrl/model 缺一个）就原样返回空，不报警
 */
export async function describeImagesDetailed(
  urls: string[],
  opts: LlmOptions,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<VisionBatch> {
  // 被过滤掉的（既不是 http 也不是本地路径）也要标成 failed：
  // 否则模型只看到 [图片]，不知道自己没看成。
  const dropped: ImageFailure[] = urls
    .map((url, index) => ({ url, index }))
    .filter((x) => !isImageUrl(x.url))
    .map((x) => ({ index: x.index, url: x.url, reason: 'unsupported' as const }))
  const usable = urls.filter(isImageUrl).slice(0, MAX_IMAGES)
  if (!usable.length) return { notes: [], failed: dropped }
  if (!opts.apiKey || !opts.baseUrl || !opts.model) {
    // 不报警：视觉开关关着是正常状态，调用方本来就不该走到这里。
    // 真走到这里说明代码路径写错了，但那是开发期该发现的，
    // 不该在运行日志里刷成「问题」，把真正要紧的报错淹掉。
    return { notes: [], failed: [] }
  }

  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS
  const deadline = Date.now() + budget

  // 用**原始下标**：usable 是过滤+截断后的数组，直接 map 的话
  // index 会从 0 重排，`[对方发了 N 张图]` 里的 N 和"第几张"全错位。
  const usableIndexed = urls
    .map((url, index) => ({ url, index }))
    .filter((x) => isImageUrl(x.url))
    .slice(0, MAX_IMAGES)

  const slots = await Promise.all(
    usableIndexed.map(({ url, index }) =>
      withDeadline<Slot>(describeOne(url, index, opts, deadline), deadline, {
        note: null,
        failure: { index, url, reason: 'timeout' },
      }),
    ),
  )

  // 每个槽位带着自己的 index，按数组顺序（即原图顺序）收回来。
  // 不用 sort：Promise.all 保持入参顺序，槽位 i 就是第 i 张图。
  const notes: ImageNote[] = []
  const failed: ImageFailure[] = []
  for (const slot of slots) {
    if (slot.note) notes.push(slot.note)
    else if (slot.failure) failed.push(slot.failure)
  }
  return { notes, failed }
}

/**
 * 把一批图片变成文字描述。
 * 没有配置视觉模型、或者全失败了，就返回空——调用方会退化成 [图片]。
 *
 * 这是兼容旧调用方的薄壳：只要描述，不要失败信息。
 * 需要知道"哪张没看成"（好在 prompt 里说明）时用 describeImagesDetailed。
 */
export async function describeImages(
  urls: string[],
  opts: LlmOptions,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<ImageNote[]> {
  const batch = await describeImagesDetailed(urls, opts, budgetMs)
  return batch.notes
}

/** 把识别结果拼成给模型看的一小段 */
export function renderImages(notes: ImageNote[], failed: ImageFailure[] = []): string {
  if (!notes.length && !failed.length) return ''

  type RenderSlot = { text: string } | { missing: true }
  const slots = new Map<number, RenderSlot>()
  let total = 0

  notes.forEach((n, i) => {
    const idx = n.index ?? i
    slots.set(idx, { text: n.text })
    total = Math.max(total, idx + 1)
  })
  for (const f of failed) {
    if (!slots.has(f.index)) slots.set(f.index, { missing: true })
    total = Math.max(total, f.index + 1)
  }

  const lines: string[] = []
  for (let i = 0; i < total; i++) {
    const slot = slots.get(i)
    if (!slot) continue
    // 明说"没加载出来"，模型才知道该让对方重发，而不是装作看见了
    lines.push('missing' in slot ? `${i + 1}. （这张图没加载出来，我没看到内容）` : `${i + 1}. ${slot.text}`)
  }
  return `[对方发了 ${total} 张图]\n${lines.join('\n')}`
}
