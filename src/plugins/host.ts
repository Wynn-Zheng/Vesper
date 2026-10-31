/**
 * 插件宿主：负责单个插件的载入、卸载与重载，并维护插件内事件订阅。
 * 插件代码的异常一律在宿主内部消化，写进 errors，不让调用方看到未捕获的异常。
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanPlugins } from './registry.ts'
import { getPluginConfig } from './settings.ts'

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
   * permissions 含 shell 时存在：跑一条命令。
   *
   * 只接受**白名单里的可执行文件**（见 SHELL_ALLOW），不经过 shell
   * （所以 `;` `|` `&&` 不会生效，参数按数组传）。超时 10 秒。
   */
  exec?: (cmd: string, args?: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

type Handler = (payload: unknown) => void

/**
 * shell 权限的白名单。
 *
 * 为什么是白名单：可执行文件太多，黑名单永远列不全；
 * 而且这功能的定位是"给它一个小工具"（看个时间、算个数、查个目录），
 * 不是通用终端。真需要更多能力，应该写进插件代码里而不是加白名单。
 *
 * 刻意不含：rm/del/mv/curl/wget/powershell/cmd/sh —— 这些能造成不可逆破坏。
 */
const SHELL_ALLOW = new Set([
  'echo', 'date', 'dir', 'ls', 'cat', 'type', 'findstr', 'grep',
  'node', 'python', 'python3', 'git', 'wc', 'head', 'tail', 'sort', 'uniq',
])

/**
 * 把插件给的相对路径解析成项目内的绝对路径。
 *
 * 光在字符串里挡 `..` 不够：`data/../../etc/passwd` 拼接后字符串里有 `..`，
 * 但 `data/x/../../../etc` 这种也可能绕过简单判断。所以 **resolve 之后**
 * 再比对根目录，这样 `..` 怎么嵌套都逃不出去。
 */
function safePath(relPath: string): string {
  const root = resolve(process.cwd())

  const abs = resolve(root, String(relPath ?? ''))
  // 必须等于根，或者以 "根 + 分隔符" 开头（防止 /root2 被 /root 误判为子目录）
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('路径越界：' + relPath)
  }
  return abs
}

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
}) {
  const pluginsRoot = options.pluginsRoot
  const dataRoot = options.dataRoot
  const settingsFile = options.settingsFile ?? join('persona', 'plugins.yaml')
  const logger = options.logger ?? defaultLogger
  const sendFn = options.send

  const errors: { id: string; message: string }[] = []
  /** 已成功激活的插件 */
  const loaded = new Map<string, LoadedPlugin>()
  /** 扫描到过的插件及其版本，用于 list() 展示未加载的插件 */
  const known = new Map<string, KnownPlugin>()
  const hostKey = `host-${++hostSerial}`
  /** 插件注册的工具：key = 工具名，value = 注册它的插件 id + 工具本体 */
  const pluginTools = new Map<string, { pluginId: string; tool: PluginTool }>()

  const eventKey = (id: string, event: string): string => `${hostKey}\u0000${id}\u0000${event}`

  /** 记录错误：既进 errors 数组，也交给 logger，方便外部排查 */
  function recordError(id: string, message: string): void {
    errors.push({ id, message })
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
        handler(payload)
      } catch (err) {
        recordError(id, `事件 ${event} 的处理器执行失败：${errorMessage(err)}`)
      }
    }
  }

  /** 只暴露这些字段，插件拿不到 process.env、require 等宿主能力 */
  function createContext(id: string, dataDir: string, permissions: string[] = []): PluginContext {
    return {
      id,
      dataDir,
      // 激活时读一次快照：运行中改配置要 reload 才生效，
      // 但比每次访问都读文件省事，也不会读到写了一半的 YAML
      config: getPluginConfig(settingsFile, id),
      log: (message: string) => info(message),
      on: (event: string, handler: Handler) => subscribe(id, event, handler),
      emit: (event: string, payload?: unknown) => dispatch(id, event, payload),
      registerTool: (tool: PluginTool) => {
        const name = String(tool?.name || '').trim()
        if (!name) { recordError(id, 'registerTool 少了 name，忽略') ; return }
        if (pluginTools.has(name)) {
          recordError(id, `工具重名，已忽略：${name}（已被 ${pluginTools.get(name)!.pluginId} 注册）`)
          return
        }
        pluginTools.set(name, { pluginId: id, tool })
      },
      // 按 permissions 挂能力：没声明就不给这个入口
      ...(permissions.includes('net')
        ? {
            fetch: (url: string, init?: RequestInit) => fetch(url, init),
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
            // 读写项目目录内的文件。
            //
            // 安全边界：解析后的**真实路径**必须以项目根开头。
            // 只在字符串层挡 `..` 不够 —— `data/../../../etc/passwd` 拼出来
            // 字符串里没有 `..` 前缀但 resolve 之后跑出去了，所以用 resolve 再比。
            // 符号链接也按真实路径算（realpath），免得链到外面去。
            readFile: async (relPath: string) => {
              const { readFileSync } = await import('node:fs')
              return readFileSync(safePath(relPath), 'utf8')
            },
            writeFile: async (relPath: string, content: string) => {
              const { mkdirSync, writeFileSync } = await import('node:fs')
              const { dirname } = await import('node:path')
              const p = safePath(relPath)
              mkdirSync(dirname(p), { recursive: true })
              writeFileSync(p, String(content ?? ''), 'utf8')
            },
          }
        : {}),
      ...(permissions.includes('shell')
        ? {
            // 跑命令：只允许白名单里的程序，不经过 shell，10 秒超时。
            //
            // 为什么白名单而不是黑名单：可执行文件太多，黑名单永远列不全；
            // 而且这是"给它一个小工具"的场景，不是通用终端。
            exec: async (cmd: string, args: string[] = []) => {
              const name = String(cmd || '').trim()
              if (!SHELL_ALLOW.has(name)) {
                throw new Error(`不允许执行 ${name}（只允许：${[...SHELL_ALLOW].join(', ')}）`)
              }
              const { execFile } = await import('node:child_process')
              const list = args.map((a) => String(a))
              return await new Promise((resolveP, rejectP) => {
                execFile(
                  name,
                  list,
                  { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
                  (err, stdout, stderr) => {
                    if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
                      rejectP(new Error(`${name} 超时（10 秒）`))
                      return
                    }
                    resolveP({
                      code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0,
                      stdout: String(stdout ?? '').slice(0, 64 * 1024),
                      stderr: String(stderr ?? '').slice(0, 64 * 1024),
                    })
                  },
                )
              })
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
      // 激活函数允许是 async，这里统一 await
      await (activate as (ctx: PluginContext) => unknown)(ctx)

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
      // 激活过程中可能已经订阅了事件，失败时一并清掉
      clearSubscriptions(id)
      recordError(id, message)
      return { ok: false, error: message }
    }
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
            return await item.tool.run(args)
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
    return await plugin.call(input)
  }

  return { load, unload, reload, list, errors, tools, invoke }
}
