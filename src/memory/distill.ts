import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { appendOpen, loadOpen } from '../people/open.ts'
import { loadPerson, personOfAccount } from '../people/store.ts'
import { appendFacts, isDeleted, loadFacts, touchFact, type Visibility } from './facts.ts'
import { similarity } from './recall.ts'
import { appendInsights, loadEpisodes, nextEpisodeId, saveEpisode } from './store.ts'
import { appendLife, loadSelf, saveSelf } from '../self/store.ts'
import { refreshProfile } from '../persona/profile.ts'
import { learnJargon } from '../learn/jargon.ts'

/** 时间戳 → 本地日期 yyyy-mm-dd */
function dateOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
import type { Episode, Insight, RawTurn, Scope } from './types.ts'

interface DistillOutput {
  episodes?: Array<{
    title?: string
    body?: string
    importance?: number
    emotion?: string
    /** 相关的已有 episode id，模型挑的；不存在的会被过滤掉 */
    related?: string[]
  }>
  facts?: Array<{
    text?: string
    confidence?: number
    source?: string
    visibility?: string
    tier?: string
  }>
  open?: Array<{ text?: string; kind?: 'todo' | 'pending' }>
  insights?: Array<{ text?: string; evidence?: string[] }>
  self?: { 自述?: string; 在想?: string; 取名?: string }
  life?: string[]
}

/** 把 rules.yaml 里"值得记/不值得记"拼进提示词，让配置真的影响整理 */
function systemPrompt(rules: Rules, knownFacts: string[] = [], knownEpisodes: Array<{ id: string; title: string }> = []): string {
  const 值得 = rules.记忆.值得记.length ? rules.记忆.值得记 : ['对方的个人信息', '情绪强烈的事', '约定']
  const 不值得 = rules.记忆.不值得记.length ? rules.记忆.不值得记 : ['寒暄', '重复内容', '语气词']
  const known = knownFacts.length
    ? `\n\n# 我已经记得的事（不要重复记；如果这次听到的更准确，写成对原文的补充，不要另起一条）\n${knownFacts.map((f) => `- ${f}`).join('\n')}`
    : ''
  // 已有经历只给 id + 标题：让模型能填 related，又不至于把正文全塞进 prompt
  const eps = knownEpisodes.length
    ? `\n\n# 我已经有的经历（可以用来填 related）\n${knownEpisodes
        .map((e) => `- ${e.id}：${e.title}`)
        .join('\n')}`
    : ''
  return `${SYSTEM_BASE}

这个人的主人希望：
- 值得记：${值得.join('、')}
- 不值得记：${不值得.join('、')}${known}${eps}`
}

const SYSTEM_BASE = `你在整理一段聊天记录，把它变成长期记忆。只输出 JSON，不要代码块，不要解释。

输出格式：
{
  "episodes": [{"title": "一句话概括", "body": "发生了什么 + 我当时怎么想", "importance": 1, "emotion": "当时的主要情绪", "related": ["相关的已有 episode id"]}],
  "facts": [{"text": "稳定的事实", "confidence": 0.9, "source": "他说过的原话，尽量短", "visibility": "public|private|unsure", "tier": "major|normal"}],
  "open": [{"text": "还没做的事，或我想跟对方确认的事", "kind": "todo"}],
  "insights": [{"text": "我对他或对这段关系的一个看法", "evidence": ["依据"]}],
  "self": {"自述": "我最近对自己的一点认识", "在想": "我最近在想的一件事", "取名": "如果还没有名字且觉得时机到了，给自己取一个"},
  "life": ["我自己那边的一件事，和对方无关"]
}

规则：
- 先在心里挑出今天最值得记的 3 件事，只写这几件，不要平均用力。
- episode 是"一段经历"，不是流水账。写具体场景，不要写"今天聊了很多"。
- related 可选：如果这条和下面列出的已有经历是同一件事的延续、或同一类事，把它们的 id 填进来（最多 3 个）；没有就不填。
- 只记值得记的：对方的个人信息、情绪强烈的事、约定、我自己想明白的事。
- 寒暄、重复、没有信息的话不要记。
- facts 只写稳定的、以后还会用到的事实。
- 档位（tier）判断——**二选一，别犹豫**：
  · major = 约定、承诺、长期目标、他明确说过的边界或底线、会影响以后很多次对话的事
  · normal = 其他所有（一次性偏好、当下状态、兴趣爱好、日常习惯）
  · 拿不准就 normal。major 是用来标明"这条以后不能弄错"的，宁缺勿滥。
  · 例：「他四级坚持要考」→ major；「他今天吃了面」→ 不该记；「他什么歌都听」→ normal。
- 可见性（visibility）判断：
  · public = 说出去也没关系（工作、学业、爱好、公开行程、对某件事的看法、生活习惯）
  · private = 不能对别人讲（家人、健康、经济、感情细节、情绪脆弱的时候、他明确表示不想被外人知道的事）
  · unsure = 我拿不准，想问问他再说
  · 学业、工作、爱好、口味、作息这类，默认 public，不用犹豫——全是 private 的话，
    我在群里就一句都不能说，那记了也没用。
  · 只有真的涉及家人、身体、钱、感情，才用 private。
  · 拿不准的时候，先想"他会不会介意别人知道这件事"，不介意就 public。
- "open" 的 kind 用 pending 表示"我拿不准、想跟对方确认"的记忆。
- self 和 life 是关于你自己的，不是关于对方的。
- 没什么值得记的就返回全空数组。`

function parseJson(text: string): DistillOutput | null {
  const direct = (() => {
    try {
      return JSON.parse(text.trim()) as DistillOutput
    } catch {
      return null
    }
  })()
  if (direct) return direct
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as DistillOutput
  } catch {
    return null
  }
}

export interface DistillResult {
  episodes: number
  facts: number
  open: number
  insights: number
  life?: number
}

export interface DistillOptions {
  personId: string
  scope: Scope
  turns: RawTurn[]
  llm: LlmOptions
  rules: Rules
}

function normVisibility(v: string | undefined): Visibility {
  if (v === 'public') return 'public'
  if (v === 'private') return 'private'
  return 'unsure'
}

/** 把一批原文压成 episode / facts / open / insights，并落盘。 */

/**
 * 这两条说的是同一件事吗？
 *
 * 为什么需要它：字符相似度分不出「同一个意思换个说法」。
 * 实测过——同一事实改写后 sim 只有 0.45，而「喜欢猫」vs「喜欢狗」有 0.50。
 * 所以灰色地带（0.45-0.9）交给模型判断，比死抠阈值靠谱。
 *
 * 只在灰色地带调用：相似度很高直接判重、很低直接当新的，都不花钱。
 */
async function sameFact(a: string, b: string, llm: LlmOptions): Promise<boolean> {
  try {
    const res = await chat(
      [
        {
          role: 'system',
          content:
            '你在判断两条关于同一个人的记录是不是同一件事。只输出 yes 或 no。\n' +
            'yes = 说的是同一个事实，只是换了说法，或者后者更准确。\n' +
            'no = 是两件不同的事，或者互相矛盾（比如一个说喜欢猫、一个说喜欢狗）。',
        },
        { role: 'user', content: `第一条：${a}\n第二条：${b}` },
      ],
      { ...llm, maxTokens: 4, temperature: 0 },
    )
    return /yes|是|同一/i.test(res.text.trim())
  } catch {
    // 判断不了就按"不同"处理：宁可多记一条，也别把新信息吞掉
    return false
  }
}

export async function distill(opts: DistillOptions): Promise<DistillResult> {
  const result: DistillResult = { episodes: 0, facts: 0, open: 0, insights: 0 }
  if (!opts.turns.length) return result

  // 群聊里必须标明谁说的，否则整理出来的人和事会张冠李戴
  const speakerOf = (t: RawTurn): string => {
    if (t.role === 'assistant') return '我'
    if (!t.senderId) return '他'
    const pid = personOfAccount('qq', t.senderId)
    return loadPerson(pid)?.name || `QQ${t.senderId}`
  }
  const transcript = opts.turns.map((t) => `${speakerOf(t)}：${t.text}`).join('\n')

  // 让模型知道已经记了什么，否则它每次从零提炼，必然重复
  const knownFacts = opts.scope.startsWith('private:') ? loadFacts(opts.personId).map((f) => f.text) : []
  // 定时任务里不能把异常抛出去：一次模型抖动不该让整轮整理变成 unhandled rejection，
  // 更不该让调用方把"出错了"和"没东西可整理"混为一谈。
  let res: { text: string }
  try {
    res = await chat(
      [
        {
      role: 'system',
      content: systemPrompt(
        opts.rules,
        knownFacts,
        // 只给 id 和标题，不给正文——省 token，也够模型判断相关性
        loadEpisodes()
          .filter((e) => e.scope === opts.scope)
          .slice(-20)
          .map((e) => ({ id: e.id, title: e.title })),
      ),
    },
        { role: 'user', content: `聊天记录：\n${transcript}` },
      ],
      { ...opts.llm, maxTokens: 1400, temperature: 0.3 },
    )
  } catch (err) {
    warnAt('整理的模型调用失败，这轮跳过', { scope: opts.scope, err: String(err).slice(0, 80) })
    return result
  }

  const data = parseJson(res.text)
  if (!data) {
    warnAt('整理结果不是合法 JSON，已跳过', { raw: res.text.slice(0, 200) })
    return result
  }

  // 用这批消息"发生的那天"，不是"现在"：
  // 凌晨 1 点整理昨晚的聊天，经历不该记成今天。
  const lastTs = opts.turns[opts.turns.length - 1]?.ts ?? Date.now()
  const date = dateOf(lastTs)

  // 已有 episode：给新的一条建链接用，也用来校验模型给的 related 是否存在
  const existingEpisodes = loadEpisodes().filter((x) => x.scope === opts.scope)

  for (const e of data.episodes ?? []) {
    const title = (e.title ?? '').trim()
    if (!title) continue
    const ep: Episode = {
      // 用已有最大序号 +1，同一天整理两次也不会互相覆盖
      id: nextEpisodeId(opts.scope, date),
      date,
      scope: opts.scope,
      importance: Math.min(10, Math.max(1, Number(e.importance ?? 5))),
      emotion: e.emotion?.trim() || undefined,
      title,
      body: (e.body ?? '').trim(),
    }
    // 和已有 episode 建链接（Hintzman 多痕迹模型：相似的不合并，靠链接表达关系）。
    // 模型可能给了 id，也可能没给——给了就校验一下别指到不存在的。
    if (existingEpisodes.length && e.related?.length) {
      const valid = new Set(existingEpisodes.map((x) => x.id))
      const ids = e.related.filter((id) => valid.has(id) && id !== ep.id).slice(0, 3)
      if (ids.length) ep.related = ids
    }
    saveEpisode(ep)
    result.episodes++
  }

  // 新事实和旧事实比对：完全重复的跳过，很像但不一样的记为"待确认"
  // 群聊里不写 facts/open：那是公共场合，分不清哪句是谁的私事
  const isPrivate = opts.scope.startsWith('private:')
  const existing = isPrivate ? loadFacts(opts.personId) : []
  const accepted: Array<{
    text: string
    date: string
    confidence: number
    visibility: Visibility
    source?: string
    tier?: 'major' | 'normal'
  }> = []
  const conflicts: Array<{ text: string; date: string; kind: 'pending' }> = []

  if (isPrivate) {
    for (const raw of data.facts ?? []) {
      const text = (raw.text ?? '').trim()
      if (text.length < 2) continue
      const confidence = Math.min(1, Math.max(0, Number(raw.confidence ?? 0.8)))
      const source = (raw.source ?? '').trim().slice(0, 60) || undefined
      const visibility = normVisibility(raw.visibility)
      // 档位：只认 major，其余一律 normal（宁缺勿滥）
      const tier: 'major' | 'normal' = raw.tier === 'major' ? 'major' : 'normal'

      const best = existing
        .map((old) => ({ old, sim: similarity(old.text, text) }))
        .sort((a, b) => b.sim - a.sim)[0]

      if (best && best.sim > 0.9) {
        // 这条又提到了：刷新确认日期，别让它慢慢过期
        touchFact(opts.personId, best.old.text, date)
        continue
      }
      // 灰色地带：字符相似度分不出「换个说法」和「另一件事」，问模型。
      // 之前这里直接当冲突让用户确认，结果同一件事换个说法就被反复问。
      if (best && best.sim >= 0.45) {
        const same = await sameFact(best.old.text, text, opts.llm)
        if (same) {
          // 同一件事：刷新确认，顺便把更准确的说法留下
          touchFact(opts.personId, best.old.text, date)
          if (text.length > best.old.text.length && best.old.text.length < text.length * 0.8) {
            // 新说法明显更详细，补一条（旧的会被 touch，不会重复计数）
            accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
          }
          continue
        }
        // 真是另一件事或互相矛盾：交给用户确认
        conflicts.push({
          text: `我记得「${best.old.text}」，这次听到「${text}」，想确认哪个对`,
          date,
          kind: 'pending',
        })
        continue
      }
      accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
    }
  }

  // 用户删过的事实不再加回来，否则"删了又被提炼回来"，删了个寂寞
  const kept = accepted.filter((f) => !isDeleted(opts.personId, f.text))
  const revived = accepted.length - kept.length
  if (revived > 0) info(`跳过 ${revived} 条你删过的事实`)

  if (kept.length) {
    appendFacts(opts.personId, kept)
    result.facts = kept.length
  }

  const opens = (data.open ?? [])
    .map((o) => ({
      text: (o.text ?? '').trim(),
      kind: (o.kind === 'pending' ? 'pending' : 'todo') as 'todo' | 'pending',
      date,
    }))
    .filter((o) => o.text.length > 1)

  // 拿不准能不能说的事实，变成一条"想问问他"
  const askPermissions = accepted
    .filter((f) => f.visibility === 'unsure')
    .map((f) => ({ text: `想问问他「${f.text}」这事能不能跟别人提`, date, kind: 'pending' as const }))

  const allOpen = [...opens, ...conflicts, ...askPermissions]
  if (isPrivate && allOpen.length) {
    appendOpen(opts.personId, allOpen)
    result.open = allOpen.length
  }

  const insights: Insight[] = (data.insights ?? [])
    .map((i, idx) => ({
      id: `${date}-${idx + 1}`,
      date,
      scope: opts.scope,
      text: (i.text ?? '').trim(),
      evidence: (i.evidence ?? []).map(String),
    }))
    .filter((i) => i.text.length > 1)
  if (insights.length) {
    appendInsights(insights)
    result.insights = insights.length
  }

  // 自我认知与自己的生活：只在私聊整理时更新
  if (opts.scope.startsWith('private:')) {
    const doc = loadSelf()
    let touched = false
    const s = data.self
    if (s?.取名 && !doc.name) {
      doc.name = s.取名.trim()
      doc.nameReason = '在整理记忆的时候，觉得这个名字像我'
      touched = true
      info(`它给自己取了名字：${doc.name}`)
    }
    if (s?.自述 && s.自述.trim() && s.自述.trim() !== doc.about) {
      doc.about = s.自述.trim()
      touched = true
    }
    if (s?.在想 && s.在想.trim()) {
      doc.thinking = s.在想.trim()
      touched = true
    }
    if (touched) saveSelf(doc)

    const life = (data.life ?? []).map((x) => String(x).trim()).filter((x) => x.length > 1)
    if (life.length) {
      appendLife(date, life)
      result.life = life.length
    }
  }

  // 群聊整理时顺带学黑话：这时候正好有一整段对话在手
  if (opts.scope.startsWith('group:')) {
    const gid = opts.scope.slice('group:'.length)
    void learnJargon(opts.turns, opts.llm, gid).catch(() => {})
  }

  info('整理完成', { person: opts.personId, scope: opts.scope, ...result })

  if (result.facts > 0 && opts.scope.startsWith('private:')) {
    void refreshProfile(opts.llm, opts.personId).catch(() => {})
  }

  return result
}

export { loadOpen }
