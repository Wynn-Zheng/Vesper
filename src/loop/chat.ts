import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { Incoming } from '../core/types.ts'
import { sendImage } from '../channel/send.ts'
import { pickEmoji } from '../emoji/pick.ts'
import { createEmojiStore, type EmojiStore } from '../emoji/store.ts'
import { chat } from '../llm/deepseek.ts'
import { describeImages, renderImages } from '../llm/vision.ts'
import type { ChatMessage, LlmOptions, ToolSpec } from '../llm/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { recall, renderRecalled, similarity } from '../memory/recall.ts'
import { markMentioned, unmentionedIssues } from '../self/observe.ts'
import { personOfMessage, scopeOf } from '../memory/scope.ts'
import { decayedMood, loadMood } from '../persona/mood.ts'
import { loadProfile } from '../persona/profile.ts'
import { renderGroupContext } from '../people/group.ts'
import { explainJargon, renderJargon } from '../learn/jargon.ts'
import { relevantPlays, renderPlays } from '../learn/plays.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildSelfBlock, buildPhaseBlock } from '../self/format.ts'
import { compressHistory, shouldCompress } from './compress.ts'
import { buildPrompt, buildSystem } from './prompt.ts'
import { getSession, getTurns, historyMessages, pushTurn, sessionKey, setSummary } from './session.ts'

export interface GenerateOptions {
  rules: Rules
  llm: LlmOptions
  /**
   * 工具注册表。现在不传（一个工具都没有）。
   * 以后接工具时传进来，这里会自动把它转成模型认识的格式。
   */
  tools?: ToolRegistry
}

/** 把注册表转成模型要的 function-calling 格式 */
function toSpecs(reg: ToolRegistry): ToolSpec[] {
  return reg.list().map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}


/** 去掉模型偶尔自带的引号包裹和 markdown 残留 */
export function sanitize(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/^\s*["'「『]+|["'」』]+\s*$/g, '')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim()
}

/** 最近几轮里，它是不是在重复说同一件事 */
export function detectRepeat(key: string): boolean {
  const last = getTurns(key)
    .filter((t) => t.role === 'assistant')
    .slice(-6)
  for (let i = 0; i < last.length; i++) {
    for (let j = i + 1; j < last.length; j++) {
      if (similarity(last[i]!.content, last[j]!.content) > 0.75) return true
    }
  }
  return false
}


/**
 * 群聊里给"谁说的"加前缀。
 * 不加的话历史里全是「用户」，三条不同人的话它分不清。
 */
export function formatUserText(scope: string, speaker: string | undefined, text: string): string {
  const name = (speaker ?? '').trim()
  return scope.startsWith('group:') && name ? `${name}：${text}` : text
}
/** 单条输入的上限：防止有人粘贴一整篇文章把上下文撑爆 */
const MAX_INPUT_CHARS = 2000

/** 和 emoji/store.ts 的默认根目录保持一致 */
const EMOJI_ROOT = join('persona', 'emoji')

/** 表情包库按 libraryCap 复用，规则热重载改了上限才重建 */
let emojiStore: EmojiStore | null = null
let emojiStoreCap = -1

function getEmojiStore(cap: number): EmojiStore {
  if (!emojiStore || emojiStoreCap !== cap) {
    emojiStore = createEmojiStore(EMOJI_ROOT, { libraryCap: cap })
    emojiStoreCap = cap
  }
  return emojiStore
}

/** score/judge 目前都不带情绪字段，用 persona 的当前心情；没有就当 neutral */
function currentEmotion(): string {
  return decayedMood(loadMood())?.emotion.trim() || 'neutral'
}

/**
 * 历史超过阈值时压一次。失败只记 warn，旧摘要和本轮回复都不受影响。
 * 每轮最多调一次 compressHistory，不会递归触发。
 */
async function compressIfNeeded(key: string, opts: GenerateOptions): Promise<void> {
  const threshold = opts.rules.上下文压缩.摘要阈值
  const keepRecent = opts.rules.上下文压缩.保留最近

  try {
    const session = getSession(key)
    const history: ChatMessage[] = session.turns.map((t) => ({ role: t.role, content: t.content }))
    if (!shouldCompress(history, threshold, keepRecent)) return

    const result = await compressHistory(history, {
      threshold,
      keepRecent,
      prevSummary: session.summary,
      callLLM: async (prompt) => {
        const res = await chat([{ role: 'user', content: prompt }], {
          ...opts.llm,
          temperature: 0.3,
          maxTokens: 400,
        })
        return res.text
      },
    })

    if (!result.compressed) {
      info('历史压缩未成功，保持旧摘要', { 会话: key })
      return
    }

    // oldest 就是这次被压掉的那截；recent 原样留作新的历史
    const oldestCount = Math.max(0, history.length - result.recent.length)
    const keep = Math.min(result.recent.length, session.turns.length)
    session.turns = session.turns.slice(session.turns.length - keep)
    setSummary(session, result.summary, oldestCount)
    info('历史已压缩', { 会话: key, 压掉: oldestCount, 保留: keep })
  } catch (err) {
    warnAt('历史压缩失败，本轮照常回复', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 回复后按当前情绪挑一张表情包发出去；失败不影响文字回复 */
async function maybeSendEmoji(m: Incoming, rules: Rules): Promise<void> {
  const limit = Math.max(0, Math.floor(rules.表情包.每条最多))
  if (!rules.表情包.开启 || limit === 0) return

  try {
    // 没有索引说明库还不存在。先判断再建 store，避免顺手写一个空索引到 persona/。
    if (!existsSync(join(EMOJI_ROOT, 'index.json'))) return

    const store = getEmojiStore(rules.表情包.库存上限)
    const item = pickEmoji(await store.list(), currentEmotion())
    if (!item) return

    await sendImage(m.from, join(EMOJI_ROOT, item.file))
    await store.touch(item.id)
    info('发了表情包', { file: item.file })
  } catch (err) {
    warnAt('表情包发送失败，不影响文字回复', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 一次完整回合：system(人格+关系+画像+记忆) + 历史 + 本轮 → 模型 → 记入会话 */
export async function generateReply(m: Incoming, opts: GenerateOptions): Promise<string> {
  const key = sessionKey(m.from)
  // 先把会话从磁盘读进来：历史原文和滚动摘要都挂在同一个对象上
  const session = getSession(key)
  const scope = scopeOf(m.from)
  const personId = personOfMessage(m)
  const text = m.text.length > MAX_INPUT_CHARS ? `${m.text.slice(0, MAX_INPUT_CHARS)}…（后面太长了，没看完）` : m.text

  // 组装前记下这次注入了哪些"待提的问题"，回复完就标记已提，
  // 免得同一件事每轮都挂在 prompt 里。
  const pendingIssueKeys = unmentionedIssues().map((i) => i.key)

  const recalled = recall({
    personId,
    scope,
    query: text,
    limit: opts.rules.记忆.检索.取回条数[0] ?? 6,
    weights: opts.rules.记忆.检索.权重,
    minScore: opts.rules.记忆.检索.最低分,
    decay: opts.rules.记忆.衰减,
  })

  const groupBlock = scope.startsWith('group:')
    ? [renderGroupContext(scope.slice('group:'.length)), renderJargon(explainJargon(text, scope.slice('group:'.length)))]
        .filter((s) => s.trim())
        .join('\n\n')
    : ''

  const system = buildSystem({
    rules: opts.rules,
    self: buildSelfBlock(opts.rules, new Date(), personId, m.from.name),
    personName: m.senderName ?? m.from.name,
    profile: loadProfile(personId),
    relation: [buildRelationBlock(opts.rules, loadRelation(personId), loadMood()), groupBlock]
      .filter((s) => s.trim())
      .join('\n\n'),
    memory: [renderRecalled(recalled), renderPlays(relevantPlays(text))].filter((s) => s.trim()).join('\n\n'),
    userChars: m.text.length,
    phase: buildPhaseBlock(opts.rules),
    repeatHint: detectRepeat(key),
  })

  // 群聊里必须标明"谁说的"：不标的话历史里全是"用户"，它就分不清三个人
  let userContent = formatUserText(scope, m.senderName ?? m.from.name, text)

  // 有图且有视觉模型：先"看"成文字，再混进这一轮的内容。
  // 主模型是纯文本的也照样能用——它读到的是描述，不是图。
  if (m.images?.length && opts.rules.视觉?.开启) {
    const visionModel = opts.rules.视觉.模型 || process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp'
    const notes = await describeImages(m.images.slice(0, opts.rules.视觉.最多张数), {
      ...opts.llm,
      model: visionModel,
    })
    if (notes.length) {
      userContent += `\n${renderImages(notes)}`
      info(`看了 ${notes.length} 张图`)
    }
  }

  // 摘要非空时，它会在历史原文前多一条【前情摘要】；为空时与以前完全一样
  const messages = buildPrompt(system, historyMessages(key), userContent, session.summary)

  const specs = opts.tools ? toSpecs(opts.tools) : []
  const res = await chat(messages, specs.length ? { ...opts.llm, tools: specs } : opts.llm)

  // 工具循环的接口点：
  // 以后模型要求调工具时，在这里执行、把结果作为 role='tool' 的消息塞回 messages、
  // 再调一次 chat()，直到它给出正文。现在没有工具，这个分支永远进不来。
  if (res.toolCalls?.length) {
    warnAt('模型要求调工具，但工具循环还没实现', { 工具: res.toolCalls.map((c) => c.name).join(',') })
  }

  pushTurn(key, { role: 'user', content: userContent, at: m.at })
  pushTurn(key, { role: 'assistant', content: res.text, at: Date.now() })

  // 历史压成滚动摘要，避免 session 无限增长；失败不挡这一轮
  await compressIfNeeded(key, opts)
  // 文字回复已经生成，按情绪补一张表情包；失败只 warn
  await maybeSendEmoji(m, opts.rules)

  if (res.usage) info('token 用量', res.usage)
  if (recalled.facts.length || recalled.episodes.length) {
    info('注入记忆', {
      对象: personId,
      facts: recalled.facts.length,
      episodes: recalled.episodes.length,
      open: recalled.open.length,
    })
  }

  const out = sanitize(res.text)
  // 这轮把"待提的问题"注入过 prompt 了，标记一下，别让它每轮都挂在那儿
  if (pendingIssueKeys.length) markMentioned(pendingIssueKeys)
  return out
}
