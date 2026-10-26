/** 工具调用的通用结构。现在没有实现任何工具，但接口先定下来，以后加不用改调用链。 */

/** 模型请求调用一个工具 */
export interface ToolCall {
  id: string
  name: string
  /** 模型给的参数，已经解析成对象 */
  args: Record<string, unknown>
}

/** 工具执行时能拿到的东西 */
export interface ToolContext {
  /** 当前对话的人 */
  personId: string
  /** 私聊某人 / 某个群 */
  scope: string
  now: Date
}

export interface Tool {
  name: string
  /** 给模型看的说明：什么时候该用它 */
  description: string
  /** JSON Schema，描述参数 */
  parameters: Record<string, unknown>
  /** 执行，返回一段文本交给模型 */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export interface ToolResult {
  name: string
  ok: boolean
  /** 交给模型的内容，失败时是错误说明 */
  content: string
}
