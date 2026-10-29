import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Rules, StageRule } from '../core/config.ts'
import { stageOf } from '../core/config.ts'

import { writeAtomic } from '../store/fs.ts'
import * as cardModule from '../persona/card.ts'
import { EMPTY_RELATION, type Anchor, type DimensionEvent, type RelationState } from './types.ts'

let ROOT = 'persona/people'
/** 测试里用 setRelationRoot 覆盖过目录时，不能再去拼角色卡路径 */
let rootOverridden = false

/** 锚点 / 维度事件的保留上限，防止文件无限长 */
export const MAX_ANCHORS = 200
export const MAX_DIMENSION_EVENTS = 50

/** 关系值的合法范围。配置文件改了范围也以 rules 为准，这里只兜底坏数据。 */
const CLOSENESS_MIN = 0
const CLOSENESS_MAX = 100

/** 测试用 */
export function setRelationRoot(p: string): void {
  ROOT = p
  rootOverridden = true
}

function finiteNumber(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clampCloseness(v: unknown): number {
  return Math.min(CLOSENESS_MAX, Math.max(CLOSENESS_MIN, finiteNumber(v, CLOSENESS_MIN)))
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function relationFile(personId: string): string {
  // 同一个好友，不同角色卡眼里的关系深浅不一样 —— 按卡再分一层
  if (rootOverridden) return join(ROOT, personId, 'relation.yaml')
  // 同一个好友，不同角色卡眼里的关系深浅不一样 —— 按卡再分一层
  return cardScopedRelation(personId, 'relation.yaml', join(ROOT, personId, 'relation.yaml'))
}

/** relation 的按卡路径（没有卡时回退老路径） */
function cardScopedRelation(personId: string, name: string, fallback: string): string {
  try {
    const { personScopedPath } = cardModule
    return personScopedPath(personId, name, fallback)
  } catch {
    return fallback
  }
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
    const dims = (raw['维度事件'] ?? {}) as Record<string, unknown>
    return {
      // 手工改过的文件可能写着 150 / abc / .inf，先夹回合法范围再交给上层
      closeness: clampCloseness(raw['总关系值'] ?? 0),
      anchors: asArray<Anchor>(raw['锚点'])
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
          ...a,
          amount: Math.abs(finiteNumber(a.amount, 0)),
        }))
        .slice(-MAX_ANCHORS),
      dimensions: {
        信任: asArray<DimensionEvent>(dims['信任']).slice(-MAX_DIMENSION_EVENTS),
        亲密: asArray<DimensionEvent>(dims['亲密']).slice(-MAX_DIMENSION_EVENTS),
        好奇: asArray<DimensionEvent>(dims['好奇']).slice(-MAX_DIMENSION_EVENTS),
        依赖: asArray<DimensionEvent>(dims['依赖']).slice(-MAX_DIMENSION_EVENTS),
      },
    }
  } catch {
    return structuredClone(EMPTY_RELATION)
  }
}

export function saveRelation(personId: string, s: RelationState): void {
  const doc = {
    总关系值: Math.round(clampCloseness(s.closeness) * 10) / 10,
    锚点: s.anchors.slice(-MAX_ANCHORS),
    维度事件: {
      信任: s.dimensions.信任.slice(-MAX_DIMENSION_EVENTS),
      亲密: s.dimensions.亲密.slice(-MAX_DIMENSION_EVENTS),
      好奇: s.dimensions.好奇.slice(-MAX_DIMENSION_EVENTS),
      依赖: s.dimensions.依赖.slice(-MAX_DIMENSION_EVENTS),
    },
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
  const unchanged: ApplyResult = { state: s, stage: stageOf(rules, s.closeness), delta: 0 }
  const reason = typeof anchor.reason === 'string' ? anchor.reason.trim() : ''
  if (rules.关系.必须挂锚点 && !reason) return unchanged

  // 幅度是外部输入（模型 JSON / 配置），NaN、Infinity、0 都不能往下算：
  // 否则 closeness 会变成 NaN，之后所有比较和阶段判断都会失效。
  const amount = Math.abs(Number(anchor.amount))
  if (!Number.isFinite(amount) || amount === 0) return unchanged

  const max = Math.abs(finiteNumber(rules.关系.单次最大变化, 0))
  const signed = anchor.direction === 'up' ? 1 : -1
  const rawDelta = signed * Math.min(max, amount)

  const [rangeMin, rangeMax] = rules.关系.总值
  const lo = Math.min(finiteNumber(rangeMin, CLOSENESS_MIN), finiteNumber(rangeMax, CLOSENESS_MAX))
  const hi = Math.max(finiteNumber(rangeMin, CLOSENESS_MIN), finiteNumber(rangeMax, CLOSENESS_MAX))
  const base = Math.min(hi, Math.max(lo, finiteNumber(s.closeness, lo)))
  const next = Math.min(hi, Math.max(lo, base + rawDelta))

  // 已经到边界：这次不产生任何变化，也就不该留下一条假的锚点
  if (next === base) return unchanged

  const date =
    anchor.date ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const full: Anchor = {
    date,
    event: anchor.event,
    dimension: anchor.dimension,
    direction: anchor.direction,
    // 记实际变化量，不是请求量：99 分时 +2 实际只加了 1
    amount: Math.abs(next - base),
    reason,
  }

  const nextState: RelationState = {
    ...s,
    closeness: next,
    anchors: [...s.anchors, full].slice(-MAX_ANCHORS),
    dimensions: {
      ...s.dimensions,
      [anchor.dimension]: [
        ...(s.dimensions[anchor.dimension] ?? []),
        { date, event: anchor.event, direction: anchor.direction },
      ].slice(-MAX_DIMENSION_EVENTS),
    },
  }

  return { state: nextState, stage: stageOf(rules, next), delta: next - base }
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
