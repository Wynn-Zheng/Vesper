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

  out.push({ name: '想事情', available: true, hint: '能在脑子里推演、琢磨、产生自己的看法', usedRecently: 0 })
  out.push({ name: '记事', available: true, hint: '会把人说过的事、约定、重要经历记下来，以后能想起来', usedRecently: 0 })
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
    hint: watchOn
      ? `每天自己挑一两个 B站视频看，看完写一句自己的想法（今天已看 ${watched} 个）`
      : '还没接上',
    usedRecently: watched,
  })

  // 发空间
  const qzoneOn = Boolean(rules.外部?.发空间?.开启)
  out.push({
    name: '发空间',
    available: qzoneOn,
    hint: qzoneOn ? '能往 QQ 空间发说说' : '还没接上',
    usedRecently: 0,
  })

  // 注册表里的工具：有一个算一个
  for (const t of tools.list()) {
    out.push({ name: t.name, available: true, hint: t.description, usedRecently: 0 })
  }

  // 明确做不到的（这几条是硬事实，不是配置）
  out.push({ name: '执行代码', available: false, hint: '跑不了程序', usedRecently: 0 })
  out.push({ name: '上网查东西', available: false, hint: '打不开网页、搜不了东西', usedRecently: 0 })
  out.push({ name: '看图片/文件', available: false, hint: '看不见图，也打不开文件', usedRecently: 0 })

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

/** 有没有能力文件（旧版本没有，用来做兼容判断） */
export function hasAbilitiesFile(): boolean {
  return existsSync('persona/self.md')
}
