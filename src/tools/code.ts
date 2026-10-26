/**
 * 它自己的代码阅读工具。
 *
 * 背景：它一直说"我看不到自己的代码"，但 diagnose.ts 里其实有读代码的函数——
 * 只是那些只给自诊断用，没接成对话里能调的工具。
 *
 * 这里把能力包成 Tool，接进工具循环。
 *
 * 安全边界（重要）：
 *   - 只能读 src/ 下的 .ts，别的一律拒绝（persona/ 有别人的私事，data/ 有日志）
 *   - 不能写、不能删、不能执行
 *   - 单次返回有上限，防止一段代码把上下文撑爆
 */
import { findCallers, readSlice, readSourceAt, searchCode } from '../self/diagnose.ts'
import type { Tool } from './types.ts'

/** 读某个文件的某几行 */
export const readCodeTool: Tool = {
  name: 'read_code',
  description:
    '读自己源码的某几行。参数 file 是相对路径（比如 src/loop/chat.ts），from/to 是行号。' +
    '想知道"我这段代码是怎么写的"时用它。只能读 src/ 下的 .ts 文件。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '相对路径，比如 src/loop/chat.ts' },
      from: { type: 'integer', description: '起始行号，从 1 开始' },
      to: { type: 'integer', description: '结束行号' },
    },
    required: ['file', 'from', 'to'],
  },
  async run(args) {
    const file = String(args['file'] ?? '')
    const from = Number(args['from'] ?? 1)
    const to = Number(args['to'] ?? from + 40)
    const slice = readSlice(file, Math.max(1, from), Math.max(1, to))
    if (!slice) return JSON.stringify({ error: `读不到 ${file}:${from}-${to}（文件不存在、越界，或者不在 src/ 下）` })
    return `${slice.file}:${slice.from}-${slice.to}\n${slice.code}`
  },
}

/** 按错误位置读上下文 */
export const readAroundTool: Tool = {
  name: 'read_around',
  description:
    '按"文件:行号"读那一段前后的代码。适合看某个报错位置附近是怎么回事。' +
    '参数 where 形如 src/llm/deepseek.ts:108。',
  parameters: {
    type: 'object',
    properties: {
      where: { type: 'string', description: '形如 src/llm/deepseek.ts:108' },
      around: { type: 'integer', description: '前后各看多少行，默认 35' },
    },
    required: ['where'],
  },
  async run(args) {
    const where = String(args['where'] ?? '')
    const around = Math.min(80, Math.max(5, Number(args['around'] ?? 35)))
    const slice = readSourceAt(where, around)
    if (!slice) return JSON.stringify({ error: `读不到 ${where}（格式不对、文件不存在，或者不在 src/ 下）` })
    return `${slice.file}:${slice.from}-${slice.to}\n${slice.code}`
  },
}

/** 搜代码 */
export const searchCodeTool: Tool = {
  name: 'search_code',
  description:
    '在自己的源码里搜一段文字，返回命中的行和文件位置。' +
    '想知道"这个功能是在哪个文件实现的""这个词出现在哪"时用它。至少要 2 个字。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜的文字，至少 2 个字' },
      limit: { type: 'integer', description: '最多返回几条，默认 8' },
    },
    required: ['query'],
  },
  async run(args) {
    const q = String(args['query'] ?? '')
    const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 8)))
    const hits = searchCode(q, limit)
    if (!hits.length) return JSON.stringify({ hits: [], note: `没搜到「${q}」` })
    return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
  },
}

/** 找谁调用了某个函数 */
export const findCallersTool: Tool = {
  name: 'find_callers',
  description:
    '找出某个函数/变量名在哪些地方被用到。想知道"这个函数是谁在调"时用它。' +
    '参数 name 是函数名（不加括号）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '函数或变量名' },
      limit: { type: 'integer', description: '最多返回几条，默认 8' },
    },
    required: ['name'],
  },
  async run(args) {
    const n = String(args['name'] ?? '')
    const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 8)))
    const hits = findCallers(n, limit)
    if (!hits.length) return JSON.stringify({ hits: [], note: `没找到谁用了「${n}」` })
    return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
  },
}

/** 全部读代码相关的工具 */

/**
 * 重新扫一遍自己的结构。
 *
 * 什么时候用：用户说"你重新扫一遍""你是不是又变了"。
 * 平时不用——地图在每次代码改动后会自动更新，进 prompt 的是最新版。
 */
export const rescanCodeTool: Tool = {
  name: 'rescan_code',
  description:
    '重新扫一遍自己的源码结构，更新"我长什么样"那份地图。' +
    '只在用户明确要求（"你重新扫一遍""看看你现在什么结构"）时用，平时不用调。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async run() {
    const { refreshCodeMap, loadCodeMapBrief } = await import('../self/codemap.ts')
    const r = refreshCodeMap(true)
    return `扫完了：${r.modules} 块。
${loadCodeMapBrief()}`
  },
}


/**
 * 申请把某条记成核心记忆。
 *
 * **它只能申请，不能写入**——core.md 只有人能改。
 * 这是故意的：让它自己判断"什么该永远记住"必然膨胀
 * （现在给它打 importance 分，24 条经验全给 8 分）。
 */
export const requestCoreTool: Tool = {
  name: 'request_core',
  description:
    '你觉得某件事是"不能弄错"的（身份/边界/诺言/偏好），可以提申请让人批准写进核心记忆。' +
    '你不是直接写，是提交一个申请，人看过才生效。' +
    '只在对方明确表达过边界、承诺、或身份信息时用，不要每句都提。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '想记成核心的那句话，一句，具体' },
      kind: {
        type: 'string',
        enum: ['身份', '边界', '诺言', '偏好'],
        description: '身份=他是谁；边界=不许干什么；诺言=答应过的事；偏好=长期喜欢/讨厌',
      },
      reason: { type: 'string', description: '为什么觉得该永远记住，一句话' },
    },
    required: ['text', 'kind'],
  },
  async run(args) {
    const { requestCore } = await import('../memory/core.ts')
    const text = typeof args['text'] === 'string' ? args['text'] : ''
    const kind = typeof args['kind'] === 'string' ? args['kind'] : '身份'
    const reason = typeof args['reason'] === 'string' ? args['reason'] : ''

    const validKind = ['身份', '边界', '诺言', '偏好'].includes(kind) ? (kind as '身份' | '边界' | '诺言' | '偏好') : '身份'
    const r = requestCore(text, validKind, reason)
    return r.ok ? `申请已提交（${validKind}），等人批。` : `没提成：${r.why}`
  },
}

export const codeTools: Tool[] = [
  requestCoreTool,
  readCodeTool,
  readAroundTool,
  searchCodeTool,
  findCallersTool,
  rescanCodeTool,
]
