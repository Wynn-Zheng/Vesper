/** 一次性：把历史快照按天去重，每天只留最新一张，并删掉超过 30 天的 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'data/versions'
const KEEP_DAYS = 30

if (!existsSync(DIR)) {
  console.log('没有快照目录')
  process.exit(0)
}

interface Item {
  id: string
  at: number
}

const items: Item[] = []
for (const e of readdirSync(DIR, { withFileTypes: true })) {
  if (!e.isDirectory()) continue
  let at = 0
  try {
    const meta = JSON.parse(readFileSync(join(DIR, e.name, '.meta.json'), 'utf8')) as { at?: number }
    at = Number(meta.at ?? 0)
  } catch {
    /* 没 meta 就按 0 处理 */
  }
  items.push({ id: e.name, at })
}

// 按天分组（id 前 8 位是 yyyymmdd）
const byDay = new Map<string, Item[]>()
for (const it of items) {
  const day = it.id.slice(0, 8)
  const list = byDay.get(day) ?? []
  list.push(it)
  byDay.set(day, list)
}

const cutoff = Date.now() - KEEP_DAYS * 86_400_000
let removed = 0
let kept = 0

for (const [, list] of byDay) {
  // 每天保留 id 最大的（最新）
  list.sort((a, b) => (a.id < b.id ? 1 : -1))
  const keep = list[0]!
  if (keep.at && keep.at < cutoff) {
    // 整天都过期了，全删
    for (const it of list) {
      rmSync(join(DIR, it.id), { recursive: true, force: true })
      removed++
    }
    continue
  }
  kept++
  for (const it of list.slice(1)) {
    rmSync(join(DIR, it.id), { recursive: true, force: true })
    removed++
  }
}

console.log(`原有 ${items.length} 张 → 保留 ${kept} 张（每天一张）→ 删除 ${removed} 张`)
