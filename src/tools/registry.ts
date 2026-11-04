import { warnAt } from '../core/log.ts'
import { isLocalTool } from './local.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

/**
 * 工具注册表。
 *
 * 现在一个工具都没注册——这是刻意的：先留位置，不写死架构。
 * 以后加工具只需要：
 *   1. 实现 Tool 接口
 *   2. 在 index.ts 里 registry.register(...)
 *   3. 在 loop/chat.ts 里把 registry 传给 generateReply
 * 调用链（boot → chat → send）不用动。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      warnAt(`工具重名，已覆盖：${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * 摘掉一个工具。
   *
   * 用在插件重载/卸载：插件工具的实现会变，旧 wrapper 还闭包着旧模块。
   * 不摘的话，控制台里"测试"跑的是新代码、模型调的还是旧代码（实测 BUG3-21），
   * 用户看到"重载成功"但聊天里行为没变，只有重启后端才好。
   */
  remove(name: string): boolean {
    return this.tools.delete(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }

  /** 执行一次工具调用。失败不抛，转成错误文本交给模型自己处理。 */
  async run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { name, ok: false, content: `没有这个工具：${name}` }
    // 权限门放在唯一的执行入口上，而不是散落在调用方：
    // 以前只有 loop/chat.ts 里手写了一次检查，插件工具和别的调用点都能绕过去。
    if (isLocalTool(name) && !(ctx.isOwner === true && !ctx.scope.startsWith('group:'))) {
      return { name, ok: false, content: '这个操作只能由主人私聊发起，在群里/别人那里不能做' }
    }
    try {
      const content = await tool.run(args, ctx)
      return { name, ok: true, content }
    } catch (err) {
      return { name, ok: false, content: `工具执行失败：${String(err).slice(0, 120)}` }
    }
  }
}

/** 全局注册表：现在空着，等真正需要工具时往里加 */
export const tools = new ToolRegistry()
