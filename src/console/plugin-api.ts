/**
 * 插件控制台接口（后端）。
 *
 * 本文件只提供「路由定义 + handler」，不负责 HTTP 监听、不拼接 URL 前缀，
 * 也不读取 process.argv / process.env。
 *
 * 控制台的启动入口需要遍历 pluginRoutes(service) 返回的数组，
 * 把每个 route 的 method + path 注册到 /api/plugins 前缀下
 * （例如 path 为 '/list' 时实际响应 /api/plugins/list）。
 * 本节点不修改既有启动入口文件。
 */
import { join } from 'node:path'
import { errorAt, info as logInfo, warnAt } from '../core/log.ts'
import { getPluginConfig, removePluginConfig, setPluginConfig } from '../plugins/settings.ts'
import { createHost } from '../plugins/host.ts'
import { checkUpdates, installPlugin, setEnabled, uninstallPlugin } from '../plugins/installer.ts'
import { scanPlugins } from '../plugins/registry.ts'

/** 单个插件路由的处理函数：只接收请求体，永远返回结果对象，不向调用方抛异常 */
export type PluginRouteHandler = (
  body: unknown,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>

/** 一条插件路由；path 不含 /api/plugins 前缀 */
export type PluginRoute = {
  method: 'GET' | 'POST'
  path: string
  handler: PluginRouteHandler
}

/** list 接口对外暴露的插件条目 */
type PluginListItem = {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  loaded: boolean
  /** 这个插件在 persona/plugins.yaml 里的配置（没有就是空对象） */
  config: Record<string, unknown>
}

/** 把任意异常转成可读文本 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 判断是否为普通对象（排除 null 和数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一的请求体非法返回 */
function invalidBody(field: string): { ok: false; error: string } {
  return { ok: false, error: `invalid body: ${field}` }
}

/**
 * 给 handler 套一层 try/catch：
 * 无论内部发生什么异常，调用方拿到的都是 { ok:false, error }。
 */
function safeHandler(
  handler: (body: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>,
): PluginRouteHandler {
  return async (body) => {
    try {
      return await handler(body)
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }
}

/**
 * 创建插件服务。
 *
 * - pluginsRoot：插件安装目录
 * - dataRoot：插件数据根目录
 * - host：可注入 createHost 返回的宿主；不传时内部自行创建
 */
export function createPluginService(options: {
  pluginsRoot: string
  dataRoot: string
  host?: ReturnType<typeof createHost>
  /** 插件配置文件。默认 persona/plugins.yaml */
  settingsFile?: string
}) {
  const pluginsRoot = options.pluginsRoot
  const dataRoot = options.dataRoot
  const settingsFile = options.settingsFile ?? join('persona', 'plugins.yaml')
  const host =
    options.host ??
    createHost({
      pluginsRoot,
      dataRoot,
      settingsFile,
      // 插件里 ctx.log() 打到业务日志（data/logs/*.jsonl），
      // 不然只会落在进程控制台，用户在控制台里看不到。
      logger: (level, message) => {
        if (level === 'error') errorAt(message, { where: 'plugin' })
        else if (level === 'warn') warnAt(message, { where: 'plugin' })
        else logInfo(message)
      },
    })

  /** 查一个插件当前是否已在宿主内存中加载 */
  function isLoaded(id: string): boolean {
    return host.list().some((item) => item.id === id && item.loaded)
  }

  const routes: PluginRoute[] = [
    {
      method: 'GET',
      path: '/list',
      handler: safeHandler(async () => {
        const { plugins } = await scanPlugins(pluginsRoot)
        const loadedIds = new Set(
          host
            .list()
            .filter((item) => item.loaded)
            .map((item) => item.id),
        )

        const list: PluginListItem[] = plugins.map((plugin) => ({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          description: plugin.manifest.description ?? '',
          enabled: plugin.enabled,
          loaded: loadedIds.has(plugin.manifest.id),
          config: getPluginConfig(settingsFile, plugin.manifest.id),
        }))

        return { ok: true, data: { plugins: list } }
      }),
    },
    {
      method: 'POST',
      path: '/install',
      handler: safeHandler(async (body) => {
        if (!isRecord(body)) return invalidBody('body')

        const source = body['source']
        if (typeof source !== 'string' || source.length === 0) return invalidBody('source')

        const allowOverwrite = body['allowOverwrite']
        if (allowOverwrite !== undefined && typeof allowOverwrite !== 'boolean') {
          return invalidBody('allowOverwrite')
        }

        const result = await installPlugin({
          source,
          pluginsRoot,
          ...(allowOverwrite === undefined ? {} : { allowOverwrite }),
        })
        if (!result.ok) return { ok: false, error: result.error ?? '安装失败' }
        return { ok: true, data: { id: result.id } }
      }),
    },
    {
      method: 'POST',
      path: '/uninstall',
      handler: safeHandler(async (body) => {
        if (!isRecord(body)) return invalidBody('body')

        const id = body['id']
        if (typeof id !== 'string' || id.length === 0) return invalidBody('id')

        const purgeData = body['purgeData']
        if (purgeData !== undefined && typeof purgeData !== 'boolean') {
          return invalidBody('purgeData')
        }

        // 已加载的插件必须先卸载，避免文件删掉了内存里还留着
        if (isLoaded(id)) {
          const unloaded = await host.unload(id)
          if (!unloaded.ok && unloaded.error !== 'not loaded') {
            return { ok: false, error: unloaded.error ?? '卸载插件失败' }
          }
        }

        const result = await uninstallPlugin({
          id,
          pluginsRoot,
          dataRoot,
          ...(purgeData === undefined ? {} : { purgeData }),
        })
        if (!result.ok) return { ok: false, error: result.error ?? '卸载失败' }

        // 顺手清掉它在 persona/plugins.yaml 里的配置，
        // 否则以后装一个同 id 的插件会读到上一任留下的配置。
        try {
          removePluginConfig(settingsFile, id)
        } catch {
          /* 配置清理失败不影响卸载本身 */
        }

        return { ok: true, data: { id } }
      }),
    },
    {
      method: 'POST',
      path: '/toggle',
      handler: safeHandler(async (body) => {
        if (!isRecord(body)) return invalidBody('body')

        const id = body['id']
        if (typeof id !== 'string' || id.length === 0) return invalidBody('id')

        const enabled = body['enabled']
        if (typeof enabled !== 'boolean') return invalidBody('enabled')

        // 停用前先卸载已加载的实例；启用后不自动加载，交给上层决定
        if (!enabled && isLoaded(id)) {
          const unloaded = await host.unload(id)
          if (!unloaded.ok && unloaded.error !== 'not loaded') {
            return { ok: false, error: unloaded.error ?? '卸载插件失败' }
          }
        }

        const result = await setEnabled({ id, pluginsRoot, enabled })
        if (!result.ok) return { ok: false, error: result.error ?? '切换启用状态失败' }
        return { ok: true, data: { id, enabled } }
      }),
    },
    {
      method: 'POST',
      path: '/config',
      handler: safeHandler(async (body) => {
        if (!isRecord(body)) return invalidBody('body')

        const id = body['id']
        if (typeof id !== 'string' || id.length === 0) return invalidBody('id')

        const config = body['config']
        if (!isRecord(config)) return invalidBody('config（要传对象）')

        // 只写配置，不动插件文件；改完要 reload 才会被插件读到
        setPluginConfig(settingsFile, id, config)
        return { ok: true, data: { id, config, note: '重载插件后生效' } }
      }),
    },
    {
      method: 'POST',
      path: '/reload',
      handler: safeHandler(async (body) => {
        if (!isRecord(body)) return invalidBody('body')

        const id = body['id']
        if (typeof id !== 'string' || id.length === 0) return invalidBody('id')

        const result = await host.reload(id)
        if (!result.ok) return { ok: false, error: result.error ?? '重载失败' }
        return { ok: true, data: { id } }
      }),
    },
    {
      method: 'GET',
      path: '/updates',
      handler: safeHandler(async () => {
        const result = await checkUpdates({ pluginsRoot })
        return {
          ok: true,
          data: result.error === undefined ? { items: result.items } : { items: result.items, error: result.error },
        }
      }),
    },
  ]

    /**
     * 把 plugins/ 下所有「已启用」的插件加载起来。
     *
     * 为什么要单独一个方法：createHost 只提供单个 load(id)，没有批量入口，
     * 所以光创建 service 永远不会激活任何插件（list 里 loaded 全是 false）。
     *
     * 单个插件失败只记进 errors，不中断其余插件。
     */
    async function start(): Promise<{ loaded: number; errors: string[] }> {
      const errors: string[] = []
      let loaded = 0
      try {
        const { plugins } = await scanPlugins(pluginsRoot)
        for (const plugin of plugins) {
          if (!plugin.enabled) continue
          const result = await host.load(plugin.manifest.id)
          if (result.ok) loaded++
          else if (result.error && result.error !== 'already loaded') {
            errors.push(`${plugin.manifest.id}: ${result.error}`)
          }
        }
      } catch (err) {
        errors.push(`扫描插件目录失败：${errorMessage(err)}`)
      }
      return { loaded, errors }
    }

    return { pluginsRoot, dataRoot, host, routes, start }
  }

/**
 * 取出一份可直接注册的路由表。
 * 控制台启动入口负责把 method + path 挂到 /api/plugins 前缀下。
 */
export function pluginRoutes(service: ReturnType<typeof createPluginService>): PluginRoute[] {
  return service.routes
}
