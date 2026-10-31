import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Rules } from '../core/config.ts'
import { loadRules, stageOf } from '../core/config.ts'
import { info, warnAt, logBus, type LogRecord } from '../core/log.ts'
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
import { loadProfile } from '../persona/profile.ts'
import { handlePeopleApi } from './people-api.ts'
import { handleDesktopApi } from './desktop-api.ts'
import { handleMiscApi } from './misc-api.ts'
import { handleMemberApi } from './member-api.ts'
import { handleSettingsApi } from './settings-api.ts'
import { handleTestApi } from './test-api.ts'
import { createPluginService, pluginRoutes } from './plugin-api.ts'
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

function text(res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8'): void {
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
  const text = (await readBody(req)) || ''
  if (!text.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
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

export async function startConsole(opts: ConsoleOptions): Promise<void> {
  consoleOpts = opts
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
    // 它只在**未登录**时存在，而且服务只听 127.0.0.1，没有额外暴露面。
    if (
      (req.method === 'GET' && /^\/(?:vendor\/)?[\w.-]+\.(js|css)$/.test(path)) ||
      (req.method === 'GET' && path === '/api/napcat/qrcode.png') ||
      (req.method === 'GET' && (path === '/' || path === '/index.html'))
    ) {
      // 二维码交给 misc-api（它知道 NapCat 装在哪）
      if (path === '/api/napcat/qrcode.png') {
        if (await handleMiscApi(req, res, path, url, json)) return
        text(res, 404, '没有二维码')
        return
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
      const body = readFileSync(full, 'utf8')
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-cache, no-store, must-revalidate',
      })
      res.end(body)
      return
    }

    // 鉴权：token 从 query 或 header 取
    const given = url.searchParams.get('token') ?? req.headers['x-console-token']
    if (opts.token && given !== opts.token) {
      // 浏览器直接打开时给一个人话页面 —— 裸 401 只会让人以为程序坏了。
      // 接口请求（fetch）还是回 JSON，前端好处理。
      const wantsHtml = String(req.headers['accept'] ?? '').includes('text/html')
      if (wantsHtml && (req.method === 'GET' || req.method === 'HEAD')) {
        const hint = given ? '链接里的 token 不对（可能少复制了后半截）' : '链接里没有 token'
        const full = given ? '' : `http://127.0.0.1:${opts.port}/?token=${opts.token}`
        text(
          res,
          401,
          `<!doctype html><meta charset="utf-8"><title>需要 token</title>
<body style="background:#0d1117;color:#e6edf3;font:15px/1.9 system-ui;padding:60px;max-width:720px">
<h2 style="margin:0 0 8px">打不开控制台</h2>
<p style="color:#8b949e;margin:0 0 20px">${hint}</p>
${full ? `<p style="margin:0 0 20px">用这个地址：<br><code style="background:#161b22;border:1px solid #30363d;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:6px;color:#79c0ff;word-break:break-all">${full}</code></p>` : ''}
<p style="color:#8b949e;font-size:13px;margin:0">
完整 token 在数据目录的 <code style="color:#79c0ff">.env</code> 里（<code>CONSOLE_TOKEN</code>），<br>
也可以看后端启动日志里那句「控制台已启动」。
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
            const okWrite = res.write(`data: ${JSON.stringify(rec)}\\n\\n`)
            if (!okWrite) dropped++
          } catch {
            // 某个客户端写失败绝不能把异常抛回业务代码（logBus.emit 是同步的）
          }
        }
        logBus.on('log', onLog)
        const ping = setInterval(() => {
          try {
            if (!res.writableEnded && !res.destroyed) res.write(': ping\\n\\n')
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
        json(res, 200, { policy: loadAccess(), path: accessFile() })
        return
      }

      if (req.method === 'PUT' && path === '/api/access') {
        const body = await readBody(req)
        const data = JSON.parse(body || '{}') as Partial<AccessPolicy>
        const clean = (v: unknown): string[] =>
          Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []
        const next: AccessPolicy = {
          groupAllow: clean(data.groupAllow),
          groupDeny: clean(data.groupDeny),
          memberAllow: clean(data.memberAllow),
          memberDeny: clean(data.memberDeny),
          requireAt: data.requireAt !== false,
        }
        saveAccess(next)
        info('权限策略已更新', {
          群白: next.groupAllow.length,
          群黑: next.groupDeny.length,
          成员白: next.memberAllow.length,
          成员黑: next.memberDeny.length,
          必须at: next.requireAt,
        })
        json(res, 200, { policy: next })
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
        const body = await readBody(req)
        const d = JSON.parse(body || '{}') as { text?: string; visibility?: string }
        const text = String(d.text ?? '')
        const v = String(d.visibility ?? '')
        if (!text || !['public', 'private', 'unsure'].includes(v)) throw new Error('参数不对')
        json(res, 200, { updated: setVisibility(personId, text, v as never) })
        return
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && path === '/api/facts') {
        const body = await readBody(req)
        const d = JSON.parse(body || '{}') as { text?: string; newText?: string; confidence?: number }
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
        const body = await readBody(req)
        const d = JSON.parse(body || '{}') as { text?: string; newText?: string }
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
        const body = await readBody(req)
        const d = JSON.parse(body || '{}') as { id?: string; scope?: string }
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
          traits: self.traits ?? {},
          selfVersions: listSelfVersions(5),
          drifts: loadDrifts(5),
          phase: phaseOf(opts.getRules(), new Date()),
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
          watchConf: opts.getRules().外部?.刷视频 ?? null,
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

      if (req.method === 'GET' && path === '/api/profile') {
        json(res, 200, { text: loadProfile(personId) })
        return
      }

      if (req.method === 'GET' && path === '/api/cost') {
        json(res, 200, costOfToday())
        return
      }



      // 核心记忆 + 它的申请。core.md 只有人能改，它只能申请。
      if (req.method === 'GET' && path === '/api/core') {
        const { loadCore, loadRequests } = await import('../memory/core.ts')
        json(res, 200, { core: loadCore(), requests: loadRequests(), max: 30 })
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
            } catch {
              /* 记流水失败不影响回复 */
            }
            json(res, 200, { ok: true, data: { reply, ms: Date.now() - started } })
          } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        // 控制台对话历史（只给页面用，别的对方看不到）
        if (req.method === 'GET' && path === '/api/chat/history') {
          json(res, 200, { ok: true, data: { turns: loadConsoleChat(50) } })
          return
        }

        if (path.startsWith('/api/plugins/')) {
          const sub = path.slice('/api/plugins'.length)
          const svc = getPluginService()
          // 第一次请求可能赶在插件加载完成之前，等它一下
          if (pluginReady) await pluginReady
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
        // 换行会破坏 self.md 的 frontmatter（能注入 traits 甚至提前闭合 ---）
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
        const body = await readJson(req) as { traits?: unknown }
        const src = body.traits
        // 必须是普通对象：字符串/数组/null 会被 Object.entries 拆成垃圾再全量覆盖
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
          json(res, 400, { error: '规矩格式不对' })
          return
        }
        const traits: Record<string, string> = {}
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
          const kk = String(k ?? '').trim().slice(0, 40)
          const vv = String(v ?? '').trim().slice(0, 300)
          if (kk && vv) traits[kk] = vv
        }
        const { loadSelf, saveSelf } = await import('../self/store.ts')
        saveSelf({ ...loadSelf(), traits })
        json(res, 200, { ok: true, traits })
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
          json(res, 500, { error: String(e) })
        }
        return
      }

      // 说话方式：写 rules.yaml 的 行为.回复（延迟用秒收，存毫秒）
      if (req.method === 'PUT' && path === '/api/talk-style') {
        const body = await readJson(req) as Record<string, unknown>
        const { readFileSync } = await import('node:fs')
        const { setConfigPath } = await import('./config-write.ts')
        try {
          let raw = readFileSync('persona/rules.yaml', 'utf8')
          const applied: Record<string, unknown> = {}

          const num = (key: string, min: number, max: number): void => {
            const rawVal = body[key]
            // Number(null) === 0 会通过 isFinite，把条数改成 1 —— 显式挡掉空值
            if (rawVal === null || rawVal === undefined || rawVal === '') return
            const n = Number(rawVal)
            if (!Number.isFinite(n)) return
            const v = Math.min(max, Math.max(min, Math.round(n)))
            const r = setConfigPath(raw, '说话.' + key, v)
            if (!r.ok) return
            raw = r.text
            applied[key] = v
          }
          const pick = (key: string, allowed: string[]): void => {
            const v = String(body[key] ?? '')
            if (!allowed.includes(v)) return
            const r = setConfigPath(raw, '说话.' + key, v)
            if (!r.ok) return
            raw = r.text
            applied[key] = v
          }
          const delay = (key: string): void => {
            const arr = body[key]
            if (!Array.isArray(arr) || arr.length !== 2) return
            const toMs = (x: unknown): number => {
              const n = Number(x)
              return Number.isFinite(n) ? Math.min(60_000, Math.max(0, Math.round(n * 1000))) : 0
            }
            const a = toMs(arr[0])
            const b = toMs(arr[1])
            const v: [number, number] = a <= b ? [a, b] : [b, a]
            const r = setConfigPath(raw, '说话.' + key, v)
            if (!r.ok) return
            raw = r.text
            applied[key] = v
          }

          num('每轮最多条数', 1, 10)
          num('每条最多字数', 1, 500)
          pick('引用频率', ['never', 'occasionally', 'often'])
          delay('条间延迟')
          delay('回复前延迟')

          if (!Object.keys(applied).length) {
            json(res, 400, { error: '没有有效的值' })
            return
          }
          const { writeAtomic: wr } = await import('../store/fs.ts')
          wr('persona/rules.yaml', raw)
          json(res, 200, { ok: true, applied })
        } catch (e) {
          json(res, 500, { error: String(e) })
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

        const traits = Object.entries(self.traits ?? {}).filter(([, v]) => v && String(v).trim())

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
          selfText: self.about || '',
          aboutOwner: self.aboutOwner,
          aboutExtra: self.aboutExtra || '',
          traits,
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

    // 人格快照列表（历史版本）
    if (req.method === 'GET' && path === '/api/self/versions') {
      const { listSelfVersions, loadSelfVersion } = await import('../self/store.ts')
      const list = listSelfVersions(30).map((v) => {
        const doc = loadSelfVersion(v.id)
        const text = doc ? [doc.about, doc.thinking, doc.abilities].filter(Boolean).join('\n') : ''
        return { id: v.id, at: v.at, chars: text.length }
      })
      json(res, 200, { versions: list })
      return
    }

    // 两个版本的行级对比
    if (req.method === 'GET' && path === '/api/self/versions/diff') {
      const a = url.searchParams.get('a') ?? ''
      const b = url.searchParams.get('b') ?? ''
      const { loadSelfVersion, lineDiff } = await import('../self/store.ts')
      const da = loadSelfVersion(a)
      const db = loadSelfVersion(b)
      if (!da || !db) {
        json(res, 404, { error: '版本不存在' })
        return
      }
      const textOf = (d: typeof da): string =>
        [d.about, d.thinking, d.abilities].filter(Boolean).join('\n\n')
      json(res, 200, { a, b, lines: lineDiff(textOf(da), textOf(db)) })
      return
    }

    // 漂移记录（它明显变过的时刻）
    if (req.method === 'GET' && path === '/api/self/drift') {
      const { loadDrifts } = await import('../self/store.ts')
      json(res, 200, { items: loadDrifts(20) })
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
        json(res, 500, { error: e instanceof Error ? e.message : String(e) })
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
        json(res, 200, { cards: abilityCards(opts.getRules()) })
        return
      }

      // 开/关一个能力：只改 rules.yaml 里对应的那一行
      if (req.method === 'PUT' && path === '/api/ability/toggle') {
        const body = await readJson(req) as { id?: string; on?: boolean }
        const { abilityCards } = await import('./ability.ts')
        const card = abilityCards(opts.getRules()).find((c) => c.id === body.id)
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
        writeFileSync('persona/rules.yaml', r.text, 'utf8')
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
        const { setConfigPath } = await import('./config-write.ts')
        const raw = readFileSync('persona/rules.yaml', 'utf8')
        const r = setConfigPath(raw, key, body.value)
        if (!r.ok) {
          json(res, 400, { error: r.error ?? '改不了' })
          return
        }
        writeFileSync('persona/rules.yaml', r.text, 'utf8')
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
          // 群名单之外的档案（私聊认识、不在任何群里的人）
          others: people
            .filter((p) => !groups.some((g) => g.members.some((m) => m.档案 === p.id)))
            .map((p) => ({ id: p.id, name: p.name })),
        })
        return
      }

      if (req.method === 'GET' && path === '/api/features') {
        const rules = opts.getRules()
        const out: Record<string, unknown> = {}

        // 表情包库
        try {
          const { createEmojiStore } = await import('../emoji/store.ts')
          const store = createEmojiStore(undefined, { libraryCap: rules.表情包?.库存上限 ?? 200 })
          const list = await store.list()
          const byMood: Record<string, number> = {}
          for (const it of list) {
            const m = it.mood || '未分类'
            byMood[m] = (byMood[m] ?? 0) + 1
          }
          out.emoji = {
            开启: rules.表情包?.开启 ?? false,
            总数: list.length,
            上限: rules.表情包?.库存上限 ?? 200,
            按情绪: byMood,
            最近: list.slice(-6).map((it) => ({ id: it.id, mood: it.mood, tags: it.tags, size: it.size, createdAt: it.createdAt, lastUsedAt: it.lastUsedAt })),
          }
        } catch (e) {
          out.emoji = { 错误: String(e).slice(0, 80) }
        }

        // 看图
        out.vision = {
          开启: rules.视觉?.开启 ?? false,
          模型: rules.视觉?.模型 || process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp',
          最多张数: rules.视觉?.最多张数 ?? 4,
          主模型是: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        }

        // 上下文压缩
        out.context = {
          摘要阈值: rules.上下文压缩?.摘要阈值 ?? 40,
          保留最近: rules.上下文压缩?.保留最近 ?? 12,
        }

        // 表达学习
        try {
          const { loadPlays } = await import('../learn/plays.ts')
          const plays = loadPlays()
          out.expression = {
            审核: rules.表达学习?.审核 ?? false,
            只用精选: rules.表达学习?.只用精选 ?? false,
            总数: plays.length,
            已精选: plays.filter((x) => x.checked).length,
            高分: plays.filter((x) => x.score >= 7).length,
            低分: plays.filter((x) => x.score <= 3).length,
            最近: plays.slice(-6).map((x) => ({ score: x.score, scene: x.scene, reply: x.reply, date: x.date, checked: !!x.checked })),
          }
        } catch (e) {
          out.expression = { 错误: String(e).slice(0, 80) }
        }

        // 情绪序列（多轮情感上下文）
        try {
          const { loadMood } = await import('../persona/mood.ts')
          const m = loadMood()
          out.mood = m
            ? {
                当前: m.emotion,
                强度: m.intensity,
                最近: (m.recent ?? []).slice(-5).map((r) => ({
                  emotion: r.emotion,
                  intensity: r.intensity,
                  at: r.at,
                  reason: r.reason ?? '',
                })),
              }
            : null
        } catch {
          out.mood = null
        }

        json(res, 200, out)
        return
      }

      if (req.method === 'GET' && path === '/api/self') {
        json(res, 200, {
          self: loadSelf(),
          life: loadLife().reverse(),
          phase: phaseOf(opts.getRules(), new Date()),
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
        // 先校验 YAML 能不能解析，再落盘
        const probe = loadRules()
        void probe
        try {
          const YAML = (await import('yaml')).default
          YAML.parse(body)
        } catch (err) {
          json(res, 400, { error: `YAML 语法错误：${String(err)}` })
          return
        }
        writeAtomic(RULES_FILE, body)
        info('rules.yaml 已通过控制台保存')
        json(res, 200, { saved: true, note: '文件监听会自动重载' })
        return
      }

      if (req.method === 'POST' && path === '/api/try') {
        if (!opts.llm) throw new Error('没有模型配置')
        const body = await readBody(req)
        const data = JSON.parse(body || '{}') as {
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
        const body = await readBody(req)
        const data = JSON.parse(body || '{}') as { action?: string; payload?: Record<string, unknown> }
        const result = await runAction(opts, data.action ?? '', data.payload ?? {}, personId)
        json(res, 200, { ok: true, result })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 用户输入类错误给 400，真出问题才给 500——否则前端分不清"我填错了"和"它坏了"
      const isInput = /说点什么|缺少|不存在|没有模型|非法的|未知操作|请求体不是合法 JSON/.test(msg)
      if (!isInput) warnAt('控制台请求出错', { path, err: msg })
      json(res, isInput ? 400 : 500, { error: msg })
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
