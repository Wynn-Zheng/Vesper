import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import { appendOpen, loadOpen } from '../people/open.ts'
import { loadPerson, personOfAccount } from '../people/store.ts'
import { appendFacts, isDeleted, loadFacts, supersedeFact, touchFact, type Visibility } from './facts.ts'
import { similarity } from './recall.ts'
import { appendInsights, loadEpisodes, nextEpisodeId, saveEpisode } from './store.ts'
import { appendLife, loadSelf, saveSelf } from '../self/store.ts'
import { refreshProfile } from '../persona/profile.ts'
import { learnJargon } from '../learn/jargon.ts'
import { learnExpressions } from '../learn/expression.ts'

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
    /**
     * 群聊里这条事实是谁的事（发言人名字，必须和聊天记录里的名字一致）。
     * 私聊时忽略——整段都是同一个人的。
     */
    who?: string
  }>
  open?: Array<{ text?: string; kind?: 'todo' | 'pending' }>
  insights?: Array<{ text?: string; evidence?: string[] }>
  self?: { 自述?: string; 在想?: string; 取名?: string }
  life?: string[]
}

/** 模型给的一条事实，字段都可能是脏的 */
type RawFact = NonNullable<DistillOutput['facts']>[number]

/** 清洗后准备写盘的一条事实 */
interface FactRow {
  text: string
  date: string
  confidence: number
  visibility: Visibility
  source?: string
  tier?: 'major' | 'normal'
}

/** 把 rules.yaml 里"值得记/不值得记"拼进提示词，让配置真的影响整理 */
function systemPrompt(
  rules: Rules,
  knownFacts: string[] = [],
  knownEpisodes: Array<{ id: string; title: string }> = [],
  isGroup = false,
): string {
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
  // 群聊里必须标明每条事实是谁的，否则只能整段丢掉（原来的做法）
  const groupHint = isGroup
    ? `\n\n# 这是群聊\nfacts 里每一条都必须带 "who"：这句话是关于谁的，用聊天记录里「名字：」的那个名字，一字不差。说不清是谁的事，就不要写进 facts。`
    : ''
  return `${SYSTEM_BASE}

这个人的主人希望：
- 值得记：${值得.join('、')}
- 不值得记：${不值得.join('、')}${known}${eps}${groupHint}`
}

const SYSTEM_BASE = `你在整理一段聊天记录，把它变成长期记忆。只输出 JSON，不要代码块，不要解释。

输出格式：
{
  "episodes": [{"title": "一句话概括", "body": "发生了什么 + 我当时怎么想", "importance": 1, "emotion": "当时的主要情绪", "related": ["相关的已有 episode id"]}],
  "facts": [{"text": "稳定的事实", "confidence": 0.9, "source": "他说过的原话，尽量短", "visibility": "public|private|unsure", "tier": "major|normal", "who": "群聊时填说话人名字，私聊不用填"}],
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
  /**
   * 这次整理是否**完整成功**。
   *
   * 为什么必须有：原来失败和"没什么可记"都返回全 0，调用方分不出来，
   * 于是整理失败也把游标推到 Date.now()，那批消息永远不会被再整理。
   */
  ok: boolean
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

/** 一批最多多少条原文 */
export const DISTILL_BATCH_TURNS = 40
/**
 * 一批 transcript 最多多少字符。
 *
 * 12K 中文字大约 8K token，加上 system prompt 和 1400 输出 token，
 * 对 DeepSeek 的上下文还有很大余量；再大会让单次整理变慢、变贵。
 */
export const DISTILL_BATCH_CHARS = 12_000

/**
 * 把一批原文切成若干小批。
 *
 * 依据：原来一次喂 7 天全部 raw（实测 300 条 → 225 条），
 * 而 prompt 要求"只挑最值得记的 3 件"——一天的对话被压成 3 条 episode，
 * 超过上下文还会整批失败。分批之后每批 40 条，每条消息都有被看见的机会。
 *
 * 切分时**不切断同一毫秒的记录**：游标按批推进，如果两条 ts 相同的消息
 * 被分到两批，失败重试时 `ts <= 游标` 会把后一条永久过滤掉。
 */
export function chunkTurns<T extends { ts: number; text: string }>(
  turns: T[],
  maxTurns = DISTILL_BATCH_TURNS,
  maxChars = DISTILL_BATCH_CHARS,
): T[][] {
  const batches: T[][] = []
  let cur: T[] = []
  let chars = 0

  for (const t of turns) {
    const len = t.text.length + 1
    const overTurns = cur.length >= maxTurns
    const overChars = cur.length > 0 && chars + len > maxChars
    // 同 ts 的尾部记录并进当前批，宁可略超也不拆开
    const sameTs = cur.length > 0 && t.ts === cur[cur.length - 1]!.ts
    if ((overTurns || overChars) && !sameTs) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(t)
    chars += len
  }
  if (cur.length) batches.push(cur)
  return batches
}

function normVisibility(v: string | undefined): Visibility {
  if (v === 'public') return 'public'
  if (v === 'private') return 'private'
  return 'unsure'
}

/** 把一批原文压成 episode / facts / open / insights，并落盘。 */

/**
 * 这两条说的是同一件事吗？还是互相矛盾？
 *
 * 为什么需要它：字符相似度分不出「同一个意思换个说法」。
 * 实测过——同一事实改写后 sim 只有 0.45，而「喜欢猫」vs「喜欢狗」有 0.50。
 * 所以灰色地带（0.45-0.9）交给模型判断，比死抠阈值靠谱。
 *
 * 为什么要分三档而不是 yes/no：
 * 原来 no 同时表示"两件不同的事"和"互相矛盾"，代码只能一律塞进 open 问用户。
 * 结果是"他喜欢猫 / 他喜欢狗"这种无关的两件事也去打扰人；
 * 而真正的矛盾（"他在北京"→"他搬去上海了"）反而只是并存，永远不失效。
 *
 * 只在灰色地带调用：相似度很高直接判重、很低直接当新的，都不花钱。
 */
async function factRelation(a: string, b: string, llm: LlmOptions): Promise<'same' | 'different' | 'contradict'> {
  try {
    const res = await chat(
      [
        {
          role: 'system',
          content:
            '你在判断两条关于同一个人的记录是什么关系。只输出一个词：same / different / contradict。\n' +
            'same = 说的是同一件事，只是换了说法，或者后者更准确。\n' +
            'different = 是两件不同的事，可以同时成立（比如喜欢猫、喜欢狗）。\n' +
            'contradict = 说的是同一个方面，但内容互相矛盾、不能同时成立（比如一个说在北京、一个说在上海；一个说喜欢猫、一个说不喜欢猫）。',
        },
        { role: 'user', content: `第一条：${a}\n第二条：${b}` },
      ],
      { ...llm, maxTokens: 4, temperature: 0 },
    )
    const text = res.text.trim().toLowerCase()
    // 先判 contradict：模型偶尔会写「不是 same，是 contradict」
    if (/contradict|矛盾/.test(text)) return 'contradict'
    // 兼容老模型的 yes/no：no 当"不同的事"，不误判成矛盾
    if (/^(yes|是|同一)/.test(text)) return 'same'
    if (/^(no|不是|不同)/.test(text)) return 'different'
    return /same/.test(text) ? 'same' : 'different'
  } catch {
    // 判断不了就按"不同"处理：宁可多记一条，也别把新信息吞掉
    return 'different'
  }
}

async function distillOnce(opts: DistillOptions): Promise<DistillResult> {
  const result: DistillResult = { ok: true, episodes: 0, facts: 0, open: 0, insights: 0 }
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
  const isPrivateScope = opts.scope.startsWith('private:')
  const isGroupScope = opts.scope.startsWith('group:')
  // 失效事实不喂给模型：否则会告诉它「我已经记得」一句被推翻的话，还叫它别重复记
  const knownFacts = isPrivateScope ? loadFacts(opts.personId).filter((f) => !f.supersededAt).map((f) => f.text) : []
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
        isGroupScope,
      ),
    },
        { role: 'user', content: `聊天记录：\n${transcript}` },
      ],
      { ...opts.llm, maxTokens: 1400, temperature: 0.3 },
    )
  } catch (err) {
    warnAt('整理的模型调用失败，这轮跳过', { scope: opts.scope, err: String(err).slice(0, 80) })
    return { ...result, ok: false }
  }

  const data = parseJson(res.text)
  if (!data) {
    warnAt('整理结果不是合法 JSON，已跳过', { raw: res.text.slice(0, 200) })
    return { ...result, ok: false }
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

  // 新事实和旧事实比对：完全重复的跳过，很像但不一样的记为"待确认"。
  //
  // 私聊：整段都是同一个人的，直接归他。
  // 群聊：按每条事实的 "who" 归到具体的人。原来群聊完全不吃 facts，
  //       代价是"群里认识的人细节永远记不住"；要求模型标 who，
  //       对不上人的（没说清、重名）就跳过——宁可少记，不能记错人。
  const isPrivate = isPrivateScope
  let accepted: FactRow[] = []
  let conflicts: Array<{ text: string; date: string; kind: 'pending' }> = []
  // 待失效的旧事实：等新事实真的写进档案再执行（顺序反了会丢事实）
  const pendingSupersede: Array<{ oldText: string; newText: string }> = []

  if (isPrivate) {
    const r = await mergeFactsInto(opts.personId, data.facts ?? [], date, opts.llm)
    accepted = r.accepted
    conflicts = r.conflicts
    pendingSupersede.push(...r.supersedes)
  } else if (isGroupScope && (data.facts ?? []).length) {
    const index = speakerIndex(opts.turns)
    const byPerson = new Map<string, RawFact[]>()
    let dropped = 0
    for (const f of data.facts ?? []) {
      const pid = matchSpeaker(index, f.who ?? '')
      if (!pid) {
        dropped++
        continue
      }
      const list = byPerson.get(pid) ?? []
      list.push(f)
      byPerson.set(pid, list)
    }
    if (dropped) info(`群聊里 ${dropped} 条事实说不清是谁的，跳过`)

    let total = 0
    for (const [pid, list] of byPerson) {
      const r = await mergeFactsInto(pid, list, date, opts.llm)
      const keptGroup = r.accepted.filter((f) => !isDeleted(pid, f.text))
      if (!keptGroup.length) continue
      appendFacts(pid, keptGroup)
      for (const s of r.supersedes) {
        if (!keptGroup.some((f) => f.text === s.newText)) continue
        supersedeFact(pid, s.oldText, date)
      }
      total += keptGroup.length
    }
    result.facts = total
  }

  // 用户删过的事实不再加回来，否则"删了又被提炼回来"，删了个寂寞
  const kept = accepted.filter((f) => !isDeleted(opts.personId, f.text))
  const revived = accepted.length - kept.length
  if (revived > 0) info(`跳过 ${revived} 条你删过的事实`)

  if (kept.length) {
    appendFacts(opts.personId, kept)
    result.facts = kept.length
  }
  // 新事实确认写进去了，才让旧说法失效
  for (const s of pendingSupersede) {
    if (!kept.some((f) => f.text === s.newText)) continue
    supersedeFact(opts.personId, s.oldText, date)
    conflicts.push({ text: '我记得「' + s.oldText + '」，这次听到「' + s.newText + '」，先按新的记了', date, kind: 'pending' })
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
    // 自述：用户写了就只允许补充，没写就整体交给它（和 reflect 一致）
    if (s?.自述 && s.自述.trim()) {
      const next = s.自述.trim()
      if (doc.aboutOwner === 'it') {
        if (next !== doc.about) {
          doc.about = next
          touched = true
        }
      } else if (next !== doc.aboutExtra) {
        doc.aboutExtra = next.slice(0, 600)
        touched = true
      }
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

  // 群聊整理时顺带学黑话和说法：这时候正好有一整段对话在手。
  //
  // 两件事分开学，因为学的东西不一样：
  //   - 黑话：这个词在这个群里是什么意思（听懂）
  //   - 说法：这个群平时怎么说话（会说）
  if (opts.scope.startsWith('group:')) {
    const gid = opts.scope.slice('group:'.length)
    void learnJargon(opts.turns, opts.llm, gid).catch(() => {})
    void learnExpressions(opts.turns, opts.llm, gid, opts.rules).catch(() => {})
  }

  info('整理完成', { person: opts.personId, scope: opts.scope, ...result })

  if (result.facts > 0 && opts.scope.startsWith('private:')) {
    void refreshProfile(opts.llm, opts.personId).catch(() => {})
  }

  return result
}

/**
 * 群聊里「名字 → personId」的索引。
 *
 * 重名的记为 null（不归属）：群里两个人都叫「小明」时，
 * 把事实写到其中任何一个头上都是错的，宁可这条不记。
 */
function speakerIndex(turns: RawTurn[]): Map<string, string | null> {
  const pidsOfName = new Map<string, Set<string>>()
  for (const t of turns) {
    if (t.role !== 'user' || !t.senderId) continue
    const pid = personOfAccount('qq', t.senderId)
    const name = (loadPerson(pid)?.name ?? '').trim()
    if (!name) continue
    const set = pidsOfName.get(name) ?? new Set<string>()
    set.add(pid)
    pidsOfName.set(name, set)
  }
  const out = new Map<string, string | null>()
  for (const [name, set] of pidsOfName) {
    out.set(name, set.size === 1 ? [...set][0]! : null)
  }
  return out
}

/** 模型填的 who 对上谁；对不上、重名、或者没填 → null（这条不记） */
function matchSpeaker(index: Map<string, string | null>, who: string): string | null {
  // 模型偶尔会写「小明（刚才说话那个）」，把括号里的解释去掉再比
  const clean = who.replace(/[（(][^）)]*[）)]/g, '').trim()
  if (!clean) return null
  const hit = index.get(clean)
  if (hit !== undefined) return hit
  for (const [name, pid] of index) {
    if (!pid) continue
    if (clean.includes(name) || name.includes(clean)) return pid
  }
  return null
}

/**
 * 把一批模型给的事实践并进某个人的档案。
 *
 * 拆出来的原因：私聊只有一个人，群聊要按发言人分给不同的人，
 * 但"去重 / 锁定 / 冲突转待确认"这套判断必须完全一样，
 * 否则群里记的事实和私聊记的会各走一套规则。
 */
async function mergeFactsInto(
  personId: string,
  raws: RawFact[],
  date: string,
  llm: LlmOptions,
): Promise<{
  accepted: FactRow[]
  conflicts: Array<{ text: string; date: string; kind: 'pending' }>
  /** 需要失效的旧事实：调用方确认新事实写进去了再执行 */
  supersedes: Array<{ oldText: string; newText: string }>
}> {
  const accepted: FactRow[] = []
  const conflicts: Array<{ text: string; date: string; kind: 'pending' }> = []
  const supersedes: Array<{ oldText: string; newText: string }> = []
  // 只和「在世」的事实比：失效的还参与判定的话，会判成 same 去 touch 一条死事实
  const existing = loadFacts(personId).filter((f) => !f.supersededAt)

  for (const raw of raws) {
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

    // 用户确认过的事实是锁定的：像它的新说法一律不碰，既不刷新也不覆盖，
    // 更不把它当成冲突去问用户。只有确实无关的新事实才继续往下走。
    if (best && best.old.by === 'me' && best.sim >= 0.45) continue

    if (best && best.sim > 0.9) {
      // 这条又提到了：刷新确认日期，别让它慢慢过期
      touchFact(personId, best.old.text, date)
      continue
    }
    // 灰色地带：字符相似度分不出「换个说法」和「另一件事」，问模型。
    // 之前这里直接当冲突让用户确认，结果同一件事换个说法就被反复问。
    if (best && best.sim >= 0.45) {
      const rel = await factRelation(best.old.text, text, llm)
      if (rel === 'same') {
        // 同一件事：刷新确认，顺便把更准确的说法留下
        touchFact(personId, best.old.text, date)
        if (text.length > best.old.text.length && best.old.text.length < text.length * 0.8) {
          // 新说法明显更详细，补一条（旧的会被 touch，不会重复计数）
          accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
        }
        continue
      }
      if (rel === 'contradict') {
        // 矛盾：先记下要失效谁，等调用方确认新事实确实写进档案了再失效。
        // 之前这里直接 supersedeFact —— 新事实随后被「删过的」过滤掉时，
        // 旧事实已经永久失效、又没有替代，一句话就这么没了。
        supersedes.push({ oldText: best.old.text, newText: text })
        accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
        continue
      }
      // different：两件不同的事，可以同时成立——直接记，别去打扰用户
      accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
      continue
    }
    accepted.push({ text, date, confidence, visibility, tier, ...(source ? { source } : {}) })
  }

  return { accepted, conflicts, supersedes }
}

/**
 * 整理一批原文（对外入口）。
 *
 * 超过一批上限就自动拆成几批顺序整理，结果累加。
 * 为什么在入口处拆、而不是让调用方拆：手动整理、定时整理、CLI 都走这里，
 * 一个入口才不会再出现"某个入口忘了分批"。
 *
 * **任一批失败就整体返回 ok:false**，调用方据此决定要不要推进游标。
 * 已经成功的那几批数据已经落盘了，重试时可能重复——宁可重复，不能丢。
 */
export async function distill(opts: DistillOptions): Promise<DistillResult> {
  const batches = chunkTurns(opts.turns)
  if (batches.length <= 1) return distillOnce(opts)

  const total: DistillResult = { ok: true, episodes: 0, facts: 0, open: 0, insights: 0 }
  for (const [i, batch] of batches.entries()) {
    info(`整理分批：${opts.scope} 第 ${i + 1}/${batches.length} 批，${batch.length} 条`)
    const r = await distillOnce({ ...opts, turns: batch })
    total.episodes += r.episodes
    total.facts += r.facts
    total.open += r.open
    total.insights += r.insights
    if (r.life) total.life = (total.life ?? 0) + r.life
    if (!r.ok) return { ...total, ok: false }
  }
  return total
}

export { loadOpen }
