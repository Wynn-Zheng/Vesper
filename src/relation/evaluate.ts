import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { loadMood, saveMood, type Mood } from '../persona/mood.ts'
import { applyAnchor, loadRelation, saveRelation, todayStr } from './store.ts'
import type { Dimension } from './types.ts'

const SYSTEM = `你在判断一轮聊天有没有改变两个人的关系。只输出 JSON，不要解释，不要代码块。

{
  "anchor": {"事件": "一句话", "维度": "信任|亲密|好奇|依赖", "方向": "up|down", "幅度": 1, "理由": "为什么这件事让关系变了"} ,
  "mood": {"情绪": "担心|平静|高兴|失落|好奇|烦躁", "强度": 0.5}
}

规则：
- 只有真的发生的事才算：分享私事、守约、说真话、记得小事、被冷落、被敷衍、久不联系。
- 寒暄、日常闲聊、单纯开玩笑不算。
- 幅度只能是 1 或 2。理由必须具体，不能写"聊得很好"。
- 这一轮没有变化，anchor 就返回 null。
- mood 是聊完之后的心情；没变化就返回 null。`

interface EvalOutput {
  anchor?: { 事件?: string; 维度?: string; 方向?: string; 幅度?: number; 理由?: string } | null
  mood?: { 情绪?: string; 强度?: number } | null
}

function parse(text: string): EvalOutput | null {
  try {
    return JSON.parse(text.trim()) as EvalOutput
  } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as EvalOutput
    } catch {
      return null
    }
  }
}

export interface EvaluateOptions {
  rules: Rules
  llm: LlmOptions
  personId: string
  userText: string
  selfText: string
}

async function evaluate(opts: EvaluateOptions): Promise<void> {
  const res = await chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `他：${opts.userText}\n我：${opts.selfText}` },
    ],
    { ...opts.llm, maxTokens: 300, temperature: 0.2 },
  )

  const data = parse(res.text)
  if (!data) return

  const state = loadRelation(opts.personId)
  let next = state

  const a = data.anchor
  if (a?.事件 && a.理由) {
    const dir = a.方向 === 'down' ? 'down' : 'up'
    const dim = (['信任', '亲密', '好奇', '依赖'] as Dimension[]).includes(a.维度 as Dimension)
      ? (a.维度 as Dimension)
      : '信任'
    const result = applyAnchor(
      next,
      {
        event: a.事件,
        dimension: dim,
        direction: dir,
        amount: Math.max(1, Math.min(2, Number(a.幅度 ?? 1))),
        reason: a.理由,
        date: todayStr(),
      },
      opts.rules,
    )
    if (result.delta !== 0) {
      next = result.state
      info(`关系 ${result.delta > 0 ? '+' : ''}${result.delta.toFixed(1)}`, {
        对象: opts.personId,
        阶段: result.stage.名,
        事件: a.事件,
      })
    }
  }

  if (next !== state) saveRelation(opts.personId, next)

  // 心情是全局的：它这一刻对所有人都是这个情绪
  const m = data.mood
  if (m?.情绪) {
    const entry = {
      emotion: m.情绪,
      intensity: Math.min(1, Math.max(0, Number(m.强度 ?? 0.3))),
      at: Date.now(),
    }
    const prev = loadMood()
    const mood: Mood = { ...entry, recent: [...(prev?.recent ?? []), entry].slice(-5) }
    saveMood(mood)
  }
}

// 串行队列：评估是异步的，但文件读写不能并发
let queue: Promise<void> = Promise.resolve()

export function evaluateTurn(opts: EvaluateOptions): void {
  queue = queue
    .then(() => evaluate(opts))
    .catch((err) => {
      warnAt('关系评估失败', { err: String(err) })
    })
}

export async function drainEvaluations(): Promise<void> {
  await queue
}
