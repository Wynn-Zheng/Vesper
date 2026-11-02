import type { ToolRegistry } from './registry.ts'
import type { Tool } from './types.ts'

/**
 * 把"插件当前的工具表"同步进注册表。
 *
 * 为什么要单独一个函数：插件重载/卸载后必须让模型也换到新实现。
 * 以前的写法是"见到重名就跳过"，于是重载后注册表里还留着旧 wrapper ——
 * 控制台里点"测试"跑的是新代码，聊天里模型调的还是旧的（实测 BUG3-21），
 * 用户只有重启后端才恢复。而这种"看起来成功了其实没生效"的 bug，
 * 靠读代码很难发现，所以抽出来单独测。
 *
 * 规则：
 *   1. 上次由插件注册、这次不在表里的名字 → 摘掉（插件被卸载/改名）
 *   2. 名字和**内置工具**冲突 → 跳过并留下 warn（插件不该顶掉 read_code 之类）
 *   3. 其余一律注册/覆盖 —— 覆盖只发生在"上次也是插件注册的"那些名字上
 */
export function syncPluginTools(
  registry: ToolRegistry | null,
  tools: Tool[],
  pluginNames: Set<string>,
  onWarn?: (message: string) => void,
  onInfo?: (message: string) => void,
): void {
  if (!registry) return
  const incoming = new Set(tools.map((t) => t.name))

  for (const old of [...pluginNames]) {
    if (incoming.has(old)) continue
    registry.remove(old)
    pluginNames.delete(old)
    onInfo?.(`插件工具已注销：${old}`)
  }

  for (const t of tools) {
    const existing = registry.get(t.name)
    if (existing && !pluginNames.has(t.name)) {
      onWarn?.(`插件工具和内置工具重名，跳过：${t.name}`)
      continue
    }
    registry.register(t)
    pluginNames.add(t.name)
    onInfo?.(`插件工具已注册：${t.name}`)
  }
}
