import type { Rules } from '../core/config.ts'
import { stageOf } from '../core/config.ts'
import { info } from '../core/log.ts'
import type { RawTurn } from '../memory/types.ts'
import { recentRaw } from '../memory/store.ts'
import { accountIdsOf, listPeople } from '../people/store.ts'
import { applyAnchor, loadRelation, saveRelation, todayStr } from './store.ts'

const DAY = 86_400_000

/**
 * 多久不说话才开始淡（天）。
 *
 * 依据 Roberts & Dunbar (2015, Human Nature)：关系越靠内层越抗衰减，
 * 朋友联系间隔中位数能到 27 天，而外层关系掉得又快又难回来。
 * 所以按阶段给"容忍期"：亲近的人半年不联系还是亲近，泛泛之交一周就淡。
 * 原来一律 7 天起扣，对强关系太苛刻。
 *
 * ⚠️ 还有一个一致性约束：**容忍期必须大于主动消息的间隔**，
 * 否则"按它的节奏联系"也会一路掉——主动频率定的是"多久该说一次"，
 * 衰减定的是"多久不说话算失联"，后者比前者短就是自相矛盾。
 * 所以取 {阶段基础值, 主动间隔 × 1.3} 的较大者。
 */
function graceDaysOf(rules: Rules, stageName: string): number {
  const base = (() => {
    switch (stageName) {
      // 兼容旧配置里的阶段名（升级时 rules.yaml 不会自动改）
      case '离不开':
      case '很亲近':
        return 30
      case '亲密':
        return 21
      case '亲近':
        return 14
      case '朋友':
        return 10
      default:
        return 7
    }
  })()

  const stage = rules.关系.阶段.find((s) => s.名 === stageName)
  const gapHours = Number(stage?.主动间隔小时)
  if (!Number.isFinite(gapHours) || gapHours <= 0) return base
  return Math.max(base, Math.round((gapHours / 24) * 1.3))
}

export interface DecayResult {
  changed: boolean
  days: number
  delta: number
}

/** 这个人的所有平台账号（QQ 号 / wxid），用于在 raw 里找"他" */
function accountIds(personId: string): string[] {
  return accountIdsOf(personId)
}

/**
 * 久不联系的关系会淡。
 *
 * 规则：
 * - 每个阶段有自己的容忍期（见 graceDaysOf），超过才开始扣
 * - 每多 3 天多扣 1 点，单次最多 3 点
 * - 60 分以上的强关系，扣减减半（抗衰减）
 * - **下限 3**：不会归零。归零会让主动消息永远够不到（死锁），
 *   而且"半年没说话就变陌生人"也不符合人对关系的记忆
 */
export function decayRelation(rules: Rules, personId: string, now = Date.now(), rawIn?: RawTurn[]): DecayResult {
  const state = loadRelation(personId)
  if (state.closeness <= 0) return { changed: false, days: 0, delta: 0 }

  const accounts = accountIds(personId)
  // 窗口必须覆盖最长的 grace：陌生阶段 grace = 720h×1.3/24 ≈ 39 天，
  // 用 30 天窗口时 39 天前的消息读不到 → lastTalkAt=0 → 直接 return 0，关系永远不衰减。
  // 取 120 天：比所有阶段的 grace 都长，读 4 个月的文件开销也还好。
  const raw = rawIn ?? recentRaw(120)

  // 他在任何地方说话都算"还联系着"：
  // 有人只加群、不私聊，只看私聊 scope 会让他的关系永远不降温。
  // 用账号列表匹配，QQ 和微信都能对上。
  let lastTalkAt = raw
    .filter((t) => t.role === 'user' && t.senderId && accounts.includes(t.senderId))
    .reduce((max, t) => Math.max(max, t.ts), 0)

  // 老数据可能没记 senderId，退回按私聊 scope 算
  if (!lastTalkAt) {
    lastTalkAt = raw
      .filter((t) => t.role === 'user' && accounts.some((a) => t.scope === `private:${a}`))
      .reduce((max, t) => Math.max(max, t.ts), 0)
  }

  if (!lastTalkAt) return { changed: false, days: 0, delta: 0 }

  const days = (now - lastTalkAt) / DAY
  const stage = stageOf(rules, state.closeness)
  const grace = graceDaysOf(rules, stage.名)
  if (days < grace) return { changed: false, days, delta: 0 }

  const baseAmount = Math.floor((days - grace) / 3) + 1
  // 强关系抗衰减：60 分以上每次只掉一半
  const scaled = state.closeness >= 60 ? Math.max(1, Math.ceil(baseAmount / 2)) : baseAmount
  const amount = Math.min(3, scaled, Math.max(0, Math.ceil(state.closeness - 3)))
  if (amount <= 0) return { changed: false, days, delta: 0 }

  const r = applyAnchor(
    state,
    {
      event: `${Math.floor(days)} 天没说话了`,
      dimension: '亲密',
      direction: 'down',
      amount,
      reason: '久不联系，感觉淡了一点',
      date: todayStr(),
    },
    rules,
  )

  if (r.delta !== 0) {
    saveRelation(personId, r.state)
    info(`关系因久未联系下降 ${r.delta.toFixed(1)}`, {
      对象: personId,
      days: Math.floor(days),
      stage: r.stage.名,
    })
  }
  return { changed: r.delta !== 0, days, delta: r.delta }
}

/** 每小时检查所有认识的人；同一天不会重复扣 */
export function startRelationDecay(rules: () => Rules, intervalMs = 3600_000): () => void {
  const timer = setInterval(() => {
    try {
      const today = todayStr()
      const people = listPeople()
      if (!people.length) return
      // 一次读出来，所有人共用，别每个人读一遍三十个文件
      const raw = recentRaw(30)
      for (const p of people) {
        const state = loadRelation(p.id)
        if (state.anchors.some((a) => a.date === today && a.event.includes('天没说话'))) continue
        decayRelation(rules(), p.id, Date.now(), raw)
      }
    } catch {
      /* ignore */
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
