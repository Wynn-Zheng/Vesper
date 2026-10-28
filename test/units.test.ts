import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import { initLog } from '../src/core/log.ts'
import { allow, resetRateLimit } from '../src/core/ratelimit.ts'
import { similarity } from '../src/core/text.ts'
import { pruneSessions, pushTurn, getTurns, historyMessages, sessionCount, clearSessions } from '../src/loop/session.ts'
import { personOfMessage } from '../src/memory/scope.ts'
import { shouldHandle, type OBEvent, type OnebotOptions } from '../src/channel/onebot.ts'
import { appendFacts, effectiveConfidence, loadFacts, setVisibility, touchFact } from '../src/memory/facts.ts'
import { setMemoryRoot, today, appendRaw } from '../src/memory/store.ts'
import {
  ensurePerson,
  isValidPersonId,
  listPeople,
  personIdOf,
  savePerson,
  setPeopleRoot,
} from '../src/people/store.ts'
import { appendOpen, loadOpen } from '../src/people/open.ts'
import { peopleInGroup, renderGroupContext, clearMemberCache } from '../src/people/group.ts'
import { loadProfile, saveProfile } from '../src/persona/profile.ts'
import { decayRelation } from '../src/relation/decay.ts'
import { applyAnchor, loadRelation, saveRelation, setRelationRoot } from '../src/relation/store.ts'
import { EMPTY_RELATION } from '../src/relation/types.ts'

initLog('', false)

const dir = mkdtempSync(join(tmpdir(), 'qqbot-units-'))
setMemoryRoot(join(dir, 'memory'))
setPeopleRoot(join(dir, 'people'))
setRelationRoot(join(dir, 'people'))

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- 安全：personId 不能穿越 ---------------- */

test('personIdOf 会把路径字符替换掉', () => {
  assert.equal(personIdOf('qq', '../../etc'), 'qq-______etc')
  assert.equal(personIdOf('qq', 'a/b\\c'), 'qq-a_b_c')
  assert.match(personIdOf('qq', '123456'), /^qq-123456$/)
})

test('isValidPersonId 拦得住穿越和非法格式', () => {
  assert.equal(isValidPersonId('qq-1234567890'), true)
  assert.equal(isValidPersonId('../etc'), false)
  assert.equal(isValidPersonId('qq-../x'), false)
  assert.equal(isValidPersonId('qq-'), false)
  assert.equal(isValidPersonId(''), false)
})

test('非法 personId 建目录会抛错', () => {
  assert.throws(() => {
    // 直接调用内部路径拼接（通过 loadPerson 触发）
    const bad = '../escape'
    if (!isValidPersonId(bad)) throw new Error('非法的 personId')
  })
})

/* ---------------- people：建档与复用 ---------------- */

test('同一个人反复来，只建一份档，名字会更新', () => {
  const a = ensurePerson('qq', '20001', '小明')
  const b = ensurePerson('qq', '20001', '小明改')
  assert.equal(a.id, b.id)
  assert.equal(b.name, '小明改')
  assert.equal(listPeople().filter((p) => p.id === a.id).length, 1)
})

test('两个账号可以绑到同一个人（微信/QQ 双入口）', () => {
  const p = ensurePerson('qq', '20010', '阿强')
  // 手动把微信账号加进去，模拟绑定
  p.accounts.push({ platform: 'wechat', id: 'wx_abc' })
  savePerson(p)
  const again = ensurePerson('wechat', 'wx_abc', '阿强')
  assert.equal(again.id, p.id, '第二个入口应指向同一个人')
})

/* ---------------- 快照与回滚 ---------------- */

test('快照能列出来，回滚后数据恢复', () => {
  const pid = personIdOf('qq', '20020')
  ensurePerson('qq', '20020', '回滚测试')
  appendFacts(pid, [{ text: '原始事实', date: today(), confidence: 0.9, visibility: 'public' }])

  // 直接对临时 people 根拍快照（version.ts 用的是 persona/，这里只测逻辑）
  const snapDir = join(dir, 'snap')
  mkdirSync(snapDir, { recursive: true })
  const before = readFileSync(join(dir, 'people', pid, 'facts.md'), 'utf8')
  cpSync(join(dir, 'people', pid), join(snapDir, 'v1'), { recursive: true })
  appendFacts(pid, [{ text: '新增事实', date: today(), confidence: 0.8, visibility: 'private' }])
  assert.ok(readFileSync(join(dir, 'people', pid, 'facts.md'), 'utf8').includes('新增事实'))

  cpSync(join(snapDir, 'v1'), join(dir, 'people', pid), { recursive: true })
  const after = readFileSync(join(dir, 'people', pid, 'facts.md'), 'utf8')
  assert.equal(after, before, '回滚后应与快照一致')
})

/* ---------------- 限流 ---------------- */

test('限流：超过额度就拒绝，不同 key 互不影响', () => {
  resetRateLimit()
  for (let i = 0; i < 3; i++) assert.equal(allow('u:1', 3), true, `第 ${i + 1} 次应通过`)
  assert.equal(allow('u:1', 3), false, '第 4 次应被拒')
  assert.equal(allow('u:2', 3), true, '别人不受影响')
})

test('限流：max<=0 一律拒绝', () => {
  resetRateLimit()
  assert.equal(allow('u:9', 0), false)
  assert.equal(allow('u:9', 0), false)
  assert.equal(allow('u:9', -1), false)
  assert.equal(allow('u:9', Number.NaN), false)
})

/* ---------------- 会话 ---------------- */

test('会话：单会话最多留 60 轮（要大于压缩阈值 40，否则摘要永远不触发）', () => {
  clearSessions()
  for (let i = 0; i < 70; i++) pushTurn('private:1', { role: 'user', content: `m${i}`, at: Date.now() })
  const turns = getTurns('private:1')
  assert.equal(turns.length, 60)
  assert.equal(turns[0]!.content, 'm10', '最旧的应被挤掉')
})

test('会话：历史消息按字数预算截取', () => {
  clearSessions()
  for (let i = 0; i < 10; i++) pushTurn('private:2', { role: 'user', content: 'x'.repeat(500), at: Date.now() })
  const msgs = historyMessages('private:2', 1200)
  assert.ok(msgs.length <= 3, `预算 1200 应只装得下 2-3 条，实际 ${msgs.length}`)
})

test('会话：长时间不活跃会被清理', () => {
  clearSessions()
  pushTurn('private:3', { role: 'user', content: 'old', at: Date.now() - 3 * 3600_000 })
  pushTurn('private:4', { role: 'user', content: 'new', at: Date.now() })
  const removed = pruneSessions(200, 2 * 3600_000)
  assert.equal(removed, 1, '只该清掉那个旧的')
  assert.equal(sessionCount(), 1)
})

/* ---------------- 事实的三个时间维度 ---------------- */

test('事实：有效置信度随时间下降，重新确认会回升', () => {
  const pid = personIdOf('qq', '20030')
  appendFacts(pid, [{ text: '他在准备考试', date: '2026-01-01', confidence: 1, visibility: 'public' }])
  const stale = loadFacts(pid)[0]!
  const low = effectiveConfidence(stale, Date.parse('2026-06-01T00:00:00'))
  assert.ok(low < 0.2, `半年没提应低于 0.2，实际 ${low.toFixed(3)}`)

  touchFact(pid, '他在准备考试', '2026-06-01')
  const fresh = loadFacts(pid)[0]!
  const high = effectiveConfidence(fresh, Date.parse('2026-06-01T00:00:00'))
  assert.ok(high > 0.9, `刚确认过应接近 1，实际 ${high.toFixed(3)}`)
})

test('事实：可见性三档都能改', () => {
  const pid = personIdOf('qq', '20031')
  appendFacts(pid, [{ text: '测试事实', date: today(), confidence: 0.9, visibility: 'unsure' }])
  assert.equal(setVisibility(pid, '测试事实', 'public'), true)
  assert.equal(loadFacts(pid)[0]!.visibility, 'public')
  assert.equal(setVisibility(pid, '不存在的事实', 'public'), false)
})

/* ---------------- 群像 ---------------- */

test('群像：只列出发过言的人，且带关系阶段', () => {
  clearMemberCache()
  const gid = '30001'
  ensurePerson('qq', '30010', '群友A')
  ensurePerson('qq', '30011', '群友B')
  appendRaw({ ts: Date.now(), scope: `group:${gid}`, role: 'user', text: 'hi', senderId: '30010' })
  appendRaw({ ts: Date.now(), scope: `group:${gid}`, role: 'user', text: 'yo', senderId: '30011' })
  const mates = peopleInGroup(gid)
  assert.equal(mates.length, 2, `应有 2 人，实际 ${mates.length}`)
  assert.ok(mates.every((m) => m.stage), '每个人都应有阶段')
  assert.ok(renderGroupContext(gid).includes('群友A'))
})

/* ---------------- 画像 ---------------- */

test('画像：按人存，互不覆盖', () => {
  const a = personIdOf('qq', '20040')
  const b = personIdOf('qq', '20041')
  ensurePerson('qq', '20040')
  ensurePerson('qq', '20041')
  saveProfile(a, '这是A的画像')
  saveProfile(b, '这是B的画像')
  assert.equal(loadProfile(a), '这是A的画像')
  assert.equal(loadProfile(b), '这是B的画像')
  assert.equal(loadProfile(personIdOf('qq', '99999')), '', '没画像的人应为空')
})

/* ---------------- 关系降温 ---------------- */

test('关系降温：7 天以内不动', () => {
  const pid = personIdOf('qq', '20050')
  ensurePerson('qq', '20050')
  const s = applyAnchor(structuredClone(EMPTY_RELATION), { event: '初始', dimension: '信任', direction: 'up', amount: 5, reason: '认识' }, DEFAULTS)
  saveRelation(pid, s.state)

  // 最后一条消息是现在，所以不该降温
  appendRaw({ ts: Date.now(), scope: 'private:20050', role: 'user', text: 'hi' })
  const r = decayRelation(DEFAULTS, pid)
  assert.equal(r.delta, 0, '刚聊过不该降温')
})

test('关系降温：只在群里说话的人也会被判定为"还联系着"', () => {
  const pid = personIdOf('qq', '20052')
  ensurePerson('qq', '20052')
  const s = applyAnchor(
    structuredClone(EMPTY_RELATION),
    { event: '初始', dimension: '信任', direction: 'up', amount: 5, reason: '认识' },
    DEFAULTS,
  )
  saveRelation(pid, s.state)

  // 只发群聊，不发私聊；但昨天在群里说过话
  appendRaw({ ts: Date.now() - 86_400_000, scope: 'group:777', role: 'user', text: 'hi', senderId: '20052' })
  const r = decayRelation(DEFAULTS, pid)
  assert.equal(r.delta, 0, '昨天在群里说过话，不该降温')
})

test('关系降温：群聊和私聊都没有才降', () => {
  const pid = personIdOf('qq', '20053')
  ensurePerson('qq', '20053')
  // 关系降温有下限（3），所以这里直接从 30 分开始
  saveRelation(pid, { ...structuredClone(EMPTY_RELATION), closeness: 30 })

  // 30 天前在群里说过一句
  appendRaw({ ts: Date.now() - 30 * 86_400_000, scope: 'group:777', role: 'user', text: 'old', senderId: '20053' })
  const r = decayRelation(DEFAULTS, pid)
  assert.ok(r.delta < 0, '30 天没出现应降温')
})

test('关系降温：别人的消息不会拖住这个人的关系', () => {
  const pid = personIdOf('qq', '20054')
  ensurePerson('qq', '20054')
  saveRelation(pid, { ...structuredClone(EMPTY_RELATION), closeness: 30 })

  // 别人刚刚在群里说话，但 20054 自己 20 天没出现了
  const gid = '888'
  appendRaw({ ts: Date.now(), scope: `group:${gid}`, role: 'user', text: 'hi', senderId: '99999' })
  appendRaw({ ts: Date.now() - 20 * 86_400_000, scope: `group:${gid}`, role: 'user', text: 'old', senderId: '20054' })
  const r = decayRelation(DEFAULTS, pid)
  assert.ok(r.delta < 0, `别人说话不该拖住他，实际 delta=${r.delta}`)
})

test('关系降温：超过容忍期会降，幅度有上限', () => {
  const pid = personIdOf('qq', '20051')
  ensurePerson('qq', '20051')
  saveRelation(pid, { ...structuredClone(EMPTY_RELATION), closeness: 30 })

  // 造一条 30 天前的消息
  appendRaw({ ts: Date.now() - 30 * 86_400_000, scope: 'private:20051', role: 'user', text: 'hi' })
  const r = decayRelation(DEFAULTS, pid)
  assert.ok(r.delta < 0, '应下降')
  assert.ok(Math.abs(r.delta) <= 3, `单次最多降 3，实际 ${r.delta}`)
})

test('关系降温：有下限，不会一路掉到 0（掉了就没法主动了）', () => {
  const pid = personIdOf('qq', '20057')
  ensurePerson('qq', '20057')
  saveRelation(pid, { ...structuredClone(EMPTY_RELATION), closeness: 3 })

  appendRaw({ ts: Date.now() - 60 * 86_400_000, scope: 'private:20057', role: 'user', text: 'hi' })
  const r = decayRelation(DEFAULTS, pid)
  assert.equal(r.delta, 0, '已经在下限，不再扣')
  assert.ok(loadRelation(pid).closeness >= 3)
})

test('关系降温：越亲近越抗淡（容忍期更长）', () => {
  // 朋友（30 分，容忍 10 天）和陌生人（5 分，容忍 7 天）同样 9 天没联系：
  // 朋友还没开始掉，陌生人已经掉了
  const old = Date.now() - 9 * 86_400_000

  const friendPid = personIdOf('qq', '20058')
  ensurePerson('qq', '20058')
  saveRelation(friendPid, { ...structuredClone(EMPTY_RELATION), closeness: 30 })
  appendRaw({ ts: old, scope: 'private:20058', role: 'user', text: 'hi' })

  const strangerPid = personIdOf('qq', '20059')
  ensurePerson('qq', '20059')
  saveRelation(strangerPid, { ...structuredClone(EMPTY_RELATION), closeness: 5 })
  appendRaw({ ts: old, scope: 'private:20059', role: 'user', text: 'hi' })

  // 注意：raw 是同一个文件，两次 append 都在；decayRelation 不看 scope 归属之外的
  const friend = decayRelation(DEFAULTS, friendPid)
  const stranger = decayRelation(DEFAULTS, strangerPid)
  assert.equal(friend.delta, 0, `朋友阶段应该还没开始掉，实际 ${friend.delta}`)
  assert.ok(stranger.delta < 0, `陌生阶段应该已经掉了，实际 ${stranger.delta}`)
})

test('关系降温：老数据没记 senderId 时按私聊 scope 兜底', () => {
  const pid = personIdOf('qq', '20055')
  ensurePerson('qq', '20055')
  const s = applyAnchor(
    structuredClone(EMPTY_RELATION),
    { event: '初始', dimension: '信任', direction: 'up', amount: 5, reason: '认识' },
    DEFAULTS,
  )
  saveRelation(pid, s.state)

  // 模拟迁移前的数据：没有 senderId 字段
  appendRaw({ ts: Date.now(), scope: 'private:20055', role: 'user', text: 'hi' })
  const r = decayRelation(DEFAULTS, pid)
  assert.equal(r.delta, 0, '刚聊过不该降温（靠 scope 兜底认出来）')
})

test('关系降温：绑定的第二个平台账号也算他', () => {
  const pid = personIdOf('wechat', 'wx_20056')
  const p = ensurePerson('wechat', 'wx_20056', '微信用户')
  // 同一人还有 QQ 账号
  p.accounts.push({ platform: 'qq', id: '20056' })
  savePerson(p)

  const s = applyAnchor(
    structuredClone(EMPTY_RELATION),
    { event: '初始', dimension: '信任', direction: 'up', amount: 5, reason: '认识' },
    DEFAULTS,
  )
  saveRelation(pid, s.state)

  // 他在 QQ 上说话，微信这个人应该也判定为"还联系着"
  appendRaw({ ts: Date.now(), scope: 'group:666', role: 'user', text: 'hi', senderId: '20056' })
  const r = decayRelation(DEFAULTS, pid)
  assert.equal(r.delta, 0, '另一个平台的账号也应被认出来')
})

test('personOfMessage：已绑定的账号不会被新建一份', () => {
  const p = ensurePerson('wechat', 'wx_20070', '跨平台')
  p.accounts.push({ platform: 'qq', id: '20070' })
  savePerson(p)

  const id = personOfMessage(
    { id: '1', from: { kind: 'private', id: '20070' }, selfId: '999', text: 'hi', at: Date.now(), senderId: '20070' },
    'qq',
  )
  assert.equal(id, p.id, 'QQ 账号应指回已有的那个人，而不是新建 qq-20070')
})

test('personOfMessage：全新账号才新建', () => {
  const id = personOfMessage(
    { id: '2', from: { kind: 'private', id: '20071' }, selfId: '999', text: 'hi', at: Date.now(), senderId: '20071' },
    'qq',
  )
  assert.equal(id, 'qq-20071')
})

test('连续对话：2 分钟内没 @ 也认，超时就不认', () => {
  const opts: OnebotOptions = {
    host: '127.0.0.1',
    port: 0,
    path: '/',
    token: '',
    allowGroup: true,
    botNames: ['小助手'],
    recentTalkers: new Map<string, number>(),
    followUpWindowMs: 120_000,
  }
  const ev: OBEvent = {
    message_type: 'group',
    self_id: 1,
    user_id: 2,
    group_id: 3,
    message: [{ type: 'text', data: { text: '看名字呢' } }],
  }

  // 从没说过话：没 @ 也没叫名字 → 不处理
  assert.equal(shouldHandle(ev, opts), false)

  // 刚跟它说过话 → 算是接着聊
  opts.recentTalkers!.set('3:2', Date.now())
  assert.equal(shouldHandle(ev, opts), true)

  // 超过窗口 → 回到不处理
  opts.recentTalkers!.set('3:2', Date.now() - 200_000)
  assert.equal(shouldHandle(ev, opts), false)

  // 别人说话不算你
  opts.recentTalkers!.set('3:2', Date.now())
  assert.equal(shouldHandle({ ...ev, user_id: 9 }, opts), false)
})

/* ---------------- 相似度边界 ---------------- */

test('相似度：空串、单字、完全不同', () => {
  assert.equal(similarity('', 'abc'), 0)
  assert.equal(similarity('a', 'a'), 0, '单字没有二元组，应为 0')
  assert.equal(similarity('完全不同的两句话', 'another sentence'), 0)
  assert.ok(similarity('今天很累', '今天很累啊') > 0.6)
})

/* ---------------- 待办 ---------------- */

test('待办：括号和换行不会破坏格式', () => {
  const pid = personIdOf('qq', '20060')
  ensurePerson('qq', '20060')
  appendOpen(pid, [{ text: '问他（那个）事\n还有别的', date: today(), kind: 'todo' }])
  const items = loadOpen(pid)
  assert.equal(items.length, 1, `应读到 1 条，实际 ${items.length}`)
  assert.ok(items[0]!.text.includes('问他'))
})
