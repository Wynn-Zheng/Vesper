/**
 * 把一轮对话的输入整理成 `buildSystem()` 的参数。
 *
 * 为什么要有这个文件（B-118）：
 *   `loop/chat.ts`（线上回复）和 `loop/preview.ts`（控制台试聊）各自手写一遍
 *   `buildSystem({...})` 的字段清单。以前 preview 那份少了十来个字段
 *   （desktop/core/requests/speech/expression/growth/intent/codeMap/personRole/
 *   consoleMode/keyword/repeatHint），结果是：用户在试聊里问「你能看到我屏幕吗」，
 *   它答"看不到"，而线上其实能截图。试聊调 prompt 的人会被彻底误导。
 *
 *   两份清单靠注释约定"要保持一致"是靠不住的 —— 加一个字段忘了另一边，
 *   谁都不会报错。所以清单只留一份，差异通过参数显式表达。
 *
 * 这里**只做数据组装**，不渲染、不拼字符串：真正的拼接仍在 `prompt.ts` 的
 * `buildSystem()`，这样两边的最终文本仍然出自同一个函数。
 */
import type { Rules } from '../core/config.ts'
import { matchKeywordReactions, renderKeywordReactions } from './keyword.ts'
import type { PromptParts } from './prompt.ts'
import { renderRecalled } from '../memory/recall.ts'
import type { Recalled } from '../memory/types.ts'
import { renderCoreForPrompt } from '../memory/core.ts'
import { renderPendingForPrompt } from '../self/requests.ts'
import { renderSpeechHabit } from '../self/speech.ts'
import { renderGrowth } from '../self/growth.ts'
import { todoForPrompt } from '../memory/intent.ts'
import { loadPerson } from '../people/store.ts'
import { loadMood } from '../persona/mood.ts'
import { loadProfile } from '../persona/profile.ts'
import { relevantPlays, renderPlays } from '../learn/plays.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildPhaseBlock, buildSelfBlock } from '../self/format.ts'
import { loadCodeMapBrief } from '../self/codemap.ts'
import { cardPromptBlock, loadCard } from '../persona/card.ts'

export interface SystemInputContext {
  rules: Rules
  /** 会话作用域：决定是不是控制台模式 */
  scope: string
  /** 这一轮的原文（关键词反应、表达挑选、记忆检索都用它） */
  text: string
  /** 对谁说的 */
  personId: string
  /** 「现在跟你说话的是谁」——即 prompt 里的 personName */
  personName: string
  /** self 段里「你和谁」的称呼。群里传群名，私聊传对方名字 */
  selfPersonName: string
  /** 群聊为 true。影响关系段的写法（私聊口吻的称呼不该出现在群里） */
  inGroup: boolean
  /** 群聊上下文（群名/黑话/刚才在聊什么）。私聊传空串 */
  groupBlock: string
  /** 距离上次说话多少小时；null 表示不显示这一行 */
  gapHours: number | null
  /** 已经选好的表达（黑话）。私聊/试聊传空串 */
  expressionText: string
  /** 这轮召回到的记忆 */
  recalled: Recalled
  /**
   * 是否显式告诉 prompt「这是群聊」。只有 chat 传；
   * 试聊不走群聊语义，保持 undefined（不出现这个字段），避免把群规则带进私聊试聊。
   */
  groupChat?: boolean
  /** 是否在重复说同一件事。只有 chat 算得出来（要看历史），试聊没有历史 */
  repeatHint?: boolean
  /** 用户原文长度。默认用 text.length */
  userChars?: number
  /** 固定时间，便于测试 */
  now?: Date
}

export function buildSystemInputs(ctx: SystemInputContext): PromptParts {
  const card = loadCard()
  const person = loadPerson(ctx.personId)
  const now = ctx.now ?? new Date()
  const ms = now.getTime()

  const relation = [
    buildRelationBlock(ctx.rules, loadRelation(ctx.personId), loadMood(), ms, {
      inGroup: ctx.inGroup,
      since: person?.firstSeen,
      callName: person?.callName,
    }),
    // 隔了多久没说话：以前只有主动消息算这个，正常对话里它不知道
    // "你们上次说话是 6 天前"，于是只会像刚才那样接话。
    // 阈值 2 小时：刚聊完的间隔没必要说，说了反而奇怪。
    ctx.gapHours !== null && ctx.gapHours >= 2
      ? `距离上次说话：${Math.round(ctx.gapHours)} 小时（${ctx.gapHours >= 48 ? '隔了挺久' : '不算久'}）`
      : '',
    ctx.groupBlock,
  ]
    .filter((s) => s.trim())
    .join('\n\n')

  const memory = [
    renderRecalled(ctx.recalled),
    renderPlays(relevantPlays(ctx.text, 3, ctx.rules.表达学习?.只用精选 ?? false)),
  ]
    .filter((s) => s.trim())
    .join('\n\n')

  return {
    keyword: renderKeywordReactions(matchKeywordReactions(ctx.rules, ctx.text)),
    rules: ctx.rules,
    card: cardPromptBlock(card),
    actionDesc: card?.actionDesc === true,
    self: buildSelfBlock(ctx.rules, now, ctx.personId, ctx.selfPersonName),
    codeMap: loadCodeMapBrief(),
    personName: ctx.personName,
    personRole: person?.role,
    profile: loadProfile(ctx.personId),
    relation,
    consoleMode: ctx.scope.startsWith('private:console-'),
    core: renderCoreForPrompt(),
    requests: renderPendingForPrompt(),
    speech: renderSpeechHabit(),
    expression: ctx.expressionText,
    growth: renderGrowth(),
    desktop: {
      只读: ctx.rules.电脑操作?.enabled === true,
      可操作: ctx.rules.电脑操作?.enabled === true && ctx.rules.电脑操作?.允许操作 === true,
    },
    abilities: {
      bili: ctx.rules.外部?.刷视频?.开启 !== false,
      qzone: ctx.rules.外部?.发空间?.开启 !== false,
    },
    intent: todoForPrompt(),
    memory,
    userChars: ctx.userChars ?? ctx.text.length,
    phase: buildPhaseBlock(ctx.rules, now),
    ...(ctx.groupChat === undefined ? {} : { groupChat: ctx.groupChat }),
    ...(ctx.repeatHint === undefined ? {} : { repeatHint: ctx.repeatHint }),
  }
}
