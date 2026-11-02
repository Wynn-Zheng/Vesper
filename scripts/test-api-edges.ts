import { readFileSync } from 'node:fs'
/**
 * 边界测试：故意用坏参数打接口，看会不会崩、会不会写出脏数据。
 */
const BASE = 'http://127.0.0.1:7788'
const TOKEN = envToken()
/** 从 .env 读控制台 token（不依赖环境变量，直接 node 跑也能通） */
function envToken(): string {
  if (process.env.CONSOLE_TOKEN) return process.env.CONSOLE_TOKEN
  try {
    const t = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const m = /^CONSOLE_TOKEN=(.*)$/m.exec(t)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}


const H = { 'x-console-token': TOKEN, 'Content-Type': 'application/json' }
let pass = 0
let fail = 0

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 可能不是 json */
  }
  return { status: res.status, json, text }
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

/* ---------- 记忆编辑的坏参数 ---------- */
{
  const r = await call('PUT', '/api/facts', {})
  check('改事实：不给 text 应该 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('DELETE', '/api/facts', {})
  check('删事实：不给 text 应该 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('DELETE', '/api/facts', { text: '这条根本不存在的事实 xyz' })
  check('删事实：不存在应该返回 deleted:false 而不是报错', r.status === 200 && (r.json as { deleted: boolean }).deleted === false, JSON.stringify(r.json))
}
{
  const r = await call('PUT', '/api/facts', { text: '不存在的', newText: 'x', confidence: 999 })
  check('改事实：confidence 超范围不该崩', r.status === 200 || r.status === 400, `实际 ${r.status}`)
}

/* ---------- 待办 ---------- */
{
  const r = await call('DELETE', '/api/open', {})
  check('删待办：不给 text 应该 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('DELETE', '/api/open', { text: '不存在的待办 xyz' })
  check('删待办：不存在不报错', r.status === 200 && (r.json as { deleted: boolean }).deleted === false)
}

/* ---------- 经历 ---------- */
{
  const r = await call('DELETE', '/api/episode', {})
  check('删经历：缺参数应该 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('DELETE', '/api/episode', { id: '不存在-01', scope: 'shared' })
  check('删经历：不存在不报错', r.status === 200 && (r.json as { deleted: boolean }).deleted === false)
}
{
  const r = await call('DELETE', '/api/episode', { id: '../../etc/passwd', scope: 'shared' })
  check('删经历：路径穿越不该成功', r.status === 200 && (r.json as { deleted: boolean }).deleted === false, JSON.stringify(r.json))
}

/* ---------- 搜索 ---------- */
{
  const r = await call('GET', '/api/search?q=')
  check('搜索：空查询返回空数组', r.status === 200 && Array.isArray((r.json as { hits: unknown[] }).hits) && (r.json as { hits: unknown[] }).hits.length === 0)
}
{
  const r = await call('GET', '/api/search?q=' + encodeURIComponent('啊'.repeat(500)))
  check('搜索：超长查询不崩', r.status === 200, `实际 ${r.status}`)
}
{
  const r = await call('GET', '/api/search?q=test&types=bogus')
  check('搜索：非法 types 不崩', r.status === 200, `实际 ${r.status}`)
}
{
  const r = await call('GET', '/api/search?q=四级&days=99999')
  check('搜索：days 超范围被夹住', r.status === 200, `实际 ${r.status}`)
}

/* ---------- 趋势 ---------- */
{
  const r = await call('GET', '/api/trend?days=0')
  check('趋势：days=0 被兜底', r.status === 200 && (r.json as { days: number }).days >= 1, JSON.stringify(r.json).slice(0, 80))
}
{
  const r = await call('GET', '/api/trend?days=999')
  check('趋势：days=999 被夹到 30', r.status === 200 && (r.json as { days: number }).days === 30, `实际 ${(r.json as { days: number }).days}`)
}

/* ---------- 人物参数 ---------- */
{
  const r = await call('GET', '/api/status?person=../../etc/passwd')
  check('路径穿越的 person 参数被忽略', r.status === 200, `实际 ${r.status}`)
}
{
  const r = await call('GET', '/api/memory?person=' + encodeURIComponent('../'.repeat(20) + 'windows'))
  check('大量 ../ 的 person 参数不崩', r.status === 200, `实际 ${r.status}`)
}
{
  const r = await call('GET', '/api/state?person=不存在的人')
  check('不存在的 person 返回兜底而不是 500', r.status === 200 || r.status === 404, `实际 ${r.status}`)
}

/* ---------- 动作 ---------- */
{
  const r = await call('POST', '/api/action', { action: '不存在的动作' })
  check('未知动作返回 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('POST', '/api/action', {})
  check('缺 action 返回 400', r.status === 400, `实际 ${r.status}`)
}

/* ---------- 试聊 ---------- */
{
  const r = await call('POST', '/api/try', {})
  check('试聊：空输入返回 400', r.status === 400, `实际 ${r.status}`)
}
{
  const r = await call('POST', '/api/try', { text: '   ' })
  check('试聊：纯空格返回 400', r.status === 400, `实际 ${r.status}`)
}

/* ---------- 鉴权 ---------- */
{
  const res = await fetch(BASE + '/api/status', { headers: { 'x-console-token': 'wrong-token-123' } })
  check('错误 token 被拒', res.status === 401 || res.status === 403, `实际 ${res.status}`)
}
{
  const res = await fetch(BASE + '/api/status')
  check('无 token 被拒', res.status === 401 || res.status === 403, `实际 ${res.status}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)

// 显式标记为模块：否则 TS 会把顶层 let/const 当全局变量，与其它脚本互相冲突
// （报 TS2451 重复声明 / TS1375 顶层 await），加这一行就没有歧义了。
export {}
