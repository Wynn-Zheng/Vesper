/**
 * 停止刷视频之后，真正地停（B-31）。
 *
 * 缺陷原样：`startWatching` 里有两个一次性 `setTimeout`（启动后等 10 分钟、
 * 每轮再随机等一会儿）没有保存句柄，`stop()` 只清了 `setInterval`。
 * 于是关掉刷视频之后，已经排队的那个定时器到点照样跑 ——
 * 表现是"我在控制台关了刷视频，十分钟后它还是发了一条"。
 *
 * 这里用很短的延迟把两个定时器都逼出来，然后验证 stop 之后一个都不触发。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import { setWatchRoot, startWatching } from '../src/outward/watch.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const d = mkdtempSync(join(tmpdir(), 'vesper-watch-stop-'))
  dirs.push(d)
  setWatchRoot(d)
  return d
}

function rulesOn(): typeof DEFAULTS {
  const r = structuredClone(DEFAULTS)
  r.外部.刷视频.开启 = true
  r.外部.刷视频.每天最多 = 3
  return r
}

const llm = { apiKey: 'k', baseUrl: 'http://localhost', model: 'm' } as never
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('stop 之后，排队中的首轮不会再跑', async () => {
  setup()
  let calls = 0
  const stop = startWatching(llm, rulesOn, 3600_000, {
    firstDelayMs: 30,
    jitterMs: 10,
    watchOne: async () => {
      calls++
      return { ok: true }
    },
  })
  // 在首轮触发之前就停掉
  stop()
  await wait(150)
  assert.equal(calls, 0, 'stop 之后不该再执行 watchOne')
})

test('stop 之后，已排上的 jitter 那一次也不会跑', async () => {
  setup()
  let calls = 0
  const stop = startWatching(llm, rulesOn, 3600_000, {
    firstDelayMs: 20,
    jitterMs: 500,
    // 固定抖动到上限，保证 stop 之前那一次一定还没到点（不然随机值小的时候
    // 会先跑完，断言就变成看运气 —— 这条本来就因为随机失败过一次）
    random: () => 1,
    watchOne: async () => {
      calls++
      return { ok: true }
    },
  })
  // 先等首轮 run() 把 jitter 排上，再停
  await wait(60)
  stop()
  await wait(300)
  assert.equal(calls, 0, 'jitter 那次应该被 clearTimeout 掉')
})

test('不 stop 时机关是活的（对照组）', async () => {
  setup()
  let calls = 0
  const stop = startWatching(llm, rulesOn, 3600_000, {
    firstDelayMs: 20,
    jitterMs: 10,
    random: () => 0,
    watchOne: async () => {
      calls++
      return { ok: true }
    },
  })
  await wait(200)
  stop()
  assert.equal(calls, 1, '没停的时候应该跑一次（说明上面的 0 不是因为压根没启动）')
})

test('刷视频关着时连 run 都不该走到 watchOne', async () => {
  setup()
  let calls = 0
  const rules = rulesOn()
  rules.外部.刷视频.开启 = false
  const stop = startWatching(llm, () => rules, 3600_000, {
    firstDelayMs: 20,
    jitterMs: 10,
    watchOne: async () => {
      calls++
      return { ok: true }
    },
  })
  await wait(150)
  stop()
  assert.equal(calls, 0)
})

test('今天已经够数时不再多刷', async () => {
  setup()
  let calls = 0
  const rules = rulesOn()
  rules.外部.刷视频.每天最多 = 0
  const stop = startWatching(llm, () => rules, 3600_000, {
    firstDelayMs: 20,
    jitterMs: 10,
    watchOne: async () => {
      calls++
      return { ok: true }
    },
  })
  await wait(150)
  stop()
  assert.equal(calls, 0)
})
