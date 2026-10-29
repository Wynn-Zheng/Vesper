import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { info } from '../core/log.ts'
import { similarity } from '../core/text.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { Rules } from '../core/config.ts'
import { writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'
import { cardScopedPath } from '../persona/card.ts'

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
  /**
   * 人工精选过。
   * rules.表达学习.只用精选 = true 时，只有带这个标记的会被用上——
   * 相当于"我审过的句子才让它学"。
   */
  checked?: boolean
}

// 学到的说话方式是按角色走的：换卡就是换人。
const FILE_LEGACY = 'persona/learned/plays.md'
function FILE(): string {
  return cardScopedPath('plays.md', FILE_LEGACY)
}
const MAX_KEEP = 60

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function playsFile(): string {
  return FILE()
}

export function loadPlays(): Play[] {
  if (!existsSync(FILE())) return []
  // 读失败（被占用/无权限）不能让整轮回复崩：这个文件是拼 prompt 时读的。
  let text = ''
  try {
    text = readFileSync(FILE(), 'utf8')
  } catch {
    return []
  }
  const out: Play[] = []
  for (const line of text.split(/\r?\n/)) {
    // ★ 表示人工精选过；有没有它都要能读
    const m = /^-\s+\[(\d+)分\](★?)\s+他说「(.+?)」→\s*我回「(.+?)」\s*（(\d{4}-\d{2}-\d{2})）\s*$/.exec(line.trim())
    if (!m) continue
    const score = Number(m[1])
    // 文件被手改坏时跳过，别让 NaN 混进渲染
    if (Number.isFinite(score)) {
      const play: Play = { score, scene: m[3]!, reply: m[4]!, date: m[5]! }
      if (m[2] === '★') play.checked = true
      out.push(play)
    }
  }
  return out
}


/** 一行经验；精选过的带 ★，人能直接看出来哪句被审过 */
function formatLine(p: Play): string {
  const star = p.checked ? '★' : ''
  return `- [${p.score}分]${star} 他说「${p.scene}」→ 我回「${p.reply}」（${p.date}）`
}

/** 人工标记/取消精选。改完立刻落盘。 */
export function toggleChecked(scene: string, checked: boolean): boolean {
  const items = loadPlays()
  const hit = items.find((p) => p.scene === scene || similarity(p.scene, scene) > 0.9)
  if (!hit) return false
  hit.checked = checked
  savePlays(items)
  return true
}

export function savePlays(items: Play[]): void {
  // 现有文件里如果有解析不了的正文，先备份再覆盖 —— 
  // 之前是"解析出几条就写几条"，格式手改坏一次，历史就被 1 条盖掉。
  try {
    if (existsSync(FILE())) {
      const raw = readFileSync(FILE(), 'utf8')
      const parsed = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length
      const usable = loadPlays().length
      if (parsed > 0 && usable === 0) {
        copyFileSync(FILE(), FILE + '.bad-' + Date.now())
      }
    }
  } catch {
    /* 备份失败也继续写 */
  }
  const good = items.filter((p) => p.score >= 7).slice(-MAX_KEEP)
  const bad = items.filter((p) => p.score <= 3).slice(-20)
  const body = [
    '# 我学到的应对方式',
    '',
    '## 这么回效果不错',
    ...(good.length ? good.map(formatLine) : ['- （还没有）']),
    '',
    '## 这么回不太好',
    ...(bad.length ? bad.map(formatLine) : ['- （还没有）']),
    '',
  ]
  writeAtomic(FILE(), body.join('\n'))
}

/** 只有明显好或明显不好的才值得记，中间的不记（没信号） */

/**
 * 让模型自己审一遍：这条经验值不值得学。
 *
 * 不审的后果：模型自评偏高（动不动 8 分），学到的句子越来越像模板。
 * 返回 false 就不记。
 */
async function reviewPlay(score: number, scene: string, reply: string, llm: LlmOptions): Promise<boolean> {
  const material = [
    `这条回复我自评 ${score} 分。`,
    `他说的：${scene}`,
    `我回的：${reply}`,
    '',
    '这条值得当作"以后遇到类似场景可以这么回"的范例吗？只输出 yes 或 no。',
    '不值得的情况：只是碰巧接上了、没信息量、像模板、或者靠的是具体某个事实（换个场景就不成立）。',
  ].join('\n')

  try {
    const res = await chat(
      [
        { role: 'system', content: '你在审查自己学到的东西。只输出 yes 或 no，不要解释。' },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 4, temperature: 0 },
    )
    return /yes|是|值得/i.test(res.text.trim())
  } catch {
    // 审不了就记下来：宁可多学一条，也别因为一次网络问题丢掉经验
    return true
  }
}

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


/**
 * 带审核的记经验。
 * 审核只在 score >= 7（要当范例的）时做；差评不用审，留着当反面教材。
 */
export async function recordPlayReviewed(
  score: number,
  scene: string,
  reply: string,
  llm: LlmOptions,
  rules: Rules,
): Promise<boolean> {
  if (score >= 7 && rules.表达学习?.审核) {
    const ok = await reviewPlay(score, scene, reply, llm)
    if (!ok) {
      info('这条没通过自审，不记', { 场景: scene.slice(0, 20) })
      return false
    }
  }
  recordPlay(score, scene, reply)
  return true
}

/** 找和他这次说的话最接近的几条经验 */
export function relevantPlays(text: string, limit = 3, checkedOnly = false): Play[] {
  let items = loadPlays()
  if (!items.length) return []
  // 只挑人工审过的句子：模型自我评分偏高时，未审的那批质量参差不齐
  if (checkedOnly) items = items.filter((p) => p.checked)
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
