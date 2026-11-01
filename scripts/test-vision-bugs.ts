/**
 * 看图模块的边界体检。
 *
 * 不打外网、不调真模型：把 globalThis.fetch 换成一个桩，
 * 想让它返回什么就返回什么。这样每次跑的结果都稳定。
 *
 * 覆盖：
 * 1. 地址立刻被拒 → toDataUrl 返回 null，不抛错
 * 2. content-type 是 text/html → 返回 null
 * 3. 超过 5MB → 拒掉（Content-Length 声明和实际响应体两条路都测）
 * 4. 模型返回空字符串 → 那一条不进结果
 * 5. 一张失败 → 下一张照常处理
 * 6. renderImages 的 0 条和 3 条
 */
import { initLog } from '../src/core/log.ts'
import { describeImages, renderImages, toDataUrl } from '../src/llm/vision.ts'

initLog('', false)

const MB = 1024 * 1024
const LIMIT = 5 * MB

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

const opts = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  model: 'vision-test',
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response

const realFetch = globalThis.fetch
let handler: FetchHandler = () => {
  throw new Error('测试没有设置 fetch 桩')
}

globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return handler(url, init)
}) as typeof fetch

function imageResponse(
  body: NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>,
  type = 'image/png',
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': type, ...headers },
  })
}

function modelReply(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

const b64 = (s: string): string => Buffer.from(s).toString('base64')
const isChat = (url: string): boolean => url.includes('/chat/completions')

try {
  /* ---------- 1. 立刻被拒的地址 ---------- */
  console.log('=== 1. 地址立刻被拒 ===')
  {
    handler = () => {
      throw new TypeError('fetch failed')
    }

    let threw = false
    let got: string | null = 'not-called'
    try {
      got = await toDataUrl('https://reject.test/a.jpg')
    } catch {
      threw = true
    }
    check('立刻拒绝：不抛错', !threw)
    check('立刻拒绝：返回 null', got === null, String(got).slice(0, 40))

    let notes: Awaited<ReturnType<typeof describeImages>> = []
    let batchThrew = false
    try {
      notes = await describeImages(['https://reject.test/a.jpg'], opts)
    } catch {
      batchThrew = true
    }
    check('立刻拒绝：整批不抛错', !batchThrew)
    check('立刻拒绝：整批返回空', notes.length === 0, JSON.stringify(notes))
  }

  /* ---------- 2. content-type 不是图片 ---------- */
  console.log('\n=== 2. 非图片 content-type ===')
  {
    handler = () => imageResponse('<html><body>404</body></html>', 'text/html; charset=utf-8')
    const got = await toDataUrl('https://img.test/page.html')
    check('text/html 返回 null', got === null, String(got).slice(0, 40))

    // 顺便守一下大小写：服务器返回 IMAGE/PNG 也该认
    handler = () => imageResponse(Buffer.from('fake-png'), 'IMAGE/PNG')
    const upper = await toDataUrl('https://img.test/upper.png')
    check(
      'content-type 大小写不敏感',
      upper?.startsWith('data:image/png;base64,') === true,
      String(upper).slice(0, 40),
    )
  }

  /* ---------- 3. 超过 5MB ---------- */
  console.log('\n=== 3. 超过 5MB ===')
  {
    // 只声明长度，不真的读 body：应该在看 body 之前就拒掉
    handler = () =>
      ({
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
          'content-length': String(LIMIT + 1),
        }),
      }) as unknown as Response
    const declared = await toDataUrl('https://img.test/declared-huge.jpg')
    check('Content-Length 声明超过 5MB：返回 null', declared === null, String(declared).slice(0, 40))

    // 没有 Content-Length 或它撒谎时，边读边数也要拦住
    handler = () => imageResponse(Buffer.alloc(LIMIT + 1, 0x41), 'image/jpeg')
    const actual = await toDataUrl('https://img.test/actual-huge.jpg')
    check('实际响应体超过 5MB：返回 null', actual === null, String(actual).slice(0, 40))
  }

  /* ---------- 4. 模型返回空字符串 ---------- */
  console.log('\n=== 4. 模型返回空字符串 ===')
  {
    handler = (url) => {
      if (url === 'https://img.test/empty.jpg') return imageResponse(Buffer.from('EMPTY-IMAGE'))
      if (isChat(url)) return modelReply('')
      throw new TypeError(`意外的地址：${url}`)
    }

    // chat() 会把空内容当可重试错误，重试两次后才放弃，这里会多花约 2 秒
    const notes = await describeImages(['https://img.test/empty.jpg'], opts)
    check('空字符串那条不进结果', notes.length === 0, JSON.stringify(notes))

    // 再单独测 vision 自己的过滤：带 tool_call 时 chat() 不会重试，
    // 会正常返回 text: '   '，用来确认空白描述不会写进结果。
    handler = (url) => {
      if (url === 'https://img.test/blank.jpg') return imageResponse(Buffer.from('BLANK-IMAGE'))
      if (isChat(url)) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '   ',
                  tool_calls: [{ id: 'call-1', function: { name: 'noop', arguments: '{}' } }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new TypeError(`意外的地址：${url}`)
    }

    const blank = await describeImages(['https://img.test/blank.jpg'], opts)
    check('空白描述不写进结果（过滤逻辑）', blank.length === 0, JSON.stringify(blank))
  }

  /* ---------- 5. 一张失败不影响下一张 ---------- */
  console.log('\n=== 5. 一张失败不影响下一张 ===')
  {
    // 5a. 第一张下载就失败
    handler = (url) => {
      if (url === 'https://img.test/broken.jpg') throw new TypeError('fetch failed')
      if (url === 'https://img.test/good.jpg') return imageResponse(Buffer.from('GOOD-IMAGE'))
      if (isChat(url)) return modelReply('一张正常的测试图')
      throw new TypeError(`意外的地址：${url}`)
    }

    const notes = await describeImages(
      ['https://img.test/broken.jpg', 'https://img.test/good.jpg'],
      opts,
    )
    check('下载失败后下一张照常识别', notes.length === 1, JSON.stringify(notes))
    check('留下的是第二张', notes[0]?.url === 'https://img.test/good.jpg', JSON.stringify(notes))

    // 5b. 第一张下载成功，但模型调用失败（400 不重试，立刻抛）
    handler = (url, init) => {
      if (url === 'https://img.test/model-fail.jpg') return imageResponse(Buffer.from('MODEL-FAIL'))
      if (url === 'https://img.test/model-ok.jpg') return imageResponse(Buffer.from('MODEL-OK'))
      if (isChat(url)) {
        const body = String(init?.body ?? '')
        if (body.includes(b64('MODEL-FAIL'))) {
          return new Response('bad request', { status: 400 })
        }
        return modelReply('第二张识别成功')
      }
      throw new TypeError(`意外的地址：${url}`)
    }

    const notes2 = await describeImages(
      ['https://img.test/model-fail.jpg', 'https://img.test/model-ok.jpg'],
      opts,
    )
    check('模型失败后下一张照常识别', notes2.length === 1, JSON.stringify(notes2))
    check('留下的是第二张（模型失败）', notes2[0]?.url === 'https://img.test/model-ok.jpg', JSON.stringify(notes2))
  }

  /* ---------- 6. renderImages 的 0 条和 3 条 ---------- */
  console.log('\n=== 6. renderImages ===')
  {
    check('0 条返回空串', renderImages([]) === '')

    const three = [
      { url: 'a', text: '一张猫的照片' },
      { url: 'b', text: '一个聊天截图，写着 hello' },
      { url: 'c', text: '一张嘲讽表情包' },
    ]
    const text = renderImages(three)
    check('3 条标了 3 张', text.includes('3 张'), text)
    check('3 条都渲染了', three.every((n) => text.includes(n.text)), text)
    check(
      '3 条编号是 1/2/3',
      ['1. ', '2. ', '3. '].every((p) => text.includes(p)),
      text,
    )
    check('3 条是 1 行标题 + 3 行内容', text.split('\n').length === 4, String(text.split('\n').length))
  }
} finally {
  globalThis.fetch = realFetch
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
