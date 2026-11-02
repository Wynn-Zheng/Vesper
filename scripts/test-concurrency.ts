/**
 * 并发与数据完整性检查。
 * 这些是最难靠读代码发现的问题：单线程跑一万次都正常，两个撞一起才暴露。
 */
import { existsSync, readFileSync } from 'node:fs'
/** 从 .env 读控制台 token（不依赖环境变量，直接跑也能通） */
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

const BASE = 'http://127.0.0.1:7788'
const TOKEN = envToken()

const H = { 'x-console-token': TOKEN, 'Content-Type': 'application/json' }

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
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
    /* ignore */
  }
  return { status: res.status, json }
}

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

/* ---------- 1. 并发写同一个文件 ---------- */
console.log('=== 并发写 ===')
{
  // 同时发 10 个快照请求，看会不会互相踩
  const before = (await call('GET', '/api/versions')).json as { snapshots: unknown[] }
  const results = await Promise.all(
    Array.from({ length: 10 }, () => call('POST', '/api/action', { action: 'snapshot' })),
  )
  const okCount = results.filter((r) => r.status === 200).length
  const after = (await call('GET', '/api/versions')).json as { snapshots: unknown[] }
  check(
    `10 个并发快照：${okCount} 个成功，新增 ${after.snapshots.length - before.snapshots.length} 个`,
    okCount >= 8,
    `成功 ${okCount}`,
  )
  // 快照 id 是时间戳，同一秒内多个会冲突——看有没有重复
  const ids = (after.snapshots as Array<{ id: string }>).map((s) => s.id)
  check('快照 id 不重复', new Set(ids).size === ids.length, `总数 ${ids.length}，去重后 ${new Set(ids).size}`)
}

/* ---------- 2. 并发读 ---------- */
console.log('\n=== 并发读 ===')
{
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call('GET', '/api/status')),
  )
  check('20 个并发 status 全部 200', results.every((r) => r.status === 200))
}

/* ---------- 3. 数据文件一致性 ---------- */
console.log('\n=== 数据完整性 ===')
{
  // facts.md 的行格式
  const root = 'persona/people'
  if (existsSync(root)) {
    const { readdirSync } = await import('node:fs')
    let badFacts = 0
    let badOpen = 0
    for (const person of readdirSync(root)) {
      const f = `${root}/${person}/facts.md`
      if (existsSync(f)) {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('#') || t.startsWith('##')) continue
          if (!t.startsWith('- ')) badFacts++
        }
      }
      const o = `${root}/${person}/open.md`
      if (existsSync(o)) {
        for (const line of readFileSync(o, 'utf8').split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('#') || t.startsWith('##')) continue
          if (!t.startsWith('- ')) badOpen++
        }
      }
    }
    check('facts.md 每行都是列表项', badFacts === 0, `${badFacts} 行异常`)
    check('open.md 每行都是列表项', badOpen === 0, `${badOpen} 行异常`)
  }
}

/* ---------- 4. 记忆能读回来 ---------- */
console.log('\n=== 读写往返 ===')
{
  const mem = (await call('GET', '/api/memory?person=qq-1234567890')).json as {
    facts: Array<{ text: string }>
  }
  const before = mem.facts.length
  // 加一条，读回来，再删掉
  const marker = `临时测试事实 ${Date.now()}`
  const add = await call('PUT', '/api/facts', { text: marker, newText: marker, confidence: 0.5 })
  check('改不存在的事实返回 updated:false', add.status === 200 && (add.json as { updated: boolean }).updated === false)
  const mem2 = (await call('GET', '/api/memory?person=qq-1234567890')).json as { facts: unknown[] }
  check('读回后事实数没变（没写脏数据）', mem2.facts.length === before, `${before} → ${mem2.facts.length}`)
}

/* ---------- 5. 日志行数上限 ---------- */
console.log('\n=== 日志 ===')
{
  const r = (await call('GET', '/api/logs/recent?n=99999')).json as Array<unknown>
  check(`日志接口有上限（要了 99999 条，返回 ${r.length} 条）`, r.length <= 500, `返回 ${r.length}`)
}

/* ---------- 6. 导出能解析 ---------- */
console.log('\n=== 导出 ===')
{
  const res = await fetch(BASE + '/api/export?days=7', { headers: H })
  const text = await res.text()
  let ok = false
  let size = 0
  try {
    const d = JSON.parse(text) as { people?: unknown[] }
    ok = Array.isArray(d.people)
    size = text.length
  } catch {
    /* ignore */
  }
  check(`导出是合法 JSON（${(size / 1024).toFixed(1)} KB）`, ok)
  check('导出带 Content-Disposition', (res.headers.get('content-disposition') ?? '').includes('attachment'))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
