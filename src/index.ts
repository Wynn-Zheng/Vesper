import { OnebotTransport, markTalker, type OnebotOptions } from './channel/onebot.ts'
import { createEmojiStore } from './emoji/store.ts'
import { boot } from './boot.ts'
import { ToolRegistry, tools as globalTools } from './tools/registry.ts'
import { syncPluginTools } from './tools/plugin-sync.ts'
import { codeTools } from './tools/code.ts'
import { sendImageTool } from './tools/image.ts'
import { requestChangeTool } from './tools/request.ts'
import { refreshCodeMap } from './self/codemap.ts'
import { startConsole } from './console/server.ts'
import { DEFAULTS, loadRules } from './core/config.ts'
import { info, initLog, pruneLogs, warnAt, errorAt } from './core/log.ts'
import { loadAccess } from './core/access.ts'
import { generateReply } from './loop/chat.ts'
import { pruneSessions } from './loop/session.ts'
import type { LlmOptions } from './llm/types.ts'
import { ensurePerson, loadPerson, personIdOf, savePerson } from './people/store.ts'
import { startCodeMapRefresher, startDistiller } from './scheduler/distiller.ts'
import { startProactive } from './scheduler/proactive.ts'
import { loadSelf } from './self/store.ts'
import { startAutoSnapshot } from './persona/version.ts'
import { startRelationDecay } from './relation/decay.ts'
import { startRateLimitSweeper } from './core/ratelimit.ts'
import { startSelfReflect } from './self/reflect.ts'
import { startObserving } from './self/observe.ts'
import { startWatching } from './outward/watch.ts'
import { startEmojiTagger } from './scheduler/emoji-tagger.ts'
import { startWatchdog, watchdogStatus } from './napcat/manager.ts'
import { mkdirSync, readFileSync, rmSync, watchFile, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

initLog()

/* ============================================================
 * 单实例锁
 *
 * 之前全库没有锁：第二个实例照样把控制台起起来，但 WS 端口被第一个占着，
 * 它 listen 失败后进程还活着 —— 表现就是"能开控制台、收不到消息"。
 * 现在启动第一件事就是抢锁：抢不到就明确报错退出（exit code 1）。
 * ============================================================ */

const PID_FILE = 'data/.pid'

interface PidLock {
  pid: number
  startedAt: string
  hostname?: string
}

/** 读锁文件；文件坏了/形状不对一律当"没有锁"（返回 null），由调用方按陈旧锁清掉 */
function readPidLock(): PidLock | null {
  try {
    const raw = JSON.parse(readFileSync(PID_FILE, 'utf8')) as Partial<PidLock>
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null
    return {
      pid: raw.pid,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      ...(typeof raw.hostname === 'string' ? { hostname: raw.hostname } : {}),
    }
  } catch {
    return null
  }
}

/** pid 还活着吗。EPERM = 进程在但没权限动它，也算活着。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 删锁。只删自己的：锁被别的实例换掉之后，退出时绝不能把它的锁删了。 */
function releasePidLock(): void {
  const cur = readPidLock()
  if (cur && cur.pid !== process.pid) return
  try {
    rmSync(PID_FILE, { force: true })
  } catch {
    /* 删不掉就留给下次当陈旧锁处理 */
  }
}

/**
 * 抢单实例锁。
 *
 * 用 `wx` 原子创建，而不是"先 existsSync 再写"：两个实例同时启动时，
 * 后者会拿到 EEXIST，而不是把前者的锁覆盖掉。
 * 陈旧锁（pid 不存在 / 文件坏了 / pid 就是自己）会自动清掉再抢。
 */
function acquirePidLock(): { ok: true; warning?: string } | { ok: false; existing: PidLock | null } {
  try {
    mkdirSync('data', { recursive: true })
  } catch {
    /* 建不了目录的话下面写锁会失败，按"没有锁"处理，不挡启动 */
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const body: PidLock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
    }
    try {
      writeFileSync(PID_FILE, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        // 写不了锁文件（只读目录 / 权限）：单实例保护失效，但不该因此起不来
        return { ok: true, warning: `写不了单实例锁 ${PID_FILE}：${String(err).slice(0, 120)}` }
      }
      const existing = readPidLock()
      if (!existing) {
        // 锁文件坏了 / 不是我们的格式：当陈旧锁清掉
        try {
          rmSync(PID_FILE, { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      // 活着的、不是自己的 → 真有第二个实例
      if (existing.pid !== process.pid && pidAlive(existing.pid)) return { ok: false, existing }
      // 陈旧锁：写锁的进程已经不在了（或者是被系统复用的本进程 pid）
      try {
        rmSync(PID_FILE, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: false, existing: readPidLock() }
}

const pidLock = acquirePidLock()
if (!pidLock.ok) {
  const who = pidLock.existing
  errorAt(`已有实例在跑（pid ${who?.pid ?? '未知'}），本进程退出`, {
    启动于: who?.startedAt ?? '',
    主机: who?.hostname ?? '',
    本进程: process.pid,
    提示: '同一份数据只能跑一个实例。确认它没在跑的话，删掉 data/.pid 再启动',
  })
  process.exit(1)
} else if (pidLock.warning) {
  warnAt(pidLock.warning)
} else {
  // SIGINT/SIGTERM 的处理器最后会 process.exit(0)，'exit' 事件会跟着触发，锁能删掉
  process.on('exit', releasePidLock)
}

// 老版本的 life/plays/jargon/mood 是全局文件；现在按角色卡隔离。
// 启动时把当前卡对应的那份复制到 cards/<id>/ 下（只复制，不删原文件）。
try {
  const { ensureCardScopedData } = await import('./persona/card.ts')
  ensureCardScopedData()
} catch {
  /* 迁移失败不挡启动 */
}

// 清理上次被强杀留下的临时文件（writeAtomic 的 .tmp）
try {
  const { readdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'versions') walk(full)
      } else if (e.name.endsWith('.tmp')) {
        try {
          rmSync(full, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const d of ['persona', 'data']) walk(d)
} catch {
  /* 清理失败不影响启动 */
}

// 配置写错不能让进程直接退出：那样控制台永远打不开，用户只能去翻日志。
// 先用默认配置把控制台起起来，明确告诉他去修 rules.yaml。
let startConfigBroken = false
let rules: ReturnType<typeof loadRules>['rules']
try {
  const loaded = loadRules()
  rules = loaded.rules
  for (const w of loaded.warnings ?? []) errorAt('配置告警', { msg: String(w) })
} catch (err) {
  errorAt('rules.yaml 解析失败，先用默认配置启动；请到控制台修改后重启', {
    err: String(err).slice(0, 300),
  })
  rules = { ...DEFAULTS }
  startConfigBroken = true
}
const getRules = (): typeof rules => rules
if (startConfigBroken) info('当前用的是内置默认配置（rules.yaml 有错），修好后重启生效')

if (!startConfigBroken) info('规则已加载：persona/rules.yaml')

// rules.yaml 改动后自动重载
try {
  // 用 watchFile（轮询）而不是 watch：编辑器原子保存会 rename 换 inode，
  // 单文件 watch 之后就静默失效、再也不重载，而且没有任何日志提示。
  watchFile('persona/rules.yaml', { interval: 1500 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
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
// 这一行以前打的是「必须@ 是/否」—— 但那个字段已经是僵尸：
// 真正决定"群里要不要 @ 才回"的是 rules.yaml 的 行为.群聊模式（BUG-13）。
// 继续打它，排障时会一路往错误方向找（明明是「只听」档，日志却说"不用 @"）。
info(
  `权限：群白 ${policy.groupAllow.length || '不限'} / 群黑 ${policy.groupDeny.length} / 成员白 ${policy.memberAllow.length || '不限'} / 成员黑 ${policy.memberDeny.length} / 群聊模式 ${getRules().行为.群聊模式}`,
)

const onebotOpts: OnebotOptions = {
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
  // 群聊模式：读 rules.yaml，改完下一条消息就生效
  getGroupMode: () => getRules().行为.群聊模式,
  // 连续对话窗口：刚才在跟它说话的人，不 @ 也能接着聊
  recentTalkers: new Map<string, number>(),
  followUpWindowMs: 2 * 60_000,
  /*
   * 表情包收集（群友发的小图存进库，以后它自己也能发）。
   *
   * ⚠ 这个字段以前**没传**，所以 `onEvent` 里那句
   * `if (this.opts.emojiStore && rules)` 永远为假 ——
   * captureEmojiSegments 写得很完整，但一次都没被调用过，库所以一直是空的。
   *
   * 这里传一个指向 persona/emoji 的 store，采集链路才真正接上。
   */
  emojiStore: createEmojiStore(),
}
const transport = new OnebotTransport(onebotOpts)

const apiKey = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
let llm: LlmOptions | undefined

// 主人先建档，后面谁来说话就自动建谁。
//
// ⚠️ 只在**还没有档案**时建档。
// 之前这里无条件调 ensurePerson(..., '主人')，每次启动都把名字
// 强制改回"主人" —— 不管群名单里同步到的是什么。
// 这就是"档案名怎么修都会变回去"的真凶。
/** 工具注册表：插件加载完要往里挂工具，所以提到模块级（下面 if (apiKey) 里赋值） */
let toolRegistry: ToolRegistry | null = null
/**
 * 当前"由插件注册进来"的工具名。
 *
 * 用来在插件重载/卸载后把旧 wrapper 摘掉：插件工具名可以覆盖自己，
 * 但绝不能覆盖内置工具（那会让插件有能力顶掉 read_code 之类的东西）。
 */
const pluginToolNames = new Set<string>()

const ownerQQ = process.env['OWNER_QQ'] || undefined
if (ownerQQ) {
  // ensurePerson 的第三个参数是**名字**，不是角色。历史上这里被当成 role 传了，
  // 所以新装环境下主人档案的 role 一直是空的 → 本机类工具（截图/桌面）对主人也拒绝。
  //
  // 这里只在 role **没写过**时补「主人」：
  //   - 新建档：第一次就写对
  //   - 老数据 role 缺失/空串：顺手修好（幂等，已经有了就不再写盘）
  //   - role 是非空的别的值（用户在控制台手改过）：不动它，尊重用户的选择 ——
  //     「主人能用本机工具」由 chat.ts 里 isOwner 的 OWNER_QQ 兜底，不靠强写 role。
  const ownerId = personIdOf('qq', ownerQQ)
  const person = loadPerson(ownerId) ?? ensurePerson('qq', ownerQQ, '主人')
  if (!person.role) {
    savePerson({ ...person, role: '主人' })
    info(`主人档案已标记：${person.name}`, { 档案: person.id, 角色: '主人' })
  } else if (person.role !== '主人') {
    info(`主人档案的 role 是「${person.role}」（控制台手改过，不覆盖；本机工具靠 OWNER_QQ 兜底）`)
  }
}

if (apiKey) {
  llm = {
    apiKey,
    baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
    model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
  }
  // 它能读自己的代码了：这 4 个工具只读、只碰 src/ 下的 .ts
  //
  // 用**全局**注册表（`tools`）：`self/abilities.ts` 生成「我能做什么」时读的就是它。
  // 以前这里 new 了一个局部实例，全局那个永远是空的 —— 于是能力清单里
  // 永远列不出 read_code / screenshot / send_image，它自己都说"我没那个工具"。
  const registry = globalTools
  toolRegistry = registry
  for (const tool of codeTools) registry.register(tool)

  // 发图：截图工具只返回本地 path，模型有路径却没手段发出去 ——
  // 于是出现「截到了」但对方什么也没收到。
  registry.register(sendImageTool)

  // 它想改自己被锁住的设定时，只能提申请（和 core 一个道理）
  registry.register(requestChangeTool)

  // 控制台对话里用户说"这段记下来"时，它自己调这个把内容升格成正式记忆
  registry.register(
    Object.assign(
      {
        name: 'commit_console_memory',
        description:
          '把控制台里刚才聊的内容记进正式记忆。只有当他说「这段记下来」「把这个记进记忆」这类明确要求时才用。',
        parameters: { type: 'object', properties: { title: { type: 'string', description: '这条记忆的一句话概括，比如「他说想换个工作」' } } },
        run: async (args: Record<string, unknown>) => {
          const { commitConsoleToMemory } = await import('./console/commit.ts')
          const r = await commitConsoleToMemory({
            ownerQQ: String(process.env['OWNER_QQ'] ?? '').trim(),
            ...(typeof args['title'] === 'string' ? { title: String(args['title']) } : {}),
          })
          return JSON.stringify(r)
        },
      },
      {},
    ),
  )

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
  boot(transport, {
    getRules,
    reply: (m, r) => generateReply(m, { rules: r, llm: llm!, tools: registry }),
    llm,
    // 「接着聊」的窗口锚在"它刚回过这个人"，而不是"上次被 @"
    touchTalker: (groupId, userId) => markTalker(onebotOpts, groupId, userId),
  })

  // 定时器错开启动：六个都在同一秒触发的话，distiller 和 proactive 会同时调模型
  const llmRef = llm
  setTimeout(() => {
    startDistiller({ llm: llmRef })
    // 代码地图：启动时先确保有一份，之后每天刷一次。
    // 之前只做了"启动时刷"，refresher 写了却没人调 —— 长期不重启的话地图会过期。
    try {
      refreshCodeMap(false)
    } catch {
      /* 没有就算了，用到时会现场扫 */
    }
    startCodeMapRefresher()
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

  // 表情包补语义标签：收的时候 NapCat 不带情绪，攒着慢慢用视觉模型补
  startEmojiTagger({ llm: llmRef, getRules: () => loadRules().rules })

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

// 原始对话也清理：distill 读 7 天、recall 读 3 天、关系降温读 30 天，
// 保留 35 天够了。不清的话 raw/ 会按天无限增长。
{
  const { pruneRaw } = await import('./memory/store.ts')
  const prunedRaw = pruneRaw(120)
  if (prunedRaw) info(`清理了 ${prunedRaw} 天的原始对话（保留 120 天）`)
  // 日志按天删（用启动时那个保留天数）+ 每 6 小时跑一次：
// 只在启动删的话，长期不重启会无限累积。以前这里写死 90，和配置里的 30 打架。
  setInterval(() => { try { pruneLogs(Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 30) } catch { /* ignore */ } }, 6 * 3600_000).unref?.()
  setInterval(() => {
    try {
      const n = pruneRaw(120)
      if (n) info(`清理了 ${n} 天的原始对话`)
    } catch {
      /* 删不掉就下次再说 */
    }
  }, 24 * 3_600_000).unref?.()
}

setInterval(() => {
  const n = pruneSessions()
  if (n) info(`清理了 ${n} 个不活跃会话`)
}, 30 * 60_000).unref?.()

// 控制台
const consolePort = Number(process.env['CONSOLE_PORT']) || 7788
const consoleToken = process.env['CONSOLE_TOKEN'] ?? ''
try {
// 控制台对话的 session 是内存态，重启就没了；但页面上的记录还在。
// 启动时倒回去，不然它"忘了"上一轮在控制台说过什么，看着像失忆。
try {
  const owner = String(process.env['OWNER_QQ'] ?? '').trim()
  if (owner) {
    const { restoreConsoleSession } = await import('./console/commit.ts')
    const n = await restoreConsoleSession(owner)
    if (n > 0) info(`控制台对话已恢复 ${n} 条（session 是内存态，重启靠这个接上）`)
  }
} catch {
  /* 恢复失败不影响启动 */
}

await startConsole({
      port: consolePort,
      // 手机要访问就设 CONSOLE_HOST=0.0.0.0（默认只听本机）
      host: process.env['CONSOLE_HOST'] || '127.0.0.1',
      // 控制台「对话」页要真聊：走和 QQ 同一条 generateReply
      reply: (m, r) => generateReply(m as never, { rules: r, llm: llm!, tools: toolRegistry ?? undefined }),
      token: consoleToken,
      getRules,
      transport,
      // 端口被占用时 WebSocketServer 不会 reject，start() 照样 resolve —— 
      // 把 startError 暴露给状态接口，控制台能显示"通道没起来"。
      getChannelStatus: () => {
        const base: { connected: boolean; startError: string | null } = {
          connected: transport.connected === true,
          startError: (transport as { startError?: string | null }).startError ?? null,
        }
        // 看门狗状态一起上报：/api/status 的 channel.watchdog 里能看到
        // 它有没有在计时、重启过几次、为什么压着不动手。
        //
        // connected 用实时值覆盖：看门狗关着的时候它从不采样，
        // 会一直返回初始的 false，控制台看起来像"断线了"（实际连着）。
        return Object.assign(base, {
          watchdog: { ...watchdogStatus(), connected: transport.connected === true },
        })
      },
      // 插件注册的工具（manifest 里 type: tool 的那些）挂进工具注册表，
      // 这样模型才能真正调用它们 —— 否则插件只是"装上了但用不上"。
      //
      // 这个回调会在**插件重载/卸载后**再被调用一次（带着最新的工具表）。
      // 所以不能"见到重名就跳过"：那样重载后注册表里还是旧 wrapper，
      // 控制台测试跑新代码、模型调用走旧代码（实测 BUG3-21）。
      // 规则：只覆盖"上次由插件注册过的名字"，绝不覆盖内置工具。
      onPluginTools: (tools) => {
        syncPluginTools(toolRegistry, tools, pluginToolNames, warnAt, info)
      },
      llm,
    })
} catch (err) {
  warnAt('控制台启动失败，不影响聊天', { err: String(err) })
}

// NapCat 掉线看门狗：WS 连续几分钟没连上（NapCat/QQ 掉线）就自动重启 NapCat。
// 判定依据、冷却策略见 src/napcat/manager.ts 的「掉线看门狗」一节；
// 开关是 rules.yaml 的 NapCat.掉线重启（默认开，控制台改完不用重启进程就生效）。
startWatchdog({
  isConnected: () => transport.connected === true,
  startError: () => (transport as { startError?: string | null }).startError ?? null,
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    info(`收到 ${sig}，正在退出`)
    // 先把待落盘的写入冲掉再退出：之前直接 process.exit(0)，
    // 正在生成的回复、后台评估、排队的写入会丢。
    void (async () => {
      // 先停看门狗：它的定时器还在跑，退出过程中可能正好触发一次「重启 NapCat」，
      // 于是刚关掉的进程又把 QQ 拉起来。以前 stopWatchdog 导出了却没人调。
      try {
        const { stopWatchdog } = await import('./napcat/manager.ts')
        stopWatchdog()
        info('掉线看门狗已停')
      } catch {
        /* ignore */
      }
      try {
        await Promise.race([transport.stop(), new Promise((r) => setTimeout(r, 3000))])
      } catch {
        /* 关不掉也要退 */
      }
      try {
        const { drainWrites } = await import('./store/serialize.ts')
        await drainWrites()
      } catch {
        /* ignore */
      }
      process.exit(0)
    })()
  })
}

process.on('unhandledRejection', (err) => errorAt('未处理的拒绝', { err: String(err) }))
// 同步异常也要兜住：boot 的 onMessage 里任何一句抛错（磁盘满/权限/半截文件）
// 之前会直接结束进程，Electron 那边只看到"静默掉线"。
process.on('uncaughtException', (err) => {
  errorAt('未捕获异常（进程继续运行）', { err: String(err), stack: err?.stack?.slice(0, 500) })
})
