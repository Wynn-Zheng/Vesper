/**
 * 控制台 API 的公共 HTTP 助手。
 *
 * 为什么单独一个文件：`desktop-api` / `member-api` / `misc-api` / `settings-api` /
 * `test-api` 原来各抄了一份一模一样的 `safeJson()`（逐字 10 行 ×5），
 * `server.ts` 里还有第 6 份 `readJson`。改一次规则要改六处，所以收成一处。
 */

/**
 * 把请求体文本解析成 JSON 对象。
 *
 * 约定（六处原来都是这个行为，保持兼容）：
 * - 空 body / 全是空白 → `{}`
 * - 非法 JSON → 抛「请求体不是合法 JSON」，外层 catch 映射成 400
 * - 合法但不是对象（数组 / 数字 / null）→ `{}`
 */
export function parseJsonBody(text: string): Record<string, unknown> {
  if (!text || !text.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}
