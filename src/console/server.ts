import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
import { search, exportAll } from './search.ts'
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
import { previewReply } from '../loop/preview.ts'
import { writeAtomic } from '../store/fs.ts'
import { chat } from '../llm/deepseek.ts'

export interface ConsoleOptions {
  port: number
  token: string
  getRules: () => Rules
  transport: Transport
  llm?: LlmOptions
}

const RULES_FILE = 'persona/rules.yaml'

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function text(res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
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
      const p = proactiveStatus(stageOf(rules, relation.closeness).名)
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
  const indexFile = resolve('console/index.html')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    // 控制台自己的静态文件（members.js 等）**不走 token 校验**。
    //
    // 为什么：`<script src="/members.js">` 带不了自定义 header，
    // 也没法把 token 拼进 src（那是硬编码，刷新就失效）。
    // 这些文件是纯前端代码，不含数据；真正拿数据还得过 /api/* 的 token。
    // 只允许 console/ 下的 .js/.css，路径里不许有 ..，其余一律 404。
    if (
      (req.method === 'GET' && /^\/[\w.-]+\.(js|css)$/.test(path)) ||
      (req.method === 'GET' && (path === '/' || path === '/index.html'))
    ) {
      const rel = path === '/' || path === '/index.html' ? 'index.html' : path.slice(1)
      const full = resolve('console', rel)
      if (!full.startsWith(resolve('console')) || !existsSync(full)) {
        text(res, 404, '没有这个文件')
        return
      }
      const type = rel.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : rel.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8'
      text(res, 200, readFileSync(full, 'utf8'), type)
      return
    }

    // 鉴权：token 从 query 或 header 取
    const given = url.searchParams.get('token') ?? req.headers['x-console-token']
    if (opts.token && given !== opts.token) {
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
        const onLog = (rec: LogRecord) => {
          res.write(`data: ${JSON.stringify(rec)}\n\n`)
        }
        logBus.on('log', onLog)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
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

      // 体检：一眼看出哪里坏了
      // 每项独立跑，API 挂了不影响查磁盘；最慢的一项 3 秒超时。
      // 能力清单：它能干什么、开没开。
      // 直接复用 abilities.ts —— 那是给 prompt 用的同一份数据，
      // 分开维护会漂（prompt 说"能看屏幕"，控制台说"不能"）。
      // 它准备做的事：读 / 加 / 完成 / 删
      // 自我页（7 个子栏）的聚合数据。
      // 一次拿全，避免每个子栏发一个请求（切 tab 会闪）。
      if (req.method === 'GET' && path === '/api/self/v2') {
        const { loadSelf } = await import('../self/store.ts')
        const { loadLife } = await import('../self/store.ts')
        const { loadIntent } = await import('../memory/intent.ts')
        const { decayedMood, loadMood } = await import('../persona/mood.ts')
        const { parseCore } = await import('../memory/core.ts')
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
        try {
          const raw = readFileSync('persona/core.md', 'utf8')
          const parsed = parseCore(raw)
          const out: Record<string, string[]> = {}
          for (const item of parsed) {
            const k = (item as unknown as { kind?: string }).kind ?? '身份'
            const v = (item as unknown as { text?: string }).text ?? ''
            if (!v) continue
            out[k] = out[k] ?? []
            out[k].push(v)
          }
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

        json(res, 200, {
          name: self.name || '',
          selfText: self.about || '',
          traits,
          life,
          intent: loadIntent(),
          mood,
          moodHistory: [],
          core,
          issues,
          codemap,
          plays,
        })
        return
      }

      // 改自述（角色卡里那一大段）
      if (req.method === 'PUT' && path === '/api/self/text') {
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string }
        const text = String(body.text ?? '')
        if (!text.trim()) {
          json(res, 400, { error: '自述不能空' })
          return
        }
        const { loadSelf, saveSelf } = await import('../self/store.ts')
        const cur = loadSelf()
        saveSelf({ ...cur, about: text })
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && path === '/api/intent') {
        const { loadIntent } = await import('../memory/intent.ts')
        json(res, 200, loadIntent())
        return
      }

      if (req.method === 'POST' && path === '/api/intent') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
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
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; on?: boolean }
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
        const body = JSON.parse((await readBody(req)) || '{}') as { key?: string; value?: unknown }
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
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))
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
          摘要阈值: rules.上下文压缩?.摘要阈值 ?? 20,
          保留最近: rules.上下文压缩?.保留最近 ?? 6,
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
        const data = JSON.parse(body || '{}') as { text?: string }
        const text = (data.text ?? '').trim()
        if (!text) throw new Error('说点什么')
        const account = primaryAccount(personId)
        const result = await previewReply(text, {
          rules: opts.getRules(),
          llm: opts.llm,
          accountId: account,
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
      const isInput = /说点什么|缺少|不存在|没有模型|非法的|未知操作/.test(msg)
      if (!isInput) warnAt('控制台请求出错', { path, err: msg })
      json(res, isInput ? 400 : 500, { error: msg })
    }
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => resolveListen())
  })

  const url = `http://127.0.0.1:${opts.port}/`
  // 日志里不打印完整 token：日志可能被贴出去排错
  const tokenHint = opts.token ? `?token=${opts.token.slice(0, 4)}…（完整 token 见 .env 的 CONSOLE_TOKEN）` : ''
  info(`控制台已启动：${url}${tokenHint}`)
}
