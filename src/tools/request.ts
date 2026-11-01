/**
 * 它主动提申请的工具。
 *
 * 用于"我真想改这个，但改不动"——比如名字是主人定的、
 * 自述被锁住了、规矩是主人加的。
 *
 * 设计取向：
 *   - 不鼓励它频繁提。description 里写清"确实想改才用"。
 *   - 它也可以直接在聊天里说，两种路都行；说出来的那些
 *     用户当场就能处理，走这个工具的多半是主人不在的时候。
 */
import { requestChange, type RequestTarget } from '../self/requests.ts'
import type { Tool } from './types.ts'

// person 的 apply 还没实现（apply.ts 里写死返回失败），先不暴露给模型：
// 提了也批不了，而失败时又不会出队（server.ts 有意为之），会永久堵住这个名额。
const TARGETS: RequestTarget[] = ['name', 'about', 'traits']

export const requestChangeTool: Tool = {
  name: 'request_change',
  description:
    '你想改某个关于自己的设定，但它被主人锁着（比如名字、自述、规矩），就用这个提申请。' +
    '只在**确实想改**的时候用，不要为了讨好或试探而提。' +
    '提了不会立刻生效，要等主人批。' +
    '如果你只是想跟主人商量，直接在聊天里说就行，不一定要用这个。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: TARGETS,
        description: '要改哪一项：name=名字, about=自述, traits=自己定的规矩, person=人物档案',
      },
      content: {
        type: 'string',
        description: '想改成什么（直接写新内容，不要写"请求修改…"这种话）',
      },
      reason: {
        type: 'string',
        description: '为什么想改。要具体，不能空。',
      },
    },
    required: ['target', 'content', 'reason'],
  },

  async run(args) {
    const target = String(args['target'] ?? '').trim() as RequestTarget
    const content = String(args['content'] ?? '').trim()
    const reason = String(args['reason'] ?? '').trim()

    if (!TARGETS.includes(target)) {
      return JSON.stringify({ ok: false, error: `不认识的类型：${target}。只能是 ${TARGETS.join(' / ')}` })
    }
    if (!reason) {
      return JSON.stringify({ ok: false, error: '得写清楚为什么想改 —— 没理由的申请主人不会批' })
    }

    const r = requestChange(target, content, reason)
    return JSON.stringify(r)
  },
}
