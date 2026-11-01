import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { loadMood, saveMood, type Mood, type MoodEntry } from '../persona/mood.ts'
import { applyAnchor, loadRelation, saveRelation, todayStr } from './store.ts'
import { loadEpisodes as loadEpisodesSafe, recentRaw as recentRawTurns } from '../memory/store.ts'
import { sharedBigrams } from '../core/text.ts'
// 从 QQ 号查显示名：群里两个人说的话混在【最近说过的原话】里，
// 不带名字就看不出是谁说的。实现在 people/store（原来这里抄了一份）。
import { displayNameOfAccount } from '../people/store.ts'
import type { Dimension } from './types.ts'
import { visible } from '../memory/recall.ts'
import type { Scope } from '../memory/types.ts'

const SYSTEM = `你在判断一轮聊天有没有改变两个人的关系。只输出 JSON，不要解释，不要代码块。

{
  "anchor": {"事件": "一句话", "维度": "信任|亲密|好奇|依赖", "方向": "up|down", "幅度": 1, "理由": "为什么这件事让关系变了"} ,
  "mood": {"情绪": "担心|平静|高兴|失落|好奇|烦躁", "强度": 0.5, "效价": -0.6, "原因": "一句话说为什么是这个心情"}
}

规则：
- 只有真的发生的事才算：分享私事、守约、说真话、记得小事、被冷落、被敷衍、久不联系。
- 寒暄、日常闲聊、单纯开玩笑不算。
- **幅度 1-3，按「这件事值多少时间」定**（参照 Hall 2018 的实证：真正让关系变近的
  是共同投入的时间，而"说了一件私事"相当于一次高质量相处）：
  · 1 = 普通的一次。记得他提过的小事、顺口一句真心话、日常接话。
  · 2 = 明显的一件事。分享家里的事/身体/感情、主动示弱、承认自己错了、
        记得并主动提起一周前他说过的细节、在他难受时接住了。
  · 3 = 很少见的大事。长期承诺并兑现、说出从没跟别人说过的事、
        严重伤害或严重失信、把关系挑明。一周出现不了一次是正常的。
- **能给 2 就给 2**：上面第 2 条列的场景，如果真发生了就判 2，不要因为"不算什么大事"退回 1。
  退回 1 的理由只能是"这件事本身很轻"，不能是"我不确定算不算"。
- 给 3 要克制，但别把 3 变成不可达——真发生了就判 3。
- 理由必须具体，不能写"聊得很好"。
- 这一轮没有变化，anchor 就返回 null。
- mood 是聊完之后的心情；没变化就返回 null。
- 原因要能看出「是谁的哪句话让我变成这样」，不超过 20 字。比如"他说不来了"、"他记得我怕黑"。
- 「效价」是 -1 到 +1 的一个数：-1 很难受，0 平淡，+1 很好受。
  强度和效价是两回事：可以说"有点难受"（强度 0.4、效价 -0.5），也可以"特别难受"（强度 0.9、效价 -0.6）。

## 判断强度时，先看「以前的事」

（下面如果列了我记得的事，就对比着看）

- 他说的事和以前**不一样**（尤其是相反）→ 情绪才该强（0.6 以上）
- 他说的事和以前**一样**，或者**第三次**说同一件事 → 情绪该弱（0.3 以下）
- 举不出"这次和以前哪里不一样" → 强度压在 0.3 以下

**只对比事实层面，不要推论他的心理。**
比如他两次都说累，就是"两次都说累"，不要写成"他一直在硬撑"。`

interface EvalOutput {
  anchor?: { 事件?: string; 维度?: string; 方向?: string; 幅度?: number; 理由?: string } | null
  mood?: { 情绪?: string; 强度?: number; 效价?: number; 原因?: string } | null
}

export interface NormalizedAnchor {
  event: string
  dimension: Dimension
  direction: 'up' | 'down'
  amount: number
  reason: string
}

const DIMENSIONS: Dimension[] = ['信任', '亲密', '好奇', '依赖']

/**
 * 把模型返回的锚点收敛成能安全写入的形状。
 *
 * 模型输出是 JSON，类型完全不可信：幅度可能是 NaN / Infinity / 字符串，
 * 事件和理由可能是对象。这里任何一项不合法都返回 null——宁可这轮不记，
 * 也不能把 NaN 写进关系值，或者把"没有理由"的变化落盘。
 */
export function normalizeAnchor(a: EvalOutput['anchor']): NormalizedAnchor | null {
  if (!a || typeof a !== 'object') return null

  const event = typeof a.事件 === 'string' ? a.事件.trim() : ''
  const reason = typeof a.理由 === 'string' ? a.理由.trim() : ''
  if (!event || !reason) return null

  const dimension = DIMENSIONS.includes(a.维度 as Dimension) ? (a.维度 as Dimension) : '信任'
  const direction = a.方向 === 'down' ? 'down' : 'up'

  // 缺省按 1；给了 0 或非有限数字说明模型输出坏了，整条丢掉。
  let amount = 1
  if (a.幅度 !== undefined && a.幅度 !== null) {
    const n = Math.abs(Number(a.幅度))
    if (!Number.isFinite(n) || n === 0) return null
    // 四舍五入后夹到 1~3：3 只留给"长期承诺/严重伤害"，不能再高
    amount = Math.min(3, Math.max(1, Math.round(n)))
  }

  return { event, dimension, direction, amount, reason }
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

/**
 * 捞几段"以前的事"，给「对比基准」用。
 *
 * 依据 Regan et al. 2024 (arXiv:2402.04232)：
 * 情绪来自**新事件和过去记忆的对比**（appraisal theory of emotion）。
 * 没有参照物，模型只能给一个笼统的"担心"或"平静"——这正是我们之前的毛病。
 *
 * 这里**不用 recall()**：那个会顺带记召回次数（markRecalled），
 * 关系评估不该影响记忆的"被想起"统计。
 *
 * 实测坑（两个）：
 *   1. bigram Jaccard 对「短 query vs 长 episode」天然很低 ——
 *      9 条 episode 里最高才 0.030，用 0.05 当门槛等于一条都取不到。
 *      改用 `sharedBigrams`（共同 bigram 数），对长度差不敏感。
 *   2. **"他第三次说同一件事"这种事，episode 里查不到** ——
 *      episode 是提炼过的（"凌晨两点他失眠说想看我成长"），
 *      不带"四级没过"这种具体词。所以还要看**最近几轮原话**。
 *
 * 所以两块拼起来：最近的经历（提炼过的）+ 最近的原话（没提炼的）。
 */
function scopeOfPerson(personId: string): Scope {
  const m = /^qq-(.+)$/.exec(personId)
  return m ? (`private:${m[1]}` as Scope) : 'shared'
}

function recentContext(scope: Scope, userText: string, limit = 3): string {
  const parts: string[] = []

  try {
    // 按 scope 过滤：以前读全量，给 A 评估时会混进 B 的私聊经历和别群原话 ——
    // 既判断错人（"他第三次说这件事"），也是隐私泄漏。
    const eps = loadEpisodesSafe().filter((e) => visible(e.scope, scope))
    if (eps.length) {
      // 1. 按共同 bigram 数排，>= 2 个才算"话题相关"，最多 2 条
      const byTopic = eps
        .map((e) => ({ e, shared: sharedBigrams(userText, `${e.title} ${e.body}`) }))
        .filter((x) => x.shared >= 2)
        .sort((a, b) => b.shared - a.shared)
        .slice(0, 2)
        .map((x) => x.e)

      // 2. 不够就用最近的补。越近的越可能和这次有关（他昨天说累，今天又说累）
      const picked = [...byTopic]
      for (const e of [...eps].reverse()) {
        if (picked.length >= limit) break
        if (!picked.includes(e)) picked.push(e)
      }

      if (picked.length) {
        parts.push(
          '【我记得的经历】',
          ...picked
            .slice(0, limit)
            .map((e) => `- ${e.date}｜${e.title}${e.emotion ? `（当时：${e.emotion}）` : ''}`),
        )
      }
    }
  } catch {
    /* 读不到就不给 */
  }

  // 最近几轮原话：用来判断"这事他说过没有"
  try {
    const recent = recentRawTurns(6)
      .filter((t) => visible(t.scope, scope))
      .filter((t) => t.role === 'user' && t.text.trim())
      .slice(-4)
    if (recent.length) {
      // 带上说话人：群里两个人说的话混在一起，不带名字就看不出
      // "这事是他说过"还是"另一个人说过"。
      parts.push(
        '',
        '【最近说过的原话】（判断"是不是说过"用）',
        ...recent.map((t) => {
          const who = t.senderId ? displayNameOfAccount(t.senderId) : ''
          const line = t.text.replace(/\s+/g, ' ').slice(0, 60)
          return who ? `- ${who}：${line}` : `- ${line}`
        }),
      )
    }
  } catch {
    /* 读不到就不给 */
  }

  return parts.join('\n')
}

async function evaluate(opts: EvaluateOptions): Promise<void> {
  const past = recentContext(scopeOfPerson(opts.personId), opts.userText)
  const userBlock = [
    `他：${opts.userText}`,
    // 回复前调用的那次没有 selfText：写"还没回"比留空更像一轮真实对话，
    // 否则模型会把空行当成"它说了句空话"。
    `我：${opts.selfText || '（还没回）'}`,
    ...(past ? ['', '以前的事（判断强度时对比着看）：', past] : []),
  ].join('\n')

  const res = await chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userBlock },
    ],
    { ...opts.llm, maxTokens: 300, temperature: 0.2 },
  )

  const data = parse(res.text)
  if (!data) {
    // 静默跳过会让"关系/心情都不动"变得无法解释（用户看起来就是"它今天没反应"）。
    // 至少留一条可查的日志；连续失败时控制台能看出来。
    warnAt('关系/心情评估返回的不是 JSON，本轮跳过', {
      对象: opts.personId,
      片段: res.text.replace(/\s+/g, ' ').slice(0, 80),
    })
    return
  }

  const state = loadRelation(opts.personId)
  let next = state

  const a = normalizeAnchor(data.anchor)
  if (a) {
    const result = applyAnchor(next, { ...a, date: todayStr() }, opts.rules)
    if (result.delta !== 0) {
      next = result.state
      info(`关系 ${result.delta > 0 ? '+' : ''}${result.delta.toFixed(1)}`, {
        对象: opts.personId,
        阶段: result.stage.名,
        事件: a.event,
      })
    }
  }

  if (next !== state) saveRelation(opts.personId, next)

  // 心情是全局的：它这一刻对所有人都是这个情绪
  const m = data.mood
  const emotion = typeof m?.情绪 === 'string' ? m.情绪.trim() : ''
  if (emotion) {
    const raw = Number(m?.强度 ?? 0.3)
    // 原因一句话就够：模型要的是「为什么变」，不是小作文。
    // 有了它，"从 0.9 掉到 0.2"才不是两个孤立的数字。
    const why = String(m?.原因 ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    // 效价：-1 很难受 ~ +1 很好受。没给或给了坏值就不写这个字段，
    // 老逻辑（按平淡衰减）照样能用。
    const rawV = Number(m?.效价)
    const entry: MoodEntry = {
      emotion,
      intensity: Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.3,
      ...(m?.效价 !== undefined && Number.isFinite(rawV)
        ? { valence: Math.min(1, Math.max(-1, rawV)) }
        : {}),
      at: Date.now(),
      ...(why ? { reason: why } : {}),
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