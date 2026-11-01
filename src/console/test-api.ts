/**
 * 测试页的接口：工具连通性 + 记忆检索。
 *
 * 试聊那个已经存在（/api/action 的 preview），这里补两个新的。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseJsonBody } from './http.ts'

type Json = (res: ServerResponse, code: number, body: unknown) => void
type ReadBody = (req: IncomingMessage) => Promise<string>

/** 能单独测的工具清单（只读的那些，不会动电脑） */
const TESTABLE = [
  { id: 'screenshot', name: '截图', group: '感知' },
  { id: 'list_windows', name: '窗口列表', group: '感知' },
  { id: 'read_code', name: '读源码', group: '感知' },
  { id: 'search_code', name: '搜代码', group: '感知' },
  { id: 'hot_list', name: 'B站热门', group: '感知' },
  { id: 'recall', name: '记忆检索', group: '记忆' },
  { id: 'facts', name: '读事实', group: '记忆' },
  { id: 'episodes', name: '读经历', group: '记忆' },
]

export async function handleTestApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  /* ============ 有哪些工具可测 ============ */
  if (method === 'GET' && path === '/api/test/tools') {
    json(res, 200, { tools: TESTABLE })
    return true
  }

  /* ============ 装 ai-desktop（截图/看窗口的后端） ============ */
  //
  // 它是个 Python 包，pip 就能装。做成异步：pip 要几十秒，同步会超时。
  if (method === 'POST' && path === '/api/test/install-ai-desktop') {
    const { startInstallAiDesktop } = await import('./tool-install.ts')
    const r = await startInstallAiDesktop()
    json(res, r.ok ? 200 : 400, r)
    return true
  }

  if (method === 'GET' && path === '/api/test/install-ai-desktop/status') {
    const { installStatus } = await import('./tool-install.ts')
    json(res, 200, installStatus())
    return true
  }

  /* ============ 测一个工具 ============ */
  if (method === 'POST' && path === '/api/test/tool') {
    const body = parseJsonBody(await readBody(req)) as { id?: string; args?: Record<string, unknown> }
    const id = String(body.id ?? '')
    const t0 = Date.now()
    let ok = false
    let detail = ''
    let preview = ''

    try {
      const r = await runToolTest(id, body.args ?? {})
      ok = r.ok
      detail = r.detail
      preview = r.preview ?? ''
    } catch (e) {
      detail = String(e).slice(0, 200)
    }

    json(res, 200, { ok, detail, preview, ms: Date.now() - t0 })
    return true
  }

  /* ============ 记忆检索（只看会回忆起什么，不生成回复） ============ */
  if (method === 'POST' && path === '/api/test/recall') {
    const body = parseJsonBody(await readBody(req)) as {
      personId?: string
      scope?: string
      query?: string
      limit?: number
    }
    const t0 = Date.now()

    try {
      const { recall, renderRecalled } = await import('../memory/recall.ts')
      const { listPeople, primaryAccount } = await import('../people/store.ts')
      const { loadRules } = await import('../core/config.ts')

      const personId = String(body.personId ?? '')
      const person = listPeople().find((p) => p.id === personId)
      // scope 是 Scope 联合类型，不能直接塞 string
      const scope = (body.scope ||
        (person ? `private:${primaryAccount(personId)}` : `private:${process.env['OWNER_QQ'] ?? ''}`)) as
        | `private:${string}`
        | `group:${string}`
        | 'shared'

      const rules = loadRules().rules
      const recalled = recall({
        personId: personId || `qq-${process.env['OWNER_QQ'] ?? ''}`,
        scope,
        query: String(body.query ?? ''),
        limit: Math.min(20, Math.max(1, Number(body.limit ?? 8) || 8)),
        weights: rules.记忆.检索.权重,
      })

      json(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        // Recalled 只有这五个字段（见 memory/types.ts）
        counts: {
          facts: recalled.facts.length,
          episodes: recalled.episodes.length,
          insights: recalled.insights.length,
          open: recalled.open.length,
          recent: (recalled.recent || []).length,
        },
        rendered: renderRecalled(recalled),
        facts: recalled.facts.map((f) => ({ text: f.text, eff: undefined })),
        episodes: recalled.episodes.map((e) => ({ title: e.title, date: e.date, importance: e.importance })),
        insights: recalled.insights.map((i) => i.text),
      })
    } catch (e) {
      json(res, 200, { ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 })
    }
    return true
  }

  return false
}

async function runToolTest(
  id: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; preview?: string }> {
  switch (id) {
    case 'screenshot': {
      const { screenshotTool } = await import('../tools/desktop.ts')
      const r = JSON.parse(await screenshotTool.run({}, {} as never)) as { ok?: boolean; path?: string; error?: string }
      return r.ok
        ? { ok: true, detail: '截到了', preview: String(r.path ?? '') }
        : { ok: false, detail: r.error ?? '失败' }
    }
    case 'list_windows': {
      const { listWindowsTool } = await import('../tools/desktop.ts')
      const out = await listWindowsTool.run({}, {} as never)
      const r = JSON.parse(String(out)) as { ok?: boolean; count?: number; error?: string }
      // 失败时要把 error 带出来（比如"没装 ai-desktop"），只说"失败"等于没说
      return r.ok
        ? { ok: true, detail: `看到 ${r.count ?? 0} 个窗口` }
        : { ok: false, detail: r.error ?? '失败' }
    }
    case 'read_code': {
      const { readCodeTool } = await import('../tools/code.ts')
      // 参数名是 file/from/to（不是 path）。而且成功时它返回的是纯文本，
      // 不是 JSON —— 之前这里 JSON.parse 直接炸。
      const out = await readCodeTool.run({ file: 'src/index.ts', from: 1, to: 12 }, {} as never)
      const text = String(out)
      if (text.trimStart().startsWith('{')) {
        // 失败分支返回的是 { error: ... }
        const err = JSON.parse(text) as { error?: string }
        return { ok: false, detail: err.error ?? '失败' }
      }
      return { ok: true, detail: '能读 src/index.ts', preview: text.slice(0, 200) }
    }
    case 'search_code': {
      const { searchCodeTool } = await import('../tools/code.ts')
      // 同样是纯文本返回（file:line: text），不是 JSON
      const out = await searchCodeTool.run({ query: 'loadRules', limit: 3 }, {} as never)
      const text = String(out)
      if (text.includes('没搜到')) return { ok: true, detail: '没搜到（可能源码没一起打进来）' }
      const n = text.split('\n').filter((l) => l.includes(':')).length
      return { ok: true, detail: `搜到 ${n} 处`, preview: text.slice(0, 200) }
    }
    case 'hot_list': {
      const { hot } = await import('../outward/bili.ts')
      // hot() 直接返回 VideoBrief[]（不是 { list }）
      const list = await hot({ limit: 3 })
      return {
        ok: list.length > 0,
        detail: `拿到 ${list.length} 条`,
        preview: list.map((x: { title?: string }) => x.title ?? '').join(' / '),
      }
    }
    case 'facts': {
      const { listPeople } = await import('../people/store.ts')
      const { loadFacts } = await import('../memory/facts.ts')
      let n = 0
      for (const p of listPeople()) n += loadFacts(p.id).length
      return { ok: true, detail: `${listPeople().length} 个人共 ${n} 条事实` }
    }
    case 'episodes': {
      const { loadEpisodes } = await import('../memory/store.ts')
      const eps = loadEpisodes()
      return { ok: true, detail: `${eps.length} 条经历` }
    }
    case 'recall': {
      const { recall } = await import('../memory/recall.ts')
      const { listPeople, primaryAccount } = await import('../people/store.ts')
      const { loadRules } = await import('../core/config.ts')

      // personId 不能拼 "qq-${OWNER_QQ}" —— 没配 OWNER_QQ 时就是 "qq-"，
      // recall 会抛「非法的 personId」。改成取第一个真人，没有就不测。
      const people = listPeople()
      const first = people[0]
      if (!first) return { ok: false, detail: '还没有任何人物档案（先聊几句）' }

      const acc = primaryAccount(first.id)
      const r = recall({
        personId: first.id,
        scope: `private:${acc}`,
        query: '测试',
        limit: 5,
        weights: loadRules().rules.记忆.检索.权重,
      })
      return {
        ok: true,
        detail: `${first.name || first.id}：${r.facts.length} 事实 / ${r.episodes.length} 经历`,
      }
    }
    default:
      return { ok: false, detail: '不认识这个工具' }
  }
}
