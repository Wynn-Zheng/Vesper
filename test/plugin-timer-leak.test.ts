import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHost } from '../src/plugins/host.ts'

/**
 * 热重载会漏资源（BUG3-22）。
 *
 * 插件是热重载的，但 ESM 模块卸载不了：插件用**全局** setInterval 起的任务，
 * 在 unload 之后还在跑，闭包着旧模块和旧 ctx。重载几十次就多出几十份实例，
 * 表现是"用久了越来越卡"，日志里什么都看不到。
 *
 * 所以给了一个 ctx.setInterval（宿主记着句柄、卸载时清掉）。
 * 这条测试用一个真的临时插件验证：卸载后它不再往文件里写。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-timer-'))
const pluginsRoot = join(dir, 'plugins')
const dataRoot = join(dir, 'data')
const pluginDir = join(pluginsRoot, 'ticker')
mkdirSync(pluginDir, { recursive: true })
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

writeFileSync(
  join(pluginDir, 'plugin.json'),
  JSON.stringify({ id: 'ticker', name: '计时器示例', version: '1.0.0', entry: 'index.mjs', type: 'event' }, null, 2),
  'utf8',
)

// 插件每 40ms 往自己的 dataDir 里追加一个点
writeFileSync(
  join(pluginDir, 'index.mjs'),
  `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

let timer = null

export function activate(ctx) {
  const file = join(ctx.dataDir, 'ticks.txt')
  // ⚠ 用 ctx.setInterval（宿主管），不是全局 setInterval
  timer = ctx.setInterval(() => appendFileSync(file, '.'), 40)
}

export function deactivate(ctx) {
  // 故意不自己 clear —— 验证宿主会兜底
}
`,
  'utf8',
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ticks = (): number => {
  try {
    return readFileSync(join(dataRoot, 'plugins', 'ticker', 'ticks.txt'), 'utf8').length
  } catch {
    return 0
  }
}

test('卸载后插件的定时器要停（不能继续跑旧代码）', async () => {
  const host = createHost({
    pluginsRoot,
    dataRoot,
    settingsFile: join(dir, 'plugins.yaml'),
    logger: () => {},
  })

  const loaded = await host.load('ticker')
  assert.equal(loaded.ok, true, loaded.error)

  await sleep(200)
  const before = ticks()
  assert.ok(before > 0, `插件应该已经开始写了，实际 ${before}`)

  const un = await host.unload('ticker')
  assert.equal(un.ok, true, un.error)

  // 等一会儿再看：如果没有被清掉，计数还会继续涨
  const atUnload = ticks()
  await sleep(300)
  const after = ticks()
  assert.equal(after, atUnload, `卸载后不该再写（卸载时 ${atUnload}，300ms 后 ${after}）`)
})

test('重载两次后，只有一个实例在跑（不会翻倍）', async () => {
  const host = createHost({
    pluginsRoot,
    dataRoot: join(dir, 'data2'),
    settingsFile: join(dir, 'plugins2.yaml'),
    logger: () => {},
  })
  const countFile = join(dir, 'data2', 'plugins', 'ticker', 'ticks.txt')
  const count = (): number => {
    try {
      return readFileSync(countFile, 'utf8').length
    } catch {
      return 0
    }
  }

  await host.load('ticker')
  await sleep(150)
  // 重载：旧实例必须被清掉，否则两份定时器一起写 → 速度翻倍
  await host.reload('ticker')
  await sleep(120)

  const a = count()
  await sleep(300)
  const b = count()
  // 300ms / 40ms ≈ 7.5 次。两份实例的话会是 ~15，这里留宽松上限
  const grew = b - a
  assert.ok(grew > 0, '重载后新实例要在跑')
  assert.ok(grew <= 12, `只该有一份在跑，实际 300ms 写了 ${grew} 次（两份会接近翻倍）`)

  await host.unload('ticker')
})
