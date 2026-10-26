import { readFileSync, existsSync } from 'node:fs'
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
      for (const [scope, list] of groups) {
        const pid = scope.startsWith('private:') ? personOfAccount('qq', scope.slice('private:'.length)) : personId
        results.push({
          scope,
          ...(await distill({ personId: pid, scope: scope as Scope, turns: list, llm: opts.llm, rules })),
        })
      }
      return { date, account, results }
    }

    case 'reload': {
      const rules = loadRules()
      return { reloaded: true, warnings: rules.warnings }
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

    case 'groupMembers': {
      const gid = String(payload['groupId'] ?? '')
      if (!gid) throw new Error('缺少 groupId')
      if (!opts.transport.listGroupMembers) throw new Error('当前通道不支持拉群成员')
      const members = await opts.transport.listGroupMembers(gid)
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
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!existsSync(indexFile)) {
          text(res, 500, '找不到 console/index.html')
          return
        }
        text(res, 200, readFileSync(indexFile, 'utf8'), 'text/html; charset=utf-8')
        return
      }

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
