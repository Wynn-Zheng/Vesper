import { warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'

/**
 * 给表情包打语义标签。
 *
 * 为什么需要：`pickEmoji()` 有两级"按心情挑"——mood 精确相等、tags 含 emotion。
 * 但收集表情包时 NapCat 只给图片，不带任何语义，所以这两级从来没命中过，
 * 实际永远走"随便挑一张"。库越攒越大，"按心情挑"就越像随机。
 *
 * 打完标之后：心情是「无语」时就真能翻出那张翻白眼的表情包。
 */

/**
 * 固定的情绪词表。
 *
 * 为什么要固定：表情包的 mood 和系统当前情绪是两套词。
 * 系统情绪是模型自由生成的（"有点烦"、"挺开心的"），要是表情包也用自由词，
 * 两边永远不会精确相等。固定一张表 + 下面的归一化，才有机会对上。
 */
export const EMOJI_MOODS = [
  '开心',
  '难过',
  '生气',
  '无语',
  '惊讶',
  '害羞',
  '疲惫',
  '期待',
  '温柔',
  '嘲讽',
] as const

export type EmojiMood = (typeof EMOJI_MOODS)[number]

/**
 * 把任意情绪词归到上面那张表里的一个。
 *
 * 例子：「有点烦」→ 生气；「挺开心的」→ 开心；「无语子」→ 无语。
 * 认不出来返回空串——宁可当没匹配到，也别硬套一个不相关的情绪。
 */
const GROUP_WORDS: Array<[EmojiMood, string[]]> = [
  ['开心', ['开心', '高兴', '愉快', '兴奋', '快乐', '满足', '舒服', '好受', '爽', '哈哈', '笑']],
  ['难过', ['难过', '失落', '低落', '委屈', '伤心', '悲伤', '哭', '难受', 'emo', '丧', '难过']],
  ['生气', ['生气', '愤怒', '烦', '恼', '火', '怒', '气', '讨厌', '不爽']],
  ['无语', ['无语', '无奈', '尴尬', '离谱', '服了', '沉默', '汗', '麻了']],
  ['惊讶', ['惊讶', '震惊', '惊', '不会吧', '居然', '竟然', '意外']],
  ['害羞', ['害羞', '脸红', '不好意思', '羞', '可爱', '心动']],
  ['疲惫', ['疲惫', '累', '困', '倦', '没精神', '躺', '麻']],
  ['期待', ['期待', '想要', '盼', '等不及', '冲', '好奇']],
  ['温柔', ['温柔', '贴心', '暖', '安心', '安慰', '心疼']],
  ['嘲讽', ['嘲讽', '鄙视', '白眼', '呵呵', '阴阳', '讥', '瞧不起']],
]

export function moodGroup(word: string): EmojiMood | '' {
  const w = String(word ?? '').trim().toLowerCase()
  if (!w) return ''
  // 已经是标准词就直接返回
  for (const m of EMOJI_MOODS) if (w === m.toLowerCase()) return m
  for (const [group, words] of GROUP_WORDS) {
    if (words.some((k) => w.includes(k))) return group
  }
  return ''
}

const SYSTEM = `你在给聊天机器人收集的表情包打标签。只输出 JSON，不要解释。

对这张图，判断：
1. 它传达的主要情绪，**必须**从这几个里选一个：${EMOJI_MOODS.join('、')}
2. 最多 5 个标签，描述图里的动作、物件、文字或梗（比如：鼓掌、点赞、翻白眼、狗、笑死、无语）

只有文字没有图的、看不清的、不是表情包的，就返回 {"情绪":"","标签":[]}。

格式：{"情绪":"开心","标签":["鼓掌","点赞"]}`

/** 单张表情包打标最多花这么多输出 token：标签不需要长 */
const MAX_TOKENS = 120

export interface EmojiTags {
  mood: string
  tags: string[]
}

function parse(text: string): EmojiTags | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { 情绪?: unknown; 标签?: unknown }
    const mood = typeof o.情绪 === 'string' ? o.情绪.trim() : ''
    const rawTags = Array.isArray(o.标签) ? o.标签 : []
    const tags = rawTags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 12)
      .slice(0, 5)
    // 情绪必须在词表里，否则当成没打出来——不然库里的 mood 会越来越杂
    const norm = moodGroup(mood)
    return { mood: norm, tags }
  } catch {
    return null
  }
}

/**
 * 让视觉模型看一眼这张表情包，给出情绪和标签。
 *
 * 失败返回 null（调用方保留空标签，下次再试）。不抛：
 * 打标是锦上添花，不能因为一次超时把整个补标任务拖死。
 */
export async function tagEmoji(
  image: { buffer: Uint8Array; ext: string },
  llm: LlmOptions,
): Promise<EmojiTags | null> {
  if (!llm.apiKey || !llm.baseUrl || !llm.model) return null
  if (!image.buffer.byteLength) return null

  const ext = image.ext.replace(/^\.+/, '').toLowerCase() || 'png'
  const mime = ext === 'jpg' ? 'jpeg' : ext
  const dataUrl = `data:image/${mime};base64,${Buffer.from(image.buffer).toString('base64')}`

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张表情包是什么情绪？给个标签。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      { ...llm, maxTokens: MAX_TOKENS, temperature: 0.2 },
    )
    const parsed = parse(res.text)
    if (!parsed) return null
    if (!parsed.mood && !parsed.tags.length) return null
    return parsed
  } catch (err) {
    warnAt('表情包打标失败，下轮再试', { err: String(err).slice(0, 80) })
    return null
  }
}
