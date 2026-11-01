/**
 * 表情包库的控制台接口。
 *
 * 为什么要这个：MaiBot 有 WebUI 能看表情包库，我们之前只能去翻
 * persona/emoji/ 目录 —— 用户根本不知道库里有什么、发的是哪张。
 *
 * 四个只读/管理操作：
 *   GET  /api/emoji/list     → 库里有什么
 *   GET  /api/emoji/image/:id → 取一张的图片（给 <img> 用）
 *   POST /api/emoji/remove   → 删一张
 *   GET  /api/emoji/stats    → 库的概况（数量/容量/最久没用的）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

type Json = (res: ServerResponse, code: number, body: unknown) => void
type ReadBody = (req: IncomingMessage) => Promise<unknown>

const ROOT = join('persona', 'emoji')

/** 图片扩展名 → content-type */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

export async function handleEmojiApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  json: Json,
  readJson: ReadBody,
): Promise<boolean> {
  if (!path.startsWith('/api/emoji/')) return false

  const { createEmojiStore } = await import('../emoji/store.ts')
  const { loadRules } = await import('../core/config.ts')
  const rules = loadRules().rules
  const store = createEmojiStore(ROOT, { libraryCap: rules.表情包.库存上限 })

  // 列表
  if (req.method === 'GET' && path === '/api/emoji/list') {
    const items = await store.list()
    // 新 → 旧，方便看最近收的
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt)
    json(res, 200, { ok: true, data: { items: sorted, cap: rules.表情包.库存上限 } })
    return true
  }

  // 概况
  if (req.method === 'GET' && path === '/api/emoji/stats') {
    const items = await store.list()
    const now = Date.now()
    const DAY = 86_400_000
    const neverUsed = items.filter((x) => x.lastUsedAt <= x.createdAt).length
    const oldest = items.reduce((min, x) => (x.lastUsedAt < min ? x.lastUsedAt : min), now)
    json(res, 200, {
      ok: true,
      data: {
        count: items.length,
        cap: rules.表情包.库存上限,
        neverUsed,
        oldestUnusedDays: items.length ? Math.floor((now - oldest) / DAY) : 0,
        enabled: rules.表情包.开启,
        chance: rules.表情包.概率,
        moodBoost: rules.表情包.心情加成,
      },
    })
    return true
  }

  // 取图：给 <img src> 用
  const imgMatch = /^\/api\/emoji\/image\/([A-Za-z0-9_-]{1,32})$/.exec(path)
  if (req.method === 'GET' && imgMatch) {
    const id = imgMatch[1]!
    const items = await store.list()
    const item = items.find((x) => x.id === id)
    if (!item) {
      json(res, 404, { ok: false, error: '没有这张表情包' })
      return true
    }

    // 文件名来自索引，但仍然规范化一次：索引是磁盘上的文件，可能被手改
    const rel = normalize(item.file).replace(/^([/\\])+/, '')
    if (rel.includes('..')) {
      json(res, 400, { ok: false, error: '文件名不合法' })
      return true
    }
    const full = join(ROOT, rel)
    if (!existsSync(full)) {
      json(res, 404, { ok: false, error: '索引里有，但图片文件不见了' })
      return true
    }
    const ext = (rel.split('.').pop() ?? '').toLowerCase()
    const buf = readFileSync(full)
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(buf.byteLength),
      // 图片按 id 寻址，内容不会变 → 可以长缓存
      'cache-control': 'public, max-age=86400',
    })
    res.end(buf)
    return true
  }

  // 删除
  if (req.method === 'POST' && path === '/api/emoji/remove') {
    const body = (await readJson(req)) as { id?: unknown }
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) {
      json(res, 400, { ok: false, error: '缺少 id' })
      return true
    }
    const ok = await store.remove(id)
    json(res, ok ? 200 : 404, ok ? { ok: true, data: { id } } : { ok: false, error: '没有这张表情包' })
    return true
  }

  return false
}
