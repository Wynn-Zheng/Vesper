import type { Rules } from '../core/config.ts'
import { info } from '../core/log.ts'
import type { RawTurn } from '../memory/types.ts'
import { recentRaw } from '../memory/store.ts'
import { accountIdsOf, listPeople } from '../people/store.ts'
import { applyAnchor, loadRelation, saveRelation, todayStr } from './store.ts'

const DAY = 86_400_000

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
 * 超过 7 天没说话，每多一天扣一点，单次最多扣 3。
 */
export function decayRelation(rules: Rules, personId: string, now = Date.now(), rawIn?: RawTurn[]): DecayResult {
  const state = loadRelation(personId)
  if (state.closeness <= 0) return { changed: false, days: 0, delta: 0 }

  const accounts = accountIds(personId)
  const raw = rawIn ?? recentRaw(30)

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
  if (days < 7) return { changed: false, days, delta: 0 }

  const amount = Math.min(3, Math.floor(days - 6))
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
