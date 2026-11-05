/**
 * panel 类型插件的后端。
 *
 * 前端（panel.html）在 iframe 里，通过
 *   POST /api/plugins/demo-panel/call  { action, payload }
 * 调到这里。
 *
 * 宿主约定：
 *   - `activate(ctx)` 里注册一个 `ctx.panel = { call }` 之类的东西；
 *   - 这个示例没用到宿主的新 API，就是普通的 event 插件跑在同一个 ctx 上。
 *
 * 计数存自己的 dataDir（宿主会建好），不碰别人的文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let ctxRef = null

function counterFile() {
  return join(ctxRef.dataDir, 'count.txt')
}

function readCount() {
  try {
    return Number(readFileSync(counterFile(), 'utf8').trim()) || 0
  } catch {
    return 0
  }
}

function writeCount(n) {
  try {
    mkdirSync(ctxRef.dataDir, { recursive: true })
    writeFileSync(counterFile(), String(n), 'utf8')
  } catch {
    /* 记不上不影响返回 */
  }
}

/**
 * 面板调进来的入口。
 *
 * 为什么导出成函数：宿主在路由 `/api/plugins/<id>/call` 时
 * 会找这个模块导出的 `call`，把 { action, payload } 原样交给它。
 */
export async function call({ action }) {
  switch (action) {
    case 'ping':
      return { pong: true, greeting: String(ctxRef?.config?.greeting ?? '你好'), at: Date.now() }
    case 'count': {
      const n = readCount() + 1
      writeCount(n)
      return { count: n }
    }
    default:
      throw new Error('未知 action：' + String(action))
  }
}

export function activate(ctx) {
  ctxRef = ctx
  ctx.log('示例面板后端已就绪')
}

export function deactivate(ctx) {
  ctx.log('示例面板后端已卸载')
  ctxRef = null
}
