import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Rules, StageRule } from '../core/config.ts'
import { stageOf } from '../core/config.ts'

import { writeAtomic } from '../store/fs.ts'
import { EMPTY_RELATION, type Anchor, type DimensionEvent, type RelationState } from './types.ts'

let ROOT = 'persona/people'

/** 测试用 */
export function setRelationRoot(p: string): void {
  ROOT = p
}

function relationFile(personId: string): string {
  return join(ROOT, personId, 'relation.yaml')
}

export function relationPath(personId: string): string {
  return relationFile(personId)
}

export function loadRelation(personId: string): RelationState {
  const file = relationFile(personId)
  if (!existsSync(file)) return structuredClone(EMPTY_RELATION)
  try {
    const raw = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (!raw) return structuredClone(EMPTY_RELATION)
    const dims = (raw['维度事件'] ?? {}) as Record<string, DimensionEvent[]>
    return {
      closeness: Number(raw['总关系值'] ?? 0),
      anchors: ((raw['锚点'] ?? []) as Anchor[]).map((a) => ({
        ...a,
        amount: Math.abs(Number(a.amount ?? 0)),
      })),
      dimensions: {
        信任: dims['信任'] ?? [],
        亲密: dims['亲密'] ?? [],
        好奇: dims['好奇'] ?? [],
        依赖: dims['依赖'] ?? [],
      },
    }
  } catch {
    return structuredClone(EMPTY_RELATION)
  }
}

export function saveRelation(personId: string, s: RelationState): void {
  const doc = {
    总关系值: Math.round(s.closeness * 10) / 10,
    锚点: s.anchors,
    维度事件: s.dimensions,
  }
  writeAtomic(relationFile(personId), `${YAML.stringify(doc)}\n`)
}

export interface ApplyResult {
  state: RelationState
  stage: StageRule
  delta: number
}

/** 应用一次锚点：closeness 变化 + 记事件。没有理由就不动。 */
export function applyAnchor(
  s: RelationState,
  anchor: Omit<Anchor, 'date'> & { date?: string },
  rules: Rules,
  now = new Date(),
): ApplyResult {
  if (rules.关系.必须挂锚点 && !anchor.reason.trim()) {
    return { state: s, stage: stageOf(rules, s.closeness), delta: 0 }
  }

  const max = rules.关系.单次最大变化
  const signed = anchor.direction === 'up' ? 1 : -1
  const rawDelta = signed * Math.min(max, Math.max(0, Math.abs(anchor.amount)))
  const [min, maxVal] = rules.关系.总值
  const next = Math.min(maxVal, Math.max(min, s.closeness + rawDelta))

  const date =
    anchor.date ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const full: Anchor = {
    date,
    event: anchor.event,
    dimension: anchor.dimension,
    direction: anchor.direction,
    amount: Math.abs(rawDelta),
    reason: anchor.reason,
  }

  const nextState: RelationState = {
    ...s,
    closeness: next,
    anchors: [...s.anchors, full].slice(-200),
    dimensions: {
      ...s.dimensions,
      [anchor.dimension]: [
        ...(s.dimensions[anchor.dimension] ?? []),
        { date, event: anchor.event, direction: anchor.direction },
      ].slice(-50),
    },
  }

  return { state: nextState, stage: stageOf(rules, next), delta: next - s.closeness }
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
