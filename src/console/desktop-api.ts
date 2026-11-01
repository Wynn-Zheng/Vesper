/**
 * 电脑操作的审批接口。
 *
 * 危险操作（点击/打字/按键）先排队，你在控制台点「允许」才真执行。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseJsonBody } from './http.ts'

type Json = (res: ServerResponse, code: number, body: unknown) => void
type ReadBody = (req: IncomingMessage) => Promise<string>

export async function handleDesktopApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  // 待确认列表 + 最近的操作日志
  if (method === 'GET' && path === '/api/desktop/state') {
    const { listPending, } = await import('../tools/desktop-pending.ts')
    const { readDesktopLog } = await import('../tools/desktop-log.ts')
    const { loadRules } = await import('../core/config.ts')

    const rules = loadRules().rules
    json(res, 200, {
      开: rules.电脑操作?.enabled === true,
      可操作: rules.电脑操作?.enabled === true && rules.电脑操作?.允许操作 === true,
      待确认: listPending(),
      日志: readDesktopLog(30),
    })
    return true
  }

  // 批准：真执行
  if (method === 'POST' && path === '/api/desktop/approve') {
    const body = parseJsonBody(await readBody(req)) as { id?: string }
    const id = String(body.id ?? '')
    if (!id) {
      json(res, 400, { error: '缺少 id' })
      return true
    }
    const { executePending } = await import('../tools/desktop.ts')
    const r = await executePending(id)
    json(res, r.ok ? 200 : 400, r)
    return true
  }

  // 拒绝
  if (method === 'POST' && path === '/api/desktop/reject') {
    const body = parseJsonBody(await readBody(req)) as { id?: string }
    const id = String(body.id ?? '')
    if (!id) {
      json(res, 400, { error: '缺少 id' })
      return true
    }
    const { rejectPending } = await import('../tools/desktop.ts')
    const ok = await rejectPending(id)
    json(res, ok ? 200 : 400, ok ? { ok: true } : { error: '没有这条' })
    return true
  }

  return false
}
