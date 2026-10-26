import type { Rules } from '../core/config.ts'
import { stageOf } from '../core/config.ts'
import { decayedMood, type Mood } from '../persona/mood.ts'
import type { RelationState } from './types.ts'

/** 把关系 + 心情渲染成给模型看的一小段。 */
export function buildRelationBlock(rules: Rules, s: RelationState, mood: Mood | null = null, now = Date.now()): string {
  const stage = stageOf(rules, s.closeness)
  const m = decayedMood(mood, now)
  const lines: string[] = []

  lines.push('关于你们的关系：')
  lines.push(`- 现在是「${stage.名}」，你叫他「${stage.称呼}」`)

  const max = rules.关系.总值[1]
  const idx = rules.关系.阶段.findIndex((x) => s.closeness <= x.至)
  const next = idx >= 0 && idx + 1 < rules.关系.阶段.length ? rules.关系.阶段[idx + 1]! : null
  const nextAt = next ? (rules.关系.阶段[idx]?.至 ?? null) : null

  lines.push(
    next && nextAt != null
      ? `- 关系值 ${Math.round(s.closeness)}/${max}，离「${next.名}」还差 ${Math.max(0, Math.ceil(nextAt - s.closeness))}`
      : `- 关系值 ${Math.round(s.closeness)}/${max}`,
  )

  if (m) {
    lines.push(`- 你现在的心情：${m.emotion}（强度 ${m.intensity.toFixed(1)}）`)
    const seq = (m.recent ?? []).slice(-4).map((r) => r.emotion)
    if (seq.length >= 2) lines.push(`- 最近这几轮你的情绪变化：${seq.join(' → ')}`)
  }

  const recent = s.anchors.slice(-3)
  if (recent.length) {
    lines.push('- 最近让你们关系变化的几件事：')
    for (const a of recent) {
      lines.push(`  ${a.date}｜${a.event}（${a.dimension} ${a.direction === 'up' ? '+' : '−'}${a.amount}）`)
    }
  }

  if (s.closeness < 10) {
    lines.push('- 你们还不熟。不要装得很亲近，也不要一次性说太多自己的事。')
  }

  return lines.join('\n')
}
