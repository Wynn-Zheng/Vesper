import { rand, say, sleep } from './channel/send.ts'
import type { Rules } from './core/config.ts'
import { talkValueOf, resolveDebounce } from './core/config.ts'
import { scoreReply } from './loop/score.ts'
import { popLastAssistant, pushHeard } from './loop/session.ts'
import { decideQuote, QUOTE_THRESHOLD } from './loop/quote.ts'
import { decayedMood, loadMood } from './persona/mood.ts'
import { info, warnAt } from './core/log.ts'
import { allow, hit, peek } from './core/ratelimit.ts'
import type { Transport } from './core/transport.ts'
import type { Incoming } from './core/types.ts'
import type { LlmOptions } from './llm/types.ts'
import { appendRaw } from './memory/store.ts'
import { watchOne } from './outward/watch.ts'
import { personOfMessage, scopeOf } from './memory/scope.ts'
import { ensurePerson } from './people/store.ts'
import { refreshGroupMembers, groupMembers, isKnownMember, setGroupMembersMissingHook } from './people/group.ts'
import { drainEvaluations, evaluateTurn } from './relation/evaluate.ts'
import { judgeReply } from './loop/judge.ts'
import { recordPlayReviewed } from './learn/plays.ts'
import { maybeSendEmoji } from './loop/chat.ts'

/**
 * 退避：连续决定不说话后，慢一点再看。
 * 不加这个的话，它决定沉默时每条新消息还会全速跑一遍打分——
 * 群里刷屏的时候等于白烧 token。
 */
const backoff = new Map<string, { since: number; count: number; pending: number }>()
export interface BootOptions {
  /** 每次消息都取一次，这样 rules.yaml 改了能立刻生效 */
  getRules: () => Rules
  /** 收到消息后返回要说的内容。空字符串 = 沉默 */
  reply: (m: Incoming, rules: Rules) => Promise<string> | string
  /** 有的话，每轮结束后异步评估一次关系变化 */
  llm?: LlmOptions
  /**
   * 记一笔「这个人在这个群刚跟它说过话」（连续对话窗口的锚点）。
   *
   * 由 index.ts 接到 transport 的 recentTalkers 上。boot 自己不持有那个 Map
   * ——它属于通道层。成功发出一条群回复后调一次，窗口就锚在"它真说话"的时刻，
   * 而不是"上次被 @"：只锚 @ 的话，连聊三分钟会突然断掉。
   */
  touchTalker?: (groupId: string, userId: string) => void
}

/** 这类短消息可以偶尔不回 */
/**
 * 改口用的句子。
 *
 * 为什么用预设句而不是让模型现生成：
 *   改口本来就该短、该含糊（"算了，当我没说"没人会写小作文），
 *   现生成反而容易变成长篇认错。而且这是低频行为，不值一次模型调用。
 */
const FIX_LINES = [
  '不对，刚才那句说岔了。',
  '算了，当我没说。',
  '……说错了，别当真。',
  '嗯，上一条不太行，我收回。',
  '等等，我刚才说得不对。',
]

const SKIPPABLE = /^(嗯+|哦+|噢+|好+|行|OK|ok|收到|在吗|在不在|哈哈+|呵+|笑死|草|6+)[。！？~～. ]*$/


/**
 * 记一次"决定不说话"，并按次数算下次最早什么时候再看。
 * 退避时间是 起始秒 × 2^(次数-连几次开始)，封顶 上限秒。
 */
function enterBackoff(scope: string, rules: Rules): void {
  const cfg = rules.行为.退避
  if (!cfg) return
  const prev = backoff.get(scope)
  const count = (prev?.count ?? 0) + 1
  let waitMs = 0
  if (count >= cfg.连几次开始) {
    const step = count - cfg.连几次开始
    const sec = Math.min(cfg.上限秒, cfg.起始秒 * Math.pow(2, step))
    waitMs = sec * 1000
  }
  backoff.set(scope, { since: Date.now() + waitMs, count, pending: 0 })
}


/**
 * 这一轮要不要引用对方那句。
 *
 * 判定逻辑在 loop/quote.ts（依据会话分析研究，见那里的注释）。
 * 这里只负责把现场的数据凑齐交给它。
 */
function shouldQuote(
  rules: Rules,
  kind: 'group' | 'private',
  batch: { textsCount: number; sendersCount: number; spanMs: number },
  m: Incoming,
  quoteIt: { addressed: boolean; targetLen: number; reply: string; moodIntensity: number; sinceLastQuoteMs: number },
): { quote: boolean; score: number; reasons: string[] } {
  const f = rules.说话.引用频率
  if (f === 'never') return { quote: false, score: 0, reasons: ['配置为 never'] }

  const d = decideQuote({
    kind,
    textsCount: batch.textsCount,
    sendersCount: batch.sendersCount,
    spanMs: batch.spanMs,
    targetLen: quoteIt.targetLen,
    reply: quoteIt.reply,
    addressed: quoteIt.addressed,
    moodIntensity: quoteIt.moodIntensity,
    sinceLastQuoteMs: quoteIt.sinceLastQuoteMs,
  })

  // often 相当于把门槛降一格（用户主动要求多引一点），never 上面已经拦掉
  if (f === 'often' && !d.quote && d.score >= QUOTE_THRESHOLD - 1) {
    return { quote: true, score: d.score, reasons: [...d.reasons, '（often 降一级）'] }
  }

  void m
  return d
}


/** 命中了屏蔽词/正则就不该处理这条 */
function shouldDrop(text: string, rules: Rules): boolean {
  const f = rules.消息过滤
  if (!f) return false
  const t = text.trim()
  if (!t) return false
  for (const w of f.屏蔽词 ?? []) {
    if (w && t.includes(w)) return true
  }
  for (const r of f.屏蔽正则 ?? []) {
    if (!r) continue
    try {
      if (new RegExp(r).test(t)) return true
    } catch {
      // 正则写错不该炸消息处理，配置检查会另外报
    }
  }
  return false
}

/** 用户要求撤回刚才那句 */
const RECALL_HINT = /撤回|收回去|撤掉|刚才那句不对|别说那句|收回/g
/** 让"去看个视频"能真的触发一次，不然它只能说"我没有这个口子" */
const WATCH_HINT = /(去看|看看|刷)(个|一个|点)?视频|去看点东西|去外面看看/
/** 否定句不算：「别去看视频了」「不用刷视频」是让它停，不是让它去 */
const WATCH_NEGATED = /(别|不要|不用|甭|勿|停止|别再)[^，。！？,!?]{0,6}(去看|看看|刷)?[^，。！？,!?]{0,4}视频/
const RECALL_WINDOW = 120_000

/**
 * 一批最多攒多少条消息。防抖窗口最长只有 批次上限（默认 8 秒），
 * 但群里刷屏时 8 秒能进几十条。攒太多的话，拼出来的 prompt 既烧钱
 * 又容易直接超上下文。
 */
const MAX_BUFFER_LINES = 20

/** 连续失败到这个次数，就说一句兜底的话 */
const FAIL_SILENT_LIMIT = 2
const FALLBACK_LINES = ['我这会儿有点卡，等下再说', '等一下，我这边不太顺', '我缓一下，马上回来']

interface Buffer {
  texts: string[]
    /** 每条消息的发送者，用来判断这轮是不是多人穿插 */
    senders: string[]
  /**
   * 每条消息的**显示名**（群名片 → 昵称 → QQ 号），和 texts 一一对应。
   *
   * 为什么要单独存：合批后要按行写「名字：内容」。只留 senders（QQ 号）的话，
   * 提示词里会出现一串数字；只留 last.senderName 的话，整批都会被冠上最后
   * 那个人的名字 —— 群里 A 说一句、B 接一句，A 的话就被算成 B 说的了。
   */
  senderLabels: string[]
  /**
   * 这一批里所有消息的图片引用（合并去重）。
   *
   * 以前 flush 直接用 `buf.last.images`：一批里分几条发的图，
   * 只有**最后一张**进了视觉，其余的只在 text 里留 `[图片]`、也没有失败标记，
   * 模型会以为自己都看见了。
   */
  images: string[]
  last: Incoming
  /**
   * 这一批该"算谁说的"（回谁、跟谁的关系、引用哪条）。
   *
   * 不能直接用 last：小明 @ 它问了一句、小红紧跟着接一句"我也有过"，
   * 用 last 就会变成「引用小红那条来回答小明」，关系值和画像还记到小红头上。
   * 规则：取**第一条叫到它的**消息；都没叫它就取第一条。
   */
  primary: Incoming
  passive: boolean
  /** 这批里有没有被 @（有就优先处理） */
  addressed: boolean
  /** 第一条到达时间，用于批次上限 */
  firstAt: number
  /** 上一条到达时间（本批次内），用于算批次跨度 */
  lastAt: number
  /**
   * 这个会话**上一批**最后一条消息的时间。
   *
   * 有时候是 0（第一次说话）。判断"安静还是活跃"看的是它，
   * 不是 lastAt —— lastAt 在本批次内永远是刚到的那个时间。
   */
  prevAt: number
  lastSender: string
  timer: NodeJS.Timeout
}

/** 这条消息是谁说的：群名片 → QQ 昵称 → QQ 号 → 会话 id（和 handle 里的 who 一致） */
function speakerLabel(m: Incoming): string {
  return m.senderName ?? m.senderNick ?? m.senderId ?? m.from.id
}

/**
 * 把一批消息拆成「谁说了什么」。
 *
 * 只要这一批不止一条消息就逐条带名字，**包括同一个人连发**；
 * 私聊永远返回 null —— 那边只有一个人，前缀名字会很怪
 * （私聊的 formatUserText 本来也不加前缀）。
 *
 * 为什么同人连发也必须带名字：`people/group.ts` 里告诉模型
 * 「带名字前缀的是别人说的；没有前缀的是你自己刚说过的」。
 * 如果一批两条都是小明说的，却只写成 `小明：第一句\n第二句`，
 * 第二句在模型眼里就成了"它自己刚说过的" —— 它会否认、或者接着自己的话往下说。
 * 这是最高频的批次（「同人续发」这一档就是为它存在的）。
 *
 * 为什么用**条数**而不是"不同名字数"判：QQ 同群允许重名名片，
 * 两个人同名时按名字数会判成单人，等于没修。
 */
export function batchLines(
  kind: string,
  texts: string[],
  labels: string[],
): Array<{ name: string; text: string }> | null {
  if (kind !== 'group') return null
  if (texts.length <= 1) return null
  return texts.map((t, i) => ({ name: labels[i] ?? '?', text: t }))
}

/** 业务装配：去重 → 限流 → 建人 → 聚合 → 落盘 → 延迟 → 生成 → 发送 → 关系评估 */
export function boot(transport: Transport, opts: BootOptions): void {
  const seen = new Set<string>()
  const buffers = new Map<string, Buffer>()
  /** 每个会话最近发出去的消息，用于撤回 */
  const lastSent = new Map<string, { ids: string[]; at: number }>()
  /** 每个会话最后一次有人说话的时间，用来算"多久没聊" */
  const lastTalk = new Map<string, number>()
  /** 每个会话最近它自己回过几次（5 分钟窗口），用来压制刷屏 */
  const replyTimes = new Map<string, number[]>()
  /** 每个会话上次引用回复的时间，用来做冷却（刚引过就别再引） */
  const lastQuoteAt = new Map<string, number>()

  /** 当前情绪强度 0~1。引用判定用它判断「这句话是不是把情绪挑起来了」。 */
  const currentMoodIntensity = (): number => {
    try {
      const m = decayedMood(loadMood())
      return m ? m.intensity : 0
    } catch {
      return 0
    }
  }

  const recentReplyCount = (scope: string): number => {
    const now = Date.now()
    const arr = (replyTimes.get(scope) ?? []).filter((x) => now - x < 5 * 60_000)
    replyTimes.set(scope, arr)
    return arr.length
  }

  /** 距这个会话上一次回复多少秒；还没回过就是 undefined */
  const lastReplyAgoSec = (scope: string): number | undefined => {
    const arr = replyTimes.get(scope) ?? []
    const last = arr[arr.length - 1]
    return last === undefined ? undefined : (Date.now() - last) / 1000
  }
  let consecutiveFailures = 0


  async function tryRecall(m: Incoming, rules: Rules): Promise<boolean> {
    if (!transport.recall) return false
    // 群里谁都能说"撤回"，但只有主人能真的让它撤回。
    //
    // 以前不看人：群里任何一个人打一句"撤回"，它就把刚发的话收了 ——
    // 别人能替它说话、也能拿这个捉弄它。私聊本来就是主人，不用判。
    if (m.from.kind === 'group') {
      const owner = String(process.env['OWNER_QQ'] ?? '').trim()
      const speaker = String(m.senderId ?? '').trim()
      if (!owner || speaker !== owner) {
        info(`不是主人说撤回，忽略：${speaker || '?'}`)
        return false
      }
    }
    const scope = scopeOf(m.from)
    const last = lastSent.get(scope)
    if (!last || Date.now() - last.at > RECALL_WINDOW) return false
    let ok = 0
    for (const id of last.ids) {
      if (await transport.recall(id)) ok++
    }
    lastSent.delete(scope)
    info(`撤回上一条：${ok}/${last.ids.length} 成功`)
    try {
      await say(transport, m.from, '撤了', rules)
    } catch {
      /* ignore */
    }
    return true
  }

  /**
   * 有人让它"去看个视频"：真的去看一个，然后把看到的说出来。
   * 不编——看得成就说看了什么、想到什么，看不成照实说。
   */
  async function tryWatchNow(m: Incoming): Promise<boolean> {
    const rules = opts.getRules()
    if (!opts.llm) return false
    await say(transport, m.from, '我去看看', rules).catch(() => {})
    const r = await watchOne({ llm: opts.llm, rules, force: true })
    if (!r.ok) {
      await say(transport, m.from, `没看成：${r.reason ?? '不知道为啥'}`, rules).catch(() => {})
      return true
    }
    const title = (r.title ?? '').slice(0, 24)
    const line = r.thought ? `看了个《${title}》，我想到：${r.thought}` : `看了个《${title}》，没什么感觉。`
    await say(transport, m.from, line, rules).catch(() => {})
    return true
  }

  /** 这一轮的批次信息：攒了几条、几个人、跨了多久。引用判定要用。 */
  interface BatchInfo {
    textsCount: number
    sendersCount: number
    spanMs: number
    /** 这批之前最后一次说话的时间（先取后写的快照）。0 = 第一次。 */
    prevAt: number
    /**
     * 这批里每一个发过言的 QQ 号（去重）。
     *
     * 为什么需要：回复成功后要给他们逐个续"刚聊过"的窗口。
     * 只用 `m.senderId`（批次里最后一个人）的话，同批里前一个人
     * 的窗口不会续期 —— 他接着说一句不 @ 的，就被判成"没叫它"，
     * 像聊到一半突然不搭理人。
     */
    senders?: string[]
  }

  async function handle(
    m: Incoming,
    text: string,
    passive: boolean,
    rules: Rules,
    batch: BatchInfo,
  ): Promise<void> {
    // 不要退到 m.from.name：群聊时那是**群名**，会把人叫成群名。
    // 退到 QQ 昵称，再退到 QQ 号。
    const who = m.senderName ?? m.senderNick ?? m.senderId ?? m.from.id

    // 内容过滤：广告、刷屏、纯数字这些别进上下文，白烧 token
    if (shouldDrop(text, rules)) {
      info(`滤掉一条（命中屏蔽规则）：${who}`)
      return
    }

    // 私聊暂停：只收消息、维护历史，不进入思考
    if (rules.行为.私聊暂停 && m.from.kind === 'private') {
      return
    }

    // 限流按"轮"算，不按消息算：连发五条算一轮，不该耗五次额度。
    // 只 peek 不计数 —— 计数放到"真要回"之前，不然被判"不回"的轮也白吃额度，
    // 用户看到的就是"@ 了也不理"。键里带上会话，群里刷屏不再吃私聊的额度。
    const senderKey = m.senderId ?? m.from.id
    const rateKey = `u:${scopeOf(m.from)}:${senderKey}`
    if (!peek(rateKey, rules.行为.每分钟上限)) {
      warnAt(`触发限流，丢弃：${who}`)
      return
    }

    // 退避：连续决定不说话后慢一点再看。
    // 被 @ 是有事找你，无视退避；否则攒够 几条消息打断 才提前醒。
    const scopeKey = scopeOf(m.from)
    const bo = rules.行为.退避 ? backoff.get(scopeKey) : undefined
    if (bo && m.passive) {
      bo.pending += 1
      const wakeAt = rules.行为.退避.几条消息打断 > 0 ? rules.行为.退避.几条消息打断 : Number.POSITIVE_INFINITY
      if (bo.pending < wakeAt && Date.now() < bo.since) {
        noteHeard(m, text)
        return
      }
      backoff.delete(scopeKey)
    }

    // 群每分钟上限：**任何要发消息的分支之前**先看一眼。
    // 放在撤回/看视频前面，是因为这两条也会往群里发话（"撤了"、看视频的两句），
    // 以前它们绕过了限速 —— 群里一直喊"去看视频"，它就一直发、还一直调模型。
    // 这里用 peek（只看不计数）；真正计数在各自发完之后。
    const groupRateKey = m.from.kind === 'group' ? 'g:' + m.from.id : ''
    if (groupRateKey && !peek(groupRateKey, rules.行为.群每分钟上限)) {
      info(`群 ${m.from.id} 已达每分钟上限，这条跳过`)
      noteHeard(m, text)
      return
    }

    // "撤回"是一句指令，不走模型
    RECALL_HINT.lastIndex = 0
    if (RECALL_HINT.test(text) && (await tryRecall(m, rules))) {
      if (groupRateKey) hit(groupRateKey)
      return
    }

    // 有人让它"去看个视频"：真的去看一个，然后回话
    if (WATCH_HINT.test(text) && !WATCH_NEGATED.test(text)) {
      const ok = await tryWatchNow(m)
      if (ok) {
        if (groupRateKey) hit(groupRateKey)
        return
      }
    }

    // 没被 @ 也不是连续对话：按内容打分决定接不接
    if (passive) {
      const score = scoreReply({
        addressed: false,
        isPrivate: m.from.kind === 'private',
        followUp: false,
        text,
        // 用 batch.prevAt（收消息时**先取后写**的快照），不要用 lastTalkAt()：
        // 后者在 604 行已经被更新成 m.at 了，算出来恒 ≈0，
        // score.ts 里 ">30min +20 / >120min +35" 这两档从来没生效过。
        idleMinutes: batch.prevAt ? (Date.now() - batch.prevAt) / 60_000 : 0,
        recentReplies: recentReplyCount(scopeOf(m.from)),
        lastReplyAgoSec: lastReplyAgoSec(scopeOf(m.from)),
        talkValue: talkValueOf(rules),
      })
      if (Math.random() > score.probability) {
        info(`这次不接（${score.score} 分：${score.reasons.join('、') || '没理由'}）：${who}`)
        noteHeard(m, text)
        enterBackoff(scopeOf(m.from), rules)
        return
      }
      info(`接这句（${score.score} 分：${score.reasons.join('、')}）`)
    }

    if (SKIPPABLE.test(text) && Math.random() < rules.行为.偶尔不回概率) {
      info(`选择不回：${text.slice(0, 12)}`)
      noteHeard(m, text)
      return
    }

    // 群每分钟上限已在上面统一 peek 过（撤回/看视频也要受它约束），
    // 这里不再重复判断：真正计数在发送前那次 allow。

    try {
      info(`← ${who}：${text.replace(/\n/g, ' / ')}`)
      // 先亮"正在输入"，再慢慢想。
      // 这一步的顺序很重要：如果先 sleep 再设，对方看到的是「半天没动静，然后突然冒出三条」；
      // 先设再 sleep，对方看到的是「他一直在这儿打字」——后者才是人的样子。
      await transport.setTyping?.(m.from, true)
      await sleep(rand(rules.说话.回复前延迟))

      // 「已读不回」：看过了、想了想、决定不说。
      //
      // 和上面那个 SKIPPABLE 跳过不同：那个是"嗯""哦"这种从头就不值得看，
      // 这个是**有意义的话**，但今天懒得接。
      // 默认 0（关着）——开了之后对方可能以为它挂了，得自己想清楚要不要。
      const leaveRead = rules.行为.已读不回概率 ?? 0
      if (leaveRead > 0 && Math.random() < leaveRead) {
        info(`看了没回：${text.slice(0, 12)}`)
        // 这也是"决定不说话"的一种：同样要记进旁听，
        // 否则开了这个开关之后，它就会对这些话彻底失忆。
        noteHeard(m, text)
        return
      }

      // 关键词反应不在这儿算了：它属于「怎么组织 prompt」，
      // 由 loop/chat.ts 直接读 rules 算（见 loop/keyword.ts）。
      // 这里再算一遍会往 prompt 里塞两份，而且老的这份只取第一条命中的规则。
      //
      // 回复前先评一次情绪（只对"直接冲它来的"：私聊 / @ / 刚聊过的人）。
      //
      // 原来评估在回复**之后**异步跑，结果是"被怼的那一句还笑着回，下一句才生气"
      // —— 这是最影响体验的那类 bug。代价是回复前多等一次小调用（几百毫秒到 1-2 秒），
      // 换"这一句的情绪是对的"。群聊普通闲聊不走这条，仍然发完之后异步评。
      if (opts.llm && !passive && rules.关系.评估?.开启 !== false) {
        const earlyPerson = personOfMessage(m)
        if (
          allow(`eval:${earlyPerson}`, Math.max(0, Number(rules.关系.评估?.每天最多 ?? 300)), 86_400_000)
        ) {
          evaluateTurn({
            rules,
            llm: opts.llm,
            personId: earlyPerson,
            userText: text,
            // 还没生成回复：让 evaluate 用"（还没回）"兜底
            selfText: '',
          })
          // 等它落地再生成回复，否则这一句还是旧情绪
          await drainEvaluations(earlyPerson)
        }
      }

      const reply = await opts.reply({ ...m, text, prevAt: batch.prevAt }, rules)
      consecutiveFailures = 0

      if (!reply || !reply.trim()) {
        info('无回复内容，保持沉默')
        // 模型选择什么都不说，也算"听过了"。
        //
        // ⚠ 但只在**没叫它**的时候记。
        // 被 @ 的那条在调模型之前就已经进了对话历史（turns），再记一遍旁听会：
        //   1. 同一句话同时出现在 turns 和 heard（模型觉得这人说了两遍）
        //   2. 被渲染成"没叫你，你只是旁观" —— 把 @ 标成旁观，方向反了
        // 这是上一版没想清楚的地方（自己改出来的 bug，回归审查时被抓到）。
        if (passive) noteHeard(m, text)
        return
      }

      // 额度**在真的发出去之后才计**（见下面的 sentNothing 分支）。
      //
      // 以前是在 say 之前计数：断线期间连发两条失败，群额度就被吃满了，
      // 重连之后连 @ 都不回 —— 用户看到的正是"它明明在线却不理我"。
      // 现在失败会把这一条撤回去（见 sentNothing）。

      // 要不要引用对方那句。
      //
      // 判定依据会话分析研究（见 loop/quote.ts 顶部注释）：引用是为了解决
      // 「多人 / 异步」造成的指代困难，不是礼貌性装饰。被 @ 和私聊指代已经
      // 很清楚，所以给负分 —— 以前那版把这两种设成 100%，方向是反的。
      const scopeNow = scopeOf(m.from)
      const lastQuote = lastQuoteAt.get(scopeNow) ?? Number.NEGATIVE_INFINITY
      const qd = shouldQuote(rules, m.from.kind, batch, m, {
        addressed: !passive,
        targetLen: text.length,
        reply,
        moodIntensity: currentMoodIntensity(),
        sinceLastQuoteMs: Date.now() - lastQuote,
      })
      if (rules.说话.引用调试) {
        info(`引用判定 ${qd.score} 分（${qd.reasons.join('，')}）→ ${qd.quote ? '引用' : '不引'}`)
      }
      const target = qd.quote && m.id ? { ...m.from, replyTo: m.id } : m.from
      const ids = await say(transport, target, reply, rules)
      // 表情包等文字发完再补：之前它是在 generateReply 里发的，早于文字，
      // 文字被限流/为空/失败时表情包已经出去了。
      // 一个字都没发出去时也别补表情包：那会变成"只有一堆图，没有话"。
      if (ids.length) void maybeSendEmoji(m, rules)

      // 一条都没发出去（NapCat 断线、被平台拒、或者 stripMentions 把整条清空了）：
      // 历史里那条 assistant 必须撤掉。
      //
      // 这条以前没人管：`reply` 已经由 chat.ts 写进 turns，而这里无条件 appendRaw，
      // 于是用户一个字没收到，它下一轮却"记得自己说过"，会接着自己的话说，
      // 甚至引用一句对方根本没看见的内容。日志里只有 `→ 小明：0 条`。
      const sentNothing = ids.length === 0
      if (sentNothing) {
        popLastAssistant(scopeOf(m.from))
        warnAt('这条一个字都没发出去，已从历史里撤掉', { 会话: scopeOf(m.from), 条数: reply.length })
      } else {
        // 发出去了才算数：群每分钟额度 + 这个人的每分钟额度
        if (m.from.kind === 'group') hit('g:' + m.from.id)
        hit(rateKey)
        if (qd.quote && m.id) lastQuoteAt.set(scopeNow, Date.now())
        backoff.delete(scopeOf(m.from))
        const scope = scopeOf(m.from)
        lastSent.set(scope, { ids, at: Date.now() })
        const arr = replyTimes.get(scope) ?? []
        arr.push(Date.now())
        replyTimes.set(scope, arr)
        // 「接着聊」的窗口锚在**它最后一次真正说话**的时刻，不是"上次被 @"。
        //
        // 只锚 @ 的话：有人连聊三分钟、它每条都回，一到那个 120 秒就突然不回，
        // 像聊着聊着走了。锚在"刚回过"才对得上人的直觉 ——
        // 既然它刚接过这个人一句，对方接着说下一句就该顺下去。
        // 只在群里有意义：连续对话窗口本来就是群聊的概念，
        // 私聊每条都必回，不需要这个锚（硬记还会在 recentTalkers 里留脏键）。
        //
        // 只给**它回的那个人**续窗口，不是整批人。
        //
        // 以前整批都续：一人 @ 它、同批另一个人只是随口说了句，那个人也会被
        // 记成"刚聊过"，之后两分钟内说什么它都必回（实测「自己判断」档
        // 从 0 条变成连回 2 条无关注闲聊）。回的是谁，就只跟谁"接着聊"。
        if (m.from.kind === 'group') {
          opts.touchTalker?.(m.from.id, m.senderId ?? m.from.id)
        }
        appendRaw({ ts: Date.now(), scope, role: 'assistant', text: reply.trim() })
      }
      info(`→ ${who}：${ids.length} 条`)

      if (opts.llm) {
        // 走到这里的是**群聊普通闲聊**（`m.passive`）：不拖慢回复，评估放到发完之后异步跑。
        // 私聊 / @ / 刚聊过的人（`!m.passive`）在生成回复**之前**就已经同步评过了，
        // 所以这里跳过它们，避免同一条消息评估两次。
        const evalConf = rules.关系.评估
        const evalPerson = personOfMessage(m)
        if (passive) {
          if (evalConf?.开启 === false) {
            /* 配置里关掉了 */
          } else if (
            allow(`eval:${evalPerson}`, Math.max(0, Number(evalConf?.每天最多 ?? 300)), 86_400_000)
          ) {
            evaluateTurn({
              rules,
              llm: opts.llm,
              personId: evalPerson,
              userText: text,
              selfText: reply.trim(),
            })
          } else {
            warnAt('关系/心情评估今日额度已用完，本轮跳过', { 对象: evalPerson })
          }
        }
        // 发完给自己这条打个分（异步，不挡后面的消息）。
        // 短回复没什么好评的，跳过省钱；可以用 rules.yaml 整体关掉。
        if (rules.行为.回复自评 !== false && reply.trim().length > 6) {
          void judgeReply({
            llm: opts.llm,
            userText: text,
            selfText: reply.trim(),
            who,
          })
            .then((r) => {
              // 分高或分低的才值得记，中间分没信号
              if (r && opts.llm) {
                void recordPlayReviewed(r.score, text, reply.trim(), opts.llm, rules).catch(() => {})
              }
              // 改口：自评很差、而且说得出具体问题时，小概率补一句。
              //
              // 只在 score < 4 时考虑——分数中等的那些"改口"反而显得神经质。
              // 而且要看 issue：只说"不够好"不算，得指出哪儿不对。
              const fixRate = rules.行为.改口概率 ?? 0
              if (fixRate > 0 && r && r.score < 4 && r.issue.trim() && Math.random() < fixRate) {
                void (async () => {
                  // 隔一会儿再发，像"发完才后悔"
                  await sleep(1200 + Math.random() * 2500)
                  const line = FIX_LINES[Math.floor(Math.random() * FIX_LINES.length)]!
                  try {
                    await say(transport, m.from, line, rules)
                    info(`改口：${line}`, { 原因: r.issue })
                  } catch {
                    /* 补不出去就算了，本来也不是必须说的 */
                  }
                })()
              }
            })
            .catch(() => {})
        }
      }
    } catch (err) {
      consecutiveFailures += 1
      warnAt('处理消息失败', { err: String(err), consecutive: consecutiveFailures })

      if (consecutiveFailures >= FAIL_SILENT_LIMIT) {
        consecutiveFailures = 0
        const line = FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)]!
        try {
          await say(transport, m.from, line, rules)
        } catch {
          /* 连兜底都发不出去就算了 */
        }
      }
    } finally {
      // 不管成没成，都要把「正在输入」收掉——
      // 不然对方会一直看到"正在输入中"，比不回还怪。
      await transport.setTyping?.(m.from, false)
    }
  }

  /** 每个会话一条发送链：上一轮还没发完时，下一轮排队，避免分句交错 */
  const sending = new Map<string, Promise<void>>()

  /**
   * 记一条「旁听」：群里别人说的话，它看见了但没回。
   *
   * 只记群聊：私聊每条都会进 turns，不需要旁听。
   * 与档位无关：无论"必须 @"还是"自己判断"，只要这条没进入生成，
   * 就该留下来当背景 —— 否则它只在被叫的那一瞬间才存在。
   */
  function noteHeard(m: Incoming, text: string): void {
    if (m.from.kind !== 'group') return
    const scope = scopeOf(m.from)
    // 合批的情况要逐条按自己的发送人记。
    // 直接用整批 text + m 的名字的话，一批里三个人的话会全记到最后一个人头上 ——
    // 和前面修的合批归属是同一个 bug，只是换了个地方。
    if (m.batchLines?.length) {
      for (const l of m.batchLines) {
        const t = l.text.trim()
        if (t) pushHeard(scope, { role: 'user', content: `${l.name}：${t}`, at: m.at })
      }
      return
    }
    const line = text.trim()
    if (!line) return
    pushHeard(scope, { role: 'user', content: `${speakerLabel(m)}：${line}`, at: m.at })
  }

  async function flush(key: string): Promise<void> {
    const buf = buffers.get(key)
    if (!buf) return
    buffers.delete(key)
    clearTimeout(buf.timer)
    // 判定/打分/日志用**原始拼接文本**（不带名字）：
    // 名字写进去会让「嗯」「哦」这类短回复的识别失准（SKIPPABLE / SHORT_ACK 都是整段锚定），
    // 内容过滤也会被群友的名字误伤，回复预算还会被名字长度抬高。
    // 逐行带名字的版本单独交给 chat.ts 拼 prompt。
    const text = buf.texts.join('\n')
    // 只有群聊需要「名字：内容」 —— 私聊里对方就一个人，前缀名字会很怪
    // （私聊的 formatUserText 本来也不加前缀）。
    const lines = batchLines(buf.last.from.kind, buf.texts, buf.senderLabels)
    // 关键：同一会话的两轮不能并发处理。之前是这里 delete 完就 await，
    // 对方在上一轮没回完时再发一条，会另起一次 handle，两轮分句互相插、后一轮可能先发完。
    const prev = sending.get(key) ?? Promise.resolve()
    const run = prev
      .catch(() => undefined)
      .then(() =>
        handle(
          // 身份用 primary（第一条叫到它的），时间用 last（这批最后到达的时刻）
          {
            ...buf.primary,
            at: buf.last.at,
            images: buf.images,
            ...(lines ? { batchLines: lines } : {}),
          },
          text,
          buf.passive,
          opts.getRules(),
          {
            textsCount: buf.texts.length,
            sendersCount: new Set(buf.senders).size,
            spanMs: buf.lastAt - buf.firstAt,
            prevAt: buf.prevAt,
            // 整批的发信人，用来给他们逐个续「刚聊过」的窗口
            senders: [...new Set(buf.senders)],
          },
        ),
      )
    // 收尾要挂在这一轮真正让"链"等到的那个 promise 上：run 本身还没收尾
    // （finally 返回的是另一个 promise），拿 run 去比 `sending.get(key)` 永远不等 ——
    // 于是每个会话都会永久留一个已 resolve 的 promise 在 map 里（有界但不干净）。
    let tail: Promise<void>
    tail = run
      .catch(() => undefined)
      .then(() => {
        if (sending.get(key) === tail) sending.delete(key)
      })
    sending.set(key, tail)
    await run
  }
  // 名单为空时让渲染那层能踢一脚刷新
  setGroupMembersMissingHook((gid) => refreshGroupMembers(transport, gid))

  transport.onMessage((m) => {
    // 自己发出去的消息被 NapCat 回传时，直接丢掉。
    // 不回滤的话它会把自己的回复当成"群里某人说的话"再学一遍 ——
    // 旁听区和 raw 都会被污染。
    if (m.selfId && m.senderId && m.senderId === m.selfId) return

    if (m.id) {
      if (seen.has(m.id)) {
        warnAt('重复消息，已跳过', { id: m.id })
        return
      }
      seen.add(m.id)
      if (seen.size > 500) {
        const first = seen.values().next().value
        if (first) seen.delete(first)
      }
    }

    const rules = opts.getRules()

    // 群里收到消息时维护成员名单（后台，不阻塞回复）
    //
    // 名单里没这个人 → 可能是新成员 → 强制刷新，不等 TTL。
    // 名单是空的（还没拉到）时 isKnownMember 返回 true，不会在这儿空转。
    if (m.from.kind === 'group') {
      const who = m.senderId ?? ''
      const known = who ? isKnownMember(m.from.id, who) : true
      if (!known) {
        info('群里出现名单外的人，刷新名单', { group: m.from.id, who })
        void refreshGroupMembers(transport, m.from.id, { force: true }).catch(() => {})
      } else {
        void refreshGroupMembers(transport, m.from.id).catch(() => {})
      }
    }

    // 第一次见就建档（群里也建，这样它"记得"这个人）
    const senderKey = m.senderId ?? m.from.id
    if (senderKey && senderKey !== 'unknown') {
      // 全局名只能用 **QQ 昵称**，不能用群名片。
      //
      // 踩过两次的坑：senderName = card ?? nickname，
      // 群里给群名片（「测试昵称A」）、私聊给昵称（「主人」），
      // 拿它当全局名，档案就被两边轮流覆盖。
      //
      // 名字来源按可靠程度排：
      //   1. senderNick（QQ 昵称，全局唯一）
      //   2. 群名单里的 nick（也是 QQ 昵称）
      //   3. 都没有就不改（传 undefined）
      let globalName = (m.senderNick ?? '').trim()
      if (!globalName && m.from.kind === 'group') {
        globalName = groupMembers(m.from.id).find((x) => x.id === senderKey)?.nick ?? ''
      }
      ensurePerson('qq', senderKey, globalName || undefined)
    }

    // 群聊里把 @QQ号 换成 @昵称：模型看到一串数字不知道那是谁。
    // OneBot 的 at 段不一定带 name，所以用群成员列表兜底替换一次。
    let displayText = m.text
    if (m.from.kind === 'group') {
      for (const mem of groupMembers(m.from.id)) {
        if (mem.id && mem.name) displayText = displayText.split(`@${mem.id}`).join(`@${mem.name}`)
      }
    }

    // 过滤要放在 appendRaw 之前：否则垃圾消息先进了 raw，
    // distill 再把它提炼进长期记忆，过滤就成了摆设。
    if (shouldDrop(displayText, rules)) {
      info(`滤掉一条（不进历史）：${m.senderName ?? m.from.id}`)
      return
    }

    appendRaw({ ts: m.at, scope: scopeOf(m.from), role: 'user', text: displayText, ...(m.senderId ? { senderId: m.senderId } : {}) })
    // 先取再写：这个值就是"上一条消息距今多久"，是判断安静/活跃的依据。
    // 之前放在下面 schedule 里读 lastTalk，读到的已经是刚写进去的新值，
    // 算出来永远是 0，"安静"那一档从来没生效过。
    const prevTalkAt = lastTalk.get(`${m.from.kind}:${m.from.id}`) ?? 0
    lastTalk.set(`${m.from.kind}:${m.from.id}`, m.at)
    // 后面用的都是替换过的文本（聚合、生成、日志）
    m.text = displayText

    // 只记录不回复：群里没叫它（而 access.yaml 要求必须 @）。
    //
    // 走到这里说明消息已经进 raw 了，也更新过 lastTalk —— 这正是这一段的目的：
    // 它看得见群里的聊天，能学这个群怎么说话、能记住发生过什么，
    // 只是不插嘴。以前这类消息在 shouldHandle 就被丢了，等于全程聋着。
    //
    // 现在再往前一步：把这句话也记进 session 的「旁听」区。
    // 只进 raw 是不够的 —— raw 是给 distill 用的长期材料，不参与这一轮的 prompt。
    // 所以用户 @ 它问"刚才聊啥呢"，它其实完全不知道群里在聊什么。
    //
    // 注意：记旁听不能只挂在 observeOnly 上。切到「自己判断」档时
    // isObserveOnly 恒为 false，那些"看了但决定不接"的消息会从别的
    // 分支返回 —— 如果不在那儿补记，它反而在最活跃的档位里最接不上前文。
    // 下面每个"决定不说话"的出口都会调 noteHeard。
    if (m.observeOnly) {
      noteHeard(m, displayText)
      return
    }

    // 聚合按"谁在哪个会话里说"分桶：群里两个人先后说话不能合并成一轮
    // 按「会话」合并，不按「会话+发送者」：同一群两个人同时说话时，
    // 之前是两个 buffer 各跑一次 generateReply —— 两边读同一份历史、
    // 互相看不到对方的 user 消息，还可能同时压缩、后写覆盖前写。
    const key = scopeOf(m.from)
    const now = Date.now()
    const addressed = !(m.passive ?? false)

    // 档位是「关闭」：不聚合，每条立刻处理。
    if (resolveDebounce(rules.行为.防抖) === null) {
      const single: Buffer = {
        texts: [m.text],
        images: [...(m.images ?? [])],
        senders: [senderKey],
        senderLabels: [speakerLabel(m)],
        last: m,
        primary: m,
        passive: m.passive ?? false,
        addressed,
        firstAt: now,
        lastAt: now,
        prevAt: prevTalkAt,
        lastSender: senderKey,
        timer: setTimeout(() => {}, 0),
      }
      buffers.set(key, single)
      void flush(key)
      return
    }

    const schedule = (buf: Buffer, sameSender: boolean): void => {
      clearTimeout(buf.timer)
      const d = resolveDebounce(rules.行为.防抖)
      if (!d) return

      // 安静/活跃看的是**上一条消息**距今多久，不是本批次内。
      // 批次内最后一条永远是刚到的，用它算这个值永远是 0。
      const quiet = now - prevTalkAt > 30_000

      // 第一条：群里是冷是热，决定"多留一会儿看有没有人接话"。
      // 后面又来消息：同人给补话的时间，换人马上处理。
      let waitSec: number
      if (buf.texts.length <= 1) {
        waitSec = quiet ? d.安静 : d.活跃
      } else {
        waitSec = sameSender ? d.同人续发 : d.换人
      }
      // 被 @ 是上限不是替换：本来该等 0.5 秒的，被 @ 了也不用等更久
      // 用**整批**的 addressed，不用当前这条的：
      // 小明 @ 它之后小红又说了句闲话，那条闲话的 addressed 是 false，
      // 拿它算会把 @ 的 1 秒上限重新拉长（实测 @ 后 2 秒才回）。
      if (buf.addressed) waitSec = Math.min(waitSec, d.被at最多)

      // 一批从第一条起最多等这么久，不能因为一直有新消息无限延后
      const elapsed = now - buf.firstAt
      const remain = d.批次上限 * 1000 - elapsed
      const waitMs = Math.max(0, Math.min(waitSec * 1000, remain))

      buf.timer = setTimeout(() => void flush(key), waitMs)
    }

    // 刷屏保护：一批最多攒 MAX_BUFFER_LINES 条。
    // 防抖窗口最长只有 批次上限（默认 8 秒），但群里刷屏时 8 秒能进几十条，
    // 拼出来的 prompt 既烧钱又容易超上下文。
    // 注意顺序：先 flush 把旧批送走（flush 会同步把 key 从 buffers 删掉），
    // 再让这条消息落到下面"新建一条"的分支 —— 不能 push 进已经送走的那批，
    // 那样这条消息就丢了。
    const existing = buffers.get(key)
    if (existing && existing.texts.length >= MAX_BUFFER_LINES) {
      clearTimeout(existing.timer)
      void flush(key)
    }

    const cur = buffers.get(key)
    if (cur) {
      // 合并这批里所有消息的图：flush 只用 buf.last.images 的话，
      // 分几条发的图只有最后一张进视觉
      cur.images = [...new Set([...cur.images, ...(m.images ?? [])])]
      cur.texts.push(m.text)
      cur.senderLabels.push(speakerLabel(m))
      cur.senders.push(m.senderId ?? m.from.id)
      cur.last = m
      cur.lastAt = now
      cur.passive = cur.passive && (m.passive ?? false)
      // ⚠ 顺序：sameSender 必须**在**更新 lastSender 之前算。
      // 以前是先写 cur.lastSender 再 schedule，schedule 里再拿它跟当前消息比，
      // 永远等于自己 → 「换人」那一档从来没生效过，一直是「同人续发」。
      const sameSender = (m.senderId ?? m.from.id) === cur.lastSender
      // 第一条叫到它的消息成为"这一批算谁说的"
      if (addressed && !cur.addressed) cur.primary = m
      cur.addressed = cur.addressed || addressed
      cur.lastSender = m.senderId ?? m.from.id
      schedule(cur, sameSender)
      return
    }

    const buf: Buffer = {
      texts: [m.text],
      images: [...(m.images ?? [])],
      senders: [m.senderId ?? m.from.id],
      senderLabels: [speakerLabel(m)],
      last: m,
      primary: m,
      passive: m.passive ?? false,
      addressed,
      firstAt: now,
      lastAt: now,
      prevAt: prevTalkAt,
      lastSender: m.senderId ?? m.from.id,
      timer: setTimeout(() => {}, 0),
    }
    schedule(buf, true)
    buffers.set(key, buf)
  })
}
