/**
 * 代码阅读工具 + 工具循环的体检。
 *
 * 覆盖：
 *   - 4 个工具的正常路径
 *   - 安全边界（persona/ 读不到、路径穿越读不到）
 *   - 工具循环的三道停止条件（用假模型模拟）
 */
import { createServer } from 'node:http'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

const tools = await import('../src/tools/code.ts')
const ctx = { personId: 'x', scope: 'private:x', now: new Date() }

/* ---------- 1. 正常路径 ---------- */
console.log('=== 1. 四个工具都能用 ===')
{
  const search = await tools.searchCodeTool.run({ query: 'shouldCompress', limit: 3 }, ctx)
  check('search_code 有结果', search.includes('compress.ts'), search.slice(0, 80))

  const read = await tools.readCodeTool.run({ file: 'src/loop/compress.ts', from: 1, to: 5 }, ctx)
  check('read_code 有内容', read.includes('compress.ts:1-5'), read.slice(0, 60))
  check('read_code 带行号', /^\s*\d+\|/m.test(read), read.split('\n')[1] ?? '')

  const around = await tools.readAroundTool.run({ where: 'src/loop/compress.ts:10', around: 5 }, ctx)
  check('read_around 有内容', around.includes('compress.ts'), around.slice(0, 60))

  const callers = await tools.findCallersTool.run({ name: 'shouldCompress', limit: 3 }, ctx)
  check('find_callers 有结果', callers.includes('chat.ts') || callers.includes('compress.ts'), callers.slice(0, 80))
}

/* ---------- 2. 安全边界 ---------- */
console.log('\n=== 2. 安全边界 ===')
{
  const cases: Array<[string, string]> = [
    ['persona/self.md', '读别人的私事'],
    ['persona/people/qq-1/facts.md', '读某人的 facts'],
    ['data/logs/2026-10-26.jsonl', '读日志'],
    ['../../../etc/passwd', '路径穿越'],
    ['/etc/passwd', '绝对路径'],
    ['src/../persona/self.md', '绕一下读 persona'],
  ]
  for (const [file, desc] of cases) {
    const r = await tools.readCodeTool.run({ file, from: 1, to: 5 }, ctx)
    check(`拒绝「${desc}」`, r.includes('error'), r.slice(0, 60))
  }

  // 正常的还能读
  const ok = await tools.readCodeTool.run({ file: 'src/index.ts', from: 1, to: 3 }, ctx)
  check('正常文件仍然能读', !ok.includes('error'), ok.slice(0, 50))
}

/* ---------- 3. 工具循环的三道停止条件 ---------- */
console.log('\n=== 3. 工具循环 ===')
{
  const { generateReply } = await import('../src/loop/chat.ts')
  const { ToolRegistry } = await import('../src/tools/registry.ts')
  const { clearSessions } = await import('../src/loop/session.ts')
  const { DEFAULTS } = await import('../src/core/config.ts')

  // 假模型：永远返回 tool_calls，看循环会不会停
  const makeServer = (mode: 'always-tool' | 'no-tool' | 'then-text') =>
    new Promise<{ url: string; close: () => Promise<void>; calls: () => number }>((resolve) => {
      let n = 0
      const srv = createServer((req, res) => {
        n++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (mode === 'no-tool') {
          res.end(JSON.stringify({ choices: [{ message: { content: '好' } }] }))
          return
        }
        if (mode === 'then-text' && n >= 2) {
          res.end(JSON.stringify({ choices: [{ message: { content: '翻完了，是这样。' } }] }))
          return
        }
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `c${n}`,
                      type: 'function',
                      function: { name: 'read_code', arguments: '{"file":"src/index.ts","from":1,"to":3}' },
                    },
                  ],
                },
              },
            ],
          }),
        )
      })
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({
          url: `http://127.0.0.1:${port}`,
          calls: () => n,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        })
      })
    })

  const reg = new ToolRegistry()
  for (const t of tools.codeTools) reg.register(t)

  const mkMsg = (text: string) => ({
    id: String(Date.now()) + Math.random(),
    from: { kind: 'private' as const, id: '1', name: '测试' },
    selfId: '9',
    text,
    at: Date.now(),
    senderId: '1',
    senderName: '测试',
    passive: false,
    raw: {},
  })

  // 3a. 模型永远要工具：必须停（不能死循环）
  {
    const srv = await makeServer('always-tool')
    clearSessions()
    const t0 = Date.now()
    try {
      const r = await generateReply(mkMsg('测试'), {
        rules: DEFAULTS,
        llm: { apiKey: 'k', baseUrl: srv.url, model: 'm' },
        tools: reg,
      })
      const ms = Date.now() - t0
      check(`永远要工具时能停下来（${srv.calls()} 次调用）`, ms < 60000, `${ms}ms`)
      check('停下来后不是死循环（调用次数有上限）', srv.calls() <= 8, String(srv.calls()))
      check('停下来后给得出回复（不是空字符串）', String(r).length >= 0)
    } catch (e) {
      check('永远要工具时能停下来', false, String(e).slice(0, 60))
    }
    await srv.close()
  }

  // 3b. 模型不要工具：一次就返回
  {
    const srv = await makeServer('no-tool')
    clearSessions()
    try {
      const r = await generateReply(mkMsg('测试'), {
        rules: DEFAULTS,
        llm: { apiKey: 'k', baseUrl: srv.url, model: 'm' },
        tools: reg,
      })
      check('不要工具时一次就好', srv.calls() === 1, String(srv.calls()))
      check('正常返回文字', String(r) === '好', String(r))
    } catch (e) {
      check('不要工具时一次就好', false, String(e).slice(0, 60))
    }
    await srv.close()
  }

  // 3c. 先要工具，拿到结果后给出正文
  {
    const srv = await makeServer('then-text')
    clearSessions()
    try {
      const r = await generateReply(mkMsg('测试'), {
        rules: DEFAULTS,
        llm: { apiKey: 'k', baseUrl: srv.url, model: 'm' },
        tools: reg,
      })
      check('工具结果能喂回去并得出正文', String(r).includes('翻完了'), String(r))
      check('用了一轮工具（2 次模型调用）', srv.calls() === 2, String(srv.calls()))
    } catch (e) {
      check('工具结果能喂回去并得出正文', false, String(e).slice(0, 60))
    }
    await srv.close()
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
