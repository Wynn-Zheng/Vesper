export type Dimension = '信任' | '亲密' | '好奇' | '依赖'

export interface Anchor {
  date: string
  event: string
  dimension: Dimension
  direction: 'up' | 'down'
  amount: number
  reason: string
}

export interface DimensionEvent {
  date: string
  event: string
  direction: 'up' | 'down'
}

export interface RelationState {
  /** 0-100，唯一驱动行为的数字 */
  closeness: number
  anchors: Anchor[]
  /** 四维只存事件，不存数值 */
  dimensions: Record<Dimension, DimensionEvent[]>
}

export const EMPTY_RELATION: RelationState = {
  closeness: 0,
  anchors: [],
  dimensions: { 信任: [], 亲密: [], 好奇: [], 依赖: [] },
}
