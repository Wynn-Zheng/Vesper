/**
 * 插件控制台接口自检：node scripts/selfcheck-plugin-api.ts
 * 在系统临时目录里造一个插件源目录，把 createPluginService 指向临时
 * pluginsRoot / dataRoot，依次调用各路由 handler 验证行为。
 * 不读写真实 plugins/、persona/、data/ 下的任何数据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginService, pluginRoutes } from '../src/console/plugin-api.ts'
import type { PluginRoute } from '../src/console/plugin-api.ts'

const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  const line = detail ? `${name}（${detail}）` : name
  failures.push(line)
  console.log(`✗ ${line}`)
}

/** 从 handler 返回值里取出 data.plugins 数组 */
function listPlugins(result: { data?: unknown }): Array<Record<string, unknown>> {
  const data = result.data
  if (data === null || typeof data !== 'object') return []
  const plugins = (data as Record<string, unknown>)['plugins']
  if (!Array.isArray(plugins)) return []
  return plugins.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
  )
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-plugin-api-'))
  const pluginsRoot = join(root, 'plugins')
  const dataRoot = join(root, 'data')
  const sourceRoot = join(root, 'sources')
  const source = join(sourceRoot, 'demo-src')
  const pluginId = 'demo'

  try {
    // 造一个合法的插件源目录
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify(
        {
          id: pluginId,
          name: '演示插件',
          version: '1.0.0',
          entry: 'index.mjs',
          description: '用于插件接口自检',
        },
        null,
        2,
      ),
      'utf8',
    )
    writeFileSync(join(source, 'index.mjs'), 'export function activate() {}\n', 'utf8')

    const service = createPluginService({ pluginsRoot, dataRoot })
    const routes: PluginRoute[] = pluginRoutes(service)

    /** 按 method + path 找路由，找不到直接抛错（由最外层统一处理） */
    function route(method: 'GET' | 'POST', path: string): PluginRoute {
      const found = routes.find((item) => item.method === method && item.path === path)
      if (!found) throw new Error(`缺少路由：${method} ${path}`)
      return found
    }

    /* ============ 1. 安装 ============ */
    console.log('=== 1. /install ===')
    const installed = await route('POST', '/install').handler({ source })
    check('安装返回 ok=true', installed.ok === true, JSON.stringify(installed))

    /* ============ 2. 列表 ============ */
    console.log('\n=== 2. /list ===')
    const afterInstall = await route('GET', '/list').handler({})
    const pluginsAfterInstall = listPlugins(afterInstall)
    const foundAfterInstall = pluginsAfterInstall.find((item) => item['id'] === pluginId)
    check('install 后 list 中出现该插件', foundAfterInstall !== undefined, JSON.stringify(pluginsAfterInstall))
    check('install 后 enabled 为 true', foundAfterInstall?.['enabled'] === true, String(foundAfterInstall?.['enabled']))

    /* ============ 3. 停用 ============ */
    console.log('\n=== 3. /toggle ===')
    const toggled = await route('POST', '/toggle').handler({ id: pluginId, enabled: false })
    check('toggle(false) 返回 ok=true', toggled.ok === true, JSON.stringify(toggled))

    const afterToggle = await route('GET', '/list').handler({})
    const foundAfterToggle = listPlugins(afterToggle).find((item) => item['id'] === pluginId)
    check('toggle(false) 后 list 中 enabled 为 false', foundAfterToggle?.['enabled'] === false, String(foundAfterToggle?.['enabled']))

    /* ============ 4. 更新检查 ============ */
    console.log('\n=== 4. /updates ===')
    const updates = await route('GET', '/updates').handler({})
    const updatesData = updates.data
    const updateItems =
      updatesData !== null && typeof updatesData === 'object'
        ? (updatesData as Record<string, unknown>)['items']
        : undefined
    check('/updates 返回 items 数组', Array.isArray(updateItems), JSON.stringify(updatesData))

    /* ============ 5. 卸载 ============ */
    console.log('\n=== 5. /uninstall ===')
    const removed = await route('POST', '/uninstall').handler({ id: pluginId })
    check('卸载返回 ok=true', removed.ok === true, JSON.stringify(removed))

    const afterUninstall = await route('GET', '/list').handler({})
    const pluginsAfterUninstall = listPlugins(afterUninstall)
    check('卸载后 list 为空', pluginsAfterUninstall.length === 0, JSON.stringify(pluginsAfterUninstall))

    /* ============ 6. 非法请求体 ============ */
    console.log('\n=== 6. 非法请求体 ===')
    const invalidInstall = await route('POST', '/install').handler({})
    check('install({}) 返回 ok=false', invalidInstall.ok === false, JSON.stringify(invalidInstall))
    check(
      "install({}) 的 error 以 'invalid body' 开头",
      typeof invalidInstall.error === 'string' && invalidInstall.error.startsWith('invalid body'),
      String(invalidInstall.error),
    )
  } finally {
    // 无论成功失败都清理临时目录
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => {
    if (failures.length > 0) {
      console.log(`\n${failures.length} 项未通过：`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exit(1)
    }
    console.log('\n全部通过')
    process.exit(0)
  },
  (err: unknown) => {
    console.log(`\n自检执行出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    process.exit(1)
  },
)
