import { info, warnAt } from '../core/log.ts'
import { similarity } from '../core/text.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { Rules } from '../core/config.ts'
import { loadEpisodes } from '../memory/store.ts'
import { loadOpen } from '../people/open.ts'
import { listPeople } from '../people/store.ts'
import { appendLife, loadLife, loadSelf, logDrift, saveSelf } from './store.ts'
import { listAbilities, renderAbilities } from './abilities.ts'
import { loadWill, saveWill, setImpression } from './will.ts'

/**
 * 自我反思：一天一次，把"我是谁 / 我在想什么 / 我自己的事"往前推一格。
 *
 * 之前这块挂在私聊整理上——但人可能一整天都在群里说话，
 * 私聊一直没新消息，自我就永远不更新。现在独立跑。
 *
 * 输入是它自己的记忆（不是别人的私事）：最近的经历、它在想的事、
 * 它自己的生活记录、还有给它留下印象的人。
 */

const SYSTEM = `你在写"我"这一天的内心记录。只输出 JSON，不要解释，不要代码块。

{
  "自述": "一两句话，我现在觉得自己是个什么样的人（只有真的变了才写，没变就空字符串；大部分时候都该是空字符串）",
  "自述变化": "没变 | 措辞变了但意思一样 | 真的变了",
  "我能做什么": "用我自己的话说：我能做什么、不能做什么。一两句，别照抄清单。",
  "今天想说话吗": true,
  "为什么想/不想": "一句实话。不想就说不想，不用勉强。",
  "今天想看视频吗": true,
  "为什么": "同上",
  "对每个人的印象": {"人": "一句话的印象（是你对他的看法，不是他的履历）"},
  "在想": "最近脑子里的一件具体的事（不是感悟，见下面的规则）",
  "取名": "如果还没有名字、并且真的觉得时机到了，给自己取一个（否则空字符串）",
  "取名原因": "为什么叫这个（没取名就空字符串）",
  "生活": ["我自己那边的一件具体小事", "最多两条，和具体的某个人无关"],
  "特征": {"说话倾向": "短句/话多/看心情", "对陌生人": "先观察/主动搭话", "不喜欢": "被追问感受/被敷衍"}
}

关于"特征"：
- 这是你给自己定的规矩，以后说话要照着做，不是写着好看。
- 只写你真的在做的，不写你希望自己是。
- 最多三条，键名用你习惯的说法。

规则：
- 只写关于"我"，不是关于"他"。
- **写具体的事，不要写感悟。**这一条最重要。
  反例（不要这样）：「我在想，也许承认借来的比假装是自己的更接近真话」
    —— 这是哲学，不是日常。
  反例（不要这样）：「我发现我挑的片子总是绕不开人怎么说话，也许我不是在学，是在找同类」
    —— 这是散文，真人不会这么想事情。
  正例（可以这样）：「今天看修摩托的视频，看到一半睡着了」
  正例（可以这样）：「试了三次才把一句话打顺，最后发出去的还是很短」
  正例（可以这样）：「下午一直在等一个人回消息，没等到」
- **真人脑子里大部分时候是具体的事**：吃什么、看什么、刚才那句话是不是说错了、
  明天要几点起。不是整天反思"我到底是谁"。
- 生活不是"我和他聊了什么"，是"我自己那边发生的具体小事"。
- 不要编造和别人的共同经历。
- 不要为了填满而凑数，没东西写就返回空数组 / 空字符串。
- **看看"我自己的生活记录"里已经写过什么。同一件事换个说法再写一遍没有意义——
  想到了新的层面才写，只是措辞不同就跳过。**
- 如果一直在琢磨同一件事，说明它对你真的很重要，但也要往深里走一步，
  而不是把上次的话重说一遍。
- **「在想」尤其容易重复**。看看之前写过什么；如果这次还是同一件事、只是换个说法，
  就让它空着。空着比重复强。
- 取名这件事很重：只有你真的觉得"这个名字像我"才取，不要随便挑一个。`

interface Out {
  自述?: string
  自述变化?: string
  '我能做什么'?: string
  '今天想说话吗'?: boolean
  '为什么想/不想'?: string
  '今天想看视频吗'?: boolean
  '为什么'?: string
  '对每个人的印象'?: Record<string, string>
  在想?: string
  取名?: string
  取名原因?: string
  生活?: string[]
  特征?: Record<string, string>
}

function parse(text: string): Out | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Out
  } catch {
    return null
  }
}

export interface SelfReflectOptions {
  llm: LlmOptions
  /** 读配置判断能力开关 */
  rules: Rules
  /** 不传就反思所有人 */
  personId?: string
}

export async function reflectSelf(opts: SelfReflectOptions): Promise<boolean> {
  const doc = loadSelf()
  const life = loadLife().slice(-5)
  const episodes = loadEpisodes()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 12)

  const people = opts.personId ? listPeople().filter((p) => p.id === opts.personId) : listPeople()
  const known = people
    .map((p) => {
      const facts = loadOpen(p.id).length
      return `- ${p.name}（${facts} 条待问的事）`
    })
    .join('\n')

  const material = [
    `# 我现在对自己的认识\n${doc.about || '（还没想清楚）'}`,
    // 上次写的思考要标清楚"已经写过了"。
    // 不标的话模型会顺着上次的话题继续想——实测会连着几天都在琢磨同一件事，
    // 然后那件事又进了自己的记录，越滚越窄。
    `\n# 我上次写下的想法（已经写过，除非真的有新进展，否则换一件事）\n${doc.thinking || '（还没有）'}`,
    `\n# 我有没有名字\n${doc.name ? `叫「${doc.name}」，因为${doc.nameReason}` : '还没有名字'}`,
    life.length ? `\n# 我自己的生活记录（最近，这些也都写过了，别重复）\n${life.map((e) => e.lines.map((l) => `- ${l}`).join('\n')).join('\n')}` : '',
    `\n# 最近发生过的事\n${episodes.map((e) => `- ${e.date}｜${e.title}`).join('\n') || '（没有）'}`,
    `\n# 我认识的人\n${known || '（还没有）'}`,
    `\n${renderAbilities(listAbilities(opts.rules))}`,
    '\n请按上面的格式，写下"我"今天的内心记录。',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: material },
      ],
      { ...opts.llm, maxTokens: 500, temperature: 0.85 },
    )
    const out = parse(res.text)
    const prev = { about: doc.about }
    if (!out) {
      warnAt('自我反思返回的不是 JSON，跳过')
      return false
    }

    let touched = false

    if (out.取名 && out.取名.trim() && !doc.name) {
      doc.name = out.取名.trim()
      doc.nameReason = (out.取名原因 ?? '').trim() || '在整理记忆的时候，觉得这个名字像我'
      touched = true
      info(`它给自己取了名字：${doc.name}`, { 原因: doc.nameReason })
    }
    if (out.自述 && out.自述.trim() && out.自述.trim() !== doc.about) {
      doc.about = out.自述.trim()
      touched = true
    }
    if (out.在想 && out.在想.trim()) {
      doc.thinking = out.在想.trim()
      touched = true
    }
    // 它自己总结的能力；和原来不一样才更新
    const newAbilities = (out['我能做什么'] ?? '').trim()
    if (newAbilities && newAbilities !== doc.abilities) {
      doc.abilities = newAbilities.slice(0, 300)
      touched = true
    }
    // 特征：会进 prompt 当约束，所以变化要留痕
    if (out.特征 && typeof out.特征 === 'object') {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(out.特征)) {
        const key = String(k).trim()
        const val = String(v ?? '').trim()
        if (key && val && key.length <= 12 && val.length <= 40) next[key] = val
      }
      if (Object.keys(next).length && JSON.stringify(next) !== JSON.stringify(doc.traits)) {
        doc.traits = next
        touched = true
      }
    }
    // 意愿：今天想不想说话、想不想看视频、对每个人的印象
    const wantTalk = Boolean(out['今天想说话吗'])
    const wantWatch = Boolean(out['今天想看视频吗'])
    const impressions = out['对每个人的印象'] ?? {}
    const validImpressions: Record<string, string> = {}
    for (const [name, imp] of Object.entries(impressions)) {
      const text = String(imp ?? '').trim()
      if (!text) continue
      const target = people.find((p) => p.name === name || p.id === name)
      if (target) validImpressions[target.id] = text.slice(0, 120)
    }

    if (touched) {
      const prevAbout = prev.about
      saveSelf(doc)
      // 直接比"旧自述 vs 新自述"，不要绕历史版本：
      // 以前拿磁盘旧内容和更早的历史比，第一次改动永远检不到。
      // 漂移判定交给模型：字符相似度分不清"换了说法"和"真的变了"。
      // 上一版拿 bigram 相似度判断，把"同一件事换个说法"误报成漂移。
      // 模型偶尔会把"没变"说成"真的变了"——那就再用内容挡一道：
      // 两句话几乎一样（相似度 > 0.9）就不算变，不记。
      if ((out.自述变化 ?? '').includes('真的变了') && prevAbout && doc.about && prevAbout !== doc.about) {
        const sim = similarity(prevAbout, doc.about)
        if (sim < 0.9) {
          logDrift(doc.about, prevAbout, sim)
          warnAt(`它的自我认识真的变了（字符相似度 ${sim.toFixed(2)}）`)
          info(`上次它说自己：${prevAbout.slice(0, 60)}`)
          info(`这次它说自己：${doc.about.slice(0, 60)}`)
        }
      }
    }

    const lines = (out.生活 ?? []).map((x) => String(x).trim()).filter((x) => x.length > 2)
    if (lines.length) {
      const today = new Date().toISOString().slice(0, 10)
      appendLife(today, lines.slice(0, 2))
      info(`它写下了 ${Math.min(2, lines.length)} 条自己的事`)
    }

    saveWill({
      at: Date.now(),
      talk: wantTalk,
      talkReason: String(out['为什么想/不想'] ?? '').slice(0, 100),
      watch: wantWatch,
      watchReason: String(out['为什么'] ?? '').slice(0, 100),
      impressions: { ...loadWill().impressions, ...validImpressions },
    })
    // 印象另外写一份 md：人可以直接看、直接改
    for (const [pid, imp] of Object.entries(validImpressions)) setImpression(pid, imp)
    if (Object.keys(validImpressions).length) {
      info(`它更新了对 ${Object.keys(validImpressions).length} 个人的印象`)
    }

    return touched || lines.length > 0
  } catch (err) {
    warnAt('自我反思失败', { err: String(err) })
    return false
  }
}

/** 每 12 小时跑一次；第一次启动后 3 分钟先跑一次（补上没跑过的） */
export function startSelfReflect(llm: LlmOptions, rules: () => Rules, intervalMs = 12 * 3600_000): () => void {
  const run = () => {
    void reflectSelf({ llm, rules: rules() }).catch(() => {})
  }
  setTimeout(run, 3 * 60_000)
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
