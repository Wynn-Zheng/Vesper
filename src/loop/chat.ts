import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { Incoming } from '../core/types.ts'
import { sendImage, splitBySentence } from '../channel/send.ts'
import { pickEmoji } from '../emoji/pick.ts'
import { createEmojiStore, type EmojiStore } from '../emoji/store.ts'
import { chat } from '../llm/deepseek.ts'
import { describeImages, renderImages } from '../llm/vision.ts'
import type { ChatMessage, LlmOptions, ToolSpec } from '../llm/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { recall, renderRecalled, similarity } from '../memory/recall.ts'
import { renderCoreForPrompt } from '../memory/core.ts'
import { renderPendingForPrompt } from '../self/requests.ts'
import { renderSpeechHabit } from '../self/speech.ts'
import { renderGrowth } from '../self/growth.ts'
import { todoForPrompt } from '../memory/intent.ts'
import { markMentioned, unmentionedIssues } from '../self/observe.ts'
import { personOfMessage, scopeOf } from '../memory/scope.ts'
import { loadPerson } from '../people/store.ts'
import { decayedMood, loadMood } from '../persona/mood.ts'
import { loadProfile } from '../persona/profile.ts'
import { renderGroupContext } from '../people/group.ts'
import { explainJargon, renderJargon } from '../learn/jargon.ts'
import { relevantPlays, renderPlays } from '../learn/plays.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildSelfBlock, buildPhaseBlock } from '../self/format.ts'
import { loadCodeMapBrief } from '../self/codemap.ts'
import { compressHistory, shouldCompress } from './compress.ts'
import { buildPrompt, buildSystem } from './prompt.ts'
import { loadCard, cardPromptBlock } from '../persona/card.ts'
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
          // 摘要目标 1100 字：中文大约 0.6 token/字，再加标点余量。
          // 原来是 400，模型写到一半就被截断，摘要自然短得可怜。
          maxTokens: 1200,
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
export async function maybeSendEmoji(m: Incoming, rules: Rules): Promise<void> {
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
  // 按「单条」截断，不是整批一起截：boot 会把几条连发拼成 m.text，
  // 整批截 2000 字时后面的消息会被砍掉，模型只答前半，而 raw 里还是全文。
  const text = m.text
    .split('\n')
    .map((line) => (line.length > MAX_INPUT_CHARS ? line.slice(0, MAX_INPUT_CHARS) + '…（这条太长了，没看完）' : line))
    .join('\n')

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
  // 最近几轮对话已经在 session history 里了（同 scope 的所有消息都进同一个 session），
  // 再让 recall 把最近 8 条原始消息塞进 system，等于最近对话注入两遍：
  // token 翻倍，而且模型容易去回一条旧消息。这里只保留召回的事实/经历/待办。
  recalled.recent = []
  // 关键词反应：rules.yaml 配的「说到 X 就 Y」，boot 已经算好放在 m.hint 里。
  // 之前 boot 传了但这里没读，等于配了不生效。
  const hintText = (m as { hint?: string }).hint?.trim() || ''
  const hintBlock = hintText ? '【这会儿该有的反应】' + hintText : ''

  const groupBlock = scope.startsWith('group:')
    ? [renderGroupContext(scope.slice('group:'.length)), renderJargon(explainJargon(text, scope.slice('group:'.length)))]
        .filter((s) => s.trim())
        .join('\n\n')
    : ''

  const system = buildSystem({
    rules: opts.rules,
    card: cardPromptBlock(loadCard()),
    actionDesc: loadCard()?.actionDesc === true,
    self: buildSelfBlock(opts.rules, new Date(), personId, m.from.name),
    codeMap: loadCodeMapBrief(),
    // 群里 m.from.name 是群名，不能当人名用
    // 群里 m.from.name 是群名，不能当人名用
    personName: m.senderName ?? m.senderNick ?? m.from.id,
    // 角色（主人/朋友…）用档案里的，别让 prompt 按显示名去猜 ——
    // 群里显示名是群名片，重名/改名会把「关系：主人」挂错人。
    personRole: loadPerson(personId)?.role,
    profile: loadProfile(personId),
    relation: [
      // 群里不渲染私聊口吻的称呼；顺带把"认识几天"告诉它
      buildRelationBlock(opts.rules, loadRelation(personId), loadMood(), Date.now(), {
        inGroup: scope.startsWith('group:'),
        since: loadPerson(personId)?.firstSeen,
      }),
      groupBlock,
      hintBlock,
    ]
      .filter((s) => s.trim())
      .join('\n\n'),
    // 核心记忆：只能人改的那部分，优先级最高
    core: renderCoreForPrompt(),
    // 它提了、还在等批的申请（不告诉它，下次会以为自己已经改了）
    requests: renderPendingForPrompt(),
    // 说话习惯（长度/问句比例/口头禅），从它自己说过的话里统计
    speech: renderSpeechHabit(),
    // 成长的痕迹（以前怎么看自己 vs 现在）
    growth: renderGrowth(),
    // 电脑操作开了没：决定 prompt 里说"能看屏幕"还是"不能"
    desktop: {
      只读: opts.rules.电脑操作?.enabled === true,
      可操作: opts.rules.电脑操作?.enabled === true && opts.rules.电脑操作?.允许操作 === true,
    },
    // 它自己准备做的事（intent.md），和"待问"不是一回事
    intent: todoForPrompt(),
    // 只用精选模式：只注入人工审过的经验
    memory: [
      renderRecalled(recalled),
      renderPlays(relevantPlays(text, 3, opts.rules.表达学习?.只用精选 ?? false)),
    ]
    .filter((s) => s.trim())
    .join('\n\n'),
    userChars: m.text.length,
    phase: buildPhaseBlock(opts.rules),
    repeatHint: detectRepeat(key),
  })

  // 群聊里必须标明"谁说的"：不标的话历史里全是"用户"，它就分不清三个人
  let userContent = formatUserText(scope, m.senderName ?? m.senderNick ?? m.from.id, text)

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
  const llmOpts = specs.length ? { ...opts.llm, tools: specs } : opts.llm

  // 工具循环：
  //   调模型 → 没有 tool_calls 就收工
  //          → 有就执行，把结果按 toolCallId 塞回去，再调一次
  //
  // 三道停止条件（缺一个都会挂住）：
  //   1. 模型自己不要工具了
  //   2. 同一个调用重复 3 次（防死循环）
  //   3. 轮数上限（最后一轮不再执行工具——结果送不回模型，只会白花钱）
  // 先记用户这条：模型超时/401 抛出去时，generateReply 会直接退出，
  // 之前这轮用户消息就完全不进历史 —— 下一轮它不知道自己刚才说过什么。
  const keepTurnsForPush = Math.max(60, opts.rules.上下文压缩.摘要阈值 + 20)
  pushTurn(key, { role: 'user', content: userContent, at: m.at }, keepTurnsForPush)
  let res = await chat(messages, llmOpts)
  const repeatCount = new Map<string, number>()
  const MAX_ROUNDS = 4
  let rounds = 0

  while (res.toolCalls?.length) {
    rounds += 1

    if (rounds > MAX_ROUNDS) {
      // 到上限了：不再执行工具，而是**撤掉工具**再调一次，逼它用已经翻到的信息回答。
      // 直接 break 会得到空回复——模型这一轮只吐了 tool_calls、没有正文。
      warnAt('工具循环到上限，改成让它直接作答', {
        轮数: rounds,
        工具: res.toolCalls.map((c) => c.name).join(','),
      })
      try {
        const forced = await chat(
          [...messages, { role: 'user', content: '（别再查了，就用你刚才翻到的东西回答。）' }],
          opts.llm,
        )
        if (forced.text.trim()) res = forced
      } catch {
        /* 连强制作答都失败，就保留原来的空正文，让它下一轮重来 */
      }
      break
    }

    let doomed = false
    for (const c of res.toolCalls) {
      const fp = `${c.name}:${JSON.stringify(c.args ?? {})}`
      const n = (repeatCount.get(fp) ?? 0) + 1
      repeatCount.set(fp, n)
      if (n >= 3) doomed = true
    }
    if (doomed) {
      warnAt('同一个工具调用重复太多次，停止', { 工具: res.toolCalls.map((c) => c.name).join(',') })
      // 和轮数上限一样：直接 break 会拿到空正文，用户什么都收不到。
      // 这里撤掉工具再调一次，逼它用已经翻到的信息回答。
      try {
        const forced = await chat(
          [...messages, { role: 'user', content: '（别再重复查了，就用你刚才翻到的东西回答。）' }],
          opts.llm,
        )
        if (forced.text.trim()) res = forced
      } catch {
        /* 强制作答也失败：保留空正文，调用方会判空沉默 */
      }
      break
    }

    // 先追加 assistant 那条（带 tool_calls），再追加结果
    messages.push({
      role: 'assistant',
      content: res.text || '',
      toolCalls: res.toolCalls,
    })

    const ctx = { personId, scope, now: new Date() }
    // 本机类工具（截图/剪贴板/发本地图片/鼠标键盘/窗口）只允许「主人 + 私聊」。
    // 之前只在注册时按 rules 判断有没有这类工具，没判断是谁在调用：
    // 群里任何成员说一句「截屏发我」就能把主人的整屏发到群里。
    const LOCAL_TOOL = /^(screenshot|clipboard_|send_image|desktop_|mouse_|keyboard_|window_|open_)/
    const isOwner = loadPerson(personId)?.role === '主人'
    const inPrivate = !scope.startsWith('group:')
    for (const c of res.toolCalls) {
      let content: string
      try {
        const tool = opts.tools?.get(c.name)
        if (!tool) throw new Error('没有这个工具：' + c.name)
        if (LOCAL_TOOL.test(c.name) && !(isOwner && inPrivate)) {
          throw new Error('这个操作只能由主人私聊发起，在群里/别人那里不能做')
        }
        content = await tool.run(c.args ?? {}, ctx)
      } catch (err) {
        // 工具失败要作为结果返回给模型，让它自己换方式或解释清楚，
        // 不是把整轮对话搞崩。
        content = JSON.stringify({ error: String(err).slice(0, 200) })
      }
      // 单条结果截断：工具可能返回整段代码，全塞回去会撑爆上下文
      messages.push({ role: 'tool', content: content.slice(0, 4000), toolCallId: c.id })
    }

    info('用了工具', { 工具: res.toolCalls.map((c) => c.name).join(','), 轮: rounds })
    res = await chat(messages, llmOpts)
  }

  // 历史保留上限跟着压缩阈值走：必须比阈值大，否则摘要永远不触发（见 pushTurn 注释）
  // 超过「每轮最多条数」的尾巴实际不会发出去（splitBySentence 会截掉），
  // 但之前历史/原文/自评都记了完整 res.text —— 它会以为说过用户没看到的话，
  // 下一轮还会引用。这里先算出发得出去的部分，历史只记这部分。
  const sendable = splitBySentence(
    sanitize(res.text),
    Math.max(1, Number(opts.rules.说话.每条最多字数) || 40),
    Math.max(1, Number(opts.rules.说话.每轮最多条数) || 3),
  ).join('\n')
  const keepTurns = Math.max(60, opts.rules.上下文压缩.摘要阈值 + 20)
  pushTurn(key, { role: 'user', content: userContent, at: m.at }, keepTurns)
  pushTurn(key, { role: 'assistant', content: sendable, at: Date.now() }, keepTurns)

  // 历史压成滚动摘要，避免 session 无限增长；失败不挡这一轮
  await compressIfNeeded(key, opts)

  if (res.usage) info('token 用量', res.usage)
  if (recalled.facts.length || recalled.episodes.length) {
    info('注入记忆', {
      对象: personId,
      facts: recalled.facts.length,
      episodes: recalled.episodes.length,
      open: recalled.open.length,
    })
  }

  const out = sendable
  // 这轮把"待提的问题"注入过 prompt 了，标记一下，别让它每轮都挂在那儿
  // 只有真说出话（非空回复）才算"提过了"：模型选择沉默/空回复时
  // 之前也会标已提，之后这个问题永远不会再被问起。
  if (pendingIssueKeys.length && out.trim()) markMentioned(pendingIssueKeys)
  return out
}
