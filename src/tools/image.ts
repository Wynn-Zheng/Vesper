/**
 * 发图片工具。
 *
 * 背景：截图工具（desktop.ts）跑完只返回一个本地 path 字符串，
 * 模型手里有路径却没手段把它发出去 —— 于是出现「截到了」但用户什么也没收到。
 *
 * sendImage 本身一直存在（channel/send.ts），OneBot 那边也注入了默认通道
 * （onebot.ts 的 setImageTransport），只是没有工具把它暴露给模型。
 *
 * 安全边界：
 *   - 只允许发本地文件，且必须是图片后缀
 *   - 大小上限交给 sendImage（它自己会检查 2MB）
 *   - 不发远程 URL（避免"帮我发这张网图"变成 SSRF 入口）
 */
import { existsSync, statSync } from 'node:fs'
import type { Target } from '../core/types.ts'
import { sendImage } from '../channel/send.ts'
import type { Tool } from './types.ts'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 把 scope（"private:123" / "group:456"）转成发送目标 */
function targetOfScope(scope: string): Target | null {
  if (scope.startsWith('group:')) {
    const id = scope.slice('group:'.length)
    return id ? { kind: 'group', id } : null
  }
  if (scope.startsWith('private:')) {
    const id = scope.slice('private:'.length)
    return id ? { kind: 'private', id } : null
  }
  return null
}

export const sendImageTool: Tool = {
  name: 'send_image',
  description:
    '把一张本地图片发给对方。' +
    '截图（screenshot）之后想把画面给对方看，就用这个把返回的 path 发出去。' +
    '只能发本地图片文件（png/jpg/gif/webp/bmp），不能发网址。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '本地图片的完整路径，比如截图工具返回的那个 path',
      },
    },
    required: ['path'],
  },

  async run(args, ctx) {
    const path = String(args['path'] ?? '').trim()

    if (!path) return JSON.stringify({ ok: false, error: '缺少 path' })
    if (/^https?:/i.test(path)) {
      return JSON.stringify({ ok: false, error: '只能发本地图片，不能发网址' })
    }
    if (!IMAGE_EXT.test(path)) {
      return JSON.stringify({ ok: false, error: `不是图片文件：${path}` })
    }
    if (!existsSync(path)) {
      return JSON.stringify({ ok: false, error: `文件不存在：${path}` })
    }

    let size = 0
    try {
      size = statSync(path).size
    } catch {
      /* 下面 sendImage 会再报 */
    }
    if (size > 2 * 1024 * 1024) {
      return JSON.stringify({ ok: false, error: `图片太大（${(size / 1024 / 1024).toFixed(1)}MB），上限 2MB` })
    }

    const target = targetOfScope(ctx.scope)
    if (!target) return JSON.stringify({ ok: false, error: `不支持的会话：${ctx.scope}` })

    try {
      await sendImage(target, path)
      return JSON.stringify({ ok: true, sent: path })
    } catch (e) {
      // 发失败要如实告诉模型，别让它以为发出去了还继续说"看这个"
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  },
}
