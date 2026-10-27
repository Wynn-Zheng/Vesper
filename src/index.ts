import { OnebotTransport } from './channel/onebot.ts'
import { boot } from './boot.ts'
import { ToolRegistry } from './tools/registry.ts'
import { codeTools } from './tools/code.ts'
import { refreshCodeMap } from './self/codemap.ts'
import { startConsole } from './console/server.ts'
import { loadRules } from './core/config.ts'
import { info, initLog, pruneLogs, warnAt, errorAt } from './core/log.ts'
import { loadAccess } from './core/access.ts'
import { generateReply } from './loop/chat.ts'
import { pruneSessions } from './loop/session.ts'
import type { LlmOptions } from './llm/types.ts'
import { ensurePerson, loadPerson, personIdOf } from './people/store.ts'
import { startDistiller } from './scheduler/distiller.ts'
import { startProactive } from './scheduler/proactive.ts'
import { loadSelf } from './self/store.ts'
import { startAutoSnapshot } from './persona/version.ts'
import { startRelationDecay } from './relation/decay.ts'
import { startRateLimitSweeper } from './core/ratelimit.ts'
import { startSelfReflect } from './self/reflect.ts'
import { startObserving } from './self/observe.ts'
import { startWatching } from './outward/watch.ts'
import { watch } from 'node:fs'

initLog()

let rules = loadRules().rules
const getRules = (): typeof rules => rules

info('规则已加载：persona/rules.yaml')

// rules.yaml 改动后自动重载
try {
  watch('persona/rules.yaml', { persistent: false }, () => {
    try {
      rules = loadRules().rules
      info('rules.yaml 已重载')
    } catch (err) {
      warnAt('rules.yaml 重载失败，继续用旧规则', { err: String(err) })
    }
  })
} catch (err) {
  warnAt('无法监听 rules.yaml，热重载不可用', { err: String(err) })
}

// 群聊里"叫它名字"也算被叫到，所以要知道它叫什么
const botNames = [loadSelf().name, rules.人格.名字].filter((n) => n && n !== '未定')

// 权限策略：第一次运行会从 .env 生成 persona/access.yaml，之后控制台改这个文件
const policy = loadAccess()
info(
  `权限：群白 ${policy.groupAllow.length || '不限'} / 群黑 ${policy.groupDeny.length} / 成员白 ${policy.memberAllow.length || '不限'} / 成员黑 ${policy.memberDeny.length} / 必须@ ${policy.requireAt ? '是' : '否'}`,
)

const transport = new OnebotTransport({
  host: process.env['ONEBOT_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ONEBOT_PORT']) || 8765,
  path: process.env['ONEBOT_PATH'] ?? '/onebot/v11/ws',
  token: process.env['ONEBOT_TOKEN'] ?? '',
  ownerQQ: process.env['OWNER_QQ'] || undefined,
  allowGroup: (process.env['ALLOW_GROUP'] ?? 'false').toLowerCase() === 'true',
  groupAllow: (process.env['GROUP_ALLOW'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  memberAllow: (process.env['MEMBER_ALLOW'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  requireAt: (process.env['GROUP_REQUIRE_AT'] ?? 'true').toLowerCase() !== 'false',
  botNames,
  // 控制台改了权限文件，下一条消息就生效
  getPolicy: () => loadAccess(),
  // 连续对话窗口：刚才在跟它说话的人，不 @ 也能接着聊
  recentTalkers: new Map<string, number>(),
  followUpWindowMs: 2 * 60_000,
})

const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
let llm: LlmOptions | undefined

// 主人先建档，后面谁来说话就自动建谁。
//
// ⚠️ 只在**还没有档案**时建档。
// 之前这里无条件调 ensurePerson(..., '主人')，每次启动都把名字
// 强制改回"主人" —— 不管群名单里同步到的是什么。
// 这就是"档案名怎么修都会变回去"的真凶。
const ownerQQ = process.env['OWNER_QQ'] || undefined
if (ownerQQ && !loadPerson(personIdOf('qq', ownerQQ))) {
  ensurePerson('qq', ownerQQ, '主人')
}

if (apiKey) {
  llm = {
    apiKey,
    baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
    model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
  }
  // 它能读自己的代码了：这 4 个工具只读、只碰 src/ 下的 .ts
  const registry = new ToolRegistry()
  for (const tool of codeTools) registry.register(tool)

  // 电脑操作：默认关。开了才把工具放进注册表——
  // 不放进去的话模型根本不知道有这些工具，谈不上"误用"。
  {
    const rules = getRules()
    if (rules.电脑操作?.enabled) {
      const { desktopReadTools, desktopWriteTools } = await import('./tools/desktop.ts')
      for (const tool of desktopReadTools) registry.register(tool)
      if (rules.电脑操作.允许操作) {
        for (const tool of desktopWriteTools) registry.register(tool)
      }
      info(
        `电脑操作已启用：${registry.size} 个工具` +
          (rules.电脑操作.允许操作 ? '（含点击/打字）' : '（只读：截图/窗口列表）'),
      )
    }
  }

  info(`模型已就绪：${llm.model}`)
  boot(transport, { getRules, reply: (m, r) => generateReply(m, { rules: r, llm: llm!, tools: registry }), llm })

  // 临时记忆 7 天过期，启动时清一次。
  // 这里在顶层模块作用域（不在 setTimeout 回调里），所以可以用 await。
  {
    const { prune: pruneTemp } = await import('./memory/temp.ts')
    pruneTemp()
  }

  // 定时器错开启动：六个都在同一秒触发的话，distiller 和 proactive 会同时调模型
  const llmRef = llm
  setTimeout(() => {
    startDistiller({ llm: llmRef })
    // 代码地图：启动时先确保有一份，之后每天刷
    try {
      refreshCodeMap(false)
    } catch {
      /* 没有就算了，用到时会现场扫 */
    }
    info('自动整理已启动（每 30 分钟检查一次）')
  }, 30_000)

  // 自我反思独立跑：一天两次，不管私聊有没有新消息
  startSelfReflect(llmRef, () => loadRules().rules)
  info('自我反思已启动（每 12 小时一次）')

  // 定时扫日志，找自己的毛病
  startObserving(() => llmRef)
  info('自检已启动（每 6 小时扫一次日志）')

  // 它自己出去看东西
  startWatching(llmRef, () => loadRules().rules)
  info('刷视频已启动（看 rules.yaml 的 外部.刷视频）')

  const owner = process.env['OWNER_QQ'] || undefined
  if (owner) {
    setTimeout(() => {
      startProactive({ llm: llmRef, transport, target: { kind: 'private', id: owner } })
      info('主动消息已启动（按关系阶段决定频率）')
    }, 90_000)
  }
} else {
  warnAt('没有 DEEPSEEK_API_KEY，先用回显模式（填好 .env 后重启即可切换）')
  boot(transport, { getRules, reply: (m) => m.text })
}

await transport.start()

// 群名单预热：不等第一条群消息。
// 不预热的话，重启后第一条群消息进来时名单还没拉到，
// 它会以为群里只有你们俩。
//
// 注意要等：NapCat 是反连过来的，transport.start() 只是开始监听，
// 立刻拉会得到"NapCat 未连接"。所以等 45 秒，失败再等 90 秒重试一次。
if (llm) {
  void (async () => {
    const { knownGroups, refreshGroupMembers, membersAreStale } = await import('./people/group.ts')
    const groups = knownGroups()
    if (!groups.length) return

    for (const delay of [45_000, 90_000]) {
      await new Promise((r) => setTimeout(r, delay))
      let ok = 0
      for (const gid of groups) {
        if (!membersAreStale(gid)) {
          ok += 1
          continue
        }
        await refreshGroupMembers(transport, gid)
        if (!membersAreStale(gid)) ok += 1
      }
      if (ok === groups.length) {
        info(`群名单已预热：${ok} 个群`)
        // 每天再刷一遍做兜底：事件驱动的刷新（新成员）可能因为 NapCat 掉线漏掉
        setInterval(() => {
          void (async () => {
            try {
              const { refreshAllGroups } = await import('./people/group.ts')
              const r = await refreshAllGroups(transport, { force: true })
              info('群名单每日刷新', { 共: r.total, 成功: r.ok, 失败: r.failed.join(',') || '无' })
            } catch (err) {
              warnAt('每日刷新群名单失败', { err: String(err).slice(0, 60) })
            }
          })()
        }, 24 * 3600_000)
        return
      }
    }
    // 盘里已经有名单时不算失败：那只是"这次没刷新成"，用到的是旧数据，
    // 下一条群消息进来时会再刷。真没名单才值得 warn。
    // 注意 ok 变量在 for 循环内部作用域，这里重新算一遍。
    const ready = groups.filter((g) => !membersAreStale(g)).length
    if (ready === 0) {
      warnAt('群名单预热没成功，盘里也没有旧名单（NapCat 可能一直没连上）', { 群数: groups.length })
    } else {
      info(`群名单预热：${ready}/${groups.length} 有数据，其余等下次群消息再刷`)
    }
  })()
}
info('已启动')

// 上次退出时如果有消息没处理完（多半是重启打断的），说一声，别让它静默消失
{
  const { readRaw, today } = await import('./memory/store.ts')
  const turns = readRaw(today())
  const lastUser = [...turns].reverse().find((t) => t.role === 'user')
  if (lastUser) {
    const after = turns.filter((t) => t.ts > lastUser.ts && t.role === 'assistant')
    if (!after.length && Date.now() - lastUser.ts > 60_000) {
      warnAt(`上次有一条消息没来得及回复（${new Date(lastUser.ts).toLocaleTimeString('zh-CN')}）：${lastUser.text.slice(0, 40)}`)
    }
  }
}

// 人格快照：改动后自动留一份，出问题能回滚
startAutoSnapshot()
info('人格快照已启动（每 30 分钟检查改动）')

// 久不联系，关系会淡
startRelationDecay(getRules)
startRateLimitSweeper()
info('关系降温与限流清理已启动')

// 内存和磁盘的定期清理：跑一个月也不会无限涨
// 日志保留天数从配置读（默认 30，在 rules.yaml 的 日志.保留天数）
const keepDays = rules.日志?.保留天数 ?? 30
const prunedLogs = pruneLogs(Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 30)
if (prunedLogs) info(`清理了 ${prunedLogs} 个过期日志文件（保留 ${keepDays} 天）`)
setInterval(() => {
  const n = pruneSessions()
  if (n) info(`清理了 ${n} 个不活跃会话`)
}, 30 * 60_000).unref?.()

// 控制台
const consolePort = Number(process.env['CONSOLE_PORT']) || 7788
const consoleToken = process.env['CONSOLE_TOKEN'] ?? ''
try {
  await startConsole({ port: consolePort, token: consoleToken, getRules, transport, llm })
} catch (err) {
  warnAt('控制台启动失败，不影响聊天', { err: String(err) })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    info(`收到 ${sig}，正在退出`)
    void transport.stop().finally(() => process.exit(0))
  })
}

process.on('unhandledRejection', (err) => errorAt('未处理的拒绝', { err: String(err) }))
