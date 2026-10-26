/**
 * 看图。
 *
 * 为什么单独一个模块：我们的主模型是 deepseek-chat（纯文本），
 * 硬把图塞给它会被忽略或报错。所以先用视觉模型把图"看"成一段文字，
 * 再把这句描述混进对话——主模型不用换。
 *
 * 一张图最多 384 token，价格跟 V4-Flash 一样，成本可以接受。
 */
import { warnAt } from '../core/log.ts'
import { chat } from './deepseek.ts'
import type { LlmOptions } from './types.ts'

export interface ImageNote {
  /** 图的地址 */
  url: string
  /** 看到了什么；识别失败就是空 */
  text: string
}

const SYSTEM = `你在帮一个聊天机器人看图。只描述，不评价。规则：

- 一两条短句，总共不超过 60 字。
- 先说是哪类图：照片 / 截图 / 表情包 / 图表 / 聊天记录 / 二次元图。
- 讲清楚"这幅图里有什么"，尤其是人在做什么、表情如何、有没有文字。
- 如果是梗图或表情包，说明它的情绪（嘲讽、委屈、开心……）。
- 不要猜图外的事，不要编。看不出就说"这张图看不太清"。`


/** 单张图最多 5MB。超过就不看，免得拖慢整个回复。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

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

/**
 * 把远程图下载下来转成 data URL。
 *
 * 为什么要自己下：实测 DeepSeek 服务器下载维基百科的图会失败
 * （Failed to download image）。QQ 的图片链接有防盗链和有效期，
 * 让对面去下更不可靠。自己下完用 base64 内联，最稳。
 *
 * 导出给体检脚本用；正常调用只经过 describeImages。
 */
export async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // 有些图床会看 UA / Referer，装得像浏览器
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://qzone.qq.com/',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null

    // content-type 可能带 charset，也可能大小写不统一
    const type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase()
    if (!type.startsWith('image/')) return null

    // 先看声明的长度，明显超限就不下载了
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null

    const buf = await readCapped(res, MAX_IMAGE_BYTES)
    if (!buf) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function isImageUrl(u: string): boolean {
  return /^https?:\/\//i.test(u)
}

/**
 * 把一批图片变成文字描述。
 * 没有配置视觉模型、或者全失败了，就返回空——调用方会退化成 [图片]。
 */
export async function describeImages(urls: string[], opts: LlmOptions): Promise<ImageNote[]> {
  const usable = urls.filter(isImageUrl).slice(0, 4)
  if (!usable.length) return []
  if (!opts.apiKey || !opts.baseUrl || !opts.model) {
    // 不报警：视觉开关关着是正常状态，调用方本来就不该走到这里。
    // 真走到这里说明代码路径写错了，但那是开发期该发现的，
    // 不该在运行日志里刷成「问题」，把真正要紧的报错淹掉。
    return []
  }

  const out: ImageNote[] = []
  for (const url of usable) {
    const dataUrl = await toDataUrl(url)
    if (!dataUrl) {
      warnAt('图片拉不下来，跳过', { url: url.slice(0, 60) })
      continue
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
        { ...opts, maxTokens: 160, temperature: 0.3 },
      )
      const text = res.text.trim().replace(/\s+/g, ' ').slice(0, 120)
      if (text) out.push({ url, text })
    } catch (err) {
      warnAt('看图失败', { err: String(err).slice(0, 60) })
    }
  }
  return out
}

/** 把识别结果拼成给模型看的一小段 */
export function renderImages(notes: ImageNote[]): string {
  if (!notes.length) return ''
  const lines = notes.map((n, i) => `${i + 1}. ${n.text}`)
  return `[对方发了 ${notes.length} 张图]\n${lines.join('\n')}`
}
