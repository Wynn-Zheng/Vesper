import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onceAtATime } from '../src/core/timer.ts'

/**
 * 定时任务的"同一时间只跑一轮"。
 *
 * 为什么值得单独测：整理和主动消息都是 setInterval 驱动的，
 * 单次执行要调模型，慢的时候会超过间隔。不设保护的话：
 *   - 整理叠加 → 重复花钱、同一条事实被提炼两遍
 *   - 主动叠加 → 同一个人连着收到两条"想你了"
 * 这两种在日志里都只表现为"跑得慢"，很难事后发现。
 */

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

test('正在跑的时候再调，直接忽略', async () => {
  let runs = 0
  const fn = onceAtATime(async () => {
    runs++
    await tick(80)
  })
  const a = fn()
  const b = fn() // 这一拍应该被忽略
  const c = fn()
  await Promise.all([a, b, c])
  assert.equal(runs, 1, '三次调用只该真正跑一次')
})

test('上一轮结束后，下一拍能正常跑', async () => {
  let runs = 0
  const fn = onceAtATime(async () => {
    runs++
    await tick(30)
  })
  await fn()
  await fn()
  assert.equal(runs, 2)
})

test('抛异常也要把锁放开（否则永久卡死）', async () => {
  let runs = 0
  const fn = onceAtATime(async () => {
    runs++
    throw new Error('模型挂了')
  })
  await assert.rejects(fn(), /模型挂了/)
  // 关键：异常后还能再跑
  await assert.rejects(fn(), /模型挂了/)
  assert.equal(runs, 2, '出错不能把"正在跑"永久置位')
})

test('同步函数也能用', async () => {
  let runs = 0
  const fn = onceAtATime(() => {
    runs++
  })
  await fn()
  await fn()
  assert.equal(runs, 2)
})
