import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * 面板隔离（BUG3-17）。
 *
 * 回归点很具体：iframe 的 sandbox 不能同时给 allow-scripts 和 allow-same-origin，
 * src 上也不能带控制台 token。给了的话面板等于完整控制台权限 ——
 * 面板里的第三方 JS 能卸插件、改模型、导数据。
 *
 * 这几条都是"读源码断言"，因为真正的沙箱行为要开浏览器才能验；
 * 但这三条约束一旦被改回去，读代码就能发现。
 */

const ROOT = join(import.meta.dirname, '..')
const pluginsJs = readFileSync(join(ROOT, 'console/plugins.js'), 'utf8')
const demo = readFileSync(join(ROOT, 'plugins/demo-panel/panel.html'), 'utf8')

test('面板 iframe 不能同时开 allow-scripts 和 allow-same-origin', () => {
  const m = /setAttribute\('sandbox',\s*'([^']*)'\)/.exec(pluginsJs)
  assert.ok(m, '找不到 sandbox 设置')
  const sandbox = m[1]!
  assert.ok(sandbox.includes('allow-scripts'), '面板需要跑脚本')
  assert.equal(
    sandbox.includes('allow-same-origin'),
    false,
    '同时给 allow-scripts + allow-same-origin 等于没有沙箱（OWASP 的经典组合）',
  )
})

test('面板 iframe 的 src 不能带 token', () => {
  assert.equal(/panel\/\$\{[^}]*\}\?token=/.test(pluginsJs), false, 'src 上不许拼 token')
  assert.ok(pluginsJs.includes('/api/plugins/panel/${encodeURIComponent(id)}'), '应该是不带参数的路径')
})

test('宿主有 postMessage 桥，且只认这个 iframe 发来的消息', () => {
  assert.ok(pluginsJs.includes("d.type !== 'vesper:call'"), '要有 vesper:call 协议')
  assert.ok(pluginsJs.includes('ev.source !== frame.contentWindow'), '必须校验消息来源')
  assert.ok(pluginsJs.includes("'/api/plugins/call'"), '只许代发到 call 这一个接口')
})

test('示例面板用桥，不再自己读 token', () => {
  assert.equal(/location\.search\)\.get\('token'\)/.test(demo), false, '面板不该再从 URL 读 token')
  assert.ok(demo.includes("type: 'vesper:call'"), '要用桥')
  assert.ok(demo.includes('宿主没响应'), '桥要有超时，别让按钮永远转圈')
})
