/**
 * 体检：一眼看出哪里坏了。
 *
 * 为什么要这个：现在出问题时得挨个查——NapCat 连没连、API 通不通、
 * 群名单是不是被清了、配置文件语法对不对。新手最怕的就是"点了没反应"，
 * 而这个模块把"为什么没反应"翻译成人话，并且给出"怎么修"。
 *
 * 设计原则：
 *   1. 每一项都能单独跑，不互相阻塞（API 挂了不影响查磁盘）
 *   2. 超时短（最慢的一项 3 秒），不能让体检本身卡住
 *   3. 结果分三级：ok / warn / fail —— warn 是"能用但有隐患"
 */
import { existsSync, statfsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadRules } from '../core/config.ts'
import { knownGroups, groupMembers } from '../people/groupcache.ts'
import { listPeople, loadPerson } from '../people/store.ts'
import { exePath as aiDesktopExe } from '../tools/desktop.ts'

export type CheckLevel = 'ok' | 'warn' | 'fail'

export interface CheckItem {
  id: string
  /** 这一项叫什么 */
  name: string
  level: CheckLevel
  /** 一句话结论 */
  detail: string
  /** 坏了怎么办（ok 时为空） */
  fix?: string
  /** 多慢（毫秒） */
  ms?: number
}

export interface HealthReport {
  at: number
  /** 总体：全 ok → ok；有 warn → warn；有 fail → fail */
  level: CheckLevel
  items: CheckItem[]
  /** ok / warn / fail 各几项 */
  counts: { ok: number; warn: number; fail: number }
}

/* ---------------- 单项检查 ---------------- */

function nodeVersion(): CheckItem {
  const v = process.versions.node
  const major = Number(v.split('.')[0])

  // 桌面版（Electron 壳）跑的是 Electron 自带的 Node，用户机器上不需要装 Node。
  // 这时候还提示"去装 Node 24"就是误导 —— 这条直接算正常。
  const electron = process.versions['electron']
  if (electron) {
    return {
      id: 'node',
      name: 'Node 版本',
      level: 'ok',
      detail: `v${v}（Electron ${electron} 自带）`,
    }
  }

  if (major >= 24) {
    return { id: 'node', name: 'Node 版本', level: 'ok', detail: `v${v}` }
  }
  if (major >= 20) {
    return {
      id: 'node',
      name: 'Node 版本',
      level: 'warn',
      detail: `v${v}（能跑，但建议 24）`,
      fix: '去 nodejs.org 装 Node 24 LTS',
    }
  }
  return {
    id: 'node',
    name: 'Node 版本',
    level: 'fail',
    detail: `v${v}（太旧）`,
    fix: '去 nodejs.org 装 Node 24 LTS',
  }
}

function configParse(): CheckItem {
  try {
    // 这里故意重新读一次文件，不用缓存的配置：
    // 缓存的是"上次成功解析的"，而这里要查"现在这份文件还能不能解析"
    const r = loadRules()
    const unknown = (r as unknown as { unknown?: string[] }).unknown ?? []
    if (unknown.length) {
      return {
        id: 'config',
        name: '配置文件',
        level: 'warn',
        detail: `rules.yaml 有 ${unknown.length} 个不认识的键：${unknown.slice(0, 3).join(', ')}`,
        fix: '拼错了？改 rules.yaml，或者删掉这些键',
      }
    }
    return { id: 'config', name: '配置文件', level: 'ok', detail: 'rules.yaml 正常' }
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 120)
    return {
      id: 'config',
      name: '配置文件',
      level: 'fail',
      detail: `rules.yaml 解析失败：${msg}`,
      fix: '按报错的行号改 rules.yaml；改坏了就去「设置 → 数据 → 还原」找快照',
    }
  }
}

function dataWritable(): CheckItem {
  try {
    const dir = join('persona')
    if (!existsSync(dir)) {
      return {
        id: 'data',
        name: '数据目录',
        level: 'fail',
        detail: 'persona/ 不存在',
        fix: '在项目根目录启动服务；如果是打包版，检查数据目录设置',
      }
    }
    const st = statSync(dir)
    if (!st.isDirectory()) {
      return { id: 'data', name: '数据目录', level: 'fail', detail: 'persona 不是目录' }
    }
    return { id: 'data', name: '数据目录', level: 'ok', detail: 'persona/ 可访问' }
  } catch (err) {
    return {
      id: 'data',
      name: '数据目录',
      level: 'fail',
      detail: `访问不了：${String(err).slice(0, 80)}`,
      fix: '检查目录权限，或者把程序放到有写权限的地方',
    }
  }
}

function diskSpace(): CheckItem {
  try {
    // Node 没有跨平台的磁盘剩余 API，用 statfs 的近似：
    // 实际能不能用不重要，这里只查"有没有明显不足"
    const s = statfsSync('.')
    const freeGB = (Number(s.bsize) * Number(s.bavail)) / 1024 ** 3
    if (freeGB < 0.2) {
      return {
        id: 'disk',
        name: '磁盘空间',
        level: 'fail',
        detail: `只剩 ${freeGB.toFixed(2)} GB`,
        fix: '清理日志（data/logs）和截图（~/.ai-desktop/screenshots）',
      }
    }
    if (freeGB < 2) {
      return {
        id: 'disk',
        name: '磁盘空间',
        level: 'warn',
        detail: `剩 ${freeGB.toFixed(1)} GB`,
        fix: '建议清理一下日志和截图',
      }
    }
    return { id: 'disk', name: '磁盘空间', level: 'ok', detail: `剩 ${freeGB.toFixed(1)} GB` }
  } catch {
    return { id: 'disk', name: '磁盘空间', level: 'ok', detail: '（查不了，跳过）' }
  }
}

async function apiKey(opts: { apiKey?: string; baseUrl?: string }): Promise<CheckItem> {
  const t0 = Date.now()
  if (!opts.apiKey) {
    return {
      id: 'api',
      name: 'DeepSeek API',
      level: 'fail',
      detail: '.env 里没有 DEEPSEEK_API_KEY',
      fix: '在项目根目录的 .env 里填 DEEPSEEK_API_KEY=sk-...',
    }
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${opts.baseUrl ?? 'https://api.deepseek.com'}/models`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const ms = Date.now() - t0
    if (res.ok) {
      return { id: 'api', name: 'DeepSeek API', level: 'ok', detail: `能调通（${ms}ms）`, ms }
    }
    if (res.status === 401) {
      return {
        id: 'api',
        name: 'DeepSeek API',
        level: 'fail',
        detail: 'key 不对（401）',
        fix: '检查 .env 里的 DEEPSEEK_API_KEY 有没有拼错、有没有过期',
        ms,
      }
    }
    if (res.status === 402 || res.status === 429) {
      return {
        id: 'api',
        name: 'DeepSeek API',
        level: 'fail',
        detail: `余额不足或限流（${res.status}）`,
        fix: '去 platform.deepseek.com 充值 / 等一会再试',
        ms,
      }
    }
    return {
      id: 'api',
      name: 'DeepSeek API',
      level: 'warn',
      detail: `返回 ${res.status}`,
      fix: '服务商那边可能不稳定，稍后再试',
      ms,
    }
  } catch (err) {
    const e = err as { name?: string }
    if (e.name === 'AbortError') {
      return {
        id: 'api',
        name: 'DeepSeek API',
        level: 'fail',
        detail: '3 秒没响应',
        fix: '网络不通？检查代理设置，或者换个网络',
        ms: Date.now() - t0,
      }
    }
    return {
      id: 'api',
      name: 'DeepSeek API',
      level: 'fail',
      detail: `连不上：${String(err).slice(0, 60)}`,
      fix: '检查网络，或者 .env 里的 DEEPSEEK_BASE_URL',
      ms: Date.now() - t0,
    }
  }
}

function napcat(state: { connected?: boolean }): CheckItem {
  if (state.connected) {
    return { id: 'napcat', name: 'NapCat 连接', level: 'ok', detail: '已连接' }
  }
  return {
    id: 'napcat',
    name: 'NapCat 连接',
    level: 'fail',
    detail: '没连上',
    fix:
      '① NapCat 开着吗 ② NapCat 的 WebSocket 客户端指向 ws://127.0.0.1:8765/onebot/v11/ws 吗 ' +
      '③ QQ 掉线了吗（NapCat 会跟着断）',
  }
}

function groups(): CheckItem {
  try {
    const gids = knownGroups()
    if (!gids.length) {
      return {
        id: 'groups',
        name: '群名单',
        level: 'warn',
        detail: '一个群都没有',
        fix: '在群里说句话，或者在「成员」页点「刷新群成员」',
      }
    }
    const thin = gids.filter((g) => groupMembers(g).length <= 1)
    if (thin.length) {
      return {
        id: 'groups',
        name: '群名单',
        level: 'warn',
        detail: `${thin.length} 个群的名单只有 1 人（${thin.join(', ')}）`,
        fix: '名单可能被清了。去「成员」页点「从快照恢复群名单」',
      }
    }
    const total = gids.reduce((a, g) => a + groupMembers(g).length, 0)
    return {
      id: 'groups',
      name: '群名单',
      level: 'ok',
      detail: `${gids.length} 个群 / ${total} 人次`,
    }
  } catch (err) {
    return {
      id: 'groups',
      name: '群名单',
      level: 'warn',
      detail: `查不了：${String(err).slice(0, 60)}`,
    }
  }
}

function peopleFiles(): CheckItem {
  try {
    const all = listPeople()
    const bad = all.filter((p) => !loadPerson(p.id))
    if (bad.length) {
      return {
        id: 'people',
        name: '人物档案',
        level: 'warn',
        detail: `${bad.length} 个档案读不出来（${bad.map((p) => p.id).slice(0, 3).join(', ')}）`,
        fix: '去「设置 → 数据」从快照还原',
      }
    }
    return { id: 'people', name: '人物档案', level: 'ok', detail: `${all.length} 个` }
  } catch {
    return { id: 'people', name: '人物档案', level: 'warn', detail: '查不了' }
  }
}

function desktopKit(): CheckItem {
  try {
    const on = loadRules().rules.电脑操作?.enabled === true
    if (!on) return { id: 'desktop', name: '电脑操作', level: 'ok', detail: '关着（默认）' }

    // 和「工具连通性」共用同一份解析，免得一边说"能用"、一边说"没装"
    const hit = aiDesktopExe()
    if (!hit) {
      return {
        id: 'desktop',
        name: '电脑操作',
        level: 'fail',
        detail: '开着，但找不到 ai-desktop',
        fix: '在 .env 里设 AI_DESKTOP_EXE=<ai-desktop.exe 路径>，或者 pip install ai-desktop',
      }
    }
    return { id: 'desktop', name: '电脑操作', level: 'ok', detail: '工具在，能用' }
  } catch {
    return { id: 'desktop', name: '电脑操作', level: 'warn', detail: '查不了' }
  }
}

/* ---------------- 汇总 ---------------- */

export async function healthReport(opts: {
  apiKey?: string
  baseUrl?: string
  connected?: boolean
}): Promise<HealthReport> {
  // 快的一项先跑，慢的（API / 网络）最后跑 —— 这样即使 API 卡住，
  // 前面几项的结果已经能显示出来了。
  const items: CheckItem[] = []
  items.push(nodeVersion())
  items.push(configParse())
  items.push(dataWritable())
  items.push(diskSpace())
  items.push(groups())
  items.push(peopleFiles())
  items.push(napcat({ connected: opts.connected }))
  items.push(desktopKit())
  items.push(await apiKey(opts))

  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const it of items) counts[it.level]++

  const level: CheckLevel = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok'

  return { at: Date.now(), level, items, counts }
}
