import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isNewer } from '../src/console/update.ts'

/**
 * 在线更新的版本判断。
 *
 * 这里只测纯逻辑（不发网络请求）—— 真正的更新源是外部服务，
 * 放进来会让测试依赖网络和线上状态。
 *
 * 重点：必须是「比当前高」才算有新版本，不能是「不相等」。
 */

test('远端更高 → 有新版本', () => {
  assert.equal(isNewer('0.1.9', '0.1.8'), true)
  assert.equal(isNewer('0.2.0', '0.1.8'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
})

test('远端更低 → 不算新版本（不能引导降级）', () => {
  // GitHub Release 还停在 0.1.6，用户装的是 0.1.8：这是最常见的真实场景
  assert.equal(isNewer('0.1.6', '0.1.8'), false)
  assert.equal(isNewer('0.1.7', '0.1.8'), false)
  assert.equal(isNewer('0.9.9', '1.0.0'), false)
})

test('同版本 → 不算新版本', () => {
  assert.equal(isNewer('0.1.8', '0.1.8'), false)
  assert.equal(isNewer('v0.1.8', '0.1.8'), false)
  assert.equal(isNewer('0.1.8', 'v0.1.8'), false)
})

test('去掉 v 前缀后能正常比', () => {
  assert.equal(isNewer('v0.1.9', '0.1.8'), true)
  assert.equal(isNewer('0.1.9', 'v0.1.8'), true)
  assert.equal(isNewer('v0.1.9', 'v0.1.8'), true)
})

test('多位数字按数值比，不按字符串比', () => {
  // '0.1.10' < '0.1.9' 是字符串比较的错；按数值应该是 0.1.10 更高
  assert.equal(isNewer('0.1.10', '0.1.9'), true)
  assert.equal(isNewer('0.1.9', '0.1.10'), false)
  assert.equal(isNewer('0.2.0', '0.10.0'), false)
  assert.equal(isNewer('0.10.0', '0.2.0'), true)
})

test('空值/非法版本号不报新版本', () => {
  assert.equal(isNewer('', '0.1.8'), false)
  assert.equal(isNewer('0.1.8', ''), false)
  assert.equal(isNewer('', ''), false)
  assert.equal(isNewer('latest', '0.1.8'), false)
  assert.equal(isNewer('0.1.8', 'latest'), false)
})

test('预发布后缀不参与比较', () => {
  assert.equal(isNewer('0.1.9-beta', '0.1.8'), true)
  assert.equal(isNewer('0.1.8-beta', '0.1.8'), false)
  assert.equal(isNewer('0.1.7-beta', '0.1.8'), false)
})
