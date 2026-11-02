/**
 * 插件宿主：负责单个插件的载入、卸载与重载，并维护插件内事件订阅。
 * 插件代码的异常一律在宿主内部消化，写进 errors，不让调用方看到未捕获的异常。
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanPlugins } from './registry.ts'
import { getPluginConfig } from './settings.ts'
import { resolvePluginPath } from './sandbox.ts'
import { createSafeFetch, DEFAULT_NET_POLICY, type NetPolicy } from './net.ts'

export type PluginLogger = (level: 'info' | 'warn' | 'error', message: string) => void

/**
 * 插件注册的工具。
 *
 * 和 src/tools/types.ts 的 Tool 形状一致，但 run 不接收 ToolContext ——
 * 插件不该直接碰宿主的上下文，它需要的东西（数据目录、配置、日志）都在自己的 ctx 里。
 */
export type PluginTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string> | string
}

export type PluginContext = {
  id: string
  dataDir: string
  /** 这个插件在 persona/plugins.yaml 里的 config（激活时读一次快照） */
  config: Record<string, unknown>
  log: (message: string) => void
  on: (event: string, handler: (payload: unknown) => void) => void
  emit: (event: string, payload?: unknown) => void
  /** 注册成模型能调用的工具（插件声明 type: 'tool' 时才有意义） */
  registerTool: (tool: PluginTool) => void
  /**
   * 以下能力只有 plugin.json 里声明了对应权限才有。
   *
   * 注意这是**协作式信任**：没声明就没有这个便捷入口，
   * 但挡不住插件直接写 globalThis.fetch —— 挡误用，不挡恶意。
   */
  /** permissions 含 net 时存在 */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** permissions 含 memory 时存在：读自己数据目录以外的 persona 文件 */
  readPersona?: (relPath: string) => Promise<string>
  /** permissions 含 message 时存在：主动发消息 */
  send?: (target: { kind: 'private' | 'group'; id: string }, text: string) => Promise<void>
  /**
   * permissions 含 files 时存在：读写项目目录内的文件。
   *
   * 限制在**项目根目录内**（不能 `..` 逃出去、不能绝对路径）。
   * 想写自己的数据就传相对路径（比如 `data/myplugin/x.json`）；
   * 只写自己 dataDir 的话其实不用这个权限。
   */
  readFile?: (relPath: string) => Promise<string>
  writeFile?: (relPath: string, content: string) => Promise<void>
  /**
   * 定时器：**请用这几个，别直接用全局 setInterval**。
   *
   * 为什么：插件是热重载的，但 ESM 模块卸载不了。插件用全局 setInterval 起的
   * 任务，在 unload/reload 之后还在跑 —— 它闭包着旧模块、旧 ctx，越重载越多，
   * 表现出来就是"用久了越来越卡"，而且日志里什么都看不到。
   * 用这里的接口，宿主在卸载时会**替你清掉**。
   *
   * 自己起的全局定时器（或其它资源）请写在 deactivate() 里清理。
   */
  setInterval?: (fn: () => void, ms: number) => PluginTimer
  setTimeout?: (fn: () => void, ms: number) => PluginTimer
  clearInterval?: (handle: PluginTimer) => void
  clearTimeout?: (handle: PluginTimer) => void
}

/** 插件定时器的句柄（宿主内部记着它是 interval 还是 timeout） */
export type PluginTimer = { readonly __pluginTimer: true } & Record<string, unknown>

/** 允许 async：插件作者很自然会写 async 处理器，宿主必须接住它的拒绝 */
type Handler = (payload: unknown) => void | Promise<void>


type LoadedPlugin = {
  version: string
  ctx: PluginContext
  deactivate?: (ctx: PluginContext) => unknown
  /**
   * 插件的 `call` 导出（panel 类型用）。
   *
   * panel.html 里点按钮 → POST /api/plugins/<id>/call → 走到这里。
   * 存模块引用而不是每次重新 import：重载后这个引用会换掉，
   * 自然就跟上新代码了。
   */
  call?: (input: { action: string; payload?: unknown }) => Promise<unknown>
}

type KnownPlugin = {
  version: string
}

/**
 * 模块级订阅表。key 由「宿主实例 + 插件 id + 事件名」组成，
 * 这样不同插件即使订阅同名事件也不会互相收到消息。
 */
const listeners = new Map<string, Set<Handler>>()

/** 给每个宿主实例一个编号，避免同一进程里多个 host 的同名插件串台 */
let hostSerial = 0
/** 给每次 import 一个递增序号，保证同一毫秒内重载也能拿到新的模块实例 */
let importSerial = 0

const defaultLogger: PluginLogger = (level, message) => {
  if (level === 'error') console.error(message)
  else if (level === 'warn') console.warn(message)
  else console.log(message)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 只接受清单允许的入口扩展名 */
function isSupportedEntry(entryPath: string): boolean {
  return /\.(?:mjs|js|cjs|ts)$/.test(entryPath)
}

export function createHost(options: {
  pluginsRoot: string
  dataRoot: string
  logger?: PluginLogger
  /** 插件配置文件。默认 persona/plugins.yaml（跟着数据目录走） */
  settingsFile?: string
  /**
   * 发消息的实现。由宿主传进来（插件不该直接碰 transport）。
   *
   * 只有声明了 message 权限的插件才拿得到 ctx.send ——
   * 传进来的这个函数就是唯一的出口。
   */
  send?: (target: { kind: 'private' | 'group'; id: string }, text: string) => Promise<void>
  /**
   * 插件网络出口的策略（域名白名单/黑名单、是否允许内网、超时）。
   *
   * 不传就是默认策略：域名不限，但内网、回环、链路本地一律打不进去。
   * 插件拿到的 ctx.fetch 是这层包装过的，不是裸 fetch。
   */
  netPolicy?: NetPolicy
}) {
  const pluginsRoot = options.pluginsRoot
  const dataRoot = options.dataRoot
  const settingsFile = options.settingsFile ?? join('persona', 'plugins.yaml')
  const logger = options.logger ?? defaultLogger
  const sendFn = options.send
  const netPolicy = options.netPolicy ?? DEFAULT_NET_POLICY

  const errors: { id: string; message: string }[] = []
  /** 已成功激活的插件 */
  const loaded = new Map<string, LoadedPlugin>()
  /** 扫描到过的插件及其版本，用于 list() 展示未加载的插件 */
  const known = new Map<string, KnownPlugin>()
  const hostKey = `host-${++hostSerial}`
  /** 插件注册的工具：key = 工具名，value = 注册它的插件 id + 工具本体 */
  const pluginTools = new Map<string, { pluginId: string; tool: PluginTool }>()
  /**
   * 每个插件通过 ctx 起的定时器。卸载/重载时必须清掉：
   * 插件是热重载的，但 ESM 模块卸载不了 —— 插件用全局 setInterval 起的任务
   * 在 unload 之后还在跑，闭包着旧模块和旧 ctx。重载几十次就多出几十份实例，
   * 表现是"用久了越来越卡"，而日志里完全看不到。
   */
  const timerHandles = new Map<
    string,
    Map<PluginTimer, { kind: 'interval' | 'timeout'; handle: ReturnType<typeof setInterval> }>
  >()

  const eventKey = (id: string, event: string): string => `${hostKey}\u0000${id}\u0000${event}`

  /** 记录错误：既进 errors 数组，也交给 logger，方便外部排查 */
  function recordError(id: string, message: string): void {
    errors.push({ id, message })
    // 只留最近 50 条：这个数组会通过 /api/plugins/list 交给前端，
    // 不设上限的话长期运行会一直涨（而且前端也没法显示几百条）
    if (errors.length > 50) errors.splice(0, errors.length - 50)
    try {
      logger('error', `[plugin:${id}] ${message}`)
    } catch {
      // logger 是外部传入的，它自己出错不应影响宿主记录错误
    }
  }

  /** 调用 info 日志；日志实现异常不应打断插件生命周期 */
  function info(message: string): void {
    try {
      logger('info', message)
    } catch {
      // 同上，忽略日志实现自身的异常
    }
  }

  /** 清掉某个插件的全部事件订阅 */
  function clearSubscriptions(id: string): void {
    const prefix = `${hostKey}\u0000${id}\u0000`
    for (const key of [...listeners.keys()]) {
      if (key.startsWith(prefix)) listeners.delete(key)
    }
  }

  function subscribe(id: string, event: string, handler: Handler): void {
    const key = eventKey(id, event)
    let handlers = listeners.get(key)
    if (!handlers) {
      handlers = new Set<Handler>()
      listeners.set(key, handlers)
    }
    handlers.add(handler)
  }

  /** 单播给同一个插件内的订阅者，单个 handler 抛错不影响其它 handler */
  function dispatch(id: string, event: string, payload: unknown): void {
    const handlers = listeners.get(eventKey(id, event))
    if (!handlers || handlers.size === 0) return
    // 先复制一份，避免 handler 内部增删订阅影响本次遍历
    for (const handler of [...handlers]) {
      try {
        // handler 可能是 async 的：try/catch 抓不到它返回的 Promise 的拒绝，
        // 那个拒绝会一路冒到进程级的 unhandledRejection，日志只剩一句
        // 「未处理的拒绝」—— 分不清是哪个插件、哪个事件。这里显式接住。
        const r = handler(payload) as unknown
        if (r && typeof (r as { then?: unknown }).then === 'function') {
          ;(r as Promise<unknown>).catch((err) => {
            recordError(id, `事件 ${event} 的处理器执行失败（异步）：${errorMessage(err)}`)
          })
        }
      } catch (err) {
        recordError(id, `事件 ${event} 的处理器执行失败：${errorMessage(err)}`)
      }
    }
  }

  /** 只暴露这些字段，插件拿不到 process.env、require 等宿主能力 */
  function createContext(id: string, dataDir: string, permissions: string[] = []): PluginContext {
    // 这个插件通过 ctx 起的定时器。卸载时统一清掉（见 clearPluginTimers）。
    const track = (kind: 'interval' | 'timeout', handle: ReturnType<typeof setInterval>): PluginTimer => {
      let set = timerHandles.get(id)
      if (!set) {
        set = new Map()
        timerHandles.set(id, set)
      }
      const token = { __pluginTimer: true } as PluginTimer
      set.set(token, { kind, handle })
      return token
    }
    const untrack = (token: PluginTimer): void => {
      const set = timerHandles.get(id)
      const item = set?.get(token)
      if (!item) return
      if (item.kind === 'interval') clearInterval(item.handle)
      else clearTimeout(item.handle)
      set!.delete(token)
    }

    return {
      id,
      dataDir,
      // 激活时读一次快照：运行中改配置要 reload 才生效，
      // 但比每次访问都读文件省事，也不会读到写了一半的 YAML
      config: getPluginConfig(settingsFile, id),
      log: (message: string) => info(message),
      on: (event: string, handler: Handler) => subscribe(id, event, handler),
      emit: (event: string, payload?: unknown) => dispatch(id, event, payload),
      // 定时器：宿主会在卸载/重载时清掉，插件不用自己记
      setInterval: (fn: () => void, ms: number) => track('interval', setInterval(fn, ms)),
      setTimeout: (fn: () => void, ms: number) => track('timeout', setTimeout(fn, ms)),
      clearInterval: (token: PluginTimer) => untrack(token),
      clearTimeout: (token: PluginTimer) => untrack(token),
      registerTool: (tool: PluginTool) => {
        const name = String(tool?.name || '').trim()
        if (!name) {
          recordError(id, 'registerTool 少了 name，忽略')
          return
        }
        // 工具名会原样进模型的 function-calling。OpenAI/DeepSeek 对它有限制
        // （^[a-zA-Z0-9_-]{1,64}$），不合法会让**整条请求 400** ——
        // 只要这个插件加载着，bot 的所有回复都失败，而错误只出现在模型层，
        // 用户看到的是"它不说话了"。所以在这里就挡掉。
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
          recordError(
            id,
            `工具名不合法：${JSON.stringify(name)}（只能用小写字母、数字、下划线和连字符，1-64 个字符），已忽略`,
          )
          return
        }
        // parameters 必须是 JSON Schema 对象，否则模型侧也会报参数错
        const params = tool?.parameters
        if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
          recordError(id, `工具 ${name} 的 parameters 必须是对象（JSON Schema），已忽略`)
          return
        }
        if (pluginTools.has(name)) {
          recordError(id, `工具重名，已忽略：${name}（已被 ${pluginTools.get(name)!.pluginId} 注册）`)
          return
        }
        pluginTools.set(name, { pluginId: id, tool })
      },
      // 按 permissions 挂能力：没声明就不给这个入口
      ...(permissions.includes('net')
        ? {
            // 不是裸 fetch：会拦内网地址、限制协议、自己跟重定向（见 plugins/net.ts）
            fetch: createSafeFetch(netPolicy, id),
          }
        : {}),
      ...(permissions.includes('message') && sendFn
        ? {
            // 主动发一条。声明了 message 才有 —— 没声明就连这个入口都没有
            send: async (target: { kind: 'private' | 'group'; id: string }, text: string) => {
              const kind = target?.kind === 'group' ? 'group' : 'private'
              const id = String(target?.id || '').trim()
              if (!id) throw new Error('send 少了目标 id')
              const body = String(text || '').trim()
              if (!body) throw new Error('内容为空')
              await sendFn({ kind, id }, body)
            },
          }
        : {}),
      ...(permissions.includes('memory')
        ? {
            // 读 persona/ 下的文件：路径必须在 persona 内，不许用 .. 逃出去
            readPersona: async (relPath: string) => {
              const bad = relPath.includes('..') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)
              if (bad) throw new Error('路径不合法：' + relPath)
              const { readFileSync } = await import('node:fs')
              return readFileSync(join('persona', relPath), 'utf8')
            },
          }
        : {}),
      ...(permissions.includes('files')
        ? {
            // 读写的根是**这个插件自己的数据目录**（不是整个项目目录）。
            //
            // 以前根是 process.cwd()，等于给插件整个数据目录的读写权：
            // `.env`（API Key）、`persona/rules.yaml`、别的插件代码全都读得到。
            // 而 `files` 权限本来想给的是"插件读写自己的数据" ——
            // 现在根收窄到 dataDir，越界会抛"路径越界"。
            readFile: async (relPath: string) => {
              const { readFileSync } = await import('node:fs')
              return readFileSync(resolvePluginPath(dataDir, relPath), 'utf8')
            },
            writeFile: async (relPath: string, content: string) => {
              const { mkdirSync, writeFileSync } = await import('node:fs')
              const { dirname } = await import('node:path')
              const p = resolvePluginPath(dataDir, relPath)
              mkdirSync(dirname(p), { recursive: true })
              writeFileSync(p, String(content ?? ''), 'utf8')
            },
          }
        : {}),
    }
  }

  async function load(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (loaded.has(id)) {
        return { ok: false, error: 'already loaded' }
      }

      const { plugins } = await scanPlugins(pluginsRoot)
      for (const plugin of plugins) {
        known.set(plugin.manifest.id, { version: plugin.manifest.version })
      }

      const plugin = plugins.find((item) => item.manifest.id === id)
      if (!plugin) {
        const message = `未找到插件：${id}`
        recordError(id, message)
        return { ok: false, error: message }
      }
      if (!plugin.enabled) {
        const message = `插件已禁用：${id}`
        recordError(id, message)
        return { ok: false, error: message }
      }

      const entryPath = join(plugin.dir, plugin.manifest.entry)
      if (!isSupportedEntry(entryPath) || !existsSync(entryPath)) {
        const message = `插件入口不存在或类型不支持：${plugin.manifest.entry}`
        recordError(id, message)
        return { ok: false, error: message }
      }

      // 数据目录在激活前建好，插件 activate 里可以直接使用
      const dataDir = join(dataRoot, 'plugins', id)
      await mkdir(dataDir, { recursive: true })

      // 加查询串绕过 Node 的模块缓存，保证 reload 能拿到新模块
      const cacheKey = `${Date.now()}-${++importSerial}`
      const mod = (await import(pathToFileURL(entryPath).href + '?v=' + cacheKey)) as {
        default?: unknown
        activate?: unknown
        deactivate?: unknown
      }

      const defaultExport = mod.default
      const defaultObject =
        defaultExport !== null && typeof defaultExport === 'object'
          ? (defaultExport as Record<string, unknown>)
          : undefined

      const activate =
        typeof defaultExport === 'function'
          ? defaultExport
          : typeof mod.activate === 'function'
            ? mod.activate
            : defaultObject && typeof defaultObject['activate'] === 'function'
              ? defaultObject['activate']
              : undefined

      if (typeof activate !== 'function') {
        const message = '插件没有导出激活函数（default 或 activate）'
        recordError(id, message)
        return { ok: false, error: message }
      }

      const deactivateCandidate =
        typeof mod.deactivate === 'function'
          ? mod.deactivate
          : defaultObject && typeof defaultObject['deactivate'] === 'function'
            ? defaultObject['deactivate']
            : undefined
      const deactivate =
        typeof deactivateCandidate === 'function'
          ? (deactivateCandidate as (ctx: PluginContext) => unknown)
          : undefined

      const ctx = createContext(id, dataDir, plugin.manifest.permissions ?? [])
      // 激活函数允许是 async，这里统一 await —— 但必须有时限：
      // 一个永不 resolve 的 activate 会让插件页所有请求挂死（见 withTimeout 注释）
      await withTimeout(
        Promise.resolve(activate(ctx) as unknown) as Promise<unknown>,
        ACTIVATE_TIMEOUT_MS,
        `插件 ${id} 的 activate`,
      )

      // panel 类型的插件靠 module 里导出的 call 接待前端请求
      const rawCall = (mod as { call?: unknown }).call
      const call =
        typeof rawCall === 'function'
          ? (rawCall as (input: { action: string; payload?: unknown }) => Promise<unknown>)
          : undefined

      loaded.set(id, { version: plugin.manifest.version, ctx, deactivate, ...(call ? { call } : {}) })
      return { ok: true }
    } catch (err) {
      const message = `载入插件失败：${errorMessage(err)}`
      // 激活过程中可能已经订阅了事件**和注册过工具**，失败时一并清掉。
      //
      // 不清工具的话（原来只清了订阅）：插件在 activate 里注册了工具、然后抛异常，
      // 修好代码重载后那些旧工具会"复活"并继续跑旧实现 —— 用户以为修好了，
      // 实际调到的还是坏的那版。这类"半激活"状态最难解释。
      clearSubscriptions(id)
      for (const [name, item] of pluginTools) {
        if (item.pluginId === id) pluginTools.delete(name)
      }
      recordError(id, message)
      return { ok: false, error: message }
    }
  }

  /** 把这个插件通过 ctx 起的定时器全部清掉（卸载/重载时用） */
  function clearPluginTimers(id: string): void {
    const set = timerHandles.get(id)
    if (!set) return
    for (const { kind, handle } of set.values()) {
      if (kind === 'interval') clearInterval(handle)
      else clearTimeout(handle)
    }
    set.clear()
    timerHandles.delete(id)
  }

  async function unload(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = loaded.get(id)
    if (!record) return { ok: false, error: 'not loaded' }

    let error: string | undefined
    if (record.deactivate) {
      try {
        await record.deactivate(record.ctx)
      } catch (err) {
        error = `卸载插件失败：${errorMessage(err)}`
        recordError(id, error)
      }
    }

    // 即使 deactivate 抛错，也要把插件从内存里移除并清空订阅
    loaded.delete(id)
    clearSubscriptions(id)
    clearPluginTimers(id)
    // 清掉这个插件注册过的工具。
    // 不删的话：重载后 registerTool 会撞上旧条目、被当"工具重名"忽略，
    // 而 tools() 因为 pluginId 还"活着"继续返回旧模块的 run ——
    // 表现就是"重载成功了，但跑的还是旧代码"，错误还只进 host.errors。
    for (const [name, item] of pluginTools) {
      if (item.pluginId === id) pluginTools.delete(name)
    }
    return error ? { ok: false, error } : { ok: true }
  }

  async function reload(id: string): Promise<{ ok: boolean; error?: string }> {
    const before = await unload(id)
    const after = await load(id)

    const messages: string[] = []
    // 插件本来就没加载时，unload 的 'not loaded' 不算重载失败
    if (before.error && before.error !== 'not loaded') messages.push(before.error)
    if (after.error) messages.push(after.error)

    const result: { ok: boolean; error?: string } = { ok: after.ok }
    if (messages.length > 0) result.error = messages.join('; ')
    return result
  }

  function list(): { id: string; loaded: boolean; version: string }[] {
    const ids = new Set<string>([...known.keys(), ...loaded.keys()])
    return [...ids].sort().map((id) => {
      const current = loaded.get(id)
      const version = current?.version ?? known.get(id)?.version ?? '0.0.0'
      return { id, loaded: current !== undefined, version }
    })
  }

  /**
   * 插件注册的工具，包装成宿主的 Tool 形状，供 index.ts 注册进 ToolRegistry。
   * 没加载/已卸载的插件，它的工具不会出现在这里。
   */
  function tools(): Array<{ name: string; pluginId: string; description: string; parameters: Record<string, unknown>; run: (args: Record<string, unknown>) => Promise<string> }> {
    const alive = new Set([...loaded.keys()])
    const out: Array<{ name: string; pluginId: string; description: string; parameters: Record<string, unknown>; run: (args: Record<string, unknown>) => Promise<string> }> = []
    for (const [name, item] of pluginTools) {
      if (!alive.has(item.pluginId)) continue
      out.push({
        name,
        pluginId: item.pluginId,
        description: String(item.tool.description || ''),
        parameters: item.tool.parameters || { type: 'object', properties: {} },
        run: async (args: Record<string, unknown>) => {
          try {
            return await withTimeout(
              Promise.resolve(item.tool.run(args)),
              TOOL_TIMEOUT_MS,
              `插件工具 ${name}`,
            )
          } catch (err) {
            return `插件工具执行失败：${String(err).slice(0, 160)}`
          }
        },
      })
    }
    return out
  }

  /**
   * 把前端的调用转给插件的 `call` 导出（panel 类型用）。
   *
   * 插件没导出 call 时给一句人话，别让前端看到 "xxx is not a function"。
   */
  async function invoke(id: string, input: { action: string; payload?: unknown }): Promise<unknown> {
    const plugin = loaded.get(id)
    if (!plugin) throw new Error(`插件 ${id} 没在运行`)
    if (!plugin.call) {
      throw new Error(`插件 ${id} 没有导出 call（panel 类型需要在入口里 export function call({action,payload})）`)
    }
    // 面板请求也要有时限：否则一个卡住的 call 会让前端按钮永远转圈
    return await withTimeout(Promise.resolve(plugin.call(input)), CALL_TIMEOUT_MS, `插件 ${id} 的 call`)
  }

  return { load, unload, reload, list, errors, tools, invoke }
}

/**
 * 给插件的异步调用加个时限。
 *
 * 为什么必须有：`activate` / `call` / `tool.run` 原来都是裸 `await`。
 * 插件里写 `await new Promise(() => {})`（等一个永不返回的请求）时：
 *   - `start()` 永远不结束 → `pluginReady` 永远 pending
 *   - 于是**所有** `/api/plugins/*` 请求挂起不返回（打开插件页都转圈）
 *   - 后面的插件也永远不加载
 * 而用户看到的只是"插件页打不开"，日志里什么都没有。
 *
 * 超时不是"惩罚插件"，是让宿主能说话：超时后按失败处理，
 * 记进 host.errors，界面上能看到"这个插件激活超时"。
 * 注意：这里只能管**异步**。插件里的同步死循环（while(true)）挡不住，
 * 那需要进程级隔离（见 .team/design-plugin-isolation.md）。
 */
function withTimeout<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`${what} 超时（${Math.round(ms / 1000)} 秒没返回）`))
    }, ms)
    // 定时器不该拖住进程退出
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    Promise.resolve(p).then(
      (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 各种插件调用的时限：激活给足（插件可能要做初始化），其它收紧 */
const ACTIVATE_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000
const TOOL_TIMEOUT_MS = 60_000
