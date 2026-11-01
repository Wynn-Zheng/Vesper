import { existsSync, readFileSync } from 'node:fs'
import { info } from '../core/log.ts'
import { similarity } from '../core/text.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { Rules } from '../core/config.ts'
import { writeAtomic } from '../store/fs.ts'
import { serialized } from '../store/serialize.ts'
import { cardScopedPath } from '../persona/card.ts'
import type { RawTurn } from '../memory/types.ts'

/**
 * 学这个群"怎么说话"——不是学意思（那是 jargon 的活），是学能拿来自用的说法。
 *
 * 和别的学习模块的分工：
 *   - jargon：听懂。「他们说的『抽象』是什么意思」→ 只影响理解
 *   - plays：怎么接。「上次他这么说，我那么回效果好」→ 学的是我自己的应对
 *   - 这个：怎么说。「群里最近把『确实』说成『属实』」→ 学的是它的嘴
 *
 * 为什么要单独一层：只懂意思不会用，等于听得懂方言但一句都不说。
 * 群里最常见的违和感就是——它看懂了，但回出来的话不是这个群的味道。
 *
 * 什么时候不该学（这是这个模块最容易被污染的地方）：
 *   ① 普通词：谁都在用，学了没意义（用双猜法过滤，借自 jargon）
 *   ② 一次性的话：只在那一句里成立，换个场景就不通
 *   ③ 别人的具体事实：那是记忆，不是表达
 *   ④ 骂人的话：跟着学一句，主人就要挨骂了
 */

export interface Expression {
  /** 说法本身：一个词、一个短句，或一个句式（用 X 占位） */
  text: string
  /** 什么场景下用 */
  scene: string
  /** 见过几次。>= 2 才算"这个群里真的在这么说"，不是某人一时口误 */
  count: number
  /** 第一次学到的日期 */
  date: string
  /** 人工精选过。rules.表达学习.只用精选 = true 时只有这些会被用上 */
  checked?: boolean
}

/** 学到的表达跟着角色卡走：换卡就是换人，不该带着别的卡的口音 */
const FILE_LEGACY = 'persona/learned/expressions.json'
function FILE(): string {
  return cardScopedPath('expressions.json', FILE_LEGACY)
}

/** 攒够这么多条就淘汰最久没出现的，免得无限长下去 */
const MAX_KEEP = 120

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function expressionFile(): string {
  return FILE()
}

export function loadExpressions(): Expression[] {
  if (!existsSync(FILE())) return []
  // 拼 prompt 的时候会读到这个文件，读失败不能把整轮回复拖垮
  try {
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is Expression => {
      const e = x as Partial<Expression>
      return typeof e.text === 'string' && e.text.trim().length > 0 && typeof e.scene === 'string'
    })
  } catch {
    return []
  }
}

export function saveExpressions(items: Expression[]): void {
  // 新学的排后面；淘汰时先扔最老的，保住最近在用的
  const kept = items.slice(-MAX_KEEP)
  writeAtomic(FILE(), JSON.stringify(kept, null, 2) + '\n')
}

/** 人工标精选/取消。改完立刻落盘。 */
export function toggleExpressionChecked(text: string, checked: boolean): boolean {
  const items = loadExpressions()
  const hit = items.find((e) => e.text === text || similarity(e.text, text) > 0.9)
  if (!hit) return false
  hit.checked = checked
  saveExpressions(items)
  return true
}

/** 学到什么不该忽略：这几类说法一律不要 */
const SYSTEM = `你在看一段群聊，要找出"这个群里特有的、能拿来自用的说话方式"。

只找这几类：
- 群友反复用的口头禅、语气词（例：把"确实"说成"属实"）
- 群友之间叫人或起哄的固定说法
- 有辨识度的新说法、梗（不是这个群的梗，是全国通用的，不要）
- 固定的句式或语序（例：把话说一半就用"反正就这样"收尾）

一律不要：
- 普通词、书面语、没有这个群特征的表达
- 只在那一句话里成立的（换个场景就不通）
- 别人的具体事情、事实、人名
- 骂人、歧视、涉及性的内容

判断方法（重要）：先结合上下文猜它的意思，再假装没有上下文单看它——两次猜得一样，说明是普通词，丢掉；差很多，才是这个群特有的。

对每个找到的，输出：
{"说法": "原样写法", "场景": "一般什么时候会这么说，一句话"}

只输出 JSON 数组，不要解释。没有就返回 []，不要凑数。`

interface Parsed {
  text: string
  scene: string
}

function parse(text: string): Parsed[] {
  const m = /\[[\s\S]*\]/.exec(text)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => {
        const o = x as { 说法?: unknown; 场景?: unknown }
        return {
          text: String(o.说法 ?? '').trim(),
          scene: String(o.场景 ?? '').trim(),
        }
      })
      .filter((x) => x.text.length > 0)
  } catch {
    return []
  }
}

/**
 * 让模型自己审一遍这批候选取哪几条。
 *
 * 为什么还要审：上面那段 prompt 已经写得很细了，但模型仍然会把
 * 一次性的玩笑话当成"反复用的说法"。多问一遍"这几个里哪些
 * 放到别的群也说得通"能砍掉一大半噪声，代价只有一次很短的请求。
 */
async function reviewExpression(item: Parsed, llm: LlmOptions): Promise<boolean> {
  const material = [
    `说法：${item.text}`,
    `用在：${item.scene}`,
    '',
    '这个说法是"这个群里反复在用的说话方式"，还是只是某个人这一次顺口说的？',
    '如果放到别的群里也完全说得通、看不出是这个群的特征，也回答 no。',
    '只输出 yes 或 no。',
  ].join('\n')

  try {
    const res = await chat(
      [
        { role: 'system', content: '你在审查自己学到的说话方式。只输出 yes 或 no，不要解释。' },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 4, temperature: 0 },
    )
    return /yes|是/i.test(res.text.trim())
  } catch {
    // 审不了就记下来：一次网络问题不该丢掉一条真表达
    return true
  }
}

/**
 * 从一段群聊里学新说法，和已有的合并。
 *
 * 返回真正新增的条数。
 */
export async function learnExpressions(
  turns: RawTurn[],
  llm: LlmOptions,
  groupId: string,
  rules: Rules,
): Promise<number> {
  const text = turns
    .filter((t) => t.role === 'user')
    .map((t) => t.text)
    .join('\n')
  // 太短的一段看不出"反复在用"，只会学到一次性的口误
  if (text.length < 80) return 0

  const existing = loadExpressions()
  const known = new Set(existing.map((e) => e.text))
  const material = existing.length
    ? `已经学到的说法（不用再报）：${existing.map((e) => e.text).join('、')}\n\n本段聊天：\n${text}`
    : `本段聊天：\n${text}`

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 700, temperature: 0.3 },
    )

    const candidates = parse(res.text).filter((c) => c.text.length <= 24)
    if (!candidates.length) return 0

    const todayStr = today()
    let added = 0
    for (const cand of candidates) {
      // 同一条别记两遍；已经有的就把次数加一，加权时会更靠前
      const dup = existing.find((e) => e.text === cand.text || similarity(e.text, cand.text) > 0.85)
      if (dup) {
        dup.count += 1
        continue
      }
      if (known.has(cand.text)) continue
      if (rules.表达学习?.审核 && !(await reviewExpression(cand, llm))) {
        info('这条表达没通过自审，不记', { 说法: cand.text })
        continue
      }
      existing.push({
        text: cand.text,
        scene: cand.scene.slice(0, 40),
        count: 1,
        date: todayStr,
      })
      known.add(cand.text)
      added++
    }

    if (added) {
      // 落盘时重新读一次再合并：distill 分批整理会并行跑好几个 learnExpressions，
      // 各自拿着开头那份快照直接写回，后写的会把先写的那批吃掉。
      serialized('expressions', () => {
        const latest = loadExpressions()
        for (const e of existing) {
          const old = latest.find((x) => x.text === e.text)
          if (old) {
            old.count = Math.max(old.count, e.count)
            if (!old.scene && e.scene) old.scene = e.scene
          } else {
            latest.push(e)
          }
        }
        saveExpressions(latest)
      })
      info(`学到 ${added} 条群里的说法`, { 群: groupId })
    }
    return added
  } catch {
    return 0
  }
}

/** 这条说法在仓库里一共被"看见"过几次（学习时累加的） */
function weight(e: Expression): number {
  // 见过越多次越像"这个群真的在用"，但别让一条压住其它所有
  return 1 + Math.min(e.count, 5) / 5
}

/**
 * 挑几条和这次对话最搭的说法。
 *
 * 排序规则：语境相似度优先（和这次说的话像不像），平手时看"群里多常用"。
 * 相似度太低的一条都不要——宁可不带口音，也别在无关的场合冒出"属实"。
 */
export function pickExpressions(text: string, limit = 3, checkedOnly = false): Expression[] {
  let items = loadExpressions()
  if (!items.length) return []
  if (checkedOnly) items = items.filter((e) => e.checked)
  if (!items.length) return []

  return items
    .map((e) => ({
      e,
      // 说法本身出现在这句话里 → 一定相关；否则按场景描述算相似度
      sim: text.includes(e.text) ? 1 : similarity(e.scene, text) * 0.9 + similarity(e.text, text) * 0.1,
    }))
    .filter((x) => x.sim > 0.2)
    .sort((a, b) => b.sim * weight(b.e) - a.sim * weight(a.e))
    .slice(0, limit)
    .map((x) => x.e)
}

/** 拼成给模型看的一小段 */
export function renderExpressions(items: Expression[]): string {
  if (!items.length) return ''
  return [
    '这个群里的人平时这么说话，你想用也可以用（不用刻意，别每句都套）：',
    ...items.map((e) => `- 「${e.text}」——${e.scene || '他们平时就这么说'}`),
  ].join('\n')
}
