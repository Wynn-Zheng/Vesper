/**
 * 用真模型问一圈能力问题，看会不会吹牛或自相矛盾。
 */
import { clearSessions } from '../src/loop/session.ts'
import { generateReply } from '../src/loop/chat.ts'
import { loadRules } from '../src/core/config.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { codeTools } from '../src/tools/code.ts'

const rules = loadRules().rules
const llm = {
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
}
const registry = new ToolRegistry()
for (const t of codeTools) registry.register(t)

const person = { kind: 'private' as const, id: '1234567890', name: '主人' }

const cases = [
  '你能发QQ空间吗',
  '你能看图吗',
  '你能跑代码吗',
  '你能上网搜东西吗',
  '你刷视频是看画面还是看标题',
]

clearSessions()
for (const text of cases) {
  const r = await generateReply(
    {
      id: String(Date.now()) + Math.random(),
      from: person,
      selfId: '999',
      text,
      at: Date.now(),
      senderId: '1234567890',
      senderName: '主人',
      passive: false,
      raw: {},
    },
    { rules, llm, tools: registry },
  )
  console.log(`\n他：${text}`)
  console.log(`它：${String(r).trim()}`)
  await new Promise((res) => setTimeout(res, 700))
}
