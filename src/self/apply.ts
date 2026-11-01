/**
 * 把一条被批准的申请真正落到字段上。
 *
 * 职责单一：拿到 ChangeRequest，改对应的存储，返回一句人话。
 * 审批流程（读队列、移除、记冷却）在 console 层做，这里只管"应用"。
 */
import { info } from '../core/log.ts'
import { saveEpisode, nextEpisodeId, today } from '../memory/store.ts'
import type { Episode } from '../memory/types.ts'
import { applyCardField, loadCard, saveCard, SELF_EDITABLE_FIELDS } from '../persona/card.ts'
import { labelOf, type ChangeRequest } from './requests.ts'
import { loadSelf, saveSelf } from './store.ts'

export interface ApplyResult {
  ok: boolean
  detail: string
}

/**
 * 应用一条申请。
 *
 * @param grant 是否"以后都让它改"（长期授权）。只对部分目标有意义。
 */
export function applyRequest(r: ChangeRequest, grant = false): ApplyResult {
  switch (r.target) {
    case 'name': {
      const doc = loadSelf()
      const name = r.content.trim().slice(0, 20)
      if (!name) return { ok: false, detail: '名字是空的' }
      saveSelf({ ...doc, name, nameReason: r.reason.slice(0, 120) || doc.nameReason })
      return { ok: true, detail: `名字改成「${name}」` }
    }

    case 'about': {
      const doc = loadSelf()
      const text = r.content.trim().slice(0, 1200)
      if (!text) return { ok: false, detail: '内容是空的' }

      if (doc.aboutOwner === 'me') {
        // 「我写」模式下，它写的东西只能进补充区；
        // 除非用户选择"以后都让它改"，那就把所有权交出去。
        if (grant) {
          saveSelf({
            ...doc,
            about: [doc.about.trim(), text].filter(Boolean).join('\n\n'),
            aboutExtra: '',
            aboutOwner: 'it',
          })
          return { ok: true, detail: '已合并进自述，并把这一项交给它自己管' }
        }
        saveSelf({ ...doc, aboutExtra: text })
        return { ok: true, detail: '已写进「它补充的」' }
      }

      saveSelf({ ...doc, about: text })
      return { ok: true, detail: '自述已更新' }
    }

    case 'card': {
      // 「它能自改角色卡」关着时走这条路：它提申请，你批准才真的改。
      // 格式：「字段：新值」，比如「核心特质：更愿意先听完再开口」
      const m = /^(.{1,10}?)[：:]\s*(.+)$/.exec(r.content.trim())
      const field = (m?.[1] ?? '').trim()
      const value = (m?.[2] ?? '').trim()
      if (!field || !value) return { ok: false, detail: '看不明白要改哪一项，写成「字段：新值」' }
      if (!(SELF_EDITABLE_FIELDS as readonly string[]).includes(field)) {
        return {
          ok: false,
          detail: `「${field}」不在它能改的范围里（只能改 ${SELF_EDITABLE_FIELDS.join('、')}）`,
        }
      }
      const card = loadCard()
      if (!card) return { ok: false, detail: '还没有角色卡' }
      if (!applyCardField(card, field, value)) return { ok: false, detail: '这个值用不了' }
      saveCard(card)
      info('批准了它改角色卡', { 字段: field, 新值: value.slice(0, 40) })
      return { ok: true, detail: `改了自己的${field}：${value.slice(0, 30)}` }
    }

    case 'person': {
      // 人物档案的申请先只支持"改名字"这一种，别的走人工
      return { ok: false, detail: '人物档案的申请还没接上，先手动改吧' }
    }

    // abilities / plays 不在 tools/request.ts 的 TARGETS 里，模型根本提不出来，
    // 所以这里不需要单独分支，落到 default 兜底即可。

    default:
      return { ok: false, detail: '不认识的申请类型' }
  }
}

/**
 * 批准后写一条 episode —— 这是"它自己的历史"，不是操作日志。
 *
 * 用户的原话：「改名字这种是比较重要的东西」，
 * 所以让它以后翻经历时能想起来"我是什么时候、为什么变的"。
 */
export function recordApproval(r: ChangeRequest, detail: string): void {
  try {
    const date = today()
    const scope = 'shared' as const
    const ep: Episode = {
      id: nextEpisodeId(scope, date),
      date,
      scope,
      // 比日常小事重要，但没到"人生节点"那种程度
      importance: 6,
      title: `我把${labelOf(r.target)}改了：${detail}`,
      body: [
        `我跟主人说想改${labelOf(r.target)}。`,
        r.reason ? `我说的是：${r.reason}` : '',
        `他批了。${detail}`,
      ]
        .filter(Boolean)
        .join('\n'),
    }
    saveEpisode(ep)
    info('批准的申请已写进经历', { target: r.target, detail })
  } catch (e) {
    // 记忆写不进去不该让审批失败
    info('写经历失败，不影响审批结果', { err: e instanceof Error ? e.message : String(e) })
  }
}
