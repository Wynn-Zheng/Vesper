/**
 * 控制台新接口的边界测试。
 *
 * 打的是**真实运行的服务**（http://127.0.0.1:7788），不是 mock：
 *   mock 测不出"路由挂没挂上""token 校验顺序对不对"这类问题。
 *
 * 覆盖：空参数 / 坏参数（路径穿越、超长、非数字）/ 不存在的人 / 未签名请求。
 */
const BASE = 'http://127.0.0.1:7788'
const TOKEN = process.env['CONSOLE_TOKEN'] ?? 'REDACTED'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(`${name}  ${detail}`)
    console.log(`  ✗ ${name}  ${detail}`)
  }
}

/** 带 token 的请求 */
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: res.status, body: await res.text() }
}

async function main(): Promise<void> {
  /* ============ 0. 服务活着吗 ============ */
  console.log('=== 0. 服务可达 ===')
  {
    const r = await api('/api/status')
    check('GET /api/status 200', r.status === 200, `实际 ${r.status}`)
  }

  /* ============ 1. 未签名请求全部 401 ============ */
  console.log('\n=== 1. 未签名 → 401 ===')
  for (const p of [
    '/api/member/table',
    '/api/settings/data',
    '/api/settings/model',
    '/api/settings/about',
    '/api/test/tools',
    '/api/ability',
    '/api/health',
    '/api/napcat',
    '/api/balance',
  ]) {
    const res = await fetch(BASE + p)
    check(`${p} 无 token → 401`, res.status === 401, `实际 ${res.status}`)
  }

  /* ============ 2. 静态文件不需要 token（但只给 js/css） ============ */
  console.log('\n=== 2. 静态文件 ===')
  {
    const res = await fetch(BASE + '/members.js')
    check('/members.js 无 token → 200', res.status === 200, `实际 ${res.status}`)
    check('Content-Type 是 js', (res.headers.get('content-type') ?? '').includes('javascript'), '')
  }
  {
    // 目录穿越：用编码过的 .. 试
    for (const evil of ['/..%2fpackage.json', '/%2e%2e/package.json', '/../src/index.ts']) {
      const res = await fetch(BASE + evil)
      check(`穿越 ${evil} 被拒`, res.status !== 200, `实际 ${res.status}`)
    }
  }

  /* ============ 3. member ============ */
  console.log('\n=== 3. member ===')
  {
    const r = await api('/api/member/table')
    check('GET /api/member/table 200', r.status === 200, `${r.status}`)
    try {
      const j = JSON.parse(r.body) as { rows?: unknown[]; nameless?: unknown[] }
      check('有 rows 字段', Array.isArray(j.rows), '')
      check('有 nameless 字段', Array.isArray(j.nameless), '')
    } catch {
      check('返回是合法 JSON', false, '解析失败')
    }
  }
  {
    // 空 id
    const r = await api('/api/member/chat?id=')
    check('chat 空 id → 4xx', r.status >= 400 && r.status < 500, `${r.status}`)
  }
  {
    // 不存在的人
    const r = await api('/api/member/chat?id=qq-99999999999')
    check('chat 不存在的人 → 404', r.status === 404, `${r.status}`)
  }
  {
    // 坏 id（注入尝试）
    const r = await api('/api/member/chat?id=' + encodeURIComponent("qq-1' OR '1'='1"))
    check('chat 坏 id 不崩', r.status >= 400 && r.status < 500, `${r.status}`)
  }
  {
    // 超长 id
    const r = await api('/api/member/chat?id=' + 'x'.repeat(5000))
    check('chat 超长 id 不崩', r.status >= 400 && r.status < 500, `${r.status}`)
  }
  {
    // 数字 limit
    const r = await api('/api/member/chat?id=qq-1234567890&limit=abc')
    check('chat limit=abc 不崩', r.status === 200 || r.status === 400, `${r.status}`)
  }
  {
    // 负数 limit
    const r = await api('/api/member/chat?id=qq-1234567890&limit=-5')
    check('chat limit=-5 不崩', r.status === 200 || r.status === 400, `${r.status}`)
  }
  {
    // block 空 body
    const r = await api('/api/member/block', { method: 'PUT', body: '{}' })
    check('block 空 body → 400', r.status === 400, `${r.status}`)
  }
  {
    // block 坏 id
    const r = await api('/api/member/block', { method: 'PUT', body: JSON.stringify({ id: '../etc/passwd', blocked: true }) })
    check('block 路径穿越 id → 400', r.status === 400, `${r.status}`)
  }

  /* ============ 4. settings ============ */
  console.log('\n=== 4. settings ===')
  for (const p of ['/api/settings/data', '/api/settings/model', '/api/settings/about']) {
    const r = await api(p)
    check(`GET ${p} 200`, r.status === 200, `${r.status}`)
    check(`${p} 返回 JSON`, (() => { try { JSON.parse(r.body); return true } catch { return false } })(), '')
  }
  {
    // 模型接口不能泄露完整 key
    const r = await api('/api/settings/model')
    const j = JSON.parse(r.body) as { apiKey?: string }
    const key = j.apiKey ?? ''
    check('apiKey 被脱敏（不是完整 32+ 字符）', !key || key.length < 20, `长度 ${key.length}`)
    check('apiKey 含省略号或有掩码', !key || key.includes('…') || key.includes('*'), key)
  }

  /* ============ 5. test ============ */
  console.log('\n=== 5. test ===')
  {
    const r = await api('/api/test/tools')
    check('GET /api/test/tools 200', r.status === 200, `${r.status}`)
    try {
      const j = JSON.parse(r.body) as { tools?: unknown[] }
      check(`工具清单有 ${j.tools?.length ?? 0} 个`, (j.tools?.length ?? 0) > 0, '')
    } catch {
      check('tools 返回 JSON', false, '')
    }
  }
  {
    // 空 id
    const r = await api('/api/test/tool', { method: 'POST', body: '{}' })
    check('tool 空 id 不崩', r.status === 200, `${r.status}`)
    try {
      const j = JSON.parse(r.body) as { ok?: boolean; detail?: string }
      check('tool 空 id 返回 ok=false', j.ok === false, JSON.stringify(j))
    } catch {
      check('tool 返回 JSON', false, '')
    }
  }
  {
    // 不存在的工具
    const r = await api('/api/test/tool', { method: 'POST', body: JSON.stringify({ id: 'nonexistent' }) })
    check('tool 不存在的 id 不崩', r.status === 200, `${r.status}`)
  }
  {
    // recall 空 query
    const r = await api('/api/test/recall', { method: 'POST', body: '{}' })
    check('recall 空 body 不崩', r.status === 200, `${r.status}`)
    try {
      const j = JSON.parse(r.body) as { ok?: boolean }
      check('recall 空 query 仍 ok', j.ok === true || j.ok === false, '')
    } catch {
      check('recall 返回 JSON', false, '')
    }
  }
  {
    // recall 坏 personId
    const r = await api('/api/test/recall', {
      method: 'POST',
      body: JSON.stringify({ query: '测试', personId: "qq-1' OR '1'='1" }),
    })
    check('recall 坏 personId 不崩', r.status === 200, `${r.status}`)
  }
  {
    // recall 超长 query
    const r = await api('/api/test/recall', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(100000) }),
    })
    check('recall 10 万字符 query 不崩', r.status === 200 || r.status === 413, `${r.status}`)
  }

  /* ============ 6. ability ============ */
  console.log('\n=== 6. ability ===')
  {
    const r = await api('/api/ability')
    check('GET /api/ability 200', r.status === 200, `${r.status}`)
    try {
      const j = JSON.parse(r.body) as { cards?: Array<{ id: string; group: string }> }
      check(`卡片有 ${j.cards?.length ?? 0} 张`, (j.cards?.length ?? 0) >= 10, '')
      check('有 3 个分组', new Set((j.cards ?? []).map((c) => c.group)).size === 3, '')
    } catch {
      check('ability 返回 JSON', false, '')
    }
  }
  {
    // toggle 空 id
    const r = await api('/api/ability/toggle', { method: 'PUT', body: '{}' })
    check('toggle 空 id → 404', r.status === 404, `${r.status}`)
  }
  {
    // toggle 不存在的 id
    const r = await api('/api/ability/toggle', { method: 'PUT', body: JSON.stringify({ id: 'nope', on: true }) })
    check('toggle 不存在的 id → 404', r.status === 404, `${r.status}`)
  }
  {
    // toggle 恒开的能力（chat 没有 toggleKey）
    const r = await api('/api/ability/toggle', { method: 'PUT', body: JSON.stringify({ id: 'chat', on: false }) })
    check('toggle 恒开的能力 → 400', r.status === 400, `${r.status}`)
  }
  {
    // param 空 key
    const r = await api('/api/ability/param', { method: 'PUT', body: '{}' })
    check('param 空 key → 400', r.status === 400, `${r.status}`)
  }
  {
    // param 不存在的 key
    const r = await api('/api/ability/param', { method: 'PUT', body: JSON.stringify({ key: '不存在.的.键', value: 1 }) })
    check('param 不存在的 key → 400', r.status === 400, `${r.status}`)
  }

  /* ============ 7. 坏 JSON 不崩 ============ */
  console.log('\n=== 7. 坏 JSON ===')
  for (const p of ['/api/member/block', '/api/test/tool', '/api/test/recall']) {
    const r = await api(p, { method: p === '/api/member/block' ? 'PUT' : 'POST', body: '{坏 json' })
    // 允许 400（我们自己挡）或 500（没挡住），但不能是连接断掉
    check(`${p} 坏 JSON 有响应`, r.status >= 400 && r.status < 600, `${r.status}`)
  }

  /* ============ 8. 服务还活着（前面折腾完没崩） ============ */
  console.log('\n=== 8. 服务健在 ===')
  {
    const r = await api('/api/status')
    check('一轮边界测试后服务仍 200', r.status === 200, `${r.status}`)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (failures.length) {
    console.log('\n失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('测试本身崩了：', e)
  process.exit(1)
})

// 显式标记为模块：否则 TS 会把顶层 let/const 当全局变量，与其它脚本互相冲突
// （报 TS2451 重复声明 / TS1375 顶层 await），加这一行就没有歧义了。
export {}
