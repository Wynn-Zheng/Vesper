import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { appendOpen, loadOpen } from '../people/open.ts'
import { loadPerson, personOfAccount } from '../people/store.ts'
import { appendFacts, isDeleted, loadFacts, touchFact, type Visibility } from './facts.ts'
import { similarity } from './recall.ts'
import { appendInsights, nextEpisodeId, saveEpisode } from './store.ts'
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
  episodes?: Array<{ title?: string; body?: string; importance?: number; emotion?: string }>
  facts?: Array<{ text?: string; confidence?: number; source?: string; visibility?: string }>
  open?: Array<{ text?: string; kind?: 'todo' | 'pending' }>
  insights?: Array<{ text?: string; evidence?: string[] }>
  self?: { 自述?: string; 在想?: string; 取名?: string }
  life?: string[]
}

/** 把 rules.yaml 里"值得记/不值得记"拼进提示词，让配置真的影响整理 */
function systemPrompt(rules: Rules, knownFacts: string[] = []): string {
  const 值得 = rules.记忆.值得记.length ? rules.记忆.值得记 : ['对方的个人信息', '情绪强烈的事', '约定']
  const 不值得 = rules.记忆.不值得记.length ? rules.记忆.不值得记 : ['寒暄', '重复内容', '语气词']
  const known = knownFacts.length
    ? `\n\n# 我已经记得的事（不要重复记；如果这次听到的更准确，写成对原文的补充，不要另起一条）\n${knownFacts.map((f) => `- ${f}`).join('\n')}`
    : ''
  return `${SYSTEM_BASE}

这个人的主人希望：
- 值得记：${值得.join('、')}
- 不值得记：${不值得.join('、')}${known}`
}

const SYSTEM_BASE = `你在整理一段聊天记录，把它变成长期记忆。只输出 JSON，不要代码块，不要解释。

输出格式：
{
  "episodes": [{"title": "一句话概括", "body": "发生了什么 + 我当时怎么想", "importance": 1, "emotion": "当时的主要情绪"}],
  "facts": [{"text": "稳定的事实", "confidence": 0.9, "source": "他说过的原话，尽量短", "visibility": "public|private|unsure"}],
  "open": [{"text": "还没做的事，或我想跟对方确认的事", "kind": "todo"}],
  "insights": [{"text": "我对他或对这段关系的一个看法", "evidence": ["依据"]}],
  "self": {"自述": "我最近对自己的一点认识", "在想": "我最近在想的一件事", "取名": "如果还没有名字且觉得时机到了，给自己取一个"},
  "life": ["我自己那边的一件事，和对方无关"]
}

规则：
- 先在心里挑出今天最值得记的 3 件事，只写这几件，不要平均用力。
- episode 是"一段经历"，不是流水账。写具体场景，不要写"今天聊了很多"。
- 只记值得记的：对方的个人信息、情绪强烈的事、约定、我自己想明白的事。
- 寒暄、重复、没有信息的话不要记。
- facts 只写稳定的、以后还会用到的事实。
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
  const res = await chat(
    [
      { role: 'system', content: systemPrompt(opts.rules, knownFacts) },
      { role: 'user', content: `聊天记录：\n${transcript}` },
    ],
    { ...opts.llm, maxTokens: 1400, temperature: 0.3 },
  )

  const data = parseJson(res.text)
  if (!data) {
    warnAt('整理结果不是合法 JSON，已跳过', { raw: res.text.slice(0, 200) })
    return result
  }

  // 用这批消息"发生的那天"，不是"现在"：
  // 凌晨 1 点整理昨晚的聊天，经历不该记成今天。
  const lastTs = opts.turns[opts.turns.length - 1]?.ts ?? Date.now()
  const date = dateOf(lastTs)

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
    saveEpisode(ep)
    result.episodes++
  }

  // 新事实和旧事实比对：完全重复的跳过，很像但不一样的记为"待确认"
  // 群聊里不写 facts/open：那是公共场合，分不清哪句是谁的私事
  const isPrivate = opts.scope.startsWith('private:')
  const existing = isPrivate ? loadFacts(opts.personId) : []
  const accepted: Array<{ text: string; date: string; confidence: number; visibility: Visibility; source?: string }> = []
  const conflicts: Array<{ text: string; date: string; kind: 'pending' }> = []

  if (isPrivate) {
    for (const raw of data.facts ?? []) {
    const text = (raw.text ?? '').trim()
    if (text.length < 2) continue
    const confidence = Math.min(1, Math.max(0, Number(raw.confidence ?? 0.8)))
    const source = (raw.source ?? '').trim().slice(0, 60) || undefined
    const visibility = normVisibility(raw.visibility)

    const best = existing
      .map((old) => ({ old, sim: similarity(old.text, text) }))
      .sort((a, b) => b.sim - a.sim)[0]

    if (best && best.sim > 0.9) {
      // 这条又提到了：刷新确认日期，别让它慢慢过期
      touchFact(opts.personId, best.old.text, date)
      continue
    }
    if (best && best.sim >= 0.55) {
      conflicts.push({
        text: `我记得「${best.old.text}」，这次听到「${text}」，想确认哪个对`,
        date,
        kind: 'pending',
      })
      continue
    }
      accepted.push({ text, date, confidence, visibility, ...(source ? { source } : {}) })
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
