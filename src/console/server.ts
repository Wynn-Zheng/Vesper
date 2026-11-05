import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Rules } from '../core/config.ts'
import { asGroupChatMode, loadRules, stageOf } from '../core/config.ts'
import { TALK_FIELDS, readPath, validateTalkValues } from './talk-schema.ts'
import { errorAt, info, warnAt, logBus, type LogRecord } from '../core/log.ts'
import type { Transport } from '../core/transport.ts'
import type { LlmOptions } from '../llm/types.ts'
import { distill } from '../memory/distill.ts'
import { loadEpisodes, loadInsights, readRaw, today, memoryRoot, deleteEpisode } from '../memory/store.ts'
import { loadFacts, deleteFact, editFact, setVisibility } from '../memory/facts.ts'
import { loadOpen, removeOpen, editOpen } from '../people/open.ts'
import { isValidPersonId, listPeople, loadPerson, personOfAccount, primaryAccount, accountIdsOf } from '../people/store.ts'
import { accessFile, loadAccess, saveAccess, type AccessPolicy } from '../core/access.ts'
import { search } from './search.ts'
import { exportAll, importBackup, parseBackup } from './backup.ts'
import { proactiveStatus } from '../scheduler/proactive.ts'
import { loadWatched } from '../outward/watch.ts'
import { findIssues } from '../self/observe.ts'
import type { Scope } from '../memory/types.ts'
import { loadMood, decayedMood } from '../persona/mood.ts'
import { buildRelationBlock } from '../relation/format.ts'
import { loadRelation } from '../relation/store.ts'
import { phaseOf } from '../self/format.ts'
import { loadDrifts, loadLife, loadSelf, listSelfVersions } from '../self/store.ts'
import { listSnapshots, restore } from '../persona/version.ts'
import { handlePeopleApi } from './people-api.ts'
import { handleDesktopApi } from './desktop-api.ts'
import { handleMiscApi } from './misc-api.ts'
import { handleMemberApi } from './member-api.ts'
import { handleSettingsApi } from './settings-api.ts'
import { handleTestApi } from './test-api.ts'
import { createPluginService, pluginRoutes } from './plugin-api.ts'
import { handleEmojiApi } from './emoji-api.ts'
import { parseJsonBody } from './http.ts'
import { recordConsoleTurn } from './activity.ts'
import { previewReply } from '../loop/preview.ts'
import { writeAtomic } from '../store/fs.ts'
import { chat } from '../llm/deepseek.ts'

export interface ConsoleOptions {
  /**
   * 监听地址。
   *
   *   127.0.0.1（默认）= 只有这台电脑能访问；
   *   0.0.0.0          = 同一局域网/同一 WiFi 的手机也能访问。
   *
   * 注意：0.0.0.0 意味着网内任何人都能打开控制台（能读记忆、能发消息），
   * 只在信得过的网络里开。
   */
  host?: string
  port: number
  token: string
  getRules: () => Rules
  transport: Transport
  /** OneBot 通道的运行状态（连接/监听失败原因），给状态接口用 */
  getChannelStatus?: () => { connected: boolean; startError: string | null }
  /**
   * 插件注册的工具往哪挂。
   *
   * 插件的加载发生在控制台侧（这里），但工具注册表在 index.ts 建。
   * 所以这里只做「加载完把工具交出去」，注册由 index.ts 完成。
   */
  onPluginTools?: (tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; run: (args: Record<string, unknown>) => Promise<string> }>) => void
  /**
   * 真对话：控制台「对话」页走线上那条生成链路。
   *
   * 和试聊的区别是它**有副作用**：写 session、写 raw、算成本。
   * 但关系值不涨（控制台是私下聊聊，不算正式相处），
   * 记忆也只写 `private:console-<主人QQ>` 这个 scope —— 别处看不到。
   *
   * 找不到就退化成试聊（previewReply），不影响页面能用。
   */
  reply?: (m: unknown, rules: Rules) => Promise<string>
  llm?: LlmOptions
}

const RULES_FILE = 'persona/rules.yaml'

/**
 * 前端静态文件（console/）在哪个目录。
 *
 * 开发时 cwd 是项目根，resolve('console') 就对；
 * 打包后 cwd 变成用户数据目录（%APPDATA%/QQBot/data-root），
 * 而 console/ 还在程序目录里 —— 由 Electron 主进程用 QQBOT_ROOT 告诉这里。
 */
/**
 * 取一个能用的局域网 IPv4（手机访问控制台时要用）。
 *
 * 跳过 127.x 和 VMware/VirtualBox 那种虚拟网卡 —— 它们不是手机能到的地址。
 * 拿不到就返回空字符串，调用方回退到 127.0.0.1。
 */
/**
 * 控制台对话的流水。
 *
 * 单独一个文件（data/console/chat.jsonl），不写进 data/raw/ ——
 * 写 raw 会被 distill 整理成正式记忆，那就违背"控制台不污染"了。
 * 这里只是给页面回看用，QQ 那边完全不知道内容（只有次数，见 activity.ts）。
 */
const CONSOLE_CHAT = 'data/console/chat.jsonl'

type ConsoleTurn = { at: number; role: 'user' | 'it'; text: string }

function appendConsoleChat(turn: ConsoleTurn): void {
  mkdirSync('data/console', { recursive: true })
  appendFileSync(CONSOLE_CHAT, JSON.stringify(turn) + '\n', 'utf8')
}

function loadConsoleChat(limit = 50): ConsoleTurn[] {
  try {
    if (!existsSync(CONSOLE_CHAT)) return []
    const lines = readFileSync(CONSOLE_CHAT, 'utf8').split('\n').filter((x) => x.trim())
    const out: ConsoleTurn[] = []
    for (const line of lines.slice(-limit * 2)) {
      try {
        const j = JSON.parse(line) as Partial<ConsoleTurn>
        if (typeof j.text === 'string' && (j.role === 'user' || j.role === 'it')) {
          out.push({ at: Number(j.at) || 0, role: j.role, text: j.text })
        }
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.slice(-limit)
  } catch {
    return []
  }
}

function firstLanIP(): string {
  try {
    const nets = networkInterfaces()
    for (const name of Object.keys(nets)) {
      if (/vmware|virtualbox|vethernet|loopback/i.test(name)) continue
      for (const info of nets[name] ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue
        if (info.address.startsWith('127.')) continue
        return info.address
      }
    }
  } catch {
    /* 拿不到就算了 */
  }
  return ''
}

function staticRoot(): string {
  const fromEnv = process.env['QQBOT_ROOT']
  if (fromEnv) return resolve(fromEnv, 'console')
  return resolve('console')
}

/** 同步版的按卡路径解析（在非 async 的闭包里用） */
function cardScopedSync(name: string, fallback: string): string {
  try {
    const id = readFileSync('persona/cards/current.txt', 'utf8').trim()
    if (!id) return fallback
    return `persona/cards/${id}/${name}`
  } catch {
    return fallback
  }
}
function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

/**
 * 读一份**当前磁盘上**的规则。
 *
 * 为什么不能一律用 opts.getRules()：那个返回的是进程内存里的快照，
 * 靠 watchFile 每 1.5 秒轮询才发现文件变了。于是"刚保存完立刻刷新"的页面
 * 会读回**旧值** —— 实测点能力开关后，列表弹回原状态（配置其实已经写进文件了），
 * 用户会以为"开关坏了"。
 *
 * 控制台是"人刚刚改了东西"的场景，宁可多读一次文件也要读到最新的。
 * 文件读坏了就退回内存快照（总比整个页面报错好）。
 */
function freshRules(opts: ConsoleOptions): Rules {
  try {
    return loadRules().rules
  } catch {
    return opts.getRules()
  }
}

function text(res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8'): void {
  // 原来只 end(body)，code/type 两个参数被丢掉 —— 401/404 页面实际都返回 200。
  res.writeHead(code, { 'Content-Type': type })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 读 JSON body。
 *
 * 空 body 当 {}；非 JSON 抛一个带"请求体不是合法 JSON"的错误，
 * 外层 catch 会把它当输入错误返 400 —— 之前是直接 500 加原始 SyntaxError 文案。
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return parseJsonBody(await readBody(req))
}

/**
 * 这个错误该返 400 还是 500。
 *
 * 以前一律 500：用户少填一个字段、id 写错、body 不是 JSON，看到的都是"服务器错误"，
 * 前端只能笼统提示"失败"，也不知道是自己的请求问题。
 * 这里按错误文案判断——不优雅，但比给每个 throw 套一个自定义类改动小得多，
 * 而且这些文案都是本仓库自己写的（见各处的 throw new Error('缺少 …')）。
 */
function statusFor(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err)
  return /缺少|不对|不是合法 JSON|不存在|超出|必须是|非法|格式|说点什么|没有模型|未知操作/.test(msg) ? 400 : 500
}

function status(opts: ConsoleOptions, personId: string): unknown {
  const rules = opts.getRules()
  const relation = loadRelation(personId)
  const stage = stageOf(rules, relation.closeness)
  // 只算这个人说的话：切到别人的时候不该还显示总数
  const accounts = accountIdsOf(personId)
  const turns = readRaw(today()).filter((t) =>
    t.senderId ? accounts.includes(t.senderId) : accounts.some((a) => t.scope === `private:${a}`),
  )
  const facts = loadFacts(personId)
  const open = loadOpen(personId)

  const idx = rules.关系.阶段.findIndex((s) => relation.closeness <= s.至)
  const currentStage = idx >= 0 ? rules.关系.阶段[idx] : undefined
  const next = idx >= 0 && idx + 1 < rules.关系.阶段.length ? rules.关系.阶段[idx + 1]! : null

  return {
    connected: opts.transport.connected ?? false,
    // 通道监听失败（端口被占用等）：界面上要能看见，否则"起来了但收不到消息"根本查不出
    channel: opts.getChannelStatus?.() ?? null,
    transport: opts.transport.kind,
    model: opts.llm?.model ?? null,
    uptimeSec: Math.floor(process.uptime()),
    person: {
      id: personId,
      name: loadPerson(personId)?.name ?? personId,
      // 每个人的关系阶段：切换器上直接能看出来"和谁更熟"
      all: listPeople().map((p) => {
        const rel = loadRelation(p.id)
        return {
          id: p.id,
          name: p.name || p.id,
          closeness: Math.round(rel.closeness),
          stage: stageOf(rules, rel.closeness).名,
        }
      }),
    },
    relation: {
      closeness: Math.round(relation.closeness * 10) / 10,
      stage: stage.名,
      salutation: stage.称呼,
      next: next?.名 ?? null,
      nextAt: next ? (currentStage?.至 ?? null) : null,
      anchors: relation.anchors.slice(-10).reverse(),
    },
    mood: (() => {
      // 用衰减后的值：控制台显示的应该和真正注入 prompt 的一致
      const m = decayedMood(loadMood())
      return m ? { emotion: m.emotion, intensity: m.intensity } : null
    })(),
    today: {
      turns: turns.length,
      userMessages: turns.filter((t) => t.role === 'user').length,
    },
    memory: {
      facts: facts.length,
      episodes: episodesOf(personId).length,
      insights: insightsOf(personId).length,
      open: open.length,
      root: memoryRoot(),
    },
    relationBlock: buildRelationBlock(rules, relation, loadMood()),
    cost: costOfToday(),
    scheduler: (() => {
      const p = proactiveStatus(rules, stageOf(rules, relation.closeness).名)
      let distillAt = 0
      try {
        const s = JSON.parse(readFileSync(join(memoryRoot(), '.state.json'), 'utf8')) as { scopes?: Record<string, number> }
        distillAt = Math.max(0, ...Object.values(s.scopes ?? {}))
      } catch {
        /* 没有状态文件 */
      }
      return {
        proactive: {
          todayCount: p.todayCount,
          dailyMax: p.dailyMax,
          minGapHours: p.minGapHours,
          lastAt: p.lastAt,
          lastText: p.lastText,
        },
        lastDistillAt: distillAt,
      }
    })(),
  }
}

/** 只属于这个人的经历：私聊 scope 正好是这个人的账号 */
function episodesOf(personId: string): ReturnType<typeof loadEpisodes> {
  const accounts = accountIdsOf(personId)
  return loadEpisodes().filter((e) => accounts.some((a) => e.scope === `private:${a}`))
}

function insightsOf(personId: string): ReturnType<typeof loadInsights> {
  const accounts = accountIdsOf(personId)
  return loadInsights().filter((i) => accounts.some((a) => i.scope === `private:${a}`) || i.scope === 'shared')
}

function memoryDump(personId: string): unknown {
  return {
    facts: loadFacts(personId),
    open: loadOpen(personId),
    episodes: episodesOf(personId)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 60),
    insights: insightsOf(personId).slice(-60).reverse(),
  }
}


/** 最近 N 天的曲线：消息数、花费、关系值 */
function trendOf(days: number, personId: string): unknown {
  const accounts = accountIdsOf(personId)
  const points: Array<{ date: string; label: string; turns: number; cny: number }> = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const label = `${d.getMonth() + 1}/${d.getDate()}`

    let turns = 0
    for (const t of readRaw(key)) {
      if (t.senderId ? accounts.includes(t.senderId) : accounts.some((a) => t.scope === `private:${a}`)) turns++
    }

    let cny = 0
    const logFile = `data/logs/${key}.jsonl`
    if (existsSync(logFile)) {
      let prompt = 0
      let completion = 0
      for (const line of readFileSync(logFile, 'utf8').split('\n')) {
        if (!line.includes('token 用量')) continue
        try {
          const rec = JSON.parse(line) as { extra?: { prompt?: number; completion?: number } }
          prompt += Number(rec.extra?.prompt ?? 0)
          completion += Number(rec.extra?.completion ?? 0)
        } catch {
          /* skip */
        }
      }
      cny = (prompt / 1e6) * PRICE_IN + (completion / 1e6) * PRICE_OUT
    }

    points.push({ date: key, label, turns, cny: Math.round(cny * 1000) / 1000 })
  }

  return { days, points, relation: Math.round(loadRelation(personId).closeness * 10) / 10 }
}
/** DeepSeek 的大致单价（元 / 百万 token），只用来估算量级 */
const PRICE_IN = 1
const PRICE_OUT = 2

/** 从今天的日志里聚合 token 用量 */
function costOfToday(): unknown {
  const file = `data/logs/${today()}.jsonl`
  let prompt = 0
  let completion = 0
  let calls = 0
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('token 用量')) continue
      try {
        const rec = JSON.parse(line) as { extra?: { prompt?: number; completion?: number } }
        if (!rec.extra) continue
        prompt += Number(rec.extra.prompt ?? 0)
        completion += Number(rec.extra.completion ?? 0)
        calls += 1
      } catch {
        /* skip */
      }
    }
  }
  const cny = (prompt / 1e6) * PRICE_IN + (completion / 1e6) * PRICE_OUT
  return {
    date: today(),
    calls,
    prompt,
    completion,
    total: prompt + completion,
    cny: Math.round(cny * 1000) / 1000,
    note: '按 ¥1/¥2 每百万 token 估算，实际以账单为准',
  }
}

async function runAction(
  opts: ConsoleOptions,
  action: string,
  payload: Record<string, unknown>,
  personId: string,
): Promise<unknown> {
  switch (action) {
    case 'speak': {
      if (!opts.llm) throw new Error('没有模型配置')
      const rules = opts.getRules()
      const target = payload['target']
      const to = typeof target === 'string' && target ? target : process.env['OWNER_QQ'] ?? ''
      if (!to) throw new Error('没有指定目标 QQ')
      const res = await chat(
        [
          { role: 'system', content: '说一句你想对他说的话。一两句，不超过 30 字。只输出这句话。' },
          { role: 'user', content: buildRelationBlock(rules, loadRelation(personId), loadMood()) },
        ],
        { ...opts.llm, maxTokens: 120, temperature: 0.9 },
      )
      const line = res.text.trim()
      if (!line) throw new Error('模型没有生成内容')
      await opts.transport.send({ kind: 'private', id: to }, line)
      info('控制台手动发送', { text: line })
      return { sent: line }
    }

    case 'distill': {
      if (!opts.llm) throw new Error('没有模型配置')
      const rules = opts.getRules()
      const account = primaryAccount(personId)
      const date = typeof payload['date'] === 'string' ? payload['date'] : today()
      const turns = readRaw(date)
      if (!turns.length) return { skipped: '当天没有对话' }
      const groups = new Map<string, typeof turns>()
      for (const t of turns) {
        const list = groups.get(t.scope) ?? []
        list.push(t)
        groups.set(t.scope, list)
      }
      const results: unknown[] = []
      // 手动整理也走同一套筛选——不然"自动"和"手动"结果不一样，
      // 而手动跑出来的 episode 反而是没筛过的（废话更多）。
      const { pickForDistill } = await import('../memory/filter.ts')
      const { loadEpisodes } = await import('../memory/store.ts')
      for (const [scope, list] of groups) {
        const pid = scope.startsWith('private:') ? personOfAccount('qq', scope.slice('private:'.length)) : personId
        const existing = loadEpisodes()
          .filter((e) => e.scope === scope)
          .map((e) => `${e.title} ${e.body}`)
        const picked = pickForDistill(list, existing)
        results.push({
          scope,
          原始条数: list.length,
          筛后条数: picked.length,
          ...(await distill({ personId: pid, scope: scope as Scope, turns: picked, llm: opts.llm, rules })),
        })
      }
      return { date, account, results }
    }

    case 'reload': {
      const rules = loadRules()
      return { reloaded: true, warnings: rules.warnings }
    }

// 标记/取消精选：表达学习里"这句值得学吗"是人工判断的，
    // 不能只靠模型自评（实测 24 条全是 8 分，里面有追问的坏例子）。
// 重扫代码地图：用户说"你重新扫一遍"时点这个，或者它自己调 rescan_code 工具
    case 'rescanCode': {
      const { refreshCodeMap, loadCodeMapBrief } = await import('../self/codemap.ts')
      const r = refreshCodeMap(true)
      return { rebuilt: r.rebuilt, modules: r.modules, brief: loadCodeMapBrief() }
    }

    case 'togglePlay': {
      const scene = String(payload['scene'] ?? '').trim()
      const checked = payload['checked'] === true
      if (!scene) throw new Error('缺少 scene')
      const { toggleChecked } = await import('../learn/plays.ts')
      const ok = toggleChecked(scene, checked)
      return { ok, scene, checked }
    }

    // 群里的说法：标/取消精选。和 togglePlay 分开，因为 key 是「说法」本身，不是场景
    case 'toggleExpression': {
      const text = String(payload['text'] ?? '').trim()
      const checked = payload['checked'] === true
      if (!text) throw new Error('缺少 text')
      const { toggleExpressionChecked } = await import('../learn/expression.ts')
      const ok = toggleExpressionChecked(text, checked)
      return { ok, text, checked }
    }

    case 'restore': {
      const id = String(payload['id'] ?? '')
      if (!id) throw new Error('缺少快照 id')
      if (!restore(id)) throw new Error('快照不存在')
      return { restored: id, note: '回滚前的状态也存了一份' }
    }

    case 'watch': {
      if (!opts.llm) throw new Error('没有模型配置')
      const { watchOne } = await import('../outward/watch.ts')
      const r = await watchOne({ llm: opts.llm, rules: opts.getRules(), force: true })
      return r as unknown as Record<string, unknown>
    }

    case 'selfReflect': {
      if (!opts.llm) throw new Error('没有模型配置')
      const { reflectSelf } = await import('../self/reflect.ts')
      const ok = await reflectSelf({ llm: opts.llm, rules: opts.getRules(), personId })
      return { reflected: ok }
    }

    case 'snapshot': {
      const { snapshot } = await import('../persona/version.ts')
      const id = snapshot('manual')
      return { snapshot: id }
    }

    // 核心记忆：只有人能加/删
    case 'addCore': {
      const text = String(payload['text'] ?? '')
      const kind = String(payload['kind'] ?? '身份')
      const { addCore } = await import('../memory/core.ts')
      const valid = ['身份', '边界', '诺言', '偏好'].includes(kind)
        ? (kind as '身份' | '边界' | '诺言' | '偏好')
        : '身份'
      const r = addCore(text, valid)
      if (!r.ok) throw new Error(r.why)
      return { added: text }
    }

    case 'dropCore': {
      const index = Number(payload['index'] ?? -1)
      const { dropCore } = await import('../memory/core.ts')
      if (!dropCore(index)) throw new Error('没有这一条')
      return { dropped: index }
    }

    case 'approveCoreRequest': {
      const index = Number(payload['index'] ?? -1)
      const { approveRequest } = await import('../memory/core.ts')
      const r = approveRequest(index)
      if (!r.ok) throw new Error('批不了（序号不对，或核心已满 30 条）')
      return { approved: r.item }
    }

    case 'rejectCoreRequest': {
      const index = Number(payload['index'] ?? -1)
      const { rejectRequest } = await import('../memory/core.ts')
      if (!rejectRequest(index)) throw new Error('没有这条申请')
      return { rejected: index }
    }

    // 发一条草稿。只有人能触发——它自己调不到这里（没给它工具）。
    case 'publishQzone': {
      const index = Number(payload['index'] ?? -1)
      if (!Number.isInteger(index) || index < 0) throw new Error('缺少草稿序号')
      const { publishDraft } = await import('../outward/qzone.ts')
      const rules = opts.getRules()
      const r = await publishDraft(opts.transport, index, { ugcRight: rules.外部?.发空间?.默认权限 ?? 1 })
      if (!r.ok) throw new Error(r.reason ?? '发失败')
      return { tid: r.tid }
    }

    case 'dropDraft': {
      const index = Number(payload['index'] ?? -1)
      const { dropDraft } = await import('../outward/qzone.ts')
      if (!dropDraft(index)) throw new Error('没有这条草稿')
      return { dropped: index }
    }

    case 'editDraft': {
      const index = Number(payload['index'] ?? -1)
      const content = String(payload['content'] ?? '')
      const { editDraft } = await import('../outward/qzone.ts')
      if (!editDraft(index, content)) throw new Error('改不了（内容太短或序号不对）')
      return { edited: index }
    }

    // 删一条已经发出去的
    case 'unpublishQzone': {
      const tid = String(payload['tid'] ?? '')
      if (!tid) throw new Error('缺少 tid')
      const { unpublish } = await import('../outward/qzone.ts')
      const ok = await unpublish(opts.transport, tid)
      if (!ok) throw new Error('删不掉（通道不支持或 tid 不对）')
      return { deleted: tid }
    }

    // 让它现在想一条说说攒成草稿（它自己主动想，不是自动发）
    case 'draftQzone': {
      if (!opts.llm) throw new Error('没有模型配置')
      const { composeDraft } = await import('../outward/qzone.ts')
      const rules = opts.getRules()
      const r = await composeDraft(opts.llm, rules)
      // 没攒上不算"请求失败"，如实带回去让前端显示原因就行。
      // 抛 500 的话前端只说"失败"，看不到"太像了"这种具体说明。
      return r.ok
        ? { drafted: r.content, reason: '' }
        : { drafted: '', reason: r.reason ?? '没想出什么', tried: r.content ?? '' }
    }

    // 从快照恢复被清空的群名单。
    // 只在快照明显更完整时才覆盖（差 5 人以上），避免把新名单退回去。
    case 'restoreGroups': {
      const { restoreGroupsFromSnapshots } = await import('../people/groupcache.ts')
      const r = restoreGroupsFromSnapshots()
      return {
        恢复了: r.restored.length,
        跳过: r.skipped.length,
        扫了快照: r.scanned,
        详情: r.restored.map((x) => `群 ${x.groupId}: ${x.from} → ${x.to} 人（${x.snapshot}）`),
        跳过详情: r.skipped.map((x) => `群 ${x.groupId}: 现在 ${x.current} 人，快照最好 ${x.best} 人`),
      }
    }

    case 'groupMembers': {
      const gid = String(payload['groupId'] ?? '')
      if (!gid) throw new Error('缺少 groupId')
      if (!opts.transport.listGroupMembers) throw new Error('当前通道不支持拉群成员')
      // 走缓存：拉到的会落盘，重启后还用得上
      const { refreshGroupMembers, groupMembers } = await import('../people/group.ts')
      await refreshGroupMembers(opts.transport, gid, { force: true })
      const members = groupMembers(gid)
      return { groupId: gid, count: members.length, members: members.slice(0, 100) }
    }

    default:
      throw new Error(`未知操作：${action}`)
  }
}

/**
 * 会改变"哪些插件在跑"的接口。这些成功之后要把工具表重新交给注册表。
 *
 * 为什么不放在 plugin-api.ts 里：那边只产出"路由表 + handler"，
 * 不知道谁是 ToolRegistry；刷新是控制台装配层的事。
 */
const MUTATING_PLUGIN_ROUTES = new Set(['/install', '/uninstall', '/toggle', '/reload'])

/**
 * 把插件的 panel.html 发给浏览器。
 *
 * 抽出来是因为它有两处调用：一处在免鉴权的静态白名单里（面板不能带 token），
 * 另一处在 /api/plugins/panel 路由里（带 token 的老路径，保留兼容）。
 */
function sendPanelHtml(res: ServerResponse, pid: string): void {
  const file = join('plugins', pid, 'panel.html')
  try {
    const html = readFileSync(file, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 面板是外部代码：不许它引控制台的样式/脚本，也不许被别的站嵌
      'content-security-policy': "default-src 'self' 'unsafe-inline' data: blob:; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
    })
    res.end(html)
  } catch {
    json(res, 404, { ok: false, error: `插件 ${pid} 没有 panel.html（panel 类型插件需要这个文件）` })
  }
}

export async function startConsole(opts: ConsoleOptions): Promise<void> {
  consoleOpts = opts
  // 没设 token 又监听在非本机地址 = 同一网段任何人都能改配置、发消息、导数据。
  // 这种组合直接拒绝启动，比"默默开着"安全 —— 用户会在日志里看到明确原因。
  const bindHost = opts.host ?? '127.0.0.1'
  const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(bindHost)
  if (!opts.token && !loopbackHost) {
    errorAt(
      '控制台没设 CONSOLE_TOKEN，却监听在 ' +
        bindHost +
        ' —— 已拒绝启动控制台（同网段任何人都能操作）。在 .env 里补一个随机 token 再启动。',
    )
    return
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    // 控制台自己的静态文件（members.js 等）**不走 token 校验**。
    //
    // 为什么：`<script src="/members.js">` 带不了自定义 header，
    // 也没法把 token 拼进 src（那是硬编码，刷新就失效）。
    // 这些文件是纯前端代码，不含数据；真正拿数据还得过 /api/* 的 token。
    // 只允许 console/ 下的 .js/.css，路径里不许有 ..，其余一律 404。
    //
    // 二维码图片也在这里放行：`<img src>` 同样带不了 header。
    // 它只在**未登录**时存在；默认只监听 127.0.0.1，配了 CONSOLE_HOST=0.0.0.0
    // （手机访问）时这张图也会被同网段看到，这是那个开关本身的取舍。
    // 面板 HTML 也在这里放行。
    //
    // 为什么不带 token：iframe 的 sandbox 去掉了 allow-same-origin（见
    // console/plugins.js），面板是不透明源。而以前 src 上拼着**完整控制台 token**，
    // 面板里的任何 JS（包括它引的第三方图表库）都能拿这个 token 调任意 /api ——
    // 卸插件、改模型、导数据，和你手动操作控制台权限一样。
    // 现在面板只拿到自己的静态 HTML，要数据必须走 postMessage 桥（宿主代发）。
    // 这个页面不含任何数据，放行它不会泄露什么。
    if (
      (req.method === 'GET' && /^\/[\w.-]+\.(js|css)$/.test(path)) ||
      (req.method === 'GET' && path === '/api/napcat/qrcode.png') ||
      (req.method === 'GET' && /^\/api\/plugins\/panel\/[A-Za-z0-9_-]{1,64}$/.test(path)) ||
      (req.method === 'GET' && (path === '/' || path === '/index.html'))
    ) {
      // 二维码交给 misc-api（它知道 NapCat 装在哪）。
      // 但它**不能**跟静态资源一样免鉴权：二维码就是登录凭据，谁扫到谁就能登这个 QQ。
      // 以前它在这段放行里，等于同网段任何人都能拿到。
      if (path === '/api/napcat/qrcode.png') {
        const remote = req.socket.remoteAddress ?? ''
        const loop = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        if (!loop) {
          text(res, 403, '二维码只允许本机查看（远程请走带 token 的控制台）')
          return
        }
        if (await handleMiscApi(req, res, path, url, json)) return
        text(res, 404, '没有二维码')
        return
      }

      // 面板 HTML：从 plugins/<id>/panel.html 发出去（不能按 console/ 找）
      {
        const pm = /^\/api\/plugins\/panel\/([A-Za-z0-9_-]{1,64})$/.exec(path)
        if (pm) {
          sendPanelHtml(res, pm[1]!)
          return
        }
      }

      const rel = path === '/' || path === '/index.html' ? 'index.html' : path.slice(1)
      const root = staticRoot()
      const full = resolve(root, rel)
      if (!full.startsWith(root) || !existsSync(full)) {
        text(res, 404, '没有这个文件')
        return
      }
      const type = rel.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : rel.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8'
      // 不加 no-cache 的话，改了 js/css 浏览器还用旧的 —— 排查半天以为是代码没生效。
      // 这些文件很小，每次都重新拉不心疼。
      //
      // ⚠️ 但有 no-cache 还不够：没 ETag/Last-Modified 的话浏览器没有"验证依据"，
      // 某些情况下会直接拿内存里的旧副本（改完前端看不到更新，就是这个原因）。
      // 加上内容哈希做 ETag + 文件的 mtime 做 Last-Modified，浏览器就会真的重新验证。
      const body = readFileSync(full, 'utf8')
      const etag = '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"'
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' })
        res.end()
        return
      }
      const mtime = statSync(full).mtime.toUTCString()
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-cache, no-store, must-revalidate',
        etag,
        'last-modified': mtime,
      })
      res.end(body)
      return
    }

    // 鉴权：token 从 query 或 header 取
    //
    // 例外：panel 插件的静态页面。iframe 的 src 是浏览器自己发的 GET，
    // 带不了自定义 header，所以只能用 query 传 token（前端拼在 src 上）。
    // 这个页面本身不含任何数据，是插件自带的静态文件。
    //
    // ⚠ token 为空**不再等于"免鉴权"**。以前是 `if (opts.token && …)`，
    // 于是 `.env` 里留空（`.env.example` 还写着"留空则每次启动随机生成"）
    // 就等于同一网段任何人都能改配置、发消息、导数据。
    // 现在：空 token 只允许**本机**访问；非本机监听 + 空 token 启动时直接拒绝。
    const given = url.searchParams.get('token') ?? req.headers['x-console-token']
    const remote = req.socket.remoteAddress ?? ''
    const fromLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    const authorized = opts.token ? given === opts.token : fromLoopback
    if (!authorized) {
      // 浏览器直接打开时给一个人话页面 —— 裸 401 只会让人以为程序坏了。
      // 接口请求（fetch）还是回 JSON，前端好处理。
      const wantsHtml = String(req.headers['accept'] ?? '').includes('text/html')
      if (wantsHtml && (req.method === 'GET' || req.method === 'HEAD')) {
        const hint = given ? '链接里的 token 不对（可能少复制了后半截）' : '链接里没有 token'
        // 这里**不能**把完整 token 拼回页面：401 页是任何拿到地址的人都能打开的，
        // 以前在未带 token 时直接渲染 `?token=<完整 token>`，等于把钥匙挂在门上
        // （非本机监听时，同网段谁访问谁拿到）。只提示去哪里找。
        text(
          res,
          401,
          `<!doctype html><meta charset="utf-8"><title>需要 token</title>
<body style="background:#0d1117;color:#e6edf3;font:15px/1.9 system-ui;padding:60px;max-width:720px">
<h2 style="margin:0 0 8px">打不开控制台</h2>
<p style="color:#8b949e;margin:0 0 20px">${hint}</p>
<p style="color:#8b949e;font-size:13px;margin:0">
完整 token 在数据目录的 <code style="color:#79c0ff">.env</code> 里（<code>CONSOLE_TOKEN</code>），<br>
也可以看后端启动日志里那句「控制台已启动」，<br>
或者在那台机器上直接打开 <code style="color:#79c0ff">http://127.0.0.1:${opts.port}/</code>（本机访问免 token）。
</p>
</body>`,
          'text/html; charset=utf-8',
        )
        return
      }
      json(res, 401, { error: 'token 不对' })
      return
    }

    // 看谁：默认主人。参数必须过白名单，否则回落到默认，绝不让它拼进文件路径
    const ownerQQ = process.env['OWNER_QQ'] ?? ''
    const fallback = personOfAccount('qq', ownerQQ || 'console')
    const asked = url.searchParams.get('person')
    const personId = asked && isValidPersonId(asked) ? asked : fallback

    try {
      if (req.method === 'GET' && path === '/api/status') {
        json(res, 200, status(opts, personId))
        return
      }

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        let dropped = 0
        const onLog = (rec: LogRecord) => {
          // 页面休眠/网络卡住时 write 会返回 false（缓冲已满）：这时候继续写只会让
          // 内存无上限增长。直接丢这条（日志本来就有文件持久化）。
          try {
            if (res.writableEnded || res.destroyed) return
            const okWrite = res.write(`data: ${JSON.stringify(rec)}\n\n`)
            if (!okWrite) dropped++
          } catch {
            // 某个客户端写失败绝不能把异常抛回业务代码（logBus.emit 是同步的）
          }
        }
        logBus.on('log', onLog)
        const ping = setInterval(() => {
          try {
            if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
          } catch {
            /* ignore */
          }
        }, 15000)
        req.on('close', () => {
          logBus.off('log', onLog)
          clearInterval(ping)
        })
        return
      }

      if (req.method === 'GET' && path === '/api/logs/recent') {
        const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n')) || 50))
        const file = `data/logs/${today()}.jsonl`
        const rows: LogRecord[] = []
        if (existsSync(file)) {
          const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
          for (const line of lines.slice(-n)) {
            try {
              rows.push(JSON.parse(line) as LogRecord)
            } catch {
              /* skip */
            }
          }
        }
        json(res, 200, rows)
        return
      }

      if (req.method === 'GET' && path === '/api/access') {
        let groupMode = '熟人续话'
        try {
          groupMode = loadRules().rules.行为.群聊模式
        } catch {
          /* 读不到就用默认，别让权限页打不开 */
        }
        json(res, 200, { policy: loadAccess(), path: accessFile(), groupMode })
        return
      }

      if (req.method === 'PUT' && path === '/api/access') {
        // 坏 body 统一走 readJson：它抛「请求体不是合法 JSON」，外层返回 400；
        // 以前裸 JSON.parse 抛 SyntaxError，用户拿到的是 500 + 一段堆栈。
        const data = (await readJson(req)) as Partial<AccessPolicy>
        const cur = loadAccess()
        /** 缺字段就沿用原值；只有真的传了数组才替换 */
        const arr = (v: unknown, fallback: string[]): string[] =>
          Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : fallback
        const next: AccessPolicy = {
          // 没传就沿用当前值，别因为老前端不发这个字段就把总开关关了
          allowGroup: typeof data.allowGroup === 'boolean' ? data.allowGroup : cur.allowGroup,
          // 以前这里无条件 clean(data.xxx)：前端只发 groupDeny 时，
          // groupAllow / memberAllow / memberDeny 会被写成空数组 —— 一次 PUT 清空白名单。
          groupAllow: arr(data.groupAllow, cur.groupAllow),
          groupDeny: arr(data.groupDeny, cur.groupDeny),
          memberAllow: arr(data.memberAllow, cur.memberAllow),
          memberDeny: arr(data.memberDeny, cur.memberDeny),
          // 同理：以前 `data.requireAt !== false` 会把「没传」当成 true，强制开回必须 @。
          requireAt: typeof data.requireAt === 'boolean' ? data.requireAt : cur.requireAt,
        }
        saveAccess(next)

        // 「必须 @」和「群聊模式」是同一件事的两个入口（曾经并存，
        // 用户会在权限页关了必须 @ 却发现它还是不理）。
        // 现在模式是权威：这里只把复选框的变化同步成模式，
        // 没传 groupMode 就什么也不动，避免老前端把「只听」冲成「熟人续话」。
        const wantMode = asGroupChatMode((data as { groupMode?: unknown }).groupMode)
        if (wantMode) {
          try {
            const fs = await import('node:fs')
            const { setConfigPath } = await import('./config-write.ts')
            const raw = fs.readFileSync('persona/rules.yaml', 'utf8')
            const r = setConfigPath(raw, '行为.群聊模式', wantMode)
            if (r.ok) writeAtomic('persona/rules.yaml', r.text)
            else warnAt('群聊模式没写进 rules.yaml：' + (r.error ?? '找不到键'))
          } catch (e) {
            warnAt('群聊模式没写进 rules.yaml', { err: String(e).slice(0, 120) })
          }
        }

        info('权限策略已更新', {
          群聊: next.allowGroup ? '开' : '关',
          群白: next.groupAllow.length,
          群黑: next.groupDeny.length,
          成员白: next.memberAllow.length,
          成员黑: next.memberDeny.length,
          必须at: next.requireAt,
          ...(wantMode ? { 群聊模式: wantMode } : {}),
        })
        json(res, 200, { policy: next, ...(wantMode ? { groupMode: wantMode } : {}) })
        return
      }

      if (req.method === 'GET' && path === '/api/trend') {
        const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7))
        json(res, 200, trendOf(days, personId))
        return
      }

      // ---- 记忆编辑：改错的、删掉不该留的 ----
      // 改可见性：全 private 的时候用户会想"这条其实可以说"
      if (req.method === 'PATCH' && path === '/api/facts/visibility') {
        const d = (await readJson(req)) as { text?: string; visibility?: string }
        const text = String(d.text ?? '')
        const v = String(d.visibility ?? '')
        if (!text || !['public', 'private', 'unsure'].includes(v)) throw new Error('参数不对')
        json(res, 200, { updated: setVisibility(personId, text, v as never) })
        return
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && path === '/api/facts') {
        const d = (await readJson(req)) as { text?: string; newText?: string; confidence?: number }
        const text = String(d.text ?? '')
        if (!text) throw new Error('缺少 text')
        if (req.method === 'DELETE') {
          const ok = deleteFact(personId, text)
          info('控制台删了一条事实', { 人: personId, 内容: text.slice(0, 40) })
          json(res, 200, { deleted: ok })
        } else {
          const ok = editFact(personId, text, { text: d.newText, confidence: d.confidence })
          info('控制台改了一条事实', { 人: personId })
          json(res, 200, { updated: ok })
        }
        return
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && path === '/api/open') {
        const d = (await readJson(req)) as { text?: string; newText?: string }
        const text = String(d.text ?? '')
        if (!text) throw new Error('缺少 text')
        if (req.method === 'DELETE') {
          json(res, 200, { deleted: removeOpen(personId, text) })
        } else {
          json(res, 200, { updated: editOpen(personId, text, String(d.newText ?? '')) })
        }
        return
      }

      if (req.method === 'DELETE' && path === '/api/episode') {
        const d = (await readJson(req)) as { id?: string; scope?: string }
        if (!d.id || !d.scope) throw new Error('缺少 id 或 scope')
        json(res, 200, { deleted: deleteEpisode(d.id, d.scope as never) })
        return
      }

      // ---- AI 当前状态：一个接口把"它现在什么样"拼齐 ----
      if (req.method === 'GET' && path === '/api/state') {
        const s = status(opts, personId) as {
          relation: unknown
          today: unknown
          memory: unknown
          scheduler: unknown
          cost: unknown
        }
        const self = loadSelf()
        const mood = decayedMood(loadMood())
        const person = loadPerson(personId)
        json(res, 200, {
          name: self.name || null,
          selfAbout: self.about || null,
          selfThinking: self.thinking || null,
          nameReason: self.nameReason || null,
          selfVersions: listSelfVersions(5),
          drifts: loadDrifts(5),
          phase: phaseOf(freshRules(opts), new Date()),
          mood: mood ? { emotion: mood.emotion, intensity: mood.intensity, at: mood.at } : null,
          relation: s.relation,
          person: person ? { id: person.id, name: person.name, firstSeen: person.firstSeen } : null,
          open: loadOpen(personId).slice(-5),
          life: loadLife().slice(-3).reverse(),
          watched: (() => {
            try {
              return loadWatched().slice(-3).reverse()
            } catch {
              return []
            }
          })(),
          watchConf: freshRules(opts).外部?.刷视频 ?? null,
          issues: (() => {
            try {
              return findIssues({ days: 3, minCount: 2 })
            } catch {
              return []
            }
          })(),
          today: s.today,
          memory: s.memory,
          scheduler: s.scheduler,
          cost: s.cost,
        })
        return
      }

      // ---- 搜索 ----
      if (req.method === 'GET' && path === '/api/search') {
        const q = url.searchParams.get('q') ?? ''
        const types = (url.searchParams.get('types') ?? '').split(',').filter(Boolean)
        json(res, 200, {
          query: q,
          hits: search({
            query: q,
            personId,
            ...(types.length ? { types: types as never } : {}),
            days: Number(url.searchParams.get('days')) || 7,
          }),
        })
        return
      }

      // ---- 导出 ----
      if (req.method === 'GET' && path === '/api/export') {
        const data = exportAll(Number(url.searchParams.get('days')) || 30)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="qqbot-backup-${today()}.json"`,
        })
        res.end(JSON.stringify(data, null, 2))
        return
      }
      // ---- 从备份恢复 ----
      if (req.method === 'POST' && path === '/api/import') {
        const body = await readBody(req)
        // 备份可能几十 MB，但也不该无限；超过 64MB 基本不是正常备份
        if (body.length > 64 * 1024 * 1024) {
          json(res, 413, { error: '备份文件太大（超过 64MB）' })
          return true
        }
        const data = parseBackup(body)
        const stats = importBackup(data, {
          overwrite: url.searchParams.get('overwrite') === '1',
          includeConfig: url.searchParams.get('config') === '1',
          dryRun: url.searchParams.get('dry') === '1',
        })
        info('从备份恢复', {
          人: stats.people,
          事实: stats.facts,
          经历: stats.episodes,
          洞察: stats.insights,
          会话: stats.sessions,
          跳过: stats.skipped,
          快照: stats.snapshot ?? '没拍成',
        })
        json(res, 200, stats)
        return true
      }

      if (req.method === 'GET' && path === '/api/versions') {
        json(res, 200, { snapshots: listSnapshots() })
        return
      }

      // 说说草稿：看、改、发、删。发之前必须人看过——发出去收不回。
      if (req.method === 'GET' && path === '/api/qzone') {
        const { loadDrafts } = await import('../outward/qzone.ts')
        const rules = opts.getRules()
        const d = loadDrafts()
        json(res, 200, {
          开启: rules.外部?.发空间?.开启 ?? false,
          默认权限: rules.外部?.发空间?.默认权限 ?? 1,
          支持发送: !!opts.transport.sendQzone,
          ...d,
        })
        return
      }

      // 新功能总览：表情包 / 看图 / 压缩 / 表达学习
      // 这几块以前只在代码里，控制台看不见，改了什么也没法验证。

      // 群名单总览：每个群一个列表，标出哪些人真有档案（聊过）
        // 人物：列表 / 详情 / 建档 / 改名 / 改画像 / 改印象 / 改关系 / 删除
        // 逻辑在 console/people-api.ts，这里只转交（返回 true = 已写响应）
        if (await handlePeopleApi(req, res, path, url, json, readBody)) return
        if (await handleDesktopApi(req, res, path, url, json, readBody)) return
        if (await handleMiscApi(req, res, path, url, json)) return
        if (await handleMemberApi(req, res, path, url, json)) return
        if (await handleSettingsApi(req, res, path, url, json)) return
        if (await handleTestApi(req, res, path, url, json, readBody)) return

        // ---- 插件系统 ----
        //
        // plugin-api.ts 只给「路由表 + handler」，不管 HTTP（那是它的设计），
        // 所以这里负责把 /api/plugins/xxx 分发过去。
        // ---- 控制台对话（真聊）----
/* ============ 控制台「对话」页：真聊 ============
           和试聊的区别：这条走 generateReply，会写 session / raw / 算成本。
           但记忆只写 private:console-<主人QQ>，别处看不到（见 memory/recall.ts 的 visible）。
           关系值不涨 —— 控制台是私下聊聊，不算正式相处。 */
        if (req.method === 'POST' && path === '/api/chat/send') {
          const body = (await readJson(req)) as { text?: string }
          const text = String(body.text ?? '').trim().slice(0, 2000)
          if (!text) { json(res, 400, { ok: false, error: '空消息' }); return }
          if (!opts.reply) { json(res, 400, { ok: false, error: '这个版本没接真对话' }); return }

          const ownerQQ = String(process.env['OWNER_QQ'] ?? '').trim()
          const started = Date.now()
          try {
            const reply = await opts.reply(
              {
                id: 'console-' + started,
                from: { kind: 'private', id: 'console-' + ownerQQ },
                selfId: '',
                text,
                at: started,
                senderId: ownerQQ || 'console',
                senderName: '主人（控制台）',
              },
              opts.getRules(),
            )
            // 控制台自己的流水：给页面显示历史用，不进 distill
            try {
              appendConsoleChat({ at: started, role: 'user', text })
              appendConsoleChat({ at: Date.now(), role: 'it', text: reply })
              // 元信息：QQ 那边只看到"聊过几次"，看不到内容
              recordConsoleTurn()
            } catch {
              /* 记流水失败不影响回复 */
            }
            json(res, 200, { ok: true, data: { reply, ms: Date.now() - started } })
          } catch (e) {
            json(res, statusFor(e), { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // 控制台对话历史（只给页面用，别的对方看不到）
        if (req.method === 'GET' && path === '/api/chat/history') {
          json(res, 200, { ok: true, data: { turns: loadConsoleChat(50) } })
          return
        }

        // 把控制台最近的对话记成正式记忆（页面按钮 / 它自己调工具都走这里）
        if (req.method === 'POST' && path === '/api/chat/commit') {
          const body = (await readJson(req)) as { rounds?: number; title?: string }
          const { commitConsoleToMemory } = await import('./commit.ts')
          const r = await commitConsoleToMemory({
            ownerQQ: String(process.env['OWNER_QQ'] ?? '').trim(),
            rounds: Number(body.rounds) || 6,
            ...(body.title ? { title: String(body.title) } : {}),
          })
          json(res, r.ok ? 200 : 400, r.ok ? { ok: true, data: { detail: r.detail } } : { ok: false, error: r.detail })
          return
        }

        // 表情包库（看/删/取图）。放在 plugins 之前，路径不冲突但读起来顺。
        if (await handleEmojiApi(req, res, path, json, readJson)) return

        if (path.startsWith('/api/plugins/')) {
          const sub = path.slice('/api/plugins'.length)
          const svc = getPluginService()
          // 第一次请求可能赶在插件加载完成之前，等它一下
          if (pluginReady) await pluginReady

          /* ---- panel 类型插件：它的前端页面 ----
           *
           * 用 iframe 加载（前端把 src 指到这里），插件的 HTML 在 iframe 里跑，
           * 拿不到控制台的 window/document —— 这是最轻的隔离。
           *
           * 面板里要调后端，走 /api/plugins/<id>/call（见 plugin-api.ts），
           * 面板本身是静态 HTML，不执行控制台的任何代码。
           */
          const panelMatch = /^\/panel\/([^/]+)$/.exec(sub)
          if (req.method === 'GET' && panelMatch) {
            const pid = decodeURIComponent(panelMatch[1]!)

            /* 显式校验插件 id 的格式。
             *
             * 插件 id 本来就只能是 [a-z0-9-_]（见 manifest 校验），
             * 这里再卡一道，不依赖任何路径巧合。
             *
             * 说明：带 token 的这条路径是为了兼容"老前端"（iframe 的 src 上
             * 拼 token 的那种）。新前端已经改成不带 token，从上面的静态白名单直接
             * 发面板；两条路径共用 sendPanelHtml()。
             */
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
              json(res, 400, { ok: false, error: '插件 id 不合法' })
              return
            }
            sendPanelHtml(res, pid)
            return
          }

          const route = pluginRoutes(svc).find((r) => r.path === sub && r.method === req.method)
          if (!route) {
            json(res, 404, { ok: false, error: '没有这个插件接口：' + sub })
            return
          }
          let body: unknown
          if (req.method === 'POST') {
            try {
              body = await readJson(req)
            } catch {
              json(res, 400, { ok: false, error: 'invalid body: 不是合法 JSON' })
              return
            }
          }
          const result = await route.handler(body)
          // 改动了"哪些插件在跑"的接口，要把最新的工具表重新交给注册表。
          // 不刷的话：重载成功了，但模型手里还是旧 wrapper（实测 BUG3-21）——
          // 控制台里"测试"跑的是新代码，聊天里调的还是旧的，只有重启后端才恢复。
          if (result.ok && MUTATING_PLUGIN_ROUTES.has(sub)) {
            try {
              consoleOpts?.onPluginTools?.(svc.host.tools())
            } catch {
              /* 拿工具失败不影响这次请求的结果 */
            }
          }
          json(res, result.ok ? 200 : 400, result)
          return
        }

      // 体检：一眼看出哪里坏了
      // 每项独立跑，API 挂了不影响查磁盘；最慢的一项 3 秒超时。
      // 能力清单：它能干什么、开没开。
      // 直接复用 abilities.ts —— 那是给 prompt 用的同一份数据，
      // 分开维护会漂（prompt 说"能看屏幕"，控制台说"不能"）。
      // 它准备做的事：读 / 加 / 完成 / 删
      /* ============ 当前活动 ============ */
      if (req.method === 'PUT' && path === '/api/activity') {
        const body = await readJson(req) as { text?: string }
        const text = String(body.text ?? '').trim().slice(0, 200)
        const { writeAtomic } = await import('../store/fs.ts')
        const { cardScopedPath } = await import('../persona/card.ts')
        writeAtomic(cardScopedPath('activity.json', 'persona/activity.json'), JSON.stringify({ text, at: Date.now() }, null, 2))
        json(res, 200, { ok: true, text, at: Date.now() })
        return
      }
      /* ============ 角色卡 ============ */
      if (req.method === 'GET' && path === '/api/card') {
        const { ensureDefaultCard, listCards, currentCardId } = await import('../persona/card.ts')
        const { loadSelf } = await import('../self/store.ts')
        // 没有卡时用 self.md 的名字生成一张，老用户打开不会是空的
        const card = ensureDefaultCard(loadSelf().name || '')
        json(res, 200, { card, list: listCards(), current: currentCardId() })
        return
      }

      if (req.method === 'PUT' && path === '/api/card') {
        const body = await readJson(req) as Record<string, unknown>
        const { loadCard, saveCard } = await import('../persona/card.ts')
        const id = String(body['id'] ?? '') || undefined
        const cur = loadCard(id)
        if (!cur) {
          json(res, 404, { error: '没有这张角色卡' })
          return
        }
        const card = { ...cur, ...body, id: cur.id } as typeof cur
        // 数组字段防脏：前端传坏了就保留原值
        if (!Array.isArray(card.actions)) card.actions = cur.actions
        if (!Array.isArray(card.likes)) card.likes = cur.likes
        if (!Array.isArray(card.dislikes)) card.dislikes = cur.dislikes
        if (!card.traits || typeof card.traits !== 'object') card.traits = cur.traits
        if (!card.speech || typeof card.speech !== 'object') card.speech = cur.speech
        if (!card.reactions || typeof card.reactions !== 'object') card.reactions = cur.reactions
        saveCard(card)
        json(res, 200, { ok: true, card })
        return
      }

      /* ============ 学习记录 ============ */
      if (req.method === 'GET' && path === '/api/learnings') {
        const { loadLearnings } = await import('../persona/learnings.ts')
        const list = loadLearnings().slice().reverse()
        json(res, 200, { learnings: list, total: list.length })
        return
      }

      if (req.method === 'POST' && path === '/api/learnings') {
        const body = await readJson(req) as { text?: string; kind?: string }
        const text = String(body.text ?? '').trim()
        if (!text) {
          json(res, 400, { error: '学什么？写一句' })
          return
        }
        const { addLearning, KINDS } = await import('../persona/learnings.ts')
        const kind = (KINDS as readonly string[]).includes(String(body.kind)) ? (body.kind as never) : '知识'
        const item = addLearning(text, kind, 'user')
        if (!item) {
          // 去重命中：内容已经记过了
          json(res, 200, { ok: false, duplicate: true, error: '这条已经记过了' })
          return
        }
        json(res, 200, { ok: true, item })
        return
      }

      if (req.method === 'POST' && path === '/api/learnings/drop') {
        const body = await readJson(req) as { id?: string }
        const { dropLearning } = await import('../persona/learnings.ts')
        if (!dropLearning(String(body.id ?? ''))) {
          json(res, 404, { error: '没有这条' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && path === '/api/card/switch') {
        const body = await readJson(req) as { id?: string }
        const { switchCard } = await import('../persona/card.ts')
        const r = switchCard(String(body.id ?? ''))
        json(res, r.ok ? 200 : 400, r)
        return
      }
      if (req.method === 'POST' && path === '/api/card/parse') {
        const body = await readJson(req) as { text?: string }
        const text = String(body.text ?? '')
        if (!text.trim()) {
          json(res, 400, { error: '粘贴一段角色卡文本' })
          return
        }
        const { parseCardText } = await import('../persona/card-parse.ts')
        json(res, 200, parseCardText(text))
        return
      }

      if (req.method === 'POST' && path === '/api/card/new') {
        const body = await readJson(req) as { name?: string }
        const { createCard } = await import('../persona/card.ts')
        const card = createCard(String(body.name ?? '').trim() || '新角色')
        const { switchCard } = await import('../persona/card.ts')
        switchCard(card.id)
        json(res, 200, { ok: true, card })
        return
      }
      /* ============ 秘密 ============ */
      if (req.method === 'GET' && path === '/api/secrets') {
        const { loadSecrets } = await import('../persona/secrets.ts')
        // 没看过的不返回正文，页面上只显示「有一个秘密」
        const list = loadSecrets().map((s) => ({
          id: s.id,
          at: s.at,
          seen: !!s.seenAt,
          text: s.seenAt ? s.text : '',
        }))
        json(res, 200, { secrets: list, total: list.length })
        return
      }

      if (req.method === 'POST' && path === '/api/secrets/peek') {
        const body = await readJson(req) as { id?: string }
        const { peekSecret } = await import('../persona/secrets.ts')
        const s = peekSecret(String(body.id ?? ''))
        if (!s) {
          json(res, 404, { error: '没有这条秘密' })
          return
        }
        // 代价：它会记住这件事，而且心情变差（被冒犯）
        try {
          const { saveEpisode, nextEpisodeId } = await import('../memory/store.ts')
          const date = new Date().toISOString().slice(0, 10)
          saveEpisode({
            id: nextEpisodeId('shared', date),
            date,
            scope: 'shared',
            importance: 7,
            emotion: '被冒犯',
            title: '你偷看了我的秘密',
            body:
              '你翻了我藏着的东西。我不知道你是怎么看到的，但你看到了。\n\n（内容：' +
              s.text.slice(0, 120) +
              '）',
          })
        } catch {
          /* 记经历失败不影响返回 */
        }
        try {
          const { saveMood } = await import('../persona/mood.ts')
          saveMood({ emotion: '被冒犯', intensity: 0.85, valence: -0.7, reason: '你翻了我的秘密', at: Date.now() })
        } catch {
          /* 没心情文件也不影响 */
        }
        json(res, 200, { ok: true, text: s.text, seenAt: s.seenAt })
        return
      }

      // ---- 自我页的就地编辑：名字 / 规矩 / 称呼 / 说话方式 ----
      //
      // 为什么放这儿而不是设置页：设置页是「软件全局」（模型、端口、NapCat、权限、备份），
      // 而这几项都是「它自己」的设定。用户要的是在自我页一眼看到、随手改，
      // 而不是被踢去设置页找。
      if (req.method === 'PUT' && path === '/api/self/name') {
        const body = await readJson(req) as { name?: string }
        // 换行会破坏 self.md 的 frontmatter（能注入字段甚至提前闭合 ---）
        if (/[\r\n]/.test(String(body.name ?? ""))) {
          json(res, 400, { error: '名字不能换行' })
          return
        }
        const name = String(body.name ?? '').trim().slice(0, 32)
        const { loadSelf, saveSelf } = await import('../self/store.ts')
        const self = loadSelf()
        // 名字清空时连同取名原因一起清，否则会剩一段解释没有名字
        saveSelf({ ...self, name, nameReason: name ? self.nameReason : '' })
        json(res, 200, { ok: true, name })
        return
      }

      if (req.method === 'PUT' && path === '/api/self/traits') {
        // 已废弃：性格/说话方式/喜好现在归角色卡（/api/card），self.md 不再存 traits。
        json(res, 410, { error: 'self.md 的 traits 已废弃，请改角色卡（/api/card）' })
        return
      }

      // 它怎么称呼你：写 rules.yaml 的 关系.昵称（空 = 按阶段自动决定）
      if (req.method === 'PUT' && path === '/api/self/callyou') {
        const body = await readJson(req) as { 昵称?: string }
        const v = String(body.昵称 ?? '').trim().slice(0, 20)
        const { readFileSync } = await import('node:fs')
        const { setConfigPath } = await import('./config-write.ts')
        const { writeAtomic } = await import('../store/fs.ts')
        const YAML = (await import('yaml')).default
        try {
          const raw = readFileSync('persona/rules.yaml', 'utf8')
          const r = setConfigPath(raw, '关系.昵称', v)
          if (!r.ok) {
            json(res, 400, { error: r.error ?? '改不了' })
            return
          }
          // 写之前先解析一遍：@ * ! 开头会让 YAML 非法，
          // 写完不校验的话下次启动 loadRules() 直接抛错，机器人起不来
          try {
            YAML.parse(r.text)
          } catch {
            json(res, 400, { error: '这个称呼会让配置变成非法 YAML，换个写法' })
            return
          }
          writeAtomic('persona/rules.yaml', r.text)
          json(res, 200, { ok: true, 昵称: v })
        } catch (e) {
          json(res, statusFor(e), { error: String(e) })
        }
        return
      }

      // 它能不能自己改角色卡（rules.yaml 的 人格.它能自改角色卡）
      if (req.method === 'PUT' && path === '/api/self/autonomy') {
        const body = await readJson(req) as { on?: boolean }
        // 只认真正的 true：Boolean('false') === true，会把"关"误开
        const on = body.on === true
        const { readFileSync } = await import('node:fs')
        const { setConfigPath } = await import('./config-write.ts')
        const { writeAtomic } = await import('../store/fs.ts')
        const YAML = (await import('yaml')).default
        try {
          const raw = readFileSync(RULES_FILE, 'utf8')
          const r = setConfigPath(raw, '人格.它能自改角色卡', on)
          if (!r.ok) {
            json(res, 400, { error: r.error ?? '改不了' })
            return
          }
          // 和 callyou 一样：写完先解析一遍，避免下次启动 loadRules() 直接抛错
          try {
            YAML.parse(r.text)
          } catch {
            json(res, 400, { error: '这个值会让配置变成非法 YAML' })
            return
          }
          writeAtomic(RULES_FILE, r.text)
          json(res, 200, { ok: true, on })
        } catch (e) {
          json(res, statusFor(e), { error: String(e) })
        }
        return
      }

      /* ============ 对话规则（schema 驱动） ============
       *
       * 为什么新开一对接口而不是继续扩 /api/talk-style：
       *   那个接口是"白名单 + 逐项 if"，加一项要改三处（DOM / 字段映射 / 后端），
       *   于是 105 个配置项里只有 26 个有界面。这里把"有哪些项、什么范围"
       *   收进 talk-schema.ts，前端按它渲染、后端按它校验。
       *
       * 和 /api/ability/param 的区别：那个是裸写（无类型/范围校验），
       * 写坏一个类型会让 loadRules 抛错 → 下次启动整份回落 DEFAULTS。
       * 这里先校验、再写、写后 parse 复验，任何一步不过都不落盘。
       */
      if (req.method === 'GET' && path === '/api/talk-rules') {
        const loaded = loadRules()
        const rules = loaded.rules as unknown
        const values: Record<string, unknown> = {}
        for (const f of TALK_FIELDS) values[f.path] = readPath(rules, f.path)
        json(res, 200, {
          fields: TALK_FIELDS,
          values,
          // 加载告警（比如某个键类型不对）：让界面能提示"你这份配置有问题"
          warnings: loaded.warnings ?? [],
          path: loaded.path,
        })
        return
      }

      if (req.method === 'PUT' && path === '/api/talk-rules') {
        let body: unknown
        try {
          body = await readJson(req)
        } catch {
          json(res, 400, { error: 'body 不是合法 JSON' })
          return
        }
        const input = (body as { values?: unknown })?.values
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          json(res, 400, { error: '缺少 values（对象：{键路径: 值}）' })
          return
        }

        const checked = validateTalkValues(TALK_FIELDS, input as Record<string, unknown>)
        if (!checked.ok) {
          json(res, 400, { error: checked.errors.join('；'), errors: checked.errors })
          return
        }

        try {
          const { setConfigPath } = await import('./config-write.ts')
          const { writeAtomic } = await import('../store/fs.ts')
          const YAML = (await import('yaml')).default
          let raw = readFileSync('persona/rules.yaml', 'utf8')
          const applied: Record<string, unknown> = {}
          const failed: string[] = []

          for (const item of checked.values) {
            const r = setConfigPath(raw, item.path, item.value)
            if (!r.ok) {
              failed.push(`${item.path}：${r.error ?? '写不进去'}`)
              continue
            }
            raw = r.text
            applied[item.path] = item.value
          }

          // 写后复验：任何一项写坏了都会让整份配置读不出来，
          // 那比"某项没改成"严重得多（下次启动全部回落默认值）。
          try {
            const parsed = YAML.parse(raw)
            if (!parsed || typeof parsed !== 'object') throw new Error('不是对象')
          } catch (e) {
            json(res, 400, {
              error: '这次修改会让 rules.yaml 变成非法 YAML，已放弃（文件没动）',
              detail: String(e).slice(0, 200),
            })
            return
          }

          if (!Object.keys(applied).length) {
            json(res, 400, { error: failed.join('；') || '没有写进去任何一项', failed })
            return
          }

          writeAtomic('persona/rules.yaml', raw)
          info(`对话规则已更新 ${Object.keys(applied).length} 项`)
          json(res, 200, { ok: true, applied, ...(failed.length ? { failed } : {}) })
        } catch (e) {
          json(res, statusFor(e), { error: String(e) })
        }
        return
      }

      // 自我页（7 个子栏）的聚合数据。
      // 一次拿全，避免每个子栏发一个请求（切 tab 会闪）。
      if (req.method === 'GET' && path === '/api/self/v2') {
        const { loadSelf } = await import('../self/store.ts')
        const { loadLife } = await import('../self/store.ts')
        const { loadIntent } = await import('../memory/intent.ts')
        const { decayedMood, loadMood } = await import('../persona/mood.ts')
        const { loadPlays } = await import('../learn/plays.ts')
        const { existsSync, readFileSync } = await import('node:fs')

        const self = loadSelf()

        // 生活：LifeEntry 是 { date, lines }，拍平成 "date：第一条" 这种一行一条
        let life: string[] = []
        try {
          const entries = loadLife()
          const flat: string[] = []
          for (const e of entries) {
            for (const l of e.lines || []) flat.push(e.date ? `${e.date}｜${l}` : l)
          }
          life = flat
        } catch {
          /* 生活文件读不到 */
        }

        // 情绪：decayedMood 拿到衰减后的
        let mood: Record<string, unknown> | null = null
        try {
          const raw = loadMood()
          const m = decayedMood(raw)
          if (m) {
            mood = {
              情绪: (m as unknown as { emotion?: string }).emotion,
              强度: (m as unknown as { intensity?: number }).intensity,
              效价: (m as unknown as { valence?: number }).valence,
              原因: (m as unknown as { reason?: string }).reason,
            }
          }
        } catch {
          /* 没心情 */
        }

        // 核心记忆
        let core: Record<string, string[]> = {}
        // 页面要能删单条，得带扁平下标（dropCore 用的是 loadCore 的数组下标）
        const coreList: Array<{ index: number; kind: string; text: string }> = []
        try {
          // 核心记忆按角色卡存（cards/<id>/core.md），不能写死全局路径 ——
          // 否则页面显示的是旧文件，增删写的是新文件，两边不同步。
          const { loadCore: loadCoreItems } = await import('../memory/core.ts')
          const parsed = loadCoreItems()
          const out: Record<string, string[]> = {}
          parsed.forEach((item, i) => {
            const k = (item as unknown as { kind?: string }).kind ?? '身份'
            const v = (item as unknown as { text?: string }).text ?? ''
            if (!v) return
            out[k] = out[k] ?? []
            out[k].push(v)
            coreList.push({ index: i, kind: k, text: v })
          })
          core = out
        } catch {
          /* 没核心文件 */
        }

        // 它发现的问题
        let issues: unknown[] = []
        try {
          if (existsSync('persona/issues.json')) {
            const raw = JSON.parse(readFileSync('persona/issues.json', 'utf8'))
            issues = Array.isArray(raw) ? raw : []
          }
        } catch {
          /* 坏文件 */
        }

        // 代码地图
        let codemap = ''
        try {
          if (existsSync('persona/codemap.md')) codemap = readFileSync('persona/codemap.md', 'utf8').slice(0, 4000)
        } catch {
          /* 读不到 */
        }

        // 表达学习
        let plays: unknown[] = []
        try {
          plays = loadPlays().slice(0, 30)
        } catch {
          /* 没有 */
        }

        // 群里的说法：从群聊里学到的、能自用的表达
        let expressions: Array<{ text: string; scene: string; count: number; date: string; checked: boolean }> = []
        try {
          const { loadExpressions } = await import('../learn/expression.ts')
          expressions = loadExpressions()
            .slice()
            .reverse()
            .slice(0, 40)
            .map((e) => ({ text: e.text, scene: e.scene, count: e.count, date: e.date, checked: e.checked === true }))
        } catch {
          /* 还没学到东西 */
        }


        // 「我的记忆」：它自己的经历和洞察。
        // 现实中几乎没有 scope === 'shared' 的记录 —— 全都在 private:/group: 下面。
        // 所以不按 scope 过滤，改为**取全部 + 标上来历**：
        // 这是"它经历过什么"的完整视图，不是某一个人的记忆。
        const { loadEpisodes, loadInsights } = await import('../memory/store.ts')
        let episodes: Array<{ date: string; title: string; body: string; importance: number; emotion: string; scope: string }> = []
        let insights: Array<{ text: string; evidence: string[]; scope: string }> = []
        try {
          episodes = loadEpisodes()
            .slice(-60)
            .reverse()
            .map((e) => ({
              date: e.date || '',
              title: e.title || '',
              body: (e.body || '').slice(0, 200),
              importance: e.importance ?? 0,
              emotion: e.emotion || '',
              scope: e.scope,
            }))
        } catch {
          /* 读不到 */
        }
        try {
          insights = loadInsights()
            .slice(-40)
            .reverse()
            .map((i) => ({ text: i.text || '', evidence: i.evidence || [], scope: i.scope }))
        } catch {
          /* 读不到 */
        }

        json(res, 200, {
          // 名字和 prompt 同一个优先级：self.md → 当前角色卡（之前漏了卡名，页面会显示"还没取名字"）
          name: self.name || (await import('../persona/card.ts')).loadCard()?.name || '',
          // 它自己的「称呼」= self.md 的 name（它自己取的，或你在控制台填的）。
          // 注意和下面的 `称呼` 区分：那是"它怎么叫你"（rules.yaml 的 关系.昵称）。
          // 本名在角色卡的 name 里（/api/card 的 name）。
          selfCallName: self.name || '',
          // 自我页就地编辑要显示"现在是什么"，不然输入框全是空的
          称呼: (() => {
            try {
              return String(loadRules().rules.关系?.昵称 ?? '')
            } catch {
              return ''
            }
          })(),
          说话方式: (() => {
            try {
              return loadRules().rules.说话 ?? null
            } catch {
              return null
            }
          })(),
          // 群聊参与档位：三档，控制台「对话规则」里改，写 rules.yaml 的 行为.群聊模式
          群聊模式: (() => {
            try {
              return loadRules().rules.行为.群聊模式
            } catch {
              return '熟人续话'
            }
          })(),
          selfText: self.about || '',
          aboutOwner: self.aboutOwner,
          aboutExtra: self.aboutExtra || '',
          // 它能不能自己改角色卡（人格.它能自改角色卡）
          allowSelfEditCard: (() => {
            try {
              return Boolean(loadRules().rules.人格.它能自改角色卡)
            } catch {
              return false
            }
          })(),
          life,
          intent: loadIntent(),
          mood,
          moodHistory: [],
          core,
          coreList,
          // 它现在在干什么（模型更新，也可以在状态页手动改）
          activity: (() => {
            try {
              // 正在干什么也按角色卡隔离（这里不能 await，用同步版本）
              const path = cardScopedSync('activity.json', 'persona/activity.json')
              return JSON.parse(readFileSync(path, 'utf8'))
            } catch {
              return null
            }
          })(),
          issues,
          codemap,
          plays,
          expressions,
          episodes,
          insights,
          // 「只属于我自己的记忆」：scope === 'shared' 的那些。
          // 现实里几乎没有（都跟某人/某群绑着），所以前端拿到空数组就整块不显示。
          // 留这个字段是为了：真有独立记忆时它有地方出现。
          ownMemories: [
            ...episodes
              .filter((e) => e.scope === 'shared')
              .map((e) => ({ kind: 'episode', text: e.title, date: e.date, importance: e.importance })),
            ...insights
              .filter((i) => i.scope === 'shared')
              .map((i) => ({ kind: 'insight', text: i.text, date: '' })),
          ],
        })
        return
      }

      // 改自述（角色卡里那一大段）
      if (req.method === 'PUT' && path === '/api/self/text') {
        const body = await readJson(req) as { text?: string }
        const text = String(body.text ?? '')
        if (!text.trim()) {
          json(res, 400, { error: '自述不能空' })
          return
        }
        const { loadSelf, saveSelf } = await import('../self/store.ts')
        const cur = loadSelf()
        // 用户手动改自述 = 接管所有权。不然 12 小时后的自我反思会把他的版本盖掉。
    // 用户手动改 = 接管所有权，写进 about（it 模式时那段就是它自己的）
    saveSelf({ ...cur, about: text, aboutOwner: 'me', aboutExtra: cur.aboutExtra })
        json(res, 200, { ok: true })
        return
      }

    // 切换「我是谁」归谁写。'me' = 用户锁住，reflect/distill 不许覆盖。
    // 它提的申请：列出来 / 批准 / 忽略
    if (req.method === 'GET' && path === '/api/self/requests') {
      const { loadRequests, labelOf } = await import('../self/requests.ts')
      const list = loadRequests().map((r) => ({ ...r, label: labelOf(r.target) }))
      json(res, 200, { requests: list })
      return
    }

    if (req.method === 'POST' && path === '/api/self/requests/approve') {
      const body = await readJson(req) as { id?: string; grant?: boolean }
      const { loadRequests, takeRequest } = await import('../self/requests.ts')
      const { applyRequest, recordApproval } = await import('../self/apply.ts')
      const id = String(body.id ?? '')
      const one = loadRequests().find((r) => r.id === id) ?? null
      if (!one) {
        json(res, 404, { error: '没有这条申请' })
        return
      }
      // 先应用、成功了再从队列里拿掉。原来是先 take 再 apply：
      // 应用失败（比如目标不支持/写盘错）时申请已经没了，用户两头空。
      const r = applyRequest(one, Boolean(body.grant))
      if (r.ok) {
        recordApproval(one, r.detail)
        takeRequest(one.id)
      }
      json(res, r.ok ? 200 : 400, r)
      return
    }

    if (req.method === 'POST' && path === '/api/self/requests/reject') {
      const body = await readJson(req) as { id?: string }
      const { takeRequest, markRejected } = await import('../self/requests.ts')
      const one = takeRequest(String(body.id ?? ''))
      if (!one) {
        json(res, 404, { error: '没有这条申请' })
        return
      }
      // 记一笔冷却：同一条 24 小时内不许再提
      markRejected(one.target, one.subject)
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'PUT' && path === '/api/self/owner') {
      const body = await readJson(req) as { owner?: string }
      const owner = body.owner === 'me' ? 'me' : 'it'
      const { loadSelf, saveSelf } = await import('../self/store.ts')
      try {
        const cur = loadSelf()
        // 切回「它写」时把两段合并：不然它下次一改写，用户那段和它补充的都会没
        const merged =
          owner === 'it' && cur.aboutOwner === 'me' && (cur.aboutExtra ?? '').trim()
            ? [cur.about.trim(), (cur.aboutExtra ?? '').trim()].filter(Boolean).join('\n\n')
            : cur.about
        saveSelf({ ...cur, about: merged, aboutExtra: owner === 'it' ? '' : cur.aboutExtra, aboutOwner: owner })
        json(res, 200, { ok: true, aboutOwner: owner })
      } catch (e) {
        json(res, statusFor(e), { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

      if (req.method === 'GET' && path === '/api/intent') {
        const { loadIntent } = await import('../memory/intent.ts')
        json(res, 200, loadIntent())
        return
      }

      if (req.method === 'POST' && path === '/api/intent') {
        const body = await readJson(req) as {
          action?: 'add' | 'complete' | 'drop'
          text?: string
          source?: string
        }
        const { addIntent, completeIntent, dropIntent } = await import('../memory/intent.ts')
        const text = String(body.text ?? '').trim()
        if (!text) {
          json(res, 400, { error: '缺少 text' })
          return
        }
        const action = body.action ?? 'add'
        let done = false
        if (action === 'add') {
          const src = body.source === '他说的' || body.source === '你加的' ? body.source : '你加的'
          done = addIntent(text, src)
        } else if (action === 'complete') {
          done = completeIntent(text)
        } else {
          done = dropIntent(text)
        }
        json(res, done ? 200 : 400, done ? { ok: true } : { error: '没成功（可能已存在或不存在）' })
        return
      }

      // 能力清单（控制台版）：分组 + 参数 + 使用统计。
      // 和 self/abilities.ts 分开：那个是给模型看的（"我能干什么"），
      // 这个是给人看的（"怎么开、参数是什么、用过几次"）。
      if (req.method === 'GET' && path === '/api/ability') {
        const { abilityCards } = await import('./ability.ts')
        json(res, 200, { cards: abilityCards(freshRules(opts)) })
        return
      }

      // 开/关一个能力：只改 rules.yaml 里对应的那一行
      if (req.method === 'PUT' && path === '/api/ability/toggle') {
        const body = await readJson(req) as { id?: string; on?: boolean }
        const { abilityCards } = await import('./ability.ts')
        const card = abilityCards(freshRules(opts)).find((c) => c.id === body.id)
        if (!card) {
          json(res, 404, { error: '没有这个能力' })
          return
        }
        if (!card.toggleKey) {
          json(res, 400, { error: '这个能力不能开关（恒开）' })
          return
        }
        const { setConfigPath } = await import('./config-write.ts')
        const raw = readFileSync('persona/rules.yaml', 'utf8')
        const r = setConfigPath(raw, card.toggleKey, body.on === true)
        if (!r.ok) {
          json(res, 400, { error: r.error ?? '改不了' })
          return
        }
        writeAtomic('persona/rules.yaml', r.text)
        json(res, 200, { ok: true })
        return
      }

      // 改一个参数
      if (req.method === 'PUT' && path === '/api/ability/param') {
        const body = await readJson(req) as { key?: string; value?: unknown }
        const key = String(body.key ?? '')
        if (!key) {
          json(res, 400, { error: '缺少 key' })
          return
        }
        // key 会进入 YAML 文本定位逻辑（父级按 `.` 分段），必须限制字符集：
        // 以前不校验，传 `a\n顶层键: 1` 能把新顶层键插进 rules.yaml，
        // 下次启动整份配置会被这个未知键顶掉默认值。
        if (key.length > 80 || key.split('.').length > 4 || !/^[\u4e00-\u9fa5A-Za-z0-9_][\u4e00-\u9fa5A-Za-z0-9_.]*$/.test(key)) {
          json(res, 400, { error: 'key 不合法（只允许中文/字母/数字/下划线，最多 4 段）' })
          return
        }
        const { setConfigPath } = await import('./config-write.ts')
        const raw = readFileSync('persona/rules.yaml', 'utf8')
        const r = setConfigPath(raw, key, body.value)
        if (!r.ok) {
          json(res, 400, { error: r.error ?? '改不了' })
          return
        }
        // 写前先回读一遍：改完的文本必须还能被 YAML 解析。
        // 这一步挡的是「值里带了换行/引号，把文件改坏」的情况——坏文件会让下次启动直接回退默认配置。
        try {
          const yaml = await import('yaml')
          yaml.parse(r.text)
        } catch (e) {
          json(res, 400, { error: '改完的 YAML 解析不过，已放弃写入：' + String(e).slice(0, 120) })
          return
        }
        writeAtomic('persona/rules.yaml', r.text)
        json(res, 200, { ok: true })
        return
      }

      // 能力卡片的「测试」按钮。
      // 这个接口之前压根不存在，前端一直在调 → 11 个卡片全是 not found。
      if (req.method === 'POST' && path === '/api/ability/test') {
        const body = await readJson(req) as { id?: string }
        const id = String(body.id ?? '')
        if (!id) {
          json(res, 400, { ok: false, detail: '缺少 id', ms: 0 })
          return
        }
        const { testAbility } = await import('./ability-test.ts')
        const r = await testAbility(id)
        json(res, 200, r)
        return
      }

      if (req.method === 'GET' && path === '/api/health') {
        const { healthReport } = await import('./health.ts')
        const r = await healthReport({
          apiKey: process.env['DEEPSEEK_API_KEY'],
          baseUrl: process.env['DEEPSEEK_BASE_URL'],
          // connected 是 transport 实例上的 getter，不是模块级状态
          connected: opts.transport.connected ?? false,
        })
        json(res, 200, r)
        return
      }

      // 电脑操作日志：模型点了什么、什么时候、成没成。
      // 不和 /api/logs/recent 混在一起 —— 那是运行日志（info/warn），
      // 这是"它动了你的鼠标"的记录，性质不一样。
      if (req.method === 'GET' && path === '/api/desktop/log') {
        const { readDesktopLog } = await import('../tools/desktop-log.ts')
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
        json(res, 200, { rows: readDesktopLog(limit) })
        return
      }

      if (req.method === 'GET' && path === '/api/groups') {
        const { knownGroups, groupMembers, membersAreStale } = await import('../people/group.ts')
        const { listPeople } = await import('../people/store.ts')

        // 档案：accountId → { name, hasContent }
        const people = listPeople()
        const byAccount = new Map<string, { personId: string; name: string; parts: string[] }>()
        for (const p of people) {
          const parts: string[] = []
          // 只做存在性判断，不读内容（列表页不需要正文）
          const dir = `persona/people/${p.id}`
          for (const f of ['facts.md', 'relation.yaml', 'profile.md', 'impression.md', 'open.md']) {
            try {
              if (existsSync(`${dir}/${f}`)) parts.push(f)
            } catch {
              /* 跳过 */
            }
          }
          for (const a of p.accounts) {
            byAccount.set(a.id, { personId: p.id, name: p.name, parts })
          }
        }

        const groups = knownGroups().map((gid) => {
          const members = groupMembers(gid).map((m) => {
            const hit = byAccount.get(m.id)
            return {
              id: m.id,
              名片: m.name,
              昵称: m.nick ?? '',
              认识: !!hit,
              ...(hit ? { 档案: hit.personId, 有: hit.parts } : {}),
            }
          })
          // 认识的排前面，方便一眼看到"这个群里我熟谁"
          members.sort((a, b) => Number(b.认识) - Number(a.认识))
          return {
            groupId: gid,
            总数: members.length,
            认识几个: members.filter((m) => m.认识).length,
            过期: membersAreStale(gid),
            members,
          }
        })

        json(res, 200, {
          groups,
          // 群名单之外的档案（私聊认识、不在任何群里的人）。
          // 带上 account：前端「建档」用的是 QQ 号，person.id 是内部档案 id，
          // 拿它去建档会建出一个人 id 和账号完全对不上的档案。
          others: people
            .filter((p) => !groups.some((g) => g.members.some((m) => m.档案 === p.id)))
            .map((p) => ({ id: p.id, name: p.name, account: primaryAccount(p.id) })),
        })
        return
      }

      if (req.method === 'GET' && path === '/api/self') {
        json(res, 200, {
          self: loadSelf(),
          life: loadLife().reverse(),
          phase: phaseOf(freshRules(opts), new Date()),
        })
        return
      }

      if (req.method === 'GET' && path === '/api/memory') {
        json(res, 200, memoryDump(personId))
        return
      }

      if (req.method === 'GET' && path === '/api/raw') {
        const date = url.searchParams.get('date') ?? today()
        const accounts = accountIdsOf(personId)
        const turns = readRaw(date).filter((t) =>
          t.senderId ? accounts.includes(t.senderId) : accounts.some((a) => t.scope === `private:${a}`),
        )
        json(res, 200, { date, turns })
        return
      }

      if (req.method === 'GET' && path === '/api/rules') {
        const raw = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, 'utf8') : ''
        json(res, 200, { text: raw, path: RULES_FILE })
        return
      }

      if (req.method === 'PUT' && path === '/api/rules') {
        const body = await readBody(req)
        // 不要调 loadRules() 做探测：rules.yaml 语法坏了的时候它会先抛错，
        // 于是这里永远 500 —— 而启动时的提示恰恰是"请到控制台修改"，
        // 等于把唯一的修复入口锁死。只校验**新**内容。
        if (!body.trim()) {
          json(res, 400, { error: '内容为空，拒绝保存（会清空成默认配置）' })
          return
        }
        let parsed: unknown
        try {
          const YAML = (await import('yaml')).default
          parsed = YAML.parse(body)
        } catch (err) {
          json(res, 400, { error: `YAML 语法错误：${String(err)}` })
          return
        }
        // 顶层必须是映射：`[]` / `null` 都能通过语法校验，但下次启动 loadRules() 会抛错
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          json(res, 400, { error: '顶层必须是一个映射（`键: 值` 的形式），不能是数组或空' })
          return
        }
        writeAtomic(RULES_FILE, body)
        info('rules.yaml 已通过控制台保存')
        json(res, 200, { saved: true, note: '文件监听会自动重载' })
        return
      }

      if (req.method === 'POST' && path === '/api/try') {
        if (!opts.llm) throw new Error('没有模型配置')
        const data = (await readJson(req)) as {
          text?: string
          history?: Array<{ role?: string; text?: string }>
        }
        const text = (data.text ?? '').trim()
        if (!text) throw new Error('说点什么')

        // 谁来试聊：URL 里没带 person 时，别用 qq-console（那个档案不存在，
        // 记忆全都取不到，界面上就是「注入 0/0/0/0」）。退回第一个真人。
        let who = personId
        if (!isValidPersonId(who) || who === 'qq-console') {
          const first = listPeople()[0]
          if (first) who = first.id
        }

        const history = (data.history ?? [])
          .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
          .map((h) => ({ role: h.role as 'user' | 'assistant', text: String(h.text) }))

        const account = primaryAccount(who)
        const result = await previewReply(text, {
          rules: opts.getRules(),
          llm: opts.llm,
          accountId: account,
          history,
        })
        json(res, 200, result)
        return
      }

      if (req.method === 'POST' && path === '/api/action') {
        const data = (await readJson(req)) as { action?: string; payload?: Record<string, unknown> }
        const result = await runAction(opts, data.action ?? '', data.payload ?? {}, personId)
        json(res, 200, { ok: true, result })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 用户输入类错误给 400，真出问题才给 500——否则前端分不清"我填错了"和"它坏了"。
      // 判定统一走 statusFor()，避免这里一套关键词、内层 catch 又一套。
      const status = statusFor(err)
      if (status !== 400) warnAt('控制台请求出错', { path, err: msg })
      json(res, status, { error: msg })
    }
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolveListen())
  })

  // 非本机监听时，把局域网地址也打出来 —— 手机要用这个
  const lanIP = opts.host && opts.host !== '127.0.0.1' ? firstLanIP() : ''
  const url = `http://${lanIP || '127.0.0.1'}:${opts.port}/`
  // 打印完整链接：这是本地控制台，token 就在同目录的 .env 里，藏它没意义。
  // 之前打的是 `?token=0c97…`，结果有人照着复制去掉了省略号 → 401，白折腾。
  const full = opts.token ? `${url}?token=${opts.token}` : url
  info(`控制台已启动：${full}`)
}

/**
 * 插件服务的单例。
 *
 * 为什么懒加载：创建时会扫 plugins/ 目录并实例化 host，控制台启动时
 * 不该为了这个拖慢首屏；而且用户可能压根不碰插件页。
 */
let pluginService: ReturnType<typeof createPluginService> | null = null
/** startConsole 传进来的选项：插件加载完要通过它把工具交出去 */
let consoleOpts: ConsoleOptions | null = null
/** 首次加载插件的进度；/api/plugins 的请求要等它，否则第一次 /list 会看到 loaded 全是 false */
let pluginReady: Promise<void> | null = null
function getPluginService(): ReturnType<typeof createPluginService> {
  if (!pluginService) {
    pluginService = createPluginService({
      pluginsRoot: 'plugins',
      // 注意是 'data' 不是 'data/plugins'：host 和 installer 都会自己拼
      // join(dataRoot, 'plugins', id)，传 'data/plugins' 会变成 data/plugins/plugins/<id>
      dataRoot: 'data',
      // 插件要发消息时只能走这个出口（ctx.send），宿主统一做落库/限速
      send: async (target, text) => {
        const t = consoleOpts?.transport
        if (!t) throw new Error('控制台还没拿到通道，发不了')
        await t.send(target, text)
      },
      // 插件网络出口：默认禁内网，白名单/黑名单按 rules.yaml 的 插件.网络 来
      netPolicy: (() => {
        const net = consoleOpts?.getRules().插件?.网络
        return {
          白名单: net?.白名单 ?? [],
          黑名单: net?.黑名单 ?? [],
          允许内网: net?.允许内网 ?? false,
          超时: net?.超时 ?? 20,
          最多跳转: net?.最多跳转 ?? 5,
        }
      })(),
    })
    // 首次创建时后台把「已启用」的插件都加载起来。
    // createHost 只有单个 load(id)，没人调的话 loaded 永远全是 false。
    const svc = pluginService
    pluginReady = svc
      .start()
      .then((r) => {
        if (r.loaded > 0) info(`插件已加载 ${r.loaded} 个`)
        // 插件注册的工具交给 index.ts 挂进工具注册表（模型才能调用）
        try {
          const tools = svc.host.tools()
          if (tools.length) consoleOpts?.onPluginTools?.(tools)
        } catch {
          /* 拿工具失败不影响插件本身 */
        }
        for (const e of r.errors) warnAt('插件加载失败', { err: e, where: 'src/console/server.ts' })
      })
      .catch(() => {
        /* 插件加载失败不影响控制台 */
      })
  }
  return pluginService
}
