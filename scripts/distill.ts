/**
 * 手动整理一次记忆：把最近一天的原文压成 episode / facts / open / insights。
 * 用法：
 *   node --env-file=.env scripts/distill.ts            # 整理今天
 *   node --env-file=.env scripts/distill.ts 2026-10-24 # 整理指定日期
 */
import { loadRules } from '../src/core/config.ts'
import { info, initLog, warn } from '../src/core/log.ts'
import { distill } from '../src/memory/distill.ts'
import { readRaw, today } from '../src/memory/store.ts'
import { personIdOf, personOfAccount } from '../src/people/store.ts'
import type { RawTurn, Scope } from '../src/memory/types.ts'
import type { LlmOptions } from '../src/llm/types.ts'

initLog()

const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY，无法整理。')
  process.exit(1)
}

const llm: LlmOptions = {
  apiKey,
  baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
  model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
}

const { rules, warnings } = loadRules()
for (const w of warnings) warn(w)

const date = process.argv[2] ?? today()
const turns = readRaw(date)

if (!turns.length) {
  info(`${date} 没有对话记录，不用整理`)
  process.exit(0)
}

// 按 scope 分组，分别整理（群聊和私聊不能混成一段经历）
const byScope = new Map<Scope, RawTurn[]>()
for (const t of turns) {
  const list = byScope.get(t.scope) ?? []
  list.push(t)
  byScope.set(t.scope, list)
}

info(`准备整理 ${date}：${turns.length} 条，${byScope.size} 个会话`)

for (const [scope, list] of byScope) {
  info(`整理 ${scope}（${list.length} 条）`)
  // 和定时整理一样：人从 scope 推（群聊没有具体的人，用一个占位 id）
  const personId = scope.startsWith('private:')
    ? personOfAccount('qq', scope.slice('private:'.length))
    : personIdOf('qq', 'group')
  const r = await distill({ personId, scope, turns: list, llm, rules })
  info(`  → episode ${r.episodes} / fact ${r.facts} / open ${r.open} / insight ${r.insights}`)
  if (!r.ok) warn(`  ${scope} 整理失败：模型调用或解析出错，这批下次重试`)
}

info('完成')
