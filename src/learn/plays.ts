import { existsSync, readFileSync } from 'node:fs'
import { info } from '../core/log.ts'
import { similarity } from '../core/text.ts'
import { writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'

/**
 * 记住"什么话怎么接，效果如何"。
 *
 * 数据来源是回复自评：分高的记成范例，分低的记成教训。
 * 用的时候按"他这次说的像不像当时那句"找最接近的几条，
 * 不是拿来照抄，是让它知道"上次类似的情况我是怎么处理的"。
 */

export interface Play {
  score: number
  /** 他当时说的话 */
  scene: string
  /** 我当时怎么回的 */
  reply: string
  date: string
}

const FILE = 'persona/learned/plays.md'
const MAX_KEEP = 60

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function playsFile(): string {
  return FILE
}

export function loadPlays(): Play[] {
  if (!existsSync(FILE)) return []
  const out: Play[] = []
  for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
    const m = /^-\s+\[(\d+)分\]\s+他说「(.+?)」→\s*我回「(.+?)」\s*（(\d{4}-\d{2}-\d{2})）\s*$/.exec(line.trim())
    if (!m) continue
    const score = Number(m[1])
    // 文件被手改坏时跳过，别让 NaN 混进渲染
    if (Number.isFinite(score)) out.push({ score, scene: m[2]!, reply: m[3]!, date: m[4]! })
  }
  return out
}

export function savePlays(items: Play[]): void {
  const good = items.filter((p) => p.score >= 7).slice(-MAX_KEEP)
  const bad = items.filter((p) => p.score <= 3).slice(-20)
  const body = [
    '# 我学到的应对方式',
    '',
    '## 这么回效果不错',
    ...(good.length ? good.map((p) => `- [${p.score}分] 他说「${p.scene}」→ 我回「${p.reply}」（${p.date}）`) : ['- （还没有）']),
    '',
    '## 这么回不太好',
    ...(bad.length ? bad.map((p) => `- [${p.score}分] 他说「${p.scene}」→ 我回「${p.reply}」（${p.date}）`) : ['- （还没有）']),
    '',
  ]
  writeAtomic(FILE, body.join('\n'))
}

/** 只有明显好或明显不好的才值得记，中间的不记（没信号） */
export function recordPlay(score: number, scene: string, reply: string): void {
  if (score >= 4 && score <= 6) return
  // 读-改-写要排队：两条回复几乎同时自评完时，不排队会丢一条经验
  serialized('plays', () => doRecordPlay(score, scene, reply))
}

function doRecordPlay(score: number, scene: string, reply: string): void {
  const s = scene.replace(/[（）：:「」]/g, ' ').trim().slice(0, 40)
  const r = reply.replace(/[（）：:「」]/g, ' ').trim().slice(0, 60)
  if (s.length < 2 || r.length < 1) return

  const items = loadPlays()
  // 同一场景只覆盖同类的：好的和坏的都留着，对比才有价值
  const isGood = score >= 7
  const dup = items.findIndex((p) => similarity(p.scene, s) > 0.9 && p.score >= 7 === isGood)
  if (dup >= 0) {
    items[dup] = { score, scene: s, reply: r, date: today() }
  } else {
    items.push({ score, scene: s, reply: r, date: today() })
  }
  savePlays(items)
  info(`记下一条经验（${score} 分）`, { 场景: s })
}

/** 找和他这次说的话最接近的几条经验 */
export function relevantPlays(text: string, limit = 3): Play[] {
  const items = loadPlays()
  if (!items.length) return []
  return items
    .map((p) => ({ p, sim: similarity(p.scene, text) }))
    .filter((x) => x.sim > 0.25)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((x) => x.p)
}

export function renderPlays(items: Play[]): string {
  if (!items.length) return ''
  const good = items.filter((p) => p.score >= 7)
  const bad = items.filter((p) => p.score <= 3)
  const lines: string[] = ['以前遇到类似的话，我是这么处理的（参考，不是照抄）：']
  for (const p of good) lines.push(`- 他说「${p.scene}」时，我回「${p.reply}」，效果不错`)
  for (const p of bad) lines.push(`- 他说「${p.scene}」时，我回「${p.reply}」，效果不好，别这样`)
  return lines.join('\n')
}
