/**
 * 外部能力体检：B站接口的纯逻辑 + 刷视频的状态机。
 * 不真调 B站。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const bili = await import('../src/outward/bili.ts')

/* ---------- 1. 分区表 ---------- */
console.log('=== 1. 分区表 ===')
{
  const zones = bili.ZONES
  const names = Object.keys(zones)
  check(`有 ${names.length} 个分区`, names.length > 0)
  const bad = names.filter((n) => !Number.isInteger(zones[n]) || zones[n]! <= 0)
  check('所有分区 id 都是正整数', bad.length === 0, bad.join(', '))
}

/* ---------- 2. humanDuration ---------- */
console.log('\n=== 2. 时长格式化 ===')
{
  const cases: Array<[number, string]> = [
    [0, '0 秒'],
    [59, '59 秒'],
    [60, '1 分钟'],
    [3599, '60 分钟'],
    [3600, '1 小时 0 分'],
    [86400, '24 小时 0 分'],
  ]
  for (const [sec, expect] of cases) {
    const got = bili.humanDuration(sec)
    check(`${sec}s → ${got}`, got === expect, `期望 ${expect}`)
  }
}

/* ---------- 3. 非法 bvid 不该发请求 ---------- */
console.log('\n=== 3. bvid 校验 ===')
{
  const bad = ['', 'BV', 'BV123', 'BV!@#$%^&*()', '不是BV', 'BV1234567890123456']
  for (const b of bad) {
    const r = await bili.detail(b)
    check(`detail("${b.slice(0, 12)}") 返回 null`, r === null, JSON.stringify(r)?.slice(0, 50))
  }
}

/* ---------- 4. 不存在的分区走总热门 ---------- */
console.log('\n=== 4. 未知分区 ===')
{
  // 以前这里真发请求，网络失败也算"通过"（只验证参数处理不崩）。
  // 现在 mock fetch：既能离线跑，又能真的断言「未知分区会回落到总热门」。
  const origFetch = globalThis.fetch
  let askedUrl = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    askedUrl = String(input instanceof Request ? input.url : input)
    return new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 })
  }) as typeof fetch
  try {
    const r = await bili.hot({ zone: '根本不存在的分区', limit: 1 })
    check('未知分区不抛错且返回数组', Array.isArray(r), typeof r)
    check('未知分区回落到总热门接口', askedUrl.includes('/x/web-interface/popular'), askedUrl.slice(0, 80))
  } finally {
    globalThis.fetch = origFetch
  }
}

/* ---------- 5. watch 的状态 ---------- */
console.log('\n=== 5. 刷视频状态 ===')
{
  const watch = await import('../src/outward/watch.ts')
  const { writeFileSync } = await import('node:fs')

  // 用临时根：以前读的是真实 persona/outward/watched.json，
  // 断言结果取决于用户昨天看过什么。
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-watch-'))
  writeFileSync(
    join(dir, 'watched.json'),
    JSON.stringify([{ bvid: 'BV1test', title: '测试视频', at: Date.now() }]),
  )
  watch.setWatchRoot(dir)
  try {
    check('loadWatched 读到 1 条', watch.loadWatched().length === 1)
    check('watchedToday 返回数字', Number.isInteger(watch.watchedToday()) && watch.watchedToday() >= 0)
    const list = watch.loadWatched()
    const badItems = list.filter((w) => typeof w.bvid !== 'string' || typeof w.title !== 'string' || typeof w.at !== 'number')
    check('每条都有 bvid/title/at', badItems.length === 0, JSON.stringify(badItems.slice(0, 1)))

    // 坏 JSON 要能兜底
    writeFileSync(join(dir, 'watched.json'), '{ 不是 json')
    check('坏 JSON 返回空数组', watch.loadWatched().length === 0)
  } finally {
    watch.setWatchRoot('persona/outward')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ---------- 6. 表情包通道的边界（顺带）---------- */
console.log('\n=== 6. 发送层（顺带回归）===')
{
  const send = await import('../src/channel/send.ts')
  // splitBySentence 在 0 上限时不该死循环
  const r = send.splitBySentence('一二三四五', 0, 3)
  check('maxLen=0 不死循环', Array.isArray(r), JSON.stringify(r)?.slice(0, 40))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
