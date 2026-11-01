import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkUrl, hostAllowed, isPrivateAddress, DEFAULT_NET_POLICY, type NetPolicy } from '../src/plugins/net.ts'

/**
 * 插件网络出口。
 *
 * 这里只测"该拦的拦住"——需要真出网的用例不放进来，
 * 不然测试会依赖外部服务和网络状态。地址判断和 URL 检查都是纯逻辑。
 */

const policy = (patch?: Partial<NetPolicy>): NetPolicy => ({ ...DEFAULT_NET_POLICY, ...patch })

/* ---------------- 地址分类 ---------------- */

test('内网地址认得出来', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    // 云厂商元数据服务，SSRF 最常打的地方
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应该判为内网`)
  }
})

test('公网地址放过去', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '223.5.5.5', '104.18.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 不该判为内网`)
  }
})

test('IPv6 回环和本地地址也要拦', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应该判为内网`)
  }
})

test('公网 IPv6 不算内网', () => {
  assert.equal(isPrivateAddress('2400:3200::1'), false)
})

/* ---------------- URL 检查 ---------------- */

test('协议只放 http/https', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/']) {
    const r = await checkUrl(url, policy())
    assert.equal(r.ok, false, `${url} 应该被拒`)
  }
})

test('内网 IP 字面量直接拒，不用查 DNS', async () => {
  for (const url of ['http://127.0.0.1:8080/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/']) {
    const r = await checkUrl(url, policy())
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /内网/)
  }
})

test('允许内网时放行（要调本地服务才开）', async () => {
  const r = await checkUrl('http://127.0.0.1:11434/api/tags', policy({ 允许内网: true }))
  assert.equal(r.ok, true)
})

test('公网地址放行', async () => {
  const r = await checkUrl('http://1.1.1.1/', policy())
  assert.equal(r.ok, true)
})

/* ---------------- 白名单 / 黑名单 ---------------- */

// 这里直接测匹配函数，不走 checkUrl：checkUrl 会查 DNS，
// 拿不存在的域名做用例时"解析失败"和"不在白名单"是两种拒绝原因，会掩盖真正要测的东西。

test('白名单只放列出来的域名', () => {
  assert.equal(hostAllowed('api.example.com', ['api.example.com']), true)
  assert.equal(hostAllowed('other.example.com', ['api.example.com']), false)
  assert.equal(hostAllowed('api.example.com', []), false)
})

test('白名单支持后缀写法', () => {
  assert.equal(hostAllowed('a.example.com', ['.example.com']), true)
  assert.equal(hostAllowed('example.com', ['.example.com']), true)
  // 别把 notexample.com 也放进去
  assert.equal(hostAllowed('notexample.com', ['.example.com']), false)
})

test('白名单支持通配前缀', () => {
  assert.equal(hostAllowed('a.example.com', ['*.example.com']), true)
  assert.equal(hostAllowed('a.other.com', ['*.example.com']), false)
})

test('白名单支持全通配', () => {
  assert.equal(hostAllowed('anything.com', ['*']), true)
})

test('大小写不敏感', () => {
  assert.equal(hostAllowed('API.Example.COM', ['api.example.com']), true)
})

test('checkUrl 走白名单和黑名单', async () => {
  const p = policy({ 白名单: ['1.1.1.1'], 黑名单: ['8.8.8.8'] })
  assert.equal((await checkUrl('http://1.1.1.1/', p)).ok, true)
  assert.equal((await checkUrl('http://8.8.8.8/', p)).ok, false)
})

test('黑名单优先于白名单', async () => {
  const p = policy({ 白名单: ['1.1.1.1'], 黑名单: ['1.1.1.1'] })
  assert.equal((await checkUrl('http://1.1.1.1/', p)).ok, false)
})

test('空 URL 和乱七八糟的串不会崩', async () => {
  for (const bad of ['', 'not a url', 'http://', '://x']) {
    const r = await checkUrl(bad, policy())
    assert.equal(r.ok, false)
  }
})
