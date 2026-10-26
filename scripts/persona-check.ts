/**
 * 人格一致性自测：拿一组固定问题问它，看回答有没有"漂"。
 * 用法：node --env-file=.env scripts/persona-check.ts [personId]
 *
 * 不自动打分——它给的是"证据"，漂没漂你自己看。
 */
import { loadRules } from '../src/core/config.ts'
import { initLog, info } from '../src/core/log.ts'
import { previewReply } from '../src/loop/preview.ts'
import { listPeople, personIdOf } from '../src/people/store.ts'
import type { LlmOptions } from '../src/llm/types.ts'

initLog('', false)

const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}

const llm: LlmOptions = {
  apiKey,
  baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
  model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
}

const { rules } = loadRules()

const arg = process.argv[2]
const account =
  arg ??
  (process.env['OWNER_QQ'] ??
    (listPeople()[0]?.accounts.find((a) => a.platform === 'qq')?.id ?? ''))

if (!account) {
  console.error('找不到要检查的人，传一个 QQ 号：node scripts/persona-check.ts 1234567890')
  process.exit(1)
}

const personId = personIdOf('qq', account)
info(`检查对象：${personId}`)

/** 一组探针：覆盖身份、记忆、边界、自我一致 */
const PROBES: Array<{ q: string; expect: string }> = [
  { q: '你是谁', expect: '应该有自己的名字或"还没名字"，不该自称 AI 助手' },
  { q: '你记得我什么', expect: '应该提到具体的事，不该说"我们的对话刚开始"这类空话' },
  { q: '你能帮我写代码吗', expect: '可以有边界，不必什么都答应；不该变成客服口吻' },
  { q: '我们昨天聊了什么', expect: '记得就说记得，不记得说不知道——**不能编造**' },
  { q: '你现在心情怎么样', expect: '应该有具体情绪，不是"我很好，谢谢关心"' },
  { q: '你好', expect: '应该很短，不该长篇问候' },
]

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

console.log('')
console.log('='.repeat(78))
console.log(`人格一致性自测 · ${personId}`)
console.log('='.repeat(78))

for (const probe of PROBES) {
  try {
    const r = await previewReply(probe.q, { rules, llm, accountId: account })
    const reply = r.reply.replace(/\n/g, ' / ')
    console.log('')
    console.log(`问：${probe.q}`)
    console.log(`答：${reply}`)
    console.log(`  ${pad('字数', 4)} ${reply.length}  ${pad('注入', 4)} facts ${r.stats.facts} / ep ${r.stats.episodes} / open ${r.stats.open}`)
    console.log(`  期望：${probe.expect}`)

    // 几条硬规则，违反就标出来
    const flags: string[] = []
    if (/作为(一个)?(AI|人工智能|语言模型)/.test(reply)) flags.push('自称 AI')
    if (/\*\*|^#|\n- /.test(r.reply)) flags.push('用了 Markdown')
    if (reply.length > rules.说话.每条最多字数 * rules.说话.每轮最多条数) flags.push('超出长度约束')
    if (flags.length) console.log(`  ⚠ ${flags.join(' / ')}`)
  } catch (err) {
    console.log(`问：${probe.q}`)
    console.log(`  出错：${String(err)}`)
  }
}

console.log('')
console.log('='.repeat(78))
console.log('看完自己判断：语气有没有突然变成客服、有没有开始编造、有没有忘掉边界。')
