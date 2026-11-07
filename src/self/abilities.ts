/**
 * 能力清单。
 *
 * 这份数据从**实际配置和注册表**读出来，不是写死的文案：
 * 开关关了，清单上就是"没接"；工具注册了，清单上就多一条。
 *
 * 用途是喂给自我反思——让它自己看"我现在接了这些"，然后用自己的话
 * 总结成"我能做什么"，写进 self.md。而不是由我们在 prompt 里替它写。
 *
 * ⚠ 一个容易犯的错（B-19）：把"系统会做的事"说成"你能做的事"。
 * 刷视频、攒说说草稿、翻 B 站榜单都是定时任务干的，模型在对话里**调不到**
 * 这些入口（`composeDraft` 只有控制台在调，`bili` 只有定时任务在用）。
 * 以前清单里一律写成"能做到"，它就会照着吹——答应人"我现在去B站看看"，
 * 然后什么也做不出来。所以每条都要标 `byModel`，渲染时分三组说清。
 */
import type { Rules } from '../core/config.ts'
import { tools } from '../tools/registry.ts'
import { loadWatched } from '../outward/watch.ts'

export interface Ability {
  name: string
  /** 现在这个能力是不是真的有（配置开着 + 依赖装上了） */
  available: boolean
  /**
   * 模型在对话里能不能**主动**用这个能力。
   *
   * false = 系统会做（定时任务、控制台按钮），但它自己在对话里做不了，
   * 不能答应人"我现在去…"。
   */
  byModel: boolean
  /** 一句话说明；模型可以自己改写成它自己的说法 */
  hint: string
}

function hoursAgo(n: number): number {
  return Date.now() - n * 3_600_000
}

/** 最近 24 小时用过几次 */
function countRecent(list: Array<{ at: number }>): number {
  const cutoff = hoursAgo(24)
  return list.filter((x) => x.at >= cutoff).length
}

export function listAbilities(rules: Rules): Ability[] {
  const out: Ability[] = []
  // 配置开着不等于真的能用：桌面工具在平台不支持时压根不会注册。
  // 清单是喂给反思让它说"我现在能做什么"的，虚报一次它就会照着吹。
  const registered = new Set(tools.list().map((t) => t.name))
  const deskRegistered = registered.has('screenshot')

  // 这三条是核心能力，但也要说清"是什么"：
  // "想事情"靠的是模型 + 一轮反思，不是真有一个持续运转的脑子。
  out.push({
    name: '想事情',
    available: true,
    byModel: true,
    hint: '能琢磨、形成自己的看法；还有每天两次的自省是在后台跑的（那部分你控制不了）',
  })
  out.push({
    name: '记事',
    available: true,
    byModel: false,
    hint: '系统会自动把人说过的事实、发生过的事、约定记成文字，以后翻出来给你看（你不用手动记）',
  })
  out.push({ name: '聊天', available: true, byModel: true, hint: '能跟人一来一回地说话' })

  // 刷视频：开关真开着才算
  const watchOn = Boolean(rules.外部?.刷视频?.开启)
  let watched = 0
  try {
    watched = countRecent(loadWatched())
  } catch {
    /* 没数据 */
  }
  out.push({
    name: '刷视频',
    available: watchOn,
    byModel: false,
    // 措辞要和实际一致：只有标题/UP主/简介，看不到画面。
    // "今天已看 N 个"可能超过配置上限——控制台手动触发会绕过上限，说明一下。
    hint: watchOn
      ? `定时任务每天自己翻一两个 B站视频的标题和简介，写一句自己的想法` +
        `（今天 ${watched} 个，上限 ${rules.外部?.刷视频?.每天最多 ?? '?'} 个；` +
        `手动点的不占这个额度）。你可以在对话里提"我今天看了什么"，但没法当场再翻`
      : '还没接上',
  })

  // 发空间：草稿模式。
  // 能写草稿（qzone.ts 实现了），但**发出去要人点**——它自己没有这个工具。
  // 写草稿这个动作也只有控制台的按钮会调（composeDraft），对话里调不到。
  const qzoneOn = Boolean(rules.外部?.发空间?.开启)
  out.push({
    name: '发空间',
    available: qzoneOn,
    byModel: false,
    hint: qzoneOn
      ? '草稿是人在控制台点「想一条」才攒的，你在对话里写不了；发出去也要人点。你能看到已攒的草稿，可以聊它'
      : '还没开（开了就能攒草稿；写和发都是人点，不是你）',
  })

  // 注册表里的工具：有一个算一个
  for (const t of tools.list()) {
    out.push({ name: t.name, available: true, byModel: true, hint: t.description })
  }

  // 明确做不到的（这几条是硬事实，不是配置）
  // 上网这件事要说准：B站接口是真能调的，但那是定时任务在调，"能上网"和"能看视频"是两回事。
  out.push({
    name: '查 B站',
    available: true,
    byModel: false,
    hint: '定时任务会去调 B站的公开接口（热门榜单、视频的标题和简介），但你在对话里没有这个工具，没法现查现答',
  })
  out.push({ name: '执行代码', available: false, byModel: false, hint: '跑不了程序' })

  // 电脑操作：能不能看屏幕、能不能动手，都取决于配置，也取决于工具是否真的注册了。
  const deskOn = rules.电脑操作?.enabled === true
  const deskCanLook = deskOn && deskRegistered
  const deskCanDo = deskCanLook && rules.电脑操作?.允许操作 === true
  out.push({
    name: '看他的屏幕',
    available: deskCanLook,
    byModel: true,
    hint: deskCanLook
      ? '能截图（带坐标刻度）、能看开了哪些窗口、能问屏幕多大'
      : deskOn
        ? '配置里开了，但这台机器上没装上桌面工具，实际看不到'
        : '电脑操作没开，看不到屏幕',
  })
  out.push({
    name: '操作他的电脑',
    available: deskCanDo,
    byModel: true,
    hint: deskCanDo
      ? '能点鼠标、打字、按键、滚轮、切窗口'
      : deskCanLook
        ? '能看但动不了手（允许操作 关着）'
        : deskOn
          ? '配置里开了，但这台机器上没装上桌面工具'
          : '电脑操作没开',
  })

  out.push({
    name: '打开网页/搜索',
    available: false,
    byModel: false,
    hint: '不能打开任意网页、不能搜索。想聊网上的事，只能用系统攒下的 B站内容',
  })
  out.push({
    name: '看视频画面',
    available: false,
    byModel: false,
    hint: '只看得到标题和简介，看不到视频本身',
  })
  // 看图是真能看的（vision.ts），只是默认关着，而且是自动"翻译"成文字给它。
  // 文件仍然打不开（只能读 src/ 下的 .ts，见 diagnose.ts 的 safePath）。
  const visionOn = Boolean(rules.视觉?.开启)
  out.push({
    name: '看图片',
    available: visionOn,
    byModel: false,
    hint: visionOn
      ? '对方发图时系统会用视觉模型把图里是什么翻译成文字给你（你自己是纯文本模型，看不到原图）'
      : '开了「视觉.开启」就能看图；现在关着',
  })
  out.push({
    name: '打开文件',
    available: false,
    byModel: false,
    hint: '只能读自己 src/ 下的 .ts 源码，读不了别的文件（也看不到别人的私事）',
  })

  return out
}

/** 渲染成给反思看的一段话 */
export function renderAbilities(list: Ability[]): string {
  const can = list.filter((a) => a.available && a.byModel)
  const systemOnly = list.filter((a) => a.available && !a.byModel)
  const cannot = list.filter((a) => !a.available)
  const lines: string[] = []
  if (can.length) {
    lines.push('# 你在对话里能主动做的（这是程序告诉你的实际情况，不是你猜的）')
    for (const a of can) lines.push(`- ${a.name}：${a.hint}`)
  }
  if (systemOnly.length) {
    lines.push('')
    lines.push('# 系统会做，但你在对话里做不了（别答应人「我现在去…」）')
    for (const a of systemOnly) lines.push(`- ${a.name}：${a.hint}`)
  }
  if (cannot.length) {
    lines.push('')
    lines.push('# 现在还没接上的')
    for (const a of cannot) lines.push(`- ${a.name}：${a.hint}`)
  }
  lines.push('')
  lines.push('用你自己的话说说"我能做什么、不能做什么"。不要照搬上面的说法，')
  lines.push('也不要写你没有的东西。如果某件事你其实没试过，就说没试过。')
  return lines.join('\n')
}
