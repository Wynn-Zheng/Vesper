/**
 * 关键词反应。
 *
 * 命中关键词或正则后，给模型追加一段**反应提示**（不是让它直接说某句话）。
 *
 * 为什么用提示而不是固定回复：固定回复太机械（"早上好" → 永远同一句），
 * 给一段提示能让模型用自己的话说，同时保证方向对。
 *
 * ⚠ 这个能力在 Rules 里早就定义好了（`关键词反应` 字段 + 默认值 `[]`），
 * 但从来没有任何地方读过它 —— 所以配了也不生效。这里把链路接上。
 *
 * 对照 MaiBot 的 `[[keyword_reaction.keyword_rules]]`。
 */
import type { Rules } from '../core/config.ts'

export interface KeywordReactionHit {
  /** 命中的词或正则 */
  matched: string
  /** 给模型的反应提示 */
  reaction: string
}

/**
 * 检查一条消息命中了哪些关键词反应。纯函数，不读盘。
 *
 * 多条规则可以同时命中（"早上好呀，最近怎么样"可能命中两条），都返回。
 * 正则写错的那条跳过——配置是用户手写的，不能因为一条写错就让整条消息处理失败。
 */
export function matchKeywordReactions(rules: Rules, text: string): KeywordReactionHit[] {
  const list = rules.关键词反应
  if (!Array.isArray(list) || !list.length) return []
  const t = String(text ?? '')
  if (!t.trim()) return []

  const hits: KeywordReactionHit[] = []
  for (const rule of list) {
    const reaction = String(rule?.反应 ?? '').trim()
    if (!reaction) continue

    let hit: string | null = null

    // 关键词：包含就算命中（中文没有词边界）
    for (const w of rule.关键词 ?? []) {
      const kw = String(w ?? '').trim()
      if (kw && t.includes(kw)) {
        hit = kw
        break
      }
    }

    // 正则：JS 语法；写错跳过
    if (!hit) {
      for (const src of rule.正则 ?? []) {
        const s = String(src ?? '').trim()
        if (!s) continue
        try {
          if (new RegExp(s).test(t)) {
            hit = `/${s}/`
            break
          }
        } catch {
          /* 正则写错：跳过这一条 */
        }
      }
    }

    if (hit) hits.push({ matched: hit, reaction })
  }
  return hits
}

/** 把命中的反应渲染成一段给模型的提示；没命中返回空串 */
export function renderKeywordReactions(hits: KeywordReactionHit[]): string {
  if (!hits.length) return ''
  const lines = hits.map((h) => `- 他这句提到了「${h.matched}」，你该这样反应：${h.reaction}`)
  return `## 这条消息里有几处值得注意的\n${lines.join('\n')}`
}
