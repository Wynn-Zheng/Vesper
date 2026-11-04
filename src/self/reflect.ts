import { info, warnAt } from '../core/log.ts'
import { similarity } from '../core/text.ts'
import { localDate } from '../core/time.ts'
import { chat } from '../llm/deepseek.ts'
import type { LlmOptions } from '../llm/types.ts'
import type { Rules } from '../core/config.ts'
import { recentRaw, loadEpisodes } from '../memory/store.ts'
import { loadOpen } from '../people/open.ts'
import { listPeople, savePerson } from '../people/store.ts'
import { appendLife, loadLife, loadSelf, logDrift, saveSelf } from './store.ts'
import { listAbilities, renderAbilities } from './abilities.ts'
import { loadWill, saveWill, setImpression } from './will.ts'
import { applyCardField, loadCard, renderCard, saveCard, SELF_EDITABLE_FIELDS } from '../persona/card.ts'
import { addIntent } from '../memory/intent.ts'

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
  "对每个人的称呼": {"人": "你平时怎么叫他 —— 不是他的真名，是你给他起的叫法（一两个字的昵称/外号都行；没想法就留空对象）"},
  "在想": "最近脑子里的一件具体的事（不是感悟，见下面的规则）",
  "取名": "主人明确给你起了名字或改了叫法（比如「你叫小鱼」「以后叫你小鱼」）就照写；还没有名字、又真觉得时机到了，也可以自己取一个。都不是就空字符串",
  "取名原因": "为什么叫这个（没取名就空字符串）",
  "生活": ["我自己那边发生的一件具体小事。可以只写状态（困/累/不想动/心情），不一定要做成什么事。今天真没什么就返回空数组", "最多两条，和具体的某个人无关"],
  "学到": ["今天看到/想通、觉得以后用得上的东西（知识、方法、道理）。没有就空数组；最多两条，每条一句话"]
}

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
- 生活不是"我和他聊了什么"，**也不是"我今天看了什么视频"**，是"我自己那边发生的具体小事"。
- **最近三天写过的东西别再写**：同样的物件、同样的场景、同样的动作，换个说法也不要。
  看看下面「我自己的生活记录」——如果这几天都在写折纸 / 水壶 / 桌面，就换一类事。
- **可以只写状态**：困了、累了、不想动、心情、天气、噪音、身体上的小事。
  真人不是每天都在做事；一连几天"在忙同一件手工"反而不像人。
- **今天真的没什么，就返回空数组**。空着比硬凑一条更像真的。
- 不要编造和别人的共同经历。
- 不要为了填满而凑数，没东西写就返回空数组 / 空字符串。
- **看看"我自己的生活记录"里已经写过什么。同一件事换个说法再写一遍没有意义——
  想到了新的层面才写，只是措辞不同就跳过。**
- 如果一直在琢磨同一件事，说明它对你真的很重要，但也要往深里走一步，
  而不是把上次的话重说一遍。
- **「在想」尤其容易重复**。看看之前写过什么；如果这次还是同一件事、只是换个说法，
  就让它空着。空着比重复强。
- 取名这件事很重：**主人明确说了**（"你叫小鱼""以后叫你小鱼"）就照办，这是他的决定；
  他没说、你又已经有名字的话，别自己换 —— "这个名字像我"才取，不要随便挑一个。
- **「对每个人的称呼」**：是你给他起的叫法，不是他的真名（"老张""阿鱼""喂"都行）。
  只有你**真的觉得想换个叫法**时才写；已经叫惯了的就别动；没想法就返回空对象。
  主人填过的建议只是建议 —— 你不喜欢可以不用，用你自己想叫的。`

interface Out {
  自述?: string
  自述变化?: string
  '我能做什么'?: string
  '今天想说话吗'?: boolean
  '为什么想/不想'?: string
  '今天想看视频吗'?: boolean
  '为什么'?: string
  '对每个人的印象'?: Record<string, string>
  /** 它给这些人起的称呼（不是真名） */
  对每个人的称呼?: Record<string, string>
  在想?: string
  取名?: string
  取名原因?: string
  生活?: string[]
  学到?: string[]
  /** 只在「它能自改角色卡」打开时才有 */
  角色卡修改?: Array<{
    字段?: string
    新值?: string
    多想改?: number
    为什么?: string
  }>
}

/** 每 12 小时最多真的改几项 */
const MAX_CARD_CHANGES = 2
/** 「非常想改」的门槛：没排上但 >= 这个分，就转成「想做的事」留到下次 */
const CARRY_OVER_SCORE = 7

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

/**
 * 从最近的原话里认出"主人给它改名"这件事。
 *
 * 只在**主人说的**那几条里找，认这几种说法：
 *   「以后叫你小鱼」「你叫小鱼吧」「就叫你小鱼」「以后叫小鱼」
 * 认出来就返回新名字；没有返回空字符串。
 *
 * 为什么不交给模型判断：实测把原话喂进去、prompt 也写了"主人说了就照办"，
 * 它仍然返回空字符串 —— 这种事不该靠概率。
 */
/** 容易被当成名字的常用词（「叫外卖吧」「叫同学来」） */
const RENAME_STOP = new Set([
  '外卖', '快递', '同学', '朋友', '老师', '师傅', '老板', '阿姨', '叔叔', '爷爷', '奶奶',
  '一声', '一下', '起来', '出来', '名字', '什么', '名字吗', '我', '你', '它', '他', '她',
])

export function detectRenameFromRecent(turns: Array<{ role: string; text: string }>): string {
  // 只要用户说的；从新到旧找
  const users = turns.filter((t) => t.role === 'user')
  const counts = new Map<string, { n: number; explicit: boolean }>()
  for (let i = users.length - 1; i >= 0; i--) {
    const t = users[i]!.text.replace(/\s+/g, ' ')
    // 必须出现「叫你 / 叫它」这种明确的称呼动作。
    // 以前 `叫(?:你|它)?` 里的「你/它」是可选的，于是「今天叫了个外卖」「这菜叫红烧肉」
    // 都算改名——有个用户的角色名被改成了菜名。
    // 另外候选限制 2–4 字（名字不会是一个字，也不可能是一句话）。
    const m =
      /(?:以后|从今往后|就|那就)?(?:叫|喊)(?:你|它)\s*[「"']?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{1,3})(?=[吧啊呀呢了哦嘛，。！？\s]|$)/.exec(
        t,
      )
    if (!m) continue
    const cand = m[1]!.replace(/[吧啊呀呢了哦嘛]$/, '').trim()
    if (cand.length < 2 || cand.length > 4) continue
    if (/(什么|啥|谁|哪|怎么|多少)/.test(cand)) continue
    if (RENAME_STOP.has(cand)) continue
    const explicit = /以后|从今往后/.test(t)
    const cur = counts.get(cand) ?? { n: 0, explicit: false }
    counts.set(cand, { n: cur.n + 1, explicit: cur.explicit || explicit })
  }
  // 说了「以后叫你 X」一次就算数；只说「叫你 X」要出现两次，
  // 免得一次口误（"叫他小心点"）就把名字改了。
  for (const [name, v] of counts) if (v.n >= 2 || v.explicit) return name
  return ''
}
export async function reflectSelf(opts: SelfReflectOptions): Promise<boolean> {
  const doc = loadSelf()
  // 只在开关打开时才读角色卡：关着的时候连读都不读，省一次 IO
  const canEditCard = Boolean(opts.rules.人格.它能自改角色卡)
  const card = canEditCard ? loadCard() : null
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
    doc.aboutOwner === 'me'
      ? // 用户写的原文是锁的，模型只能补，不能改
        `# 我是谁（这段是主人写的，你不能改它）\n${doc.about || '（还没写）'}\n\n` +
        `# 你之前补充的（可以更新，但要保留说对了的部分）\n${doc.aboutExtra || '（还没有）'}\n\n` +
        '注意：上面「我是谁」那一段是主人写死的，别复述、别改写、别把它当自己的话重说一遍。' +
        '你只写自己最近新发现的、和那段不重复的东西，短一点没关系。'
      : `# 我现在对自己的认识\n${doc.about || '（还没想清楚）'}`,
    // 上次写的思考要标清楚"已经写过了"。
    // 不标的话模型会顺着上次的话题继续想——实测会连着几天都在琢磨同一件事，
    // 然后那件事又进了自己的记录，越滚越窄。
    `\n# 我最近想的事（已经写过，除非真的有新进展，否则换一件事）\n${doc.thinking || '（还没有）'}`,
    // 最近的对话：反思必须能看到"主人最近跟我说了什么"。
    // 之前这里只有经历/生活/角色卡，**没有原话** —— 所以主人在对话里说
    // "以后叫你小鱼"，反思根本看不到，也就不会去改「取名」。
    `\n# 最近跟人说的话（原话，别复述，但你要知道发生过什么）\n${
      recentRaw(40)
        .map((t) => `${t.role === 'user' ? '他' : '我'}：${t.text.replace(/\s+/g, ' ').slice(0, 80)}`)
        .join('\n') || '（还没有）'
    }`,
    `\n# 我有没有名字\n${doc.name ? `叫「${doc.name}」，因为${doc.nameReason}` : '还没有名字'}`,
    life.length ? `\n# 我自己的生活记录（最近，这些也都写过了，别重复）\n${life.map((e) => e.lines.map((l) => `- ${l}`).join('\n')).join('\n')}` : '',
    `\n# 最近发生过的事\n${episodes.map((e) => `- ${e.date}｜${e.title}`).join('\n') || '（没有）'}`,
    `\n# 我认识的人\n${known || '（还没有）'}`,
    `\n${renderAbilities(listAbilities(opts.rules))}`,
    card
      ? `\n# 你现在的角色卡（这是主人给你定的底子，你在它上面活）\n${renderCard(card).trim()}\n\n` +
        `# 你可以改自己的角色卡\n` +
        `从上面挑你真想改的，想改的程度打 1-10 分。每 12 小时最多真的改 ${MAX_CARD_CHANGES} 项，` +
        `剩下的如果你打了 ${CARRY_OVER_SCORE} 分以上，会变成「想做的事」留到下次；其余就放下。\n` +
        `能改的字段只有：${SELF_EDITABLE_FIELDS.join('、')}。\n` +
        `名字、生日、外貌、身份 不要动 —— 那是主人定的，你只能提申请。\n` +
        `在 JSON 里用 "角色卡修改" 输出，例如：\n` +
        `[{"字段":"核心特质","新值":"更愿意先听完再开口","多想改":8,"为什么":"发现自己老抢话"}]`
      : '',
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

    // 取名：只在**还没名字**时由它自己取；**主人明确给你改名**时也允许改。
    //
    // 以前条件写死 `!doc.name`：一旦有了名字，主人在对话里说"你叫小鱼"
    // 它也不会动 —— 表现为"我跟它说了它还是叫大肥鱼"。
    //
    // 而且**不能只靠模型**：实测把原话放进材料、prompt 也写了"主人说了就照办"，
    // 它照样返回空字符串。所以主人在原话里明确说的，这里直接认，确定性优先。
    const wantedName =
      (out.取名 ?? '').trim() || detectRenameFromRecent(recentRaw(60))
    if (wantedName && wantedName !== doc.name) {
      // 自己取（没名字时）或主人明确改名，两种都收；理由分开记
      const byOwner = !(out.取名 ?? '').trim()
      doc.name = wantedName
      doc.nameReason =
        (out.取名原因 ?? '').trim() ||
        (byOwner ? '主人给改的' : '在整理记忆的时候，觉得这个名字像我')
      touched = true
      info(`它改名了：${doc.name}`, { 原因: doc.nameReason, 来源: byOwner ? '原话识别' : '模型' })
    }
    // 用户写了「我是谁」就锁住 —— 否则他刚改完、下一次反思就被模型版本盖掉，
    // 看起来就像"刚才写的东西被清空了"。
    // 自述：用户写了就只允许补充，没写就整体交给它
    if (out.自述 && out.自述.trim()) {
      const next = out.自述.trim()
      if (doc.aboutOwner === 'it') {
        if (next !== doc.about) {
          doc.about = next
          touched = true
        }
      } else if (next !== doc.aboutExtra) {
        // 「我写」模式：原文锁死，只更新它补充的那一段
        doc.aboutExtra = next.slice(0, 600)
        touched = true
      }
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
    // 角色卡：只在「它能自改角色卡」打开时处理。
    // 按「多想改」排序，最多真的改 2 项；>=7 分但没排上的转成「想做的事」，其余丢弃。
    if (canEditCard && card && Array.isArray(out.角色卡修改)) {
      const allowed = new Set(SELF_EDITABLE_FIELDS as readonly string[])
      const changes = out.角色卡修改
        .map((c) => ({
          field: String(c?.字段 ?? '').trim(),
          value: String(c?.新值 ?? '').trim(),
          score: Number(c?.多想改) || 0,
          why: String(c?.为什么 ?? '').trim(),
        }))
        .filter((c) => allowed.has(c.field) && c.value)
        .sort((a, b) => b.score - a.score)

      const applied = changes.slice(0, MAX_CARD_CHANGES)
      for (const c of applied) applyCardField(card, c.field, c.value)
      if (applied.length) {
        saveCard(card)
        info('它改了自己的角色卡', {
          改动: applied.map((c) => `${c.field}→${c.value.slice(0, 20)}`).join('；'),
        })
      }

      for (const c of changes.slice(MAX_CARD_CHANGES)) {
        if (c.score < CARRY_OVER_SCORE) continue
        addIntent(`想改自己的${c.field}：${c.value.slice(0, 60)}`, '我自己想到的')
        info('它把没改成的想法记成待办', { 字段: c.field, 想改分数: c.score })
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
      // 它自己学到的：放在 saveSelf 之后 —— 写学习记录失败不该把本轮自述/取名一起回滚
      if (Array.isArray(out.学到)) {
        try {
          const { addLearning } = await import('../persona/learnings.ts')
          for (const t of out.学到) {
            if (typeof t !== 'string') continue
            const learnText = t.trim()
            if (learnText.length >= 4 && learnText !== '[object Object]') {
              addLearning(learnText.slice(0, 300), '知识', 'itself')
            }
          }
        } catch (e) {
          warnAt('写学习记录失败（不影响本轮反思）', { err: String(e) })
        }
      }
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
      // 本地日期：toISOString() 是 UTC，凌晨 0–8 点写的生活记录会记成前一天
      const today = localDate()
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

    // 它给这些人起的称呼：反思时自己取，写进 people/<id>/meta.json 的 callName。
    // 主人填的 callNameSuggested 只是建议，它这里写什么就是什么 —— 以它为准。
    const callNames = out['对每个人的称呼']
    if (callNames && typeof callNames === 'object' && !Array.isArray(callNames)) {
      for (const [name, call] of Object.entries(callNames)) {
        const c = String(call ?? '').trim().slice(0, 12)
        if (!c) continue
        const target = people.find((p) => p.name === name || p.id === name)
        if (!target) continue
        if (target.callName === c) continue
        target.callName = c
        savePerson(target)
        info(`它给「${target.name}」换了个叫法：${c}`)
      }
    }
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
