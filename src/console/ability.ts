/**
 * 能力清单（控制台用）。
 *
 * 和 self/abilities.ts 的分工：
 *   abilities.ts  → 给 **模型** 看的（"我能干什么"），进 prompt
 *   这个文件      → 给 **人** 看的（"这个能力怎么开、参数是什么、用过几次"），进控制台
 *
 * 为什么分开：
 *   abilities.ts 的文案是给模型理解自己用的（"能截图、能看窗口"），
 *   而控制台需要的是**可操作的东西**（开关在哪、参数叫什么、上次用是什么时候）。
 *   混在一起两边都不好用。
 *
 * 分组：交流 / 感知 / 行动 —— 按"它跟外界怎么交互"分，
 * 记忆和内心不在这里（那些属于「自我」）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'

export type AbilityGroup = '交流' | '感知' | '行动'

export interface AbilityParam {
  /** 配置里的键路径，如 '视觉.开启' */
  key: string
  label: string
  kind: 'bool' | 'number' | 'text' | 'list'
  value: unknown
  /** 单位或提示 */
  hint?: string
}

export interface AbilityCard {
  id: string
  name: string
  group: AbilityGroup
  /** SVG 图标的 key（前端映射） */
  icon: string
  /** 一句话说它是什么 */
  desc: string
  /** 现在能用吗 */
  on: boolean
  /** 开关对应哪个配置键（空 = 不能开关，恒开） */
  toggleKey?: string
  /** 参数 */
  params: AbilityParam[]
  /** 最近 7 天用了几次 */
  uses7d: number
  /** 最近一次用是什么时候（0 = 没用过） */
  lastUsed: number
  /** 最近几次的结果（ok/fail） */
  recent: Array<{ at: number; ok: boolean }>
}

/** 从 data/logs 里数"用了工具"的记录 */
function usageStats(): Map<string, { count: number; last: number; recent: Array<{ at: number; ok: boolean }> }> {
  const out = new Map<string, { count: number; last: number; recent: Array<{ at: number; ok: boolean }> }>()
  const cutoff = Date.now() - 7 * 86_400_000
  const dir = join('data', 'logs')
  if (!existsSync(dir)) return out

  let files: string[] = []
  try {
    files = readdirSafe(dir).filter((f) => f.endsWith('.jsonl')).slice(-8)
  } catch {
    return out
  }

  for (const f of files) {
    let raw = ''
    try {
      raw = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('用了工具')) continue
      try {
        const j = JSON.parse(line) as { ts?: number; extra?: { 工具?: string; 轮?: number } }
        const tool = j.extra?.工具
        const ts = j.ts ?? 0
        if (!tool || ts < cutoff) continue
        const cur = out.get(tool) ?? { count: 0, last: 0, recent: [] }
        cur.count++
        cur.last = Math.max(cur.last, ts)
        cur.recent.push({ at: ts, ok: true })
        if (cur.recent.length > 20) cur.recent = cur.recent.slice(-20)
        out.set(tool, cur)
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return out
}

function readdirSafe(p: string): string[] {
  try {
    // 用 readFileSync 的方式不稳，这里直接用 fs 的 readdirSync
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    return readdirSync(p)
  } catch {
    return []
  }
}

/** 读配置里一个键的值（支持 a.b 这种路径） */
function readKey(rules: Rules, key: string): unknown {
  let cur: unknown = rules
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function abilityCards(rules: Rules): AbilityCard[] {
  const usage = usageStats()
  const stat = (tool: string) => {
    const u = usage.get(tool)
    return {
      uses7d: u?.count ?? 0,
      lastUsed: u?.last ?? 0,
      recent: (u?.recent ?? []).slice(-8),
    }
  }

  const cards: AbilityCard[] = []

  /* ---------------- 交流 ---------------- */

  cards.push({
    id: 'chat',
    name: '聊天',
    group: '交流',
    icon: 'chat',
    desc: '跟人一来一回地说话。这是最基本的能力，关不掉。',
    on: true,
    params: [
      { key: '说话.每条最多字数', label: '每条最多字数', kind: 'number', value: readKey(rules, '说话.每条最多字数') },
      { key: '说话.每轮最多条数', label: '每轮最多条数', kind: 'number', value: readKey(rules, '说话.每轮最多条数') },
      { key: '说话.回复前延迟', label: '回复前延迟（毫秒区间）', kind: 'text', value: JSON.stringify(readKey(rules, '说话.回复前延迟')), hint: '格式 [1000,4000]' },
    ],
    ...stat(''),
  })

  const emojiOn = Boolean((readKey(rules, '表情包') as { 开启?: boolean } | undefined)?.开启)
  cards.push({
    id: 'emoji',
    name: '表情包',
    group: '交流',
    icon: 'emoji',
    desc: '回复时配一张表情包。库存是它自己从聊天里收集的。',
    on: emojiOn,
    toggleKey: '表情包.开启',
    params: [
      { key: '表情包.每条最多', label: '每条最多几张', kind: 'number', value: readKey(rules, '表情包.每条最多') },
      { key: '表情包.库存上限', label: '库存上限', kind: 'number', value: readKey(rules, '表情包.库存上限') },
    ],
    ...stat(''),
  })

  cards.push({
    id: 'jargon',
    name: '黑话',
    group: '交流',
    icon: 'jargon',
    desc: '群里的梗和缩写，看多了会自己学。',
    on: true,
    params: [],
    ...stat(''),
  })

  const playsOn = Boolean((readKey(rules, '表达学习') as { 审核?: boolean } | undefined)?.审核)
  cards.push({
    id: 'plays',
    name: '表达学习',
    group: '交流',
    icon: 'book',
    desc: '从"回得好的"那些话里学说法，下次遇到类似的就用。',
    on: playsOn,
    toggleKey: '表达学习.审核',
    params: [
      { key: '表达学习.只用精选', label: '只用人工精选的', kind: 'bool', value: readKey(rules, '表达学习.只用精选') },
    ],
    ...stat(''),
  })

  /* ---------------- 感知 ---------------- */

  const visionOn = Boolean((readKey(rules, '视觉') as { 开启?: boolean } | undefined)?.开启)
  cards.push({
    id: 'vision',
    name: '看图片',
    group: '感知',
    icon: 'image',
    desc: '对方发图时，先让视觉模型"看"成一段文字，再回。',
    on: visionOn,
    toggleKey: '视觉.开启',
    params: [
      { key: '视觉.最多张数', label: '一次最多看几张', kind: 'number', value: readKey(rules, '视觉.最多张数') },
      { key: '视觉.模型', label: '视觉模型', kind: 'text', value: readKey(rules, '视觉.模型'), hint: '留空用默认' },
    ],
    ...stat('vision'),
  })

  cards.push({
    id: 'bili',
    name: '查 B站',
    group: '感知',
    icon: 'tv',
    desc: '调 B 站公开接口：热门榜、视频标题和简介。这是真联网。',
    on: true,
    params: [],
    ...stat(''),
  })

  cards.push({
    id: 'code',
    name: '读自己的代码',
    group: '感知',
    icon: 'code',
    desc: '能读 src/ 下的 .ts，知道自己是怎么写出来的。',
    on: true,
    params: [],
    ...stat('read_code'),
  })

  const deskOn = Boolean((readKey(rules, '电脑操作') as { enabled?: boolean } | undefined)?.enabled)
  cards.push({
    id: 'screen',
    name: '看屏幕',
    group: '感知',
    icon: 'monitor',
    desc: '截屏（带坐标刻度）、看开了哪些窗口、问屏幕多大。',
    on: deskOn,
    toggleKey: '电脑操作.enabled',
    params: [
      { key: '电脑操作.敏感窗口', label: '敏感窗口（标题命中就不截）', kind: 'list', value: readKey(rules, '电脑操作.敏感窗口') },
    ],
    ...stat('screenshot'),
  })

  /* ---------------- 行动 ---------------- */

  const canDo = deskOn && Boolean((readKey(rules, '电脑操作') as { 允许操作?: boolean } | undefined)?.允许操作)
  cards.push({
    id: 'deskctl',
    name: '操作电脑',
    group: '行动',
    icon: 'mouse',
    desc: '点鼠标、打字、按键、滚轮、切窗口。点了会先排队等你批。',
    on: canDo,
    toggleKey: '电脑操作.允许操作',
    params: [],
    ...stat('click'),
  })

  const watchOn = Boolean((readKey(rules, '外部.刷视频') as { 开启?: boolean } | undefined)?.开启)
  cards.push({
    id: 'watch',
    name: '刷视频',
    group: '行动',
    icon: 'play',
    desc: '每天自己翻一两个 B 站视频的标题和简介，写一句自己的想法。',
    on: watchOn,
    toggleKey: '外部.刷视频.开启',
    params: [
      { key: '外部.刷视频.每天最多', label: '每天最多几个', kind: 'number', value: readKey(rules, '外部.刷视频.每天最多') },
      { key: '外部.刷视频.最短间隔小时', label: '最短间隔（小时）', kind: 'number', value: readKey(rules, '外部.刷视频.最短间隔小时') },
    ],
    ...stat('watch'),
  })

  const qzoneOn = Boolean((readKey(rules, '外部.发空间') as { 开启?: boolean } | undefined)?.开启)
  cards.push({
    id: 'qzone',
    name: '发空间',
    group: '行动',
    icon: 'send',
    desc: '写说说草稿。草稿模式——发出去要人点。',
    on: qzoneOn,
    toggleKey: '外部.发空间.开启',
    params: [
      { key: '外部.发空间.需要确认', label: '发之前要人确认', kind: 'bool', value: readKey(rules, '外部.发空间.需要确认') },
    ],
    ...stat('qzone'),
  })

  return cards
}
