import { rand, say, sleep } from './channel/send.ts'
import type { Rules } from './core/config.ts'
import { talkValueOf } from './core/config.ts'
import { scoreReply } from './loop/score.ts'
import { info, warnAt } from './core/log.ts'
import { allow } from './core/ratelimit.ts'
import type { Transport } from './core/transport.ts'
import type { Incoming } from './core/types.ts'
import type { LlmOptions } from './llm/types.ts'
import { appendRaw } from './memory/store.ts'
import { watchOne } from './outward/watch.ts'
import { personOfMessage, scopeOf } from './memory/scope.ts'
import { ensurePerson } from './people/store.ts'
import { refreshGroupMembers, groupMembers, isKnownMember, setGroupMembersMissingHook } from './people/group.ts'
import { evaluateTurn } from './relation/evaluate.ts'
import { judgeReply } from './loop/judge.ts'
import { recordPlayReviewed } from './learn/plays.ts'

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
}

/** 这类短消息可以偶尔不回 */
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
 * 被点名或有问号时几乎一定引，其余按 说话.引用频率 的概率来。
 */
function shouldQuote(rules: Rules, kind: 'group' | 'private', addressed: boolean, hasQuestion: boolean): boolean {
  const f = rules.说话.引用频率
  if (f === 'never') return false
  // 被点名 / 问句：引用更像接话
  if (addressed || hasQuestion) return true
  // 私聊本来就只有两个人，引用意义不大
  if (kind === 'private') return Math.random() < 0.15
  const p = f === 'often' ? 0.6 : 0.3
  return Math.random() < p
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

/** 命中关键词/正则时返回要追加给模型的反应提示 */
function reactionFor(text: string, rules: Rules): string | undefined {
  const list = rules.关键词反应 ?? []
  if (!list.length) return undefined
  for (const rule of list) {
    const hitWord = (rule.关键词 ?? []).some((w) => w && text.includes(w))
    if (hitWord) return rule.反应
    for (const r of rule.正则 ?? []) {
      if (!r) continue
      try {
        if (new RegExp(r).test(text)) return rule.反应
      } catch {
        /* 同上 */
      }
    }
  }
  return undefined
}

/** 用户要求撤回刚才那句 */
const RECALL_HINT = /撤回|收回去|撤掉|刚才那句不对|别说那句|收回/g
/** 让"去看个视频"能真的触发一次，不然它只能说"我没有这个口子" */
const WATCH_HINT = /(去看|看看|刷)(个|一个|点)?视频|去看点东西|去外面看看/
const RECALL_WINDOW = 120_000

/** 连续失败到这个次数，就说一句兜底的话 */
const FAIL_SILENT_LIMIT = 2
const FALLBACK_LINES = ['我这会儿有点卡，等下再说', '等一下，我这边不太顺', '我缓一下，马上回来']

interface Buffer {
  texts: string[]
  last: Incoming
  passive: boolean
  /** 这批里有没有被 @（有就优先处理） */
  addressed: boolean
  /** 第一条到达时间，用于批次上限 */
  firstAt: number
  /** 上一条到达时间，用于判断"安静"还是"活跃" */
  lastAt: number
  lastSender: string
  timer: NodeJS.Timeout
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

  const lastTalkAt = (t: { kind: string; id: string }): number => lastTalk.get(`${t.kind}:${t.id}`) ?? 0
  const recentReplyCount = (scope: string): number => {
    const now = Date.now()
    const arr = (replyTimes.get(scope) ?? []).filter((x) => now - x < 5 * 60_000)
    replyTimes.set(scope, arr)
    return arr.length
  }
  let consecutiveFailures = 0


  async function tryRecall(m: Incoming, rules: Rules): Promise<boolean> {
    if (!transport.recall) return false
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

  async function handle(m: Incoming, text: string, passive: boolean, rules: Rules): Promise<void> {
    const who = m.senderName ?? m.from.name ?? m.from.id

    // 内容过滤：广告、刷屏、纯数字这些别进上下文，白烧 token
    if (shouldDrop(text, rules)) {
      info(`滤掉一条（命中屏蔽规则）：${who}`)
      return
    }

    // 私聊暂停：只收消息、维护历史，不进入思考
    if (rules.行为.私聊暂停 && m.from.kind === 'private') {
      return
    }

    // 限流按"轮"算，不按消息算：连发五条算一轮，不该耗五次额度
    const senderKey = m.senderId ?? m.from.id
    if (!allow(`u:${senderKey}`, rules.行为.每分钟上限)) {
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
        return
      }
      backoff.delete(scopeKey)
    }

    // "撤回"是一句指令，不走模型
    RECALL_HINT.lastIndex = 0
    if (RECALL_HINT.test(text) && (await tryRecall(m, rules))) return

    // 有人让它"去看个视频"：真的去看一个，然后回话
    if (WATCH_HINT.test(text)) {
      const ok = await tryWatchNow(m)
      if (ok) return
    }

    // 没被 @ 也不是连续对话：按内容打分决定接不接
    if (passive) {
      const score = scoreReply({
        addressed: false,
        isPrivate: m.from.kind === 'private',
        followUp: false,
        text,
        idleMinutes: (Date.now() - lastTalkAt(m.from)) / 60_000,
        recentReplies: recentReplyCount(scopeOf(m.from)),
        talkValue: talkValueOf(rules),
      })
      if (Math.random() > score.probability) {
        info(`这次不接（${score.score} 分：${score.reasons.join('、') || '没理由'}）：${who}`)
        enterBackoff(scopeOf(m.from), rules)
        return
      }
      info(`接这句（${score.score} 分：${score.reasons.join('、')}）`)
    }

    if (SKIPPABLE.test(text) && Math.random() < rules.行为.偶尔不回概率) {
      info(`选择不回：${text.slice(0, 12)}`)
      return
    }

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
        return
      }

      // 命中关键词就追加一段"反应提示"，不用改代码就能调整它的回应
    const hint = reactionFor(text, rules)
    const reply = await opts.reply({ ...m, text, ...(hint ? { hint } : {}) }, rules)
      consecutiveFailures = 0

      if (!reply || !reply.trim()) {
        info('无回复内容，保持沉默')
        return
      }

      if (m.from.kind === 'group' && !allow(`g:${m.from.id}`, rules.行为.群每分钟上限)) {
        info(`群 ${m.from.id} 触发限速，这条不发`)
        return
      }

      // 回某一句的时候引用它，更像接话而不是自言自语。
      // 频率由 rules.说话.引用频率 控制（never / occasionally / often），
      // 被点名和问句会额外抬高概率——那种场合不引用反而奇怪。
      const wasAddressed = !(m.passive ?? false)
      const quoteIt = shouldQuote(rules, m.from.kind, wasAddressed, /[?？]|吗|呢/.test(text))
      const target = quoteIt && m.id ? { ...m.from, replyTo: m.id } : m.from
      const ids = await say(transport, target, reply, rules)
      backoff.delete(scopeOf(m.from))
      if (ids.length) {
        const scope = scopeOf(m.from)
        lastSent.set(scope, { ids, at: Date.now() })
        const arr = replyTimes.get(scope) ?? []
        arr.push(Date.now())
        replyTimes.set(scope, arr)
      }
      appendRaw({ ts: Date.now(), scope: scopeOf(m.from), role: 'assistant', text: reply.trim() })
      info(`→ ${who}：${ids.length} 条`)

      if (opts.llm) {
        evaluateTurn({
          rules,
          llm: opts.llm,
          personId: personOfMessage(m),
          userText: text,
          selfText: reply.trim(),
        })
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

  async function flush(key: string): Promise<void> {
    const buf = buffers.get(key)
    if (!buf) return
    buffers.delete(key)
    clearTimeout(buf.timer)
    await handle(buf.last, buf.texts.join('\n'), buf.passive, opts.getRules())
  }

  // 名单为空时让渲染那层能踢一脚刷新
  setGroupMembersMissingHook((gid) => refreshGroupMembers(transport, gid))

  transport.onMessage((m) => {
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
      // 名字来源按可靠程度排：
      //   1. 消息里带的（卡面 / 昵称）
      //   2. 群名单里的（NapCat 给的最新昵称）
      //   3. 不要用 m.from.name —— 群聊时那是群名，会把人叫成群名
      let displayName = (m.senderName ?? '').trim()
      if (!displayName && m.from.kind === 'group') {
        displayName = groupMembers(m.from.id).find((x) => x.id === senderKey)?.name ?? ''
      }
      ensurePerson('qq', senderKey, displayName || undefined)
    }

    // 群聊里把 @QQ号 换成 @昵称：模型看到 @552388771 不知道那是谁。
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
    lastTalk.set(`${m.from.kind}:${m.from.id}`, m.at)
    // 后面用的都是替换过的文本（聚合、生成、日志）
    m.text = displayText

    // 聚合按"谁在哪个会话里说"分桶：群里两个人先后说话不能合并成一轮
    const key = `${scopeOf(m.from)}:${m.senderId ?? m.from.id}`
    const now = Date.now()
    const addressed = !(m.passive ?? false)

    const schedule = (buf: Buffer): void => {
      clearTimeout(buf.timer)
      const d = rules.行为.防抖
      const quiet = now - buf.lastAt > 30_000
      const sameSender = (m.senderId ?? m.from.id) === buf.lastSender

      // 被 @ 优先；安静时多等一会儿；同人续发给补话时间；换人马上处理
      let waitSec = d.同人续发
      if (addressed) waitSec = d.被at最多
      else if (quiet) waitSec = d.安静
      else if (!sameSender) waitSec = d.换人

      // 一批从第一条起最多等这么久，不能因为一直有新消息无限延后
      const elapsed = now - buf.firstAt
      const remain = d.批次上限 * 1000 - elapsed
      const waitMs = Math.max(0, Math.min(waitSec * 1000, remain))

      buf.timer = setTimeout(() => void flush(key), waitMs)
    }

    const existing = buffers.get(key)
    if (existing) {
      existing.texts.push(m.text)
      existing.last = m
      existing.lastAt = now
      existing.passive = existing.passive && (m.passive ?? false)
      existing.addressed = existing.addressed || addressed
      existing.lastSender = m.senderId ?? m.from.id
      schedule(existing)
      return
    }

    const buf: Buffer = {
      texts: [m.text],
      last: m,
      passive: m.passive ?? false,
      addressed,
      firstAt: now,
      lastAt: now,
      lastSender: m.senderId ?? m.from.id,
      timer: setTimeout(() => {}, 0),
    }
    schedule(buf)
    buffers.set(key, buf)
  })
}
