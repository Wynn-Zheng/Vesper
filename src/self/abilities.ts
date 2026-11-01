/**
 * 能力清单。
 *
 * 这份数据从**实际配置和注册表**读出来，不是写死的文案：
 * 开关关了，清单上就是"没接"；工具注册了，清单上就多一条。
 *
 * 用途是喂给自我反思——让它自己看"我现在接了这些"，然后用自己的话
 * 总结成"我能做什么"，写进 self.md。而不是由我们在 prompt 里替它写。
 */
import { existsSync } from 'node:fs'
import type { Rules } from '../core/config.ts'
import { tools } from '../tools/registry.ts'
import { loadWatched } from '../outward/watch.ts'

export interface Ability {
  name: string
  /** 现在能不能用 */
  available: boolean
  /** 一句话说明；模型可以自己改写成它自己的说法 */
  hint: string
  /** 最近用过多少次（0 = 没试过） */
  usedRecently: number
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

  // 这三条是核心能力，但也要说清"是什么"：
  // "想事情"靠的是模型 + 一轮反思，不是真有一个持续运转的脑子。
  out.push({
    name: '想事情',
    available: true,
    hint: '能琢磨、形成自己的看法；每天有两次专门用来反思（不是随时都在想）',
    usedRecently: 0,
  })
  out.push({
    name: '记事',
    available: true,
    hint: '把人说过的事实、发生过的事、约定记成文字，以后能翻出来',
    usedRecently: 0,
  })
  out.push({ name: '聊天', available: true, hint: '能跟人一来一回地说话', usedRecently: 0 })

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
    // 措辞要和实际一致：只有标题/UP主/简介，看不到画面。
    // "今天已看 N 个"可能超过配置上限——控制台手动触发会绕过上限，说明一下。
    hint: watchOn
      ? `每天自己翻一两个 B站视频的标题和简介，写一句自己的想法` +
        `（今天 ${watched} 个，上限 ${rules.外部?.刷视频?.每天最多 ?? '?'} 个；` +
        `手动点的不占这个额度）`
      : '还没接上',
    usedRecently: watched,
  })

  // 发空间：草稿模式。
  // 能写草稿（qzone.ts 实现了），但**发出去要人点**——它自己没有这个工具。
  const qzoneOn = Boolean(rules.外部?.发空间?.开启)
  out.push({
    name: '发空间',
    available: qzoneOn,
    hint: qzoneOn
      ? '能写说说草稿，但要人看过点「发出去」才真发（发出去收不回，虽然能删）'
      : '还没开（开了就能写草稿；发不发还是人说了算）',
    usedRecently: 0,
  })

  // 注册表里的工具：有一个算一个
  for (const t of tools.list()) {
    out.push({ name: t.name, available: true, hint: t.description, usedRecently: 0 })
  }

  // 明确做不到的（这几条是硬事实，不是配置）
  // 上网这件事要说准：B站接口是真能调的，但"能上网"和"能看视频"是两回事。
  out.push({
    name: '查 B站',
    available: true,
    hint: '能调 B站的公开接口：看热门榜单、拿视频的标题和简介。这是真联网',
    usedRecently: 0,
  })
  out.push({ name: '执行代码', available: false, hint: '跑不了程序', usedRecently: 0 })

  // 电脑操作：能不能看屏幕、能不能动手，都取决于配置。
  const deskOn = rules.电脑操作?.enabled === true
  const deskCanDo = deskOn && rules.电脑操作?.允许操作 === true
  out.push({
    name: '看他的屏幕',
    available: deskOn,
    hint: deskOn ? '能截图（带坐标刻度）、能看开了哪些窗口、能问屏幕多大' : '电脑操作没开，看不到屏幕',
    usedRecently: 0,
  })
  out.push({
    name: '操作他的电脑',
    available: deskCanDo,
    hint: deskCanDo
      ? '能点鼠标、打字、按键、滚轮、切窗口'
      : deskOn
        ? '能看但动不了手（允许操作 关着）'
        : '电脑操作没开',
    usedRecently: 0,
  })

  out.push({
    name: '打开网页/搜索',
    available: false,
    hint: '只能调 B站那几个接口，不能打开任意网页、不能搜索',
    usedRecently: 0,
  })
  out.push({
    name: '看视频画面',
    available: false,
    hint: '只看得到标题和简介，看不到视频本身',
    usedRecently: 0,
  })
  // 看图是真能看的（vision.ts），只是默认关着。
  // 文件仍然打不开（只能读 src/ 下的 .ts，见 diagnose.ts 的 safePath）。
  const visionOn = Boolean(rules.视觉?.开启)
  out.push({
    name: '看图片',
    available: visionOn,
    hint: visionOn
      ? '对方发图时能用视觉模型看清图里是什么（你自己是纯文本模型，靠另一次调用"翻译"成文字）'
      : '开了「视觉.开启」就能看图；现在关着',
    usedRecently: 0,
  })
  out.push({
    name: '打开文件',
    available: false,
    hint: '只能读自己 src/ 下的 .ts 源码，读不了别的文件（也看不到别人的私事）',
    usedRecently: 0,
  })

  return out
}

/** 渲染成给反思看的一段话 */
export function renderAbilities(list: Ability[]): string {
  const can = list.filter((a) => a.available)
  const cannot = list.filter((a) => !a.available)
  const lines: string[] = []
  if (can.length) {
    lines.push('# 现在真正接着的能力（这是程序告诉你的实际情况，不是你猜的）')
    for (const a of can) lines.push(`- ${a.name}：${a.hint}`)
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

