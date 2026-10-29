/**
 * 成员页（表格 + 抽屉）。
 *
 * 和 people-api.ts 的分工：
 *   people-api.ts → 人物列表/详情/改名/改画像/印象/关系（单人的编辑）
 *   这个文件      → **表格**（所有成员一行一个 + 7 列）+ 抽屉要的全量数据
 *
 * 为什么要分开：表格要的是"一次拿所有人一起看"的扁平结构，
 * 详情要的是"一个人所有东西"的深结构。两种查询的目的不一样。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

type Json = (res: ServerResponse, code: number, body: unknown) => void

/** 读 JSON body：空 body 当 {}，非法 JSON 抛一个能映射成 400 的错误 */
function safeJson(text: string): Record<string, unknown> {
  if (!text || !text.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}
export async function handleMemberApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  json: Json,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  /* ============ 表格：所有成员 × 7 列 ============ */
  if (method === 'GET' && path === '/api/member/table') {
    const { listPeople, primaryAccount } = await import('../people/store.ts')
    const { loadRelation } = await import('../relation/store.ts')
    const { knownGroups, groupMembers } = await import('../people/group.ts')
    const { loadFacts } = await import('../memory/facts.ts')
    const { recentRaw, loadEpisodes, loadInsights } = await import('../memory/store.ts')
    const { parseCore } = await import('../memory/core.ts')
    const { loadRules, stageOf } = await import('../core/config.ts')
    const { readFileSync, existsSync } = await import('node:fs')

    const rules = loadRules().rules
    const people = listPeople()

    /* --- 群索引：QQ号 → 在哪些群 --- */
    const inGroup = new Map<string, Array<{ groupId: string; 名片: string }>>()
    for (const gid of knownGroups()) {
      for (const m of groupMembers(gid)) {
        const arr = inGroup.get(m.id) ?? []
        arr.push({ groupId: gid, 名片: m.name })
        inGroup.set(m.id, arr)
      }
    }

    /* --- 对话统计：从 raw 里数 ---
     * 要分开私聊和群聊：群里的消息也是他"说的"，但不能算成"私聊过"。
     */
    const talk = new Map<string, { turns: number; lastAt: number }>()
    const talkedPrivate = new Set<string>() // 私聊过的人
    for (const t of recentRaw(7)) {
      if (t.role !== 'user' || !t.senderId) continue
      const cur = talk.get(t.senderId) ?? { turns: 0, lastAt: 0 }
      cur.turns++
      cur.lastAt = Math.max(cur.lastAt, t.ts)
      talk.set(t.senderId, cur)
      if (t.scope.startsWith('private:')) talkedPrivate.add(t.senderId)
    }

    /* --- 核心记忆：按人分组（core.md 里带 @人的条目） --- */
    let coreItems: Array<{ text: string; kind: string; personId?: string }> = []
    try {
      if (existsSync('persona/core.md')) {
        const raw = readFileSync('persona/core.md', 'utf8')
        const parsed = parseCore(raw) as unknown as Array<{
          text?: string
          kind?: string
          personId?: string
        }>
        coreItems = parsed
          .filter((x) => x.text)
          .map((x) => ({ text: x.text!, kind: x.kind ?? '身份', ...(x.personId ? { personId: x.personId } : {}) }))
      }
    } catch {
      /* 没核心文件 */
    }

    /* --- 一个人的所有数据 --- */
    const rows = people.map((p) => {
      const rel = loadRelation(p.id)
      const accounts = p.accounts.map((a) => a.id)

      // 来源
      const 来源: Array<{ kind: 'private' | 'group'; label: string; id: string }> = []
      // 私聊：只在 private scope 里说过话才算（群消息不算）
      if (accounts.some((a) => talkedPrivate.has(a))) {
        来源.push({ kind: 'private', label: '私聊', id: 'private' })
      }
      for (const a of accounts) {
        for (const g of inGroup.get(a) ?? []) {
          if (!来源.some((x) => x.kind === 'group' && x.id === g.groupId)) {
            来源.push({ kind: 'group', label: g.名片 ? `群 ${g.groupId}（${g.名片}）` : `群 ${g.groupId}`, id: g.groupId })
          }
        }
      }

      // 记忆
      const facts = loadFacts(p.id).filter((f) => !f.faint)
      let eps: number[] = []
      let ins: number[] = []
      try {
        eps = loadEpisodes().filter((e) => accounts.some((a) => e.scope === `private:${a}`)).map((e) => 1)
        ins = loadInsights()
          .filter((i) => accounts.some((a) => i.scope === `private:${a}`) || i.scope === 'shared')
          .map((i) => 1)
      } catch {
        /* 读不到 */
      }

      // 对话
      let turns = 0
      let lastTalk = 0
      for (const a of accounts) {
        const t = talk.get(a)
        if (t) {
          turns += t.turns
          lastTalk = Math.max(lastTalk, t.lastAt)
        }
      }

      // 核心
      const core = coreItems.filter((c) => c.personId && accounts.some((a) => c.personId === a || c.personId === p.id))

      return {
        id: p.id,
        名字: p.name || p.id,
        账号: primaryAccount(p.id),
        账号列表: accounts,
        来源,
        关系: { 值: Math.round(rel.closeness), 阶段: stageOf(rules, rel.closeness).名 },
        记忆: { facts: facts.length, episodes: eps.length, insights: ins.length },
        对话: { turns, lastAt: lastTalk },
        核心: { count: core.length, items: core.map((c) => ({ text: c.text, kind: c.kind })) },
        日期: { firstSeen: p.firstSeen ?? 0, lastTalk },
      }
    })

    // 群里还没建档的人（也要能看见，标成"没聊过"）
    const known = new Set(people.flatMap((p) => p.accounts.map((a) => a.id)))
    const nameless: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const gid of knownGroups()) {
      for (const m of groupMembers(gid)) {
        if (known.has(m.id) || seen.has(m.id)) continue
        seen.add(m.id)
        nameless.push({
          id: `qq-${m.id}`,
          名字: m.name || m.nick || m.id,
          账号: m.id,
          账号列表: [m.id],
          来源: inGroup.get(m.id)?.map((g) => ({ kind: 'group', label: `群 ${g.groupId}（${g.名片}）`, id: g.groupId })) ?? [
            { kind: 'group', label: `群 ${gid}`, id: gid },
          ],
          关系: { 值: 0, 阶段: '陌生' },
          记忆: { facts: 0, episodes: 0, insights: 0 },
          对话: { turns: 0, lastAt: 0 },
          核心: { count: 0, items: [] },
          日期: { firstSeen: 0, lastTalk: 0 },
          未建档: true,
        })
      }
    }

    json(res, 200, {
      rows,
      nameless,
      stats: {
        total: rows.length + nameless.length,
        chatted: rows.filter((r) => r.对话.turns > 0).length,
        archived: rows.length,
      },
    })
    return true
  }

  /* ============ 抽屉：一个人的历史对话 ============ */
  if (method === 'GET' && path === '/api/member/chat') {
    const id = url.searchParams.get('id') ?? ''
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60))
    const { isValidPersonId, loadPerson } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }
    const meta = loadPerson(id)
    if (!meta) {
      json(res, 404, { error: '没有这个人的档案' })
      return true
    }

    const { recentRaw } = await import('../memory/store.ts')
    const accounts = meta.accounts.map((a) => a.id)

    const rows = recentRaw(7)
      .filter((t) => {
        if (!accounts.includes(t.senderId ?? '')) return false
        // 私聊 scope 或他所在的群
        return t.scope.startsWith('private:') || t.scope.startsWith('group:')
      })
      .slice(-limit)
      .map((t) => ({
        at: t.ts,
        role: t.role,
        text: t.text,
        scope: t.scope,
      }))

    json(res, 200, { rows, total: rows.length })
    return true
  }

  /* ============ 抽屉：屏蔽/取消屏蔽 ============ */
  // 屏蔽的意思：它不再主动跟这个人说话（但还会记住对方说的）
  if (method === 'PUT' && path === '/api/member/block') {
    const body = safeJson(await readBody(req)) as { id?: string; blocked?: boolean }
    const id = String(body.id ?? '')
    const { isValidPersonId } = await import('../people/store.ts')
    if (!isValidPersonId(id)) {
      json(res, 400, { error: 'id 不对' })
      return true
    }

// memberDeny 比对的是原始平台账号（QQ 号），不是内部 personId（qq-123）。
    // 之前把 personId 写进去，checkAccess 永远匹配不上 → 点"屏蔽"返回 200，bot 照旧回他。
    const { loadPerson } = await import('../people/store.ts')
    const person = loadPerson(id)
    const qq = person?.accounts.find((a) => a.platform === 'qq')?.id ?? ''
    if (!qq) {
      json(res, 400, { error: '这个人还没有 QQ 账号，没法屏蔽' })
      return true
    }
    const bodyBlocked = body.blocked === (true as unknown) || (body.blocked as unknown) === 'true' || (body.blocked as unknown) === 1
    const { loadAccess, saveAccess } = await import('../core/access.ts')
    const acc = loadAccess()
    const list = new Set(acc.memberDeny ?? [])
    if (bodyBlocked) list.add(qq)
    else list.delete(qq)
    saveAccess({ ...acc, memberDeny: [...list] })
    json(res, 200, { ok: true, blocked: list.has(qq) })
    return true
  }
  return false
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}
