/**
 * 找源码目录。
 *
 * 开发时源码就在 cwd/src；打包后 cwd 是用户数据目录（%APPDATA%/qqbot/data-root），
 * 那里没有 src，源码在 resources/app/src。
 *
 * 之前 codemap / 读代码工具都写死 'src'，打包后每次消息都报
 * "扫不了 src/: ENOENT"，而且"读自己的代码"这个能力整个失效。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 源码目录的绝对/相对路径（保证 existsSync 为真；真找不到就返回 'src' 让调用方报错） */
export function srcRoot(): string {
  const root = process.env['QQBOT_ROOT']
  const candidates: string[] = []
  if (root) candidates.push(join(root, 'src'))
  candidates.push('src')
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'src'
}

/**
 * 把 "src/loop/chat.ts" 这种逻辑路径转成实际可读的路径。
 *
 * 逻辑路径永远以 src/ 开头（模型和文档里都是这么写的），
 * 实际磁盘位置打包前后不一样 —— 这里做一次映射。
 */
export function resolveSrcPath(logical: string): string | null {
  if (!logical.startsWith('src/')) return null
  const rest = logical.slice('src/'.length)
  return join(srcRoot(), rest)
}
