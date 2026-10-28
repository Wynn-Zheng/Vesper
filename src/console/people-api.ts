/**
 * 人物相关的控制台接口。
 *
 * 单独放一个文件，不塞进 server.ts —— 那个文件已经 1000 多行，
 * 再往里加容易改坏（这次就改坏过一回）。
 *
 * 约定：handlePeopleApi 返回 true 表示这个请求已经处理并写了响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

type Json = (res: ServerResponse, code: number, body: unknown) => void
type ReadBody = (req: IncomingMessage) => Promise<string>

/**
 * 包一层：内部不论怎么抛，都转成 { error } 返回。
 *
 * 为什么不让它抛到 server.ts 的外层 catch：
 *   外层会把**原始异常**直接塞进 { error }，前端弹出来是一坨英文堆栈，
 *   对用户没意义。这里统一成一句中文，详细内容记到 warnAt 里。
 */
export async function handlePeopleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  try {
    return await handlePeopleApiInner(req, res, path, url, json, readBody)
  } catch (err) {
    const { warnAt } = await import('../core/log.ts')
    warnAt('人物接口出错', { path, err: String(err).slice(0, 200) })
    // 已经发过响应就别再发一次（会 header already sent）
    if (!res.headersSent) {
      json(res, 500, { error: '这个操作没成功，详情看日志里的「人物接口出错」' })
    }
    return true
  }
}

async function handlePeopleApiInner(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  /* ============ 人物列表 ============ */
  if (method === 'GET' && path === '/api/people') {
    const { listPeople, primaryAccount } = await import('../people/store.ts')
    const { loadRelation } = await import('../relation/store.ts')
    const { knownGroups, groupMembers } = await import('../people/group.ts')
    const { loadFacts } = await import('../memory/facts.ts')
    const { recentRaw } = await import('../memory/store.ts')
    const { loadRules, stageOf } = await import('../core/config.ts')

    const rules = loadRules().rules
    const people = listPeople()

    // QQ号 → 在哪些群、在这个群叫什么
    const groupIndex = new Map<string, Array<{ groupId: string; 名片: string }>>()
    for (const gid of knownGroups()) {
      for (const m of groupMembers(gid)) {
        const arr = groupIndex.get(m.id) ?? []
        arr.push({ groupId: gid, 名片: m.name })
        groupIndex.set(m.id, arr)
      }
    }

    // 最近说过话的时间
    const lastTalk = new Map<string, number>()
    for (const turn of recentRaw(7)) {
      if (turn.role !== 'user' || !turn.senderId) continue
      const cur = lastTalk.get(turn.senderId) ?? 0
      if (turn.ts > cur) lastTalk.set(turn.senderId, turn.ts)
    }

    const rows = people.map((person) => {
      const rel = loadRelation(person.id)
      const facts = loadFacts(person.id)
      const accounts = person.accounts.map((a) => a.id)

      const inGroups: Array<{ groupId: string; 名片: string }> = []
      for (const a of accounts) {
        for (const g of groupIndex.get(a) ?? []) {
          if (!inGroups.some((x) => x.groupId === g.groupId)) inGroups.push(g)
        }
      }

      let last = 0
      for (const a of accounts) last = Math.max(last, lastTalk.get(a) ?? 0)

      return {
        id: person.id,
        名字: person.name || person.id,
        账号: primaryAccount(person.id),
        角色: person.role ?? '',
        名字锁: person.nameLocked === true,
        在群: inGroups,
        群数: inGroups.length,
        关系: Math.round(rel.closeness),
        阶段: stageOf(rules, rel.closeness).名,
        事实: facts.filter((f) => !f.faint && !f.supersededAt).length,
        最近: last,
      }
    })

    // 群里还没建档的人（给「建档」按钮用）
    const known = new Set(people.flatMap((p) => p.accounts.map((a) => a.id)))
    const candidates: Array<{ id: string; 名片: string; 昵称: string; 群: string[] }> = []
    const seen = new Set<string>()
    for (const gid of knownGroups()) {
      for (const m of groupMembers(gid)) {
        if (known.has(m.id) || seen.has(m.id)) continue
        seen.add(m.id)
        candidates.push({
          id: m.id,
          名片: m.name,
          昵称: m.nick ?? '',
          群: groupIndex.get(m.id)?.map((g) => g.groupId) ?? [gid],
        })
      }
    }

    json(res, 200, { people: rows, candidates })
    return true
  }

  /* ============ 人物详情 ============ */
  if (method === 'GET' && path === '/api/person/detail') {
    const id = url.searchParams.get('id') ?? ''
    const { isValidPersonId, loadPerson, primaryAccount } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }

    const meta = loadPerson(id)
    if (!meta) {
      json(res, 404, { error: '没有这个人的档案' })
      return true
    }

    const { loadRelation } = await import('../relation/store.ts')
    const { loadFacts } = await import('../memory/facts.ts')
    const { loadProfile } = await import('../persona/profile.ts')
    const { impressionOf } = await import('../self/will.ts')
    const { loadOpen } = await import('../people/open.ts')
    const { loadEpisodes } = await import('../memory/store.ts')
    const { knownGroups, groupMembers } = await import('../people/group.ts')
    const { loadRules, stageOf } = await import('../core/config.ts')

    const rules = loadRules().rules
    const rel = loadRelation(id)
    const accounts = meta.accounts.map((a) => a.id)

    const inGroups: Array<{ groupId: string; 名片: string }> = []
    for (const gid of knownGroups()) {
      for (const m of groupMembers(gid)) {
        if (accounts.includes(m.id) && !inGroups.some((x) => x.groupId === gid)) {
          inGroups.push({ groupId: gid, 名片: m.name })
        }
      }
    }

    json(res, 200, {
      id,
      名字: meta.name || id,
      账号: primaryAccount(id),
      账号列表: accounts,
      角色: meta.role ?? '',
      名字锁: meta.nameLocked === true,
      首次见到: meta.firstSeen ?? 0,
      在群: inGroups,
      关系: {
        值: Math.round(rel.closeness),
        阶段: stageOf(rules, rel.closeness).名,
        // 四维只存事件、不存数值（见 relation/types.ts），这里给的是"发生过几件事"
        维度: Object.fromEntries(
          Object.entries(rel.dimensions ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
        ),
        锚点数: (rel.anchors ?? []).length,
      },
      事实: loadFacts(id).filter((f) => !f.faint),
      画像: loadProfile(id),
      印象: impressionOf(id),
      待问: loadOpen(id),
      经历: loadEpisodes()
        .filter((e) => accounts.some((a) => e.scope === `private:${a}`))
        .slice(-30),
    })
    return true
  }

  /* ============ 确认 / 取消确认一条事实 ============ */
  if (method === 'POST' && path === '/api/person/fact/confirm') {
    const raw = JSON.parse((await readBody(req)) || '{}') as unknown
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown; index?: unknown; confirmed?: unknown }) : {}
    const id = String(body.id ?? '')
    const indexValue = body.index
    const index =
      typeof indexValue === 'number'
        ? indexValue
        : typeof indexValue === 'string' && indexValue.trim()
          ? Number(indexValue)
          : Number.NaN
    const { isValidPersonId, loadPerson } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    if (!Number.isInteger(index) || index < 0) {
      json(res, 400, { error: 'index 不对' })
      return true
    }
    if (!loadPerson(id)) {
      json(res, 404, { error: '没有这个人的档案' })
      return true
    }

    // 用户确认过 → me；取消 → it。其他值一律按取消处理，和 body 的布尔语义一致。
    const by: 'it' | 'me' = body.confirmed === true ? 'me' : 'it'
    const { setFactBy } = await import('../memory/facts.ts')
    if (!setFactBy(id, index, by)) {
      json(res, 404, { error: '没有这条事实' })
      return true
    }
    json(res, 200, { ok: true, index, by })
    return true
  }

  /* ============ 建档 ============ */
  if (method === 'POST' && path === '/api/person/create') {
    const body = JSON.parse((await readBody(req)) || '{}') as { accountId?: string; name?: string }
    const accountId = String(body.accountId ?? '').trim()
    if (!/^\d{4,12}$/.test(accountId)) {
      json(res, 400, { error: '账号不对' })
      return true
    }

    const { ensurePerson, loadPerson } = await import('../people/store.ts')
    const already = !!loadPerson(`qq-${accountId}`)
    ensurePerson('qq', accountId, body.name?.trim() || undefined)
    json(res, 200, { ok: true, id: `qq-${accountId}`, already })
    return true
  }

  /* ============ 改名 ============ */
  if (method === 'PUT' && path === '/api/person/name') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; name?: string }
    const id = String(body.id ?? '')
    const name = String(body.name ?? '').trim()
    if (!name) {
      json(res, 400, { error: '名字不能空' })
      return true
    }
    if (name.length > 40) {
      json(res, 400, { error: '名字太长' })
      return true
    }

    const { isValidPersonId, loadPerson, savePerson } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    const meta = loadPerson(id)
    if (!meta) {
      json(res, 404, { error: '没有这个人的档案' })
      return true
    }
    savePerson({ ...meta, name })
    json(res, 200, { ok: true })
    return true
  }

  /* ============ 改关系标签 / 锁名字 ============ */
  if (method === 'PUT' && path === '/api/person/role') {
    const raw = JSON.parse((await readBody(req)) || '{}') as unknown
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown; role?: unknown; nameLocked?: unknown }) : {}
    const id = String(body.id ?? '')
    const hasRole = Object.prototype.hasOwnProperty.call(body, 'role')
    const hasLock = Object.prototype.hasOwnProperty.call(body, 'nameLocked')
    if (!hasRole && !hasLock) {
      json(res, 400, { error: '要给 role 或 nameLocked' })
      return true
    }

    const { isValidPersonId, isPersonRole, loadPerson, savePerson } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }

    // 先校验完再写盘：两个字段一起传时，坏的那个不能留下半截修改。
    if (hasRole && !isPersonRole(body.role)) {
      json(res, 400, { error: 'role 只能是 主人/朋友/同事/网友/陌生人' })
      return true
    }
    if (hasLock && typeof body.nameLocked !== 'boolean') {
      json(res, 400, { error: 'nameLocked 只能是 true / false' })
      return true
    }

    const meta = loadPerson(id)
    if (!meta) {
      json(res, 404, { error: '没有这个人的档案' })
      return true
    }

    const next = { ...meta }
    if (hasRole) next.role = body.role as string
    if (hasLock) next.nameLocked = body.nameLocked as boolean
    savePerson(next)
    json(res, 200, {
      ok: true,
      ...(next.role !== undefined ? { role: next.role } : {}),
      ...(next.nameLocked !== undefined ? { nameLocked: next.nameLocked } : {}),
    })
    return true
  }

  /* ============ 改画像 ============ */
  if (method === 'PUT' && path === '/api/person/profile') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; text?: string }
    const id = String(body.id ?? '')
    const { isValidPersonId } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    const { saveProfile } = await import('../persona/profile.ts')
    saveProfile(id, String(body.text ?? ''))
    json(res, 200, { ok: true })
    return true
  }

  /* ============ 改印象 ============ */
  if (method === 'PUT' && path === '/api/person/impression') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; text?: string }
    const id = String(body.id ?? '')
    const { isValidPersonId } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    const { setImpression } = await import('../self/will.ts')
    setImpression(id, String(body.text ?? ''))
    json(res, 200, { ok: true })
    return true
  }

  /* ============ 改关系 ============ */
  // 只有 closeness 是数字；四维只存事件，不能改
  if (method === 'PUT' && path === '/api/person/relation') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; closeness?: number }
    const id = String(body.id ?? '')
    const { isValidPersonId } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    const n = Number(body.closeness)
    if (!Number.isFinite(n)) {
      json(res, 400, { error: 'closeness 不是数字' })
      return true
    }

    const { loadRelation, saveRelation } = await import('../relation/store.ts')
    const rel = loadRelation(id)
    const closeness = Math.min(100, Math.max(0, Math.round(n)))
    saveRelation(id, { ...rel, closeness })
    json(res, 200, { ok: true, closeness })
    return true
  }

  /* ============ 删档案 ============ */
  if (method === 'DELETE' && path === '/api/person') {
    const id = url.searchParams.get('id') ?? ''
    const { isValidPersonId, clearPersonCache } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }

    const { snapshot } = await import('../persona/version.ts')
    snapshot('before-delete-person')

    const { rmSync, existsSync } = await import('node:fs')
    const dir = `persona/people/${id}`
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    clearPersonCache()
    json(res, 200, { ok: true })
    return true
  }

  return false
}
