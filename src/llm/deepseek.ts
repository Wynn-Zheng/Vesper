import { warnAt, errorAt } from '../core/log.ts'
import type { ChatMessage, LlmOptions, LlmResult } from './types.ts'

/** 会被重试的错误：网络问题、5xx、限流 */
class RetryableError extends Error {}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 区分"该重试的网络抖动"和"重试也没用的错误"。
 *
 * fetch 失败时抛的是 TypeError('fetch failed')，底层原因挂在 cause 上
 * （ECONNRESET / ENOTFOUND / UND_ERR_CONNECT_TIMEOUT 等）；
 * AbortSignal.timeout 抛的是 DOMException，name 为 TimeoutError / AbortError。
 * 这些都是一次性的，等一会儿再来通常就好。
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const text = `${err.name} ${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket hang up|TimeoutError|AbortError|aborted/i.test(
    text,
  )
}

/**
 * 调一次模型。失败按"可重试/不可重试"区分：
 * - 401/400/422 视为配置错误，直接抛，不浪费配额
 * - 网络错误、429、5xx 重试 2 次
 */

/**
 * 把内部消息转成 API 要的形状。
 *
 * 内部用 camelCase（toolCallId / toolCalls），API 要 snake_case（tool_call_id / tool_calls）。
 * 之前直接 JSON.stringify 发出去，接上工具后第一次调用就 422：
 *   messages[5]: missing field `tool_call_id`
 */
function toWire(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.toolCallId) out['tool_call_id'] = m.toolCallId
  if (m.toolCalls?.length) {
    out['tool_calls'] = m.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
    }))
    // assistant 带 tool_calls 时 content 不能是空字符串以外的怪东西
    if (!m.content) out['content'] = null
  }
  return out
}

export async function chat(messages: ChatMessage[], opts: LlmOptions): Promise<LlmResult> {
  const body = JSON.stringify({
    model: opts.model,
    messages: messages.map(toWire),
    temperature: opts.temperature ?? 1.0,
    max_tokens: opts.maxTokens ?? 300,
    stream: false,
    // 有工具才传；tool_choice=auto 让它自己决定要不要翻代码
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
  })

  const delays = [500, 1500]
  let lastErr: Error = new Error('unknown')

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      // 配置缺了就直说，别让它崩在 baseUrl.replace 上
  if (!opts.baseUrl) throw new Error('模型没有配置 baseUrl（检查 .env 的 DEEPSEEK_BASE_URL）')
  if (!opts.apiKey) throw new Error('模型没有配置 apiKey（检查 .env 的 DEEPSEEK_API_KEY）')
  if (!opts.model) throw new Error('模型没有配置 model（检查 .env 的 DEEPSEEK_MODEL）')

  const res = await fetch(endpoint(opts.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const msg = `HTTP ${res.status} ${detail.slice(0, 300)}`
        if (res.status === 401 || res.status === 400 || res.status === 422) {
          throw new Error(`模型配置有问题：${msg}`)
        }
        throw new RetryableError(msg)
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string
            tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>
          }
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }

      const msg = data.choices?.[0]?.message
      const text = msg?.content?.trim() ?? ''

      // 模型要求调工具：参数是 JSON 字符串，坏了就当空对象（让工具自己报错，别在这崩）
      const toolCalls = (msg?.tool_calls ?? [])
        .map((c) => {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(c.function?.arguments ?? '{}') as Record<string, unknown>
          } catch {
            /* 参数坏了就当空对象 */
          }
          return { id: c.id, name: c.function?.name ?? '', args }
        })
        .filter((c) => c.name)

      if (!text && !toolCalls.length) throw new RetryableError('模型返回了空内容')

      return {
        text,
        ...(toolCalls.length ? { toolCalls } : {}),
        usage: data.usage
          ? {
              prompt: data.usage.prompt_tokens ?? 0,
              completion: data.usage.completion_tokens ?? 0,
              total: data.usage.total_tokens ?? 0,
            }
          : undefined,
      }
    } catch (err) {
      lastErr = err as Error
      // fetch 自己抛的网络错误（DNS、连接重置、AbortSignal.timeout 的超时）
      // 不是 RetryableError，以前一律当"不该重试"直接 break —— 结果一次抖动就失败。
      const retryable = err instanceof RetryableError || isTransientNetworkError(err)
      if (!retryable || attempt === delays.length) break
      const wait = delays[attempt] ?? 1500
      warnAt(`模型调用失败，${wait}ms 后重试（第 ${attempt + 1} 次）`, { err: lastErr.message })
      await sleep(wait)
    }
  }

  errorAt('模型调用最终失败', { err: lastErr.message })
  throw lastErr
}
