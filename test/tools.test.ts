import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { Tool } from '../src/tools/types.ts'

const ctx = { personId: 'qq-1', scope: 'private:1', now: new Date() }

const echo: Tool = {
  name: 'echo',
  description: '把输入原样返回',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async run(args) {
    return String(args['text'] ?? '')
  },
}

test('注册表：注册后能取到', () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  assert.equal(reg.size, 1)
  assert.equal(reg.get('echo')?.name, 'echo')
  assert.equal(reg.list().length, 1)
})

test('注册表：重名会覆盖而不是堆两份', () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  reg.register({ ...echo, description: '覆盖版' })
  assert.equal(reg.size, 1)
  assert.equal(reg.get('echo')?.description, '覆盖版')
})

test('注册表：执行成功返回内容', async () => {
  const reg = new ToolRegistry()
  reg.register(echo)
  const r = await reg.run('echo', { text: '你好' }, ctx)
  assert.equal(r.ok, true)
  assert.equal(r.content, '你好')
})

test('注册表：工具抛错不炸调用方，转成错误文本', async () => {
  const reg = new ToolRegistry()
  reg.register({
    ...echo,
    name: 'boom',
    async run() {
      throw new Error('炸了')
    },
  })
  const r = await reg.run('boom', {}, ctx)
  assert.equal(r.ok, false)
  assert.ok(r.content.includes('炸了'))
})

test('注册表：调用不存在的工具返回说明而不是崩', async () => {
  const reg = new ToolRegistry()
  const r = await reg.run('nope', {}, ctx)
  assert.equal(r.ok, false)
  assert.ok(r.content.includes('没有这个工具'))
})

test('注册表：默认是空的（我们现在一个工具都没有）', async () => {
  const { tools } = await import('../src/tools/registry.ts')
  assert.equal(tools.size, 0)
  assert.deepEqual(tools.list(), [])
})

test('本机权限门：所有 desktop 工具都被拦住', async () => {
  const { isLocalTool } = await import('../src/loop/chat.ts')
  const { desktopReadTools, desktopWriteTools } = await import('../src/tools/desktop.ts')
  const all = [...desktopReadTools, ...desktopWriteTools]
  assert.ok(all.length >= 10, `desktop 工具数异常：${all.length}`)
  // 锁死这条：以前用正则按前缀匹配，`click`/`type_text`/`press_key`/`scroll`/
  // `focus_window`/`list_windows`/`monitor_info` 七个全漏，群里能看主人窗口标题。
  for (const t of all) {
    assert.ok(isLocalTool(t.name), `${t.name} 没被本机权限门拦住`)
  }
  // 发本地图片也算"碰本机"
  assert.ok(isLocalTool('send_image'))
  // 只读代码不算（群里也能读）
  assert.ok(!isLocalTool('read_code'))
})
