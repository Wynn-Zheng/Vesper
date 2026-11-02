import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'
import { writeAtomic } from '../store/fs.ts'
import { warnAt } from './log.ts'
export interface AccessPolicy {
  /**
   * 群聊总开关。
   *
   * 以前这个开关只在 .env 的 ALLOW_GROUP 里，控制台改不到 ——
   * 而桌面版生成的 .env 又没有这一项（缺省 false），
   * 结果就是「装好、连上 NapCat、群里 @ 它，一条都不回」，
   * 日志里写「群聊总开关没开（.env 里 ALLOW_GROUP 不是 true）」，
   * 但界面上根本没有能打开它的地方。现在收到这里，控制台可改。
   */
  allowGroup: boolean
  /** 群白名单：为空表示不限制 */
  groupAllow: string[]
  /** 群黑名单：永远不理 */
  groupDeny: string[]
  /** 成员白名单：为空表示不限制 */
  memberAllow: string[]
  /** 成员黑名单：永远不理 */
  memberDeny: string[]
  /** 群里是否必须 @ 它 */
  requireAt: boolean
}

const FILE = 'persona/access.yaml'

const EMPTY: AccessPolicy = {
  allowGroup: false,
  groupAllow: [],
  groupDeny: [],
  memberAllow: [],
  memberDeny: [],
  requireAt: true,
}

function split(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 从 .env 推一份初始策略：第一次运行时用 */
function fromEnv(): AccessPolicy {
  return {
    // .env 写了就听它的；没写则默认开 —— 这个程序装出来就是为了在群里用的，
    // 默认关掉等于装完什么都不会发生，而界面上又没有别的地方能打开。
    // requireAt 默认 true 已经兜住了"乱插话"，所以默认开不会吵。
    allowGroup: process.env['ALLOW_GROUP'] === undefined ? true : process.env['ALLOW_GROUP'].toLowerCase() === 'true',
    groupAllow: split(process.env['GROUP_ALLOW']),
    groupDeny: [],
    memberAllow: split(process.env['MEMBER_ALLOW']),
    memberDeny: [],
    requireAt: (process.env['GROUP_REQUIRE_AT'] ?? 'true').toLowerCase() !== 'false',
  }
}

export function accessFile(): string {
  return FILE
}

/**
 * 读权限策略。
 * 文件不在就用 .env 生成一份——第一次运行后，控制台改的就是这个文件，不再碰 .env。
 */
export function loadAccess(file: string = FILE): AccessPolicy {
  if (!existsSync(file)) {
    const initial = fromEnv()
    saveAccess(initial, file)
    return initial
  }
  try {
    const raw = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    const group = (raw['群'] ?? {}) as Record<string, unknown>
    const member = (raw['成员'] ?? {}) as Record<string, unknown>
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []
    return {
      // 老文件没有「开启」这一项：退回 .env 的值，.env 也没有就默认开
      allowGroup:
        typeof group['开启'] === 'boolean'
          ? group['开启']
          : process.env['ALLOW_GROUP'] === undefined
            ? true
            : process.env['ALLOW_GROUP'].toLowerCase() === 'true',
      groupAllow: list(group['白名单']),
      groupDeny: list(group['黑名单']),
      memberAllow: list(member['白名单']),
      memberDeny: list(member['黑名单']),
      requireAt: member['必须at'] !== false,
    }
  } catch (err) {
    // 解析失败不能当"没有策略"：那等于黑名单/白名单全部失效，
    // 群里任何人 @ 它都会回。保守做法是拒绝所有群响应，并喊一声。
    warnAt('access.yaml 解析失败，暂时拒绝所有群消息（请检查/修好这个文件）', {
      err: String(err).slice(0, 200),
    })
    return { ...EMPTY, groupDeny: ['*'] }
  }
}

export function saveAccess(p: AccessPolicy, file: string = FILE): void {
  const doc = {
    群: { 开启: p.allowGroup, 白名单: p.groupAllow, 黑名单: p.groupDeny },
    成员: { 白名单: p.memberAllow, 黑名单: p.memberDeny, 必须at: p.requireAt },
  }
  writeAtomic(file, `${YAML.stringify(doc)}\n`)
}

export interface AccessResult {
  ok: boolean
  /** 被挡的原因，给日志用 */
  reason?: '群黑名单' | '成员黑名单' | '不在群白名单' | '不在成员白名单'
}

/** 黑名单优先于白名单；白名单为空表示不限制 */
export function checkAccess(p: AccessPolicy, groupId: string, userId: string): AccessResult {
  // '*' 是 access.yaml 解析失败时的"全拒"哨兵（见 loadAccess 的 catch）。
  // 不加这行的话它会落到下面的白名单判断，而白名单为空 = 不限制 ——
  // 结果就是配置文件坏了反而全放行，和日志里那句"暂时拒绝所有群消息"正好相反。
  if (p.groupDeny.includes('*')) return { ok: false, reason: '群黑名单' }
  if (p.groupDeny.includes(groupId)) return { ok: false, reason: '群黑名单' }
  if (p.memberDeny.includes(userId)) return { ok: false, reason: '成员黑名单' }
  if (p.groupAllow.length && !p.groupAllow.includes(groupId)) return { ok: false, reason: '不在群白名单' }
  if (p.memberAllow.length && !p.memberAllow.includes(userId)) return { ok: false, reason: '不在成员白名单' }
  return { ok: true }
}
