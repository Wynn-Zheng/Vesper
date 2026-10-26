import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { Incoming } from '../core/types.ts'
import { chat } from '../llm/deepseek.ts'
import { describeImages, renderImages } from '../llm/vision.ts'
import type { LlmOptions, ToolSpec } from '../llm/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { recall, renderRecalled, similarity } from '../memory/recall.ts'
import { markMentioned, unmentionedIssues } from '../self/observe.ts'
import { personOfMessage, scopeOf } from '../memory/scope.ts'
import { loadMood } from '../persona/mood.ts'
import { loadProfile } from '../persona/profile.ts'
import { renderGroupContext } from '../people/group.ts'
import { explainJargon, renderJargon } from '../learn/jargon.ts'
import { relevantPlays, renderPlays } from '../learn/plays.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildSelfBlock, buildPhaseBlock } from '../self/format.ts'
import { buildSystem } from './prompt.ts'
import { getTurns, historyMessages, pushTurn, sessionKey } from './session.ts'

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

/** 一次完整回合：system(人格+关系+画像+记忆) + 历史 + 本轮 → 模型 → 记入会话 */
export async function generateReply(m: Incoming, opts: GenerateOptions): Promise<string> {
  const key = sessionKey(m.from)
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

  const messages = [
    { role: 'system' as const, content: system },
    ...historyMessages(key),
    { role: 'user' as const, content: userContent },
  ]

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
