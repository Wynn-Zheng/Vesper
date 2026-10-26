/**
 * 模型客户端体检。
 *
 * 全部用假 baseUrl / 本地假服务，不真调 DeepSeek。
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

const deepseek = await import('../src/llm/deepseek.ts')

/* ---------- 1. 配置缺失时的错要能看懂 ---------- */
console.log('=== 1. 配置缺失 ===')
{
  const base = { apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'm' }
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['缺 apiKey', { ...base, apiKey: '' }, /apiKey/],
    ['缺 baseUrl', { ...base, baseUrl: '' }, /baseUrl/],
    ['缺 model', { ...base, model: '' }, /model/],
  ]
  for (const [name, cfg, re] of cases) {
    try {
      await deepseek.chat([{ role: 'user', content: 'x' }], cfg)
      check(name, false, '没抛错')
    } catch (e) {
      const msg = String((e as Error).message)
      check(`${name} 错误信息提到字段`, re.test(msg), msg.slice(0, 60))
    }
  }
}

/* ---------- 2. 重试与错误分类（本地假服务）---------- */
console.log('\n=== 2. 重试与错误分类 ===')
{
  // 记录请求次数，按预设状态码应答
  const makeServer = (
    handler: (n: number) => { status: number; body: string },
  ): Promise<{ url: string; count: () => number; close: () => Promise<void> }> => {
    return new Promise((resolve) => {
      let n = 0
      const srv = createServer((req, res) => {
        n++
        const { status, body } = handler(n)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(body)
      })
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({
          url: `http://127.0.0.1:${port}`,
          count: () => n,
          close: () =>
            new Promise<void>((r) => {
              srv.close(() => r())
            }),
        })
      })
    })
  }

  const okBody = JSON.stringify({
    choices: [{ message: { content: '好的' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })

  // 2a. 429 会重试
  {
    const s = await makeServer((n) => (n < 2 ? { status: 429, body: '{"error":"rate"}' } : { status: 200, body: okBody }))
    try {
      const r = await deepseek.chat([{ role: 'user', content: 'x' }], {
        apiKey: 'k',
        baseUrl: s.url,
        model: 'm',
      })
      check(`429 后重试成功（请求 ${s.count()} 次）`, r.text === '好的', r.text)
      check('429 确实重试了（>1 次）', s.count() > 1, String(s.count()))
    } catch (e) {
      check('429 后重试成功', false, String(e).slice(0, 80))
    }
    await s.close()
  }

  // 2b. 5xx 会重试
  {
    const s = await makeServer((n) => (n < 2 ? { status: 500, body: '{"error":"boom"}' } : { status: 200, body: okBody }))
    try {
      const r = await deepseek.chat([{ role: 'user', content: 'x' }], { apiKey: 'k', baseUrl: s.url, model: 'm' })
      check('500 后重试成功', r.text === '好的', r.text)
    } catch (e) {
      check('500 后重试成功', false, String(e).slice(0, 80))
    }
    await s.close()
  }

  // 2c. 400 不重试（只请求一次）
  {
    const s = await makeServer(() => ({ status: 400, body: '{"error":"bad request"}' }))
    try {
      await deepseek.chat([{ role: 'user', content: 'x' }], { apiKey: 'k', baseUrl: s.url, model: 'm' })
      check('400 抛错', false, '没抛')
    } catch (e) {
      check('400 抛错', true)
      check(`400 不重试（只请求 ${s.count()} 次）`, s.count() === 1, String(s.count()))
      check('400 的错误信息带状态码', /400/.test(String((e as Error).message)), String((e as Error).message).slice(0, 60))
    }
    await s.close()
  }
}

/* ---------- 3. 空内容与 usage 缺失 ---------- */
console.log('\n=== 3. 空内容与 usage 缺失 ===')
{
  const makeServer = (body: string): Promise<{ url: string; close: () => Promise<void> }> =>
    new Promise((resolve) => {
      const srv = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      })
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((r) => {
              srv.close(() => r())
            }),
        })
      })
    })

  // 3a. usage 缺失不崩
  {
    const s = await makeServer(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
    try {
      const r = await deepseek.chat([{ role: 'user', content: 'x' }], { apiKey: 'k', baseUrl: s.url, model: 'm' })
      check('usage 缺失时返回正常', r.text === 'hi')
      check('usage 是 undefined', r.usage === undefined, JSON.stringify(r.usage))
    } catch (e) {
      check('usage 缺失时返回正常', false, String(e).slice(0, 60))
    }
    await s.close()
  }

  // 3b. 有 tool_calls 但 content 为空，不该报错
  {
    const s = await makeServer(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
    )
    try {
      const r = await deepseek.chat([{ role: 'user', content: 'x' }], { apiKey: 'k', baseUrl: s.url, model: 'm' })
      check('toolCalls 存在时 content 为空不报错', Array.isArray(r.toolCalls) && r.toolCalls.length === 1, JSON.stringify(r).slice(0, 100))
    } catch (e) {
      check('toolCalls 存在时 content 为空不报错', false, String(e).slice(0, 80))
    }
    await s.close()
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
