/**
 * 成长的痕迹：让它知道自己变过。
 *
 * 原料：persona/self-history/drift.jsonl
 *   {"at":..., "from":"旧自述", "to":"新自述", "sim":0.88}
 * 这是 reflect 每次改写「自述」时记的。
 *
 * 为什么有用：
 *   人知道"我以前是那样，现在是这样"。没有这个，它每次都是从零开始，
 *   说不出"我以前觉得……现在不这么想了"这种话。
 *
 * 怎么用：只在真的变过（有 >= 2 条 drift）时才注入，而且只说**最早和现在**，
 * 不列全部——列全部会变成流水账，反而看不出变化。
 */
import { loadDrifts } from './store.ts'

/** 多少天前 */
function ago(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) {
    const hours = Math.floor((now - at) / 3_600_000)
    return hours <= 0 ? '刚才' : `${hours} 小时前`
  }
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

export function renderGrowth(now = Date.now()): string {
  // 读全部并恢复成正序（loadDrifts 是给控制台用的，返回最近的 N 条倒序）。
  // 原来这里自己抄了一份 drift.jsonl 的解析，与 store.ts 的重复。
  const all = loadDrifts(Number.MAX_SAFE_INTEGER).reverse()
  // 只变过一次说明还没形成"轨迹"，说了反而奇怪
  if (all.length < 2) return ''

  const first = all[0]!
  const last = all[all.length - 1]!

  // 首尾一样就没必要说（可能只是标点改了）
  if (first.from === last.to) return ''

  const lines: string[] = ['【你变过的地方】']
  lines.push(`你改过 ${all.length} 次对自己的看法。`)
  lines.push(`- ${ago(first.at, now)}你是这么说的：「${clip(first.from)}」`)
  lines.push(`- 现在你是这么说的：「${clip(last.to)}」`)

  // 相似度低说明不是措辞微调，是真的换了想法
  if (last.sim < 0.5) {
    lines.push('这两句差得挺远——说明你确实变过，不是换了个说法。')
  }

  lines.push('如果这次聊到"你以前怎么样"，可以照实说，但别主动提。')
  return lines.join('\n')
}

function clip(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}
