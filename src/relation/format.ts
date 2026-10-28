import type { Rules, StageRule } from '../core/config.ts'
import { stageOf } from '../core/config.ts'
import { decayedMood, type Mood } from '../persona/mood.ts'
import type { RelationState } from './types.ts'

const DAY = 86_400_000

export interface RelationFormatOptions {
  /**
   * 群聊里不渲染称呼。
   *
   * 原因：称呼是私聊口吻（"哎"、"名字里的一两个字"），
   * 群里对着一群人用这个会串味。关系值和阶段本身照样给。
   */
  inGroup?: boolean
  /** 认识多久了（毫秒时间戳）；有就加一句 */
  since?: number
}

/**
 * 旧版 rules.yaml 里的称呼占位符。
 *
 * 升级时用户的 rules.yaml 是**数据**，不会跟着代码走——里面还留着
 * "昵称"/"专属"这种占位符。直接塞给模型它会字面照做，所以这里映射成说明。
 */
const LEGACY_SALUTATION: Record<string, string> = {
  昵称: '叫名字里的一两个字',
  专属: '用你们之间习惯的叫法',
}

/**
 * 称呼怎么叫。
 *
 * 优先用 rules.yaml 里配的 `关系.昵称`；没配就按阶段给"怎么叫"的说明。
 * **不能**把"昵称""专属"这种占位符直接塞给模型——它会字面照做，真的叫你"昵称"。
 */
export function salutationOf(rules: Rules, stage: StageRule, inGroup: boolean): string {
  if (inGroup) return ''
  const custom = (rules.关系.昵称 ?? '').trim()
  if (custom) return `叫他「${custom}」`
  return LEGACY_SALUTATION[stage.称呼] ?? stage.称呼
}

/** 把关系 + 心情渲染成给模型看的一小段。 */
export function buildRelationBlock(
  rules: Rules,
  s: RelationState,
  mood: Mood | null = null,
  now = Date.now(),
  opts: RelationFormatOptions = {},
): string {
  const stage = stageOf(rules, s.closeness)
  const m = decayedMood(mood, now)
  const lines: string[] = []

  lines.push('关于你们的关系：')
  lines.push(`- 现在是「${stage.名}」`)

  const salutation = salutationOf(rules, stage, opts.inGroup === true)
  if (salutation) lines.push(`- 称呼上：${salutation}`)

  // ⚠️ 这里**故意不写关系值和"离下一档还差几分"**。
  // 实测：模型看到"17/100，离朋友还差 9"会去刷分（说好听的话讨升级），
  // 偶尔还会直接说出来（"我们还差 9 分就到朋友了"）。阶段名本身够用了，
  // 想看具体数值去控制台。

  if (opts.since && Number.isFinite(opts.since) && opts.since > 0) {
    const days = Math.max(0, Math.round((now - opts.since) / DAY))
    if (days >= 1) lines.push(`- 你们认识 ${days} 天了`)
  }

  if (m) {
    lines.push(`- 你现在的心情：${m.emotion}（强度 ${m.intensity.toFixed(1)}）`)

    // 多轮情感上下文：ZifaMem 论文实测比单轮快照 +39% 偏好。
    // 光给情绪名不够——要知道是从多高掉下来的、为什么掉。
    const seq = (m.recent ?? []).slice(-4)
    if (seq.length >= 2) {
      const parts = seq.map((r) => {
        const lvl = r.intensity.toFixed(1)
        return r.reason ? `${r.emotion} ${lvl}（${r.reason}）` : `${r.emotion} ${lvl}`
      })
      lines.push(`- 最近的情绪：${parts.join(' → ')}`)

      // 涨还是跌，说清楚：模型容易把"一直平淡"和"剧烈波动"当成一回事
      const first = seq[0]!
      const last = seq[seq.length - 1]!
      const delta = last.intensity - first.intensity
      if (Math.abs(delta) >= 0.3) {
        lines.push(
          delta > 0
            ? `- 情绪在往上走：从 ${first.intensity.toFixed(1)} 升到 ${last.intensity.toFixed(1)}`
            : `- 情绪在往下掉：从 ${first.intensity.toFixed(1)} 降到 ${last.intensity.toFixed(1)}`,
        )
      }
    }
  }

  const recent = s.anchors.slice(-3)
  if (recent.length) {
    lines.push('- 最近让你们关系变化的几件事：')
    for (const a of recent) {
      lines.push(`  ${a.date}｜${a.event}（${a.dimension} ${a.direction === 'up' ? '+' : '−'}${a.amount}）`)
    }
  }

  // 按"是不是第一阶段"判断，不写死 closeness < 10 或阶段名
  // （用户可以在 rules.yaml 里改阈值/改名，写死就会错位）
  if (rules.关系.阶段[0]?.名 === stage.名) {
    lines.push('- 你们还不熟。不要装得很亲近，也不要一次性说太多自己的事。')
  }

  return lines.join('\n')
}
