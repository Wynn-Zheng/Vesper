import type { ToolCall } from '../tools/types.ts'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 多模态内容的一段：文字或图片 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: Role
  /** 纯文本，或者文字+图片混合 */
  content: string | ContentPart[]
  /** role = tool 时，对应哪个调用 */
  toolCallId?: string
  /** role = assistant 且模型要调工具时，这里放着它要调的东西 */
  toolCalls?: ToolCall[]
}

/** 传给模型的工具定义（OpenAI / DeepSeek 的 function-calling 格式） */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmOptions {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  /**
   * 工具定义。现在没有注册任何工具，所以一直是 undefined。
   * 以后接工具时这个字段会真的传下去，调用链不用改。
   */
  tools?: ToolSpec[]
}

export interface LlmResult {
  /** 模型说的正文。要调工具时可能为空 */
  text: string
  /** 模型要求调用的工具。现在永远为空，但结构已经留好 */
  toolCalls?: ToolCall[]
  usage?: { prompt: number; completion: number; total: number }
}
