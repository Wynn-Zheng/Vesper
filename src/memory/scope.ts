import type { Incoming, Target } from '../core/types.ts'
import { findPersonByAccount, personIdOf, type Platform } from '../people/store.ts'
import type { Scope } from './types.ts'

/** 会话作用域：私聊按人，群聊按群 */
export function scopeOf(t: Target): Scope {
  return (t.kind === 'private' ? `private:${t.id}` : `group:${t.id}`) as Scope
}

/**
 * 这条消息背后的人。群聊时是发言人。
 * 先查有没有已绑定这个账号的人（微信和 QQ 是同一个人时，不能各算一份），
 * 查不到才用「平台-账号」新建。
 */
export function personOfMessage(m: Incoming, platform: Platform = 'qq'): string {
  const account = m.senderId || (m.from.kind === 'private' ? m.from.id : '')
  if (!account) return personIdOf(platform, 'unknown')
  const known = findPersonByAccount(platform, account)
  return known ? known.id : personIdOf(platform, account)
}
