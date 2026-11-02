import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import type { Incoming, Target } from '../core/types.ts'
import { sendImage, splitBySentence } from '../channel/send.ts'
import { matchKeywordReactions, renderKeywordReactions } from './keyword.ts'
import { pickEmoji } from '../emoji/pick.ts'
import { createEmojiStore, type EmojiStore } from '../emoji/store.ts'
import { chat } from '../llm/deepseek.ts'
import { describeImagesDetailed, renderImages } from '../llm/vision.ts'
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
import { pickExpressions, renderExpressions } from '../learn/expression.ts'
import { relevantPlays, renderPlays } from '../learn/plays.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildSelfBlock, buildPhaseBlock } from '../self/format.ts'
import { loadCodeMapBrief } from '../self/codemap.ts'
import { compressHistory, shouldCompress } from './compress.ts'
import { buildPrompt, buildSystem, renderHeard } from './prompt.ts'
import { loadCard, cardPromptBlock } from '../persona/card.ts'
import { getHeard, getSession, getTurns, historyMessages, pushTurn, sessionKey, setSummary } from './session.ts'

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

/**
 * 本机类工具：只允许「主人 + 私聊」。
 *
 * 之前用正则按前缀匹配（`screenshot|clipboard_|send_image|desktop_|mouse_|keyboard_|window_|open_`），
 * 但桌面工具的真实名字是 `click`/`type_text`/`press_key`/`scroll`/`focus_window`/
 * `list_windows`/`monitor_info` —— **7 个全不匹配**，等于群里任何人说一句
 * 「列一下窗口」就能拿到主人的窗口标题（里面常有网页标题、文件名）。
 *
 * 现在改成显式集合：新增本机工具必须往这里加一条，测试会断言
 * "注册表里每个 desktop 工具都在这个集合里"，避免再靠命名习惯漏掉。
 */
const LOCAL_TOOL = new Set([
  'screenshot', 'list_windows', 'monitor_info', 'mouse_position', 'clipboard_read',
  'click', 'type_text', 'press_key', 'scroll', 'focus_window',
  'send_image',
])

/** 这个工具是不是"碰本机"的（截图/窗口/剪贴板/鼠标键盘/本地图片） */
export function isLocalTool(name: string): boolean {
  return LOCAL_TOOL.has(name)
}


/**
 * 群聊里给这轮文本加上"谁说的"。
 *
 * 单条消息时加一次前缀；合批且批里有多个人时，boot 已经把每行写成
 * 「名字：内容」了（并发 `speakerInText`），这里就不要再冠一次最后那个人的名字 ——
 * 否则 A 的话会被算成 B 说的。
 */
export function formatUserText(scope: string, speaker: string | undefined, text: string): string {
  const name = (speaker ?? '').trim()
  return scope.startsWith('group:') && name ? `${name}：${text}` : text
}
/** 单条输入的上限：防止有人粘贴一整篇文章把上下文撑爆 */
const MAX_INPUT_CHARS = 2000

/**
 * 把一批「谁说了什么」渲染成 prompt 里的多行文本，带预算。
 *
 * 逐条截断（和单条消息一样 2000 字），整体再封顶 ——
 * 群里刷屏时，一轮 prompt 被撑到几万字既烧钱又直接超上下文。
 *
 * 两条规则，都是踩出来的：
 *   1. **第一条必须保住**。一批里最前面那条往往就是"@ 它 你看这个"，
 *      也就是这一轮的由头。只按"从新往旧装"的话，刷屏时它会被挤掉，
 *      模型看到一堆别人的长文，却不知道有人在叫它。
 *   2. 丢了几条要**说出来**。不标注的话，模型以为它看到了整批。
 */
export function renderBatch(
  lines: Array<{ name: string; text: string }>,
  maxChars = MAX_INPUT_CHARS * 4,
): string {
  if (!lines.length) return ''
  const cap = (t: string): string =>
    t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) + '…（这条太长了，没看完）' : t
  const render = (i: number): string => `${lines[i]!.name}：${cap(lines[i]!.text)}`

  let budget = maxChars

  // 先给第一条留位置（最多占一半预算，防止它自己就把预算吃光）
  const firstLine = render(0)
  const firstKept = firstLine.length <= Math.floor(maxChars / 2)
  if (firstKept) budget -= firstLine.length

  const tail: string[] = []
  let dropped = 0
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = render(i)
    if (line.length > budget) {
      dropped = i // 剩下的 1..i 都没装进来
      break
    }
    budget -= line.length
    tail.unshift(line)
  }

  const head = firstKept ? [firstLine] : []
  const omitted = dropped > 0 ? dropped - (firstKept ? 0 : 1) : 0
  const note = omitted > 0 ? [`（前面还有 ${omitted} 条没贴出来，太长了）`] : []
  return [...head, ...note, ...tail].filter(Boolean).join('\n')
}

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

/** 当前心情强度 0-1。没有心情就是 0（不该因为"没心情"就多发表情包） */
function moodStrength(): number {
  const m = decayedMood(loadMood())
  const v = Number(m?.intensity)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
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

    // oldest 就是这次被压掉的那截；recent 原样留作新的历史。
    //
    // ⚠ 必须按"压掉了多少条"从头切，不能按"当前长度倒推 keep 条"：
    // 压缩要一次模型调用（几秒），这期间很可能又来了新消息、已经 push 进 turns。
    // 用 `slice(当前长度 - keep)` 的话，窗口会被新消息挤着往前挪，
    // 于是「没进摘要、也还没轮到保留」的那几条被静默丢掉 ——
    // 既不在摘要里，也不在原文里。
    const oldestCount = Math.max(0, history.length - result.recent.length)
    const drop = Math.min(oldestCount, session.turns.length)
    session.turns = session.turns.slice(drop)
    setSummary(session, result.summary, oldestCount)
    info('历史已压缩', { 会话: key, 压掉: drop, 保留: session.turns.length })
  } catch (err) {
    warnAt('历史压缩失败，本轮照常回复', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 回复后按当前情绪挑一张表情包发出去；失败不影响文字回复。
 *
 * ⚠ 不是每句都发。原来是无条件补一张，那个行为有两个问题：
 *   1. 太机械——真人不会每条文字后面都跟一张图
 *   2. 和图库内容无关——不管聊什么都是同一张
 *
 * 现在按概率决定，心情强时概率更高（心情本身就是"想表达"的信号）。
 * 概率 0 就等于完全关掉（不用改 `开启`）。
 */
/**
 * 给任意会话发一个表情包。
 *
 * 抽出来是因为**主动消息也要能发**：原来只收 `Incoming`，主动消息没有入站对象，
 * 于是主动那边永远只发纯文字（D9 那条"主动配表情包"其实是 0）。
 */
export async function maybeSendEmojiTo(to: Target, rules: Rules): Promise<void> {
  const limit = Math.max(0, Math.floor(rules.表情包.每条最多))
  if (!rules.表情包.开启 || limit === 0) return

  // 概率门：心情越强越容易发
  const mood = currentEmotion()
  const base = Math.min(1, Math.max(0, Number(rules.表情包.概率) || 0))
  const boost = Math.min(1, Math.max(0, Number(rules.表情包.心情加成) || 0))
  const moodIntensity = moodStrength()
  const chance = Math.min(1, base + boost * moodIntensity)
  if (chance <= 0) return
  if (Math.random() >= chance) return

  try {
    // 没有索引说明库还不存在。先判断再建 store，避免顺手写一个空索引到 persona/。
    if (!existsSync(join(EMOJI_ROOT, 'index.json'))) return

    const store = getEmojiStore(rules.表情包.库存上限)
    const item = pickEmoji(await store.list(), mood)
    if (!item) return

    await sendImage(to, join(EMOJI_ROOT, item.file))
    await store.touch(item.id)
    info('发了表情包', { file: item.file, 心情: mood, 概率: chance.toFixed(2) })
  } catch (err) {
    warnAt('表情包发送失败，不影响文字回复', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 被动回复用：从入站消息里取会话 */
export async function maybeSendEmoji(m: Incoming, rules: Rules): Promise<void> {
  return maybeSendEmojiTo(m.from, rules)
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

  // 距上一次说话多少小时（用会话里最后一条的时间）。
  //
  // ⚠️ 必须**拷贝**：`getTurns` 返回的是 `session.turns` 的同一个数组引用，
  // 后面 pushTurn(本轮回复) 会改它。用引用的话，下面的防复读硬拦截会拿
  // "本轮回复"和它自己比（相似度 1 > 0.85）→ 把每一条 ≥15 字的回复都拦掉。
  const prevTurns = [...getTurns(key)]
  // 优先用入站消息带的 prevAt（收消息时落盘的快照）：
  // session.turns 会被 pruneSessions(2h) 清掉，而"隔了 2 小时以上"恰好是
  // 要显示"距离上次说话 X 小时"的场景 —— 用 session 算正好在那时失效。
  const prevAt = m.prevAt || (prevTurns.length ? prevTurns[prevTurns.length - 1]?.at : undefined)
  const gapHours = prevAt ? (m.at - prevAt) / 3_600_000 : null

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

  const inGroup = scope.startsWith('group:')
  // 群里刚才在聊什么。只有群聊有：私聊不存在"旁听"。
  // 不注入这段的话，用户 @ 它问"刚才聊啥呢"，它只看得到自己被叫的那几句。
  const heardBlock = inGroup ? renderHeard(getHeard(key)) : ''

  const groupBlock = inGroup
    ? [
        renderGroupContext(scope.slice('group:'.length)),
        renderJargon(explainJargon(text, scope.slice('group:'.length))),
        heardBlock,
      ]
        .filter((s) => s.trim())
        .join('\n\n')
    : ''

  const system = buildSystem({
    // 关键词反应：命中关键词就给模型一句"该怎么反应"的提示
    keyword: renderKeywordReactions(matchKeywordReactions(opts.rules, text)),
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
        // 它自己给这人起的称呼（没有就回落到 rules.yaml 的 关系.昵称）
        callName: loadPerson(personId)?.callName,
      }),
      // 隔了多久没说话：以前只有主动消息算这个，正常对话里它不知道
      // "你们上次说话是 6 天前"，于是只会像刚才那样接话。
      // 阈值 2 小时：刚聊完的间隔没必要说，说了反而奇怪。
      gapHours !== null && gapHours >= 2
        ? `距离上次说话：${Math.round(gapHours)} 小时（${gapHours >= 48 ? '隔了挺久' : '不算久'}）`
        : '',
      groupBlock,
    ]
      .filter((s) => s.trim())
      .join('\n\n'),
    // 核心记忆：只能人改的那部分，优先级最高
    // 这一轮在不在控制台（scope 是 private:console-xxx）
    consoleMode: scope.startsWith('private:console-'),
    core: renderCoreForPrompt(),
    // 它提了、还在等批的申请（不告诉它，下次会以为自己已经改了）
    requests: renderPendingForPrompt(),
    // 说话习惯（长度/问句比例/口头禅），从它自己说过的话里统计
    speech: renderSpeechHabit(),
    // 这个群里学到的说法（"属实""抽象"这种）：只往群聊里放，
    // 私聊里带一堆某个群的黑话会很怪。
    expression: scope.startsWith('group:')
      ? renderExpressions(pickExpressions(text, 3, opts.rules.表达学习?.只用精选 ?? false))
      : '',
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
    // 群聊：prompt 里要说明"你可以选择这次不说话"、以及不要 @ 人
    groupChat: inGroup,
  })

  // 群聊里必须标明"谁说的"：不标的话历史里全是"用户"，它就分不清三个人。
  // 一批里有多条消息时 boot 已经拆好逐条发言，这里按行渲染；
  // 单条消息仍走 formatUserText（加一次名字前缀）。
  //
  // ⚠ 逐条渲染要自己套预算：上面那段按"单条"截断（MAX_INPUT_CHARS）只作用于
  // m.text 整体，合批时每条原文并没有被单独截。群里连发长文/刷屏能把一轮
  // prompt 撑到几万字（成本 + 直接超上下文）。这里逐条截断 + 总预算。
  let userContent = m.batchLines?.length
    ? renderBatch(m.batchLines)
    : formatUserText(scope, m.senderName ?? m.senderNick ?? m.from.id, text)

  // 有图且有视觉模型：先"看"成文字，再混进这一轮的内容。
  // 主模型是纯文本的也照样能用——它读到的是描述，不是图。
  //
  // 几张图并发看，整批有总预算；没看成的（下载失败/超时）也要写进内容，
  // 否则模型只看到 [图片]，会以为图好好的，答得跟真看见了一样。
  if (m.images?.length && opts.rules.视觉?.开启) {
    const visionModel = opts.rules.视觉.模型 || process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp'
    const batch = await describeImagesDetailed(
      m.images.slice(0, opts.rules.视觉.最多张数),
      {
        ...opts.llm,
        model: visionModel,
      },
      opts.rules.视觉.总预算毫秒,
    )
    if (batch.notes.length || batch.failed.length) {
      userContent += `\n${renderImages(batch.notes, batch.failed)}`
      if (batch.notes.length) info(`看了 ${batch.notes.length} 张图`)
      if (batch.failed.length) info(`${batch.failed.length} 张图没看成，已在 prompt 里说明`)
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
    // 主人判定：档案里的角色，或直接命中 OWNER_QQ。
    // 只认 role 不够稳：老数据的 role 是空的（历史 bug：建档时把「主人」当名字传了），
    // 那种环境下本机类工具对主人也会拒绝。OWNER_QQ 是配置里明写的，按账号认人兜底。
    // 注意：这里只放宽"谁算主人"，私聊限制仍然生效（群里照样不能截屏）。
    const ownerQQ = String(process.env['OWNER_QQ'] ?? '').trim()
    const isOwner =
      loadPerson(personId)?.role === '主人' ||
      (ownerQQ !== '' && String(m.senderId ?? '') === ownerQQ)
    const inPrivate = !scope.startsWith('group:')
    for (const c of res.toolCalls) {
      let content: string
      try {
        const tool = opts.tools?.get(c.name)
        if (!tool) throw new Error('没有这个工具：' + c.name)
        if (LOCAL_TOOL.has(c.name) && !(isOwner && inPrivate)) {
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
  // 和最近几条说过的话太像：这次干脆不说（比复读一次好）。
  //
  // 之前只有 detectRepeat 的"提示"——把"你刚才说过类似的"塞进 prompt，
  // 模不模型听不听是随缘。这里做硬拦截：宁可这轮沉默（boot 会记"无回复内容"），
  // 也不发一句"我昨天就说过这个"。
  // 两个保守条件：回复 ≥15 字（"嗯""好"本来就容易撞）、相似度 >0.85。
  //
  // ⚠️ 顺序很重要：**先判复读、再入历史**。
  // 以前是先 pushTurn 再判，被拦下的回复已经进历史 ——
  // 下一轮它以为自己说过，detectRepeat 也会读到它。
  if (
    out.trim().length >= 15 &&
    prevTurns.some((t) => t.role === 'assistant' && similarity(t.content, out) > 0.85)
  ) {
    info('回复和最近太像，这次不说了', { 片段: out.slice(0, 30) })
    return ''
  }

  // 空回复（模型只吐了空白/代码围栏，或工具循环到上限也没说人话）：
  // **不要**往历史里塞一条空的 assistant。
  // 以前无条件 pushTurn，于是 turns 里留下 `{role:'assistant', content:''}`，
  // 下一轮原样带进 prompt、甚至原样发给模型（有些实现会因此报错）。
  if (!sendable.trim()) {
    info('这一轮没有可发的内容，不写历史')
    return ''
  }

  // 通过拦截才补历史（用户这条在调模型之前已经记过了，这里只补回复）
  pushTurn(key, { role: 'assistant', content: sendable, at: Date.now() }, keepTurns)
  // 压缩放到**发送之后**、不 await：它要一次 1200-token 的模型调用，
  // 卡在 return 前会让这一轮明显变慢（而用户此刻正等着回复）。
  void compressIfNeeded(key, opts).catch(() => undefined)

  // 这轮把"待提的问题"注入过 prompt 了，标记一下，别让它每轮都挂在那儿
  // 只有真说出话（非空回复）才算"提过了"：模型选择沉默/空回复时
  // 之前也会标已提，之后这个问题永远不会再被问起。
  if (pendingIssueKeys.length && out.trim()) markMentioned(pendingIssueKeys)
  return out
}
