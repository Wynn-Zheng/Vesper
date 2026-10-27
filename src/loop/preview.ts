import type { Rules } from '../core/config.ts'
import type { Target } from '../core/types.ts'
import type { LlmOptions } from '../llm/types.ts'
import { chat } from '../llm/deepseek.ts'
import { recall, renderRecalled } from '../memory/recall.ts'
import { personOfAccount, loadPerson } from '../people/store.ts'
import { loadMood } from '../persona/mood.ts'
import { loadProfile } from '../persona/profile.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { buildSelfBlock, buildPhaseBlock } from '../self/format.ts'
import { buildSystem } from './prompt.ts'

export interface PreviewOptions {
  rules: Rules
  llm: LlmOptions
  /** 用谁的身份说话 */
  accountId: string
  /**
   * 之前聊过的轮次（只用于试聊）。
   *
   * 不加这个的话，每句话都是独立单轮 —— 问完"你能看屏幕吗"，再说
   * "那你刷个视频"，它根本不记得上一句，回答会显得割裂。
   */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
}

export interface PreviewResult {
  reply: string
  system: string
  stats: {
    facts: number
    episodes: number
    insights: number
    open: number
    systemChars: number
  }
  usage?: { prompt: number; completion: number; total: number }
  elapsedMs: number
}

/**
 * 控制台的"试聊"：走和线上一样的组装逻辑，但不写 session、不落盘、不评估关系。
 * 用来调 prompt 时看"它到底看到了什么"。
 */
export async function previewReply(text: string, opts: PreviewOptions): Promise<PreviewResult> {
  const started = Date.now()
  const personId = personOfAccount('qq', opts.accountId)
  const scope = `private:${opts.accountId}` as const

  const recalled = recall({
    personId,
    scope,
    query: text,
    limit: opts.rules.记忆.检索.取回条数[0] ?? 6,
    weights: opts.rules.记忆.检索.权重,
    minScore: opts.rules.记忆.检索.最低分,
  })

  const system = buildSystem({
    rules: opts.rules,
    self: buildSelfBlock(opts.rules, new Date(), personId, loadPerson(personId)?.name ?? opts.accountId),
    personName: loadPerson(personId)?.name ?? opts.accountId,
    profile: loadProfile(personId),
    relation: buildRelationBlock(opts.rules, loadRelation(personId), loadMood()),
    memory: renderRecalled(recalled),
    userChars: text.length,
    phase: buildPhaseBlock(opts.rules),
  })

  const res = await chat(
    [
      { role: 'system', content: system },
      // 历史必须排在当前这句前面，而且只取最近几轮 ——
      // 试聊场景不用太长，太多反而把当前问题淹了。
      ...(opts.history ?? []).slice(-12).map((h) => ({
        role: h.role,
        content: h.text,
      })),
      { role: 'user', content: text },
    ],
    opts.llm,
  )

  return {
    reply: res.text,
    system,
    stats: {
      facts: recalled.facts.length,
      episodes: recalled.episodes.length,
      insights: recalled.insights.length,
      open: recalled.open.length,
      systemChars: system.length,
    },
    usage: res.usage,
    elapsedMs: Date.now() - started,
  }
}

/** 保留旧签名兼容：传 Target 的场景 */
export function previewForTarget(text: string, opts: PreviewOptions & { from: Target }): Promise<PreviewResult> {
  return previewReply(text, { ...opts, accountId: opts.from.id })
}
