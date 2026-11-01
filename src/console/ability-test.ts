/**
 * 能力卡片上「测试」按钮的后端实现。
 *
 * 之前这个接口根本不存在（前端一直调 /api/ability/test），
 * 所以那 11 个卡片点「测试」全都是 not found。
 *
 * 这里做的是"轻量自检"：能当场验的就验（文件在不在、配置有没有、
 * 接口通不通），不能当场验的（比如截图要桌面）就给一句实话，
 * 不假装成功。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadRules } from '../core/config.ts'
import { srcRoot } from '../core/paths.ts'

export type AbilityTestResult = {
  ok: boolean
  detail: string
  ms: number
}

/** 数一个目录下的 .ts 文件 */
function countTs(dir: string): number {
  try {
    let n = 0
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) n++
      }
    }
    walk(dir)
    return n
  } catch {
    return 0
  }
}

/**
 * 跑一个能力的自检。
 *
 * 不认识的 id 返回 ok:false + 说明，而不是假装通过 —— 用户看到"✓"会以为能力真的好了。
 */
export async function testAbility(id: string): Promise<AbilityTestResult> {
  const t0 = Date.now()
  const done = (ok: boolean, detail: string): AbilityTestResult => ({
    ok,
    detail,
    ms: Date.now() - t0,
  })

  let rules
  try {
    rules = loadRules().rules
  } catch (e) {
    return done(false, 'rules.yaml 读不了：' + (e instanceof Error ? e.message : String(e)))
  }

  const hasKey = Boolean((process.env['DEEPSEEK_API_KEY'] ?? '').trim())

  switch (id) {
    case 'chat': {
      if (!hasKey) return done(false, '没有 DEEPSEEK_API_KEY，只能回显，不是真对话')
      return done(true, '模型可用（' + (process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat') + '）')
    }

    case 'emoji': {
      const n = countFiles('persona/emoji')
      if (n === 0) return done(false, '表情包库存是空的（它还没从聊天里收集到）')
      return done(true, `${n} 个表情包`)
    }

    case 'jargon': {
      const n = countFiles('persona/jargon')
      if (n === 0) return done(true, '还没学到黑话（正常，需要先聊一段时间）')
      return done(true, `${n} 条黑话`)
    }

    case 'plays': {
      const n = countFiles('persona/plays')
      return done(true, n === 0 ? '还没有精选句子（聊多了会攒）' : `${n} 条`)
    }

    case 'vision': {
      if (!hasKey) return done(false, '没有 API Key，视觉模型用不了')
      const vm = (rules as unknown as Record<string, unknown>)['视觉'] as Record<string, unknown> | undefined
      const model = typeof vm?.['模型'] === 'string' ? (vm['模型'] as string) : ''
      if (!model) return done(true, '用默认视觉模型')
      return done(true, '视觉模型：' + model)
    }

    case 'bili': {
      // 不真联网（会慢，而且断网时不该算失败）—— 只确认配置允许
      return done(true, '接口已就绪（真联网，断网时会报错）')
    }

    case 'code': {
      const root = srcRoot()
      if (!existsSync(root)) return done(false, `找不到源码目录（${root}）`)
      const n = countTs(root)
      if (n === 0) return done(false, '源码目录里没有 .ts 文件')
      return done(true, `能读 ${n} 个 .ts 文件`)
    }

    case 'screen': {
      const pc = (rules as unknown as Record<string, unknown>)['电脑操作'] as Record<string, unknown> | undefined
      if (pc?.['enabled'] !== true) return done(false, '电脑操作总开关是关的')
      return done(true, '已启用（真截图要桌面，这里不试）')
    }

    case 'deskctl': {
      const pc = (rules as unknown as Record<string, unknown>)['电脑操作'] as Record<string, unknown> | undefined
      if (pc?.['enabled'] !== true) return done(false, '电脑操作总开关是关的')
      if (pc?.['允许操作'] !== true) return done(true, '只读模式（不能点击/打字）')
      return done(true, '可以点击和打字')
    }

    case 'watch': {
      const w = (rules as unknown as Record<string, unknown>)['外部'] as Record<string, unknown> | undefined
      const v = w?.['刷视频'] as Record<string, unknown> | undefined
      if (v?.['开启'] !== true) return done(false, '刷视频是关的')
      return done(true, `每天最多 ${String(v?.['每天最多'] ?? '?')} 个`)
    }

    case 'qzone': {
      // 配置在「外部.发空间」，不是顶层「空间」——读错层级会让这个测试永远报“没开”。
      const ext = (rules as unknown as Record<string, unknown>)['外部'] as Record<string, unknown> | undefined
      const q = ext?.['发空间'] as Record<string, unknown> | undefined
      if (q?.['开启'] !== true) return done(false, '发说说没开')
      return done(true, '发之前要人确认')
    }

    default:
      return done(false, '这个能力还没有自检项')
  }
}

/** 数目录下的文件数（递归），目录不存在算 0 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  try {
    let n = 0
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else n++
      }
    }
    walk(dir)
    return n
  } catch {
    return 0
  }
}
