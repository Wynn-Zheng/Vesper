import type { Rules } from '../core/config.ts'
import type { Transport } from '../core/transport.ts'
import type { Target } from '../core/types.ts'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function rand([min, max]: [number, number]): number {
  return Math.floor(min + Math.random() * (max - min))
}

const HARD_BREAK = /([。！？!?～~…]+|[\n]+)/
const SOFT_BREAK = /([，,、；;：:]+)/

/**
 * 按语义切句，不按字数硬切。
 * 1) 先按句末标点和换行切
 * 2) 单句仍超长，按逗号类切
 * 3) 还超长，才硬切
 * 4) 超过 maxParts 的合并进最后一条（宁可长一点，也别发一串）
 */
export function splitBySentence(text: string, maxLen: number, maxParts: number): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (!clean) return []

  const sentences: string[] = []
  let buf = ''
  for (const chunk of clean.split(HARD_BREAK)) {
    if (!chunk) continue
    if (HARD_BREAK.test(chunk)) {
      buf += chunk
      if (buf.trim()) sentences.push(buf.trim())
      buf = ''
    } else {
      buf += chunk
    }
  }
  if (buf.trim()) sentences.push(buf.trim())

  const sized: string[] = []
  for (const s of sentences) {
    if (s.length <= maxLen) {
      sized.push(s)
      continue
    }
    for (const piece of s.split(SOFT_BREAK)) {
      const p = piece.trim()
      if (!p) continue
      if (p.length <= maxLen) sized.push(p)
      else for (let i = 0; i < p.length; i += maxLen) sized.push(p.slice(i, i + maxLen))
    }
  }

  if (sized.length <= maxParts) return sized

  // 超了条数上限：只发前 maxParts 条。
  // 以前是"剩下全拼进最后一条"，结果最后一条能有几百字，违背每条不超过 maxLen 的约束。
  // 模型本来就不该说这么多，截掉比发一坨更像人。
  return sized.slice(0, maxParts)
}

/** 分句 + 间隔发送。返回实际发出的每条消息 id（平台支持时）。 */
export async function say(t: Transport, to: Target, text: string, rules: Rules): Promise<string[]> {
  const parts = splitBySentence(text, rules.说话.每条最多字数, rules.说话.每轮最多条数)
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(rand(rules.说话.条间延迟))
    // 只有第一条引用：不然分句发 3 条会引用同一条三次，像刷屏
    const here = i === 0 ? to : { ...to, replyTo: undefined }
    const res = await t.send(here, parts[i]!)
    if (res && typeof res === 'object' && res.messageId) ids.push(res.messageId)
  }
  return ids
}
