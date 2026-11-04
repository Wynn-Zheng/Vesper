/**
 * 一把梭：跑完所有检查，并**校验输出格式**。
 *
 * 为什么要校验输出：之前有过 exit=0 但一个字没打印的情况——
 * 脚本自己崩在输出之前，退出码还是 0。只看退出码会被骗。
 */
import { execSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { judge } from './gate.ts'

interface Step {
  name: string
  cmd: string
  /** 输出里必须匹配这个正则，否则算失败（防止静默不工作） */
  expect: RegExp
  /** 需要服务在跑 */
  live?: boolean
  /**
   * 备选命令：正常命令失败、且输出里命中 fallbackWhen 时改跑它。
   *
   * 存在的理由：受限沙箱（DSH 的 workspace-write）会拒绝子进程开命名管道，
   * `node --test` 给每个测试文件 spawn 子进程时报 EPERM。
   * 这时退回单进程模式重跑，结果一样，只是不再逐文件隔离。
   */
  fallback?: string
  fallbackWhen?: RegExp
}

/** 临时输出目录：沙箱里不能走 pipe，只能落到文件再读 */
const TMP_DIR = '.tmp-check'

/**
 * 跑一条检查命令，把 stdout / stderr 收进同一个文件再读出来。
 *
 * 为什么不用 stdio:'pipe'：沙箱禁止命名管道，execSync 会直接 EPERM。
 * 文件重定向不经过管道，两种环境下都能工作。
 * 返回值里的 code 为 -1 表示连进程都没起来（被沙箱拒绝）。
 */
function runStep(cmd: string, id: number): { out: string; code: number } {
  mkdirSync(TMP_DIR, { recursive: true })
  const file = join(TMP_DIR, `${id}.log`)
  const fd = openSync(file, 'w')
  let code = 0
  try {
    execSync(cmd, {
      stdio: ['ignore', fd, fd],
      timeout: 300_000,
      // QQBOT_NO_LOG_FILE：测试不写 data/logs（否则 mock 的错误会污染真实日志和 issues.json）
      env: { ...process.env, NO_COLOR: '1', QQBOT_NO_LOG_FILE: '1' },
    })
  } catch (e) {
    const status = (e as { status?: unknown }).status
    code = typeof status === 'number' ? status : -1
  } finally {
    closeSync(fd)
  }

  let out = ''
  try {
    out = readFileSync(file, 'utf8')
  } catch {
    /* 文件没写出来：当作空输出，交给 expect 判失败 */
  }
  try {
    rmSync(file, { force: true })
  } catch {
    /* 删不掉不影响判定，下次会覆盖 */
  }
  return { out, code }
}

const STEPS: Step[] = [
  // 全量类型检查：含 scripts/（87 个脚本），catch 真正的类型错误
  { name: '类型检查', cmd: 'node node_modules/typescript/bin/tsc --noEmit', expect: /^$/ },
  // 严格检查（noUnusedLocals）只覆盖 src/dev/test：
  // scripts/ 是测试与工具脚本，未使用的 import 属风格问题，不强求。
  { name: '类型检查（严格）', cmd: 'node node_modules/typescript/bin/tsc -p tsconfig.strict.json --noEmit --noUnusedLocals', expect: /^$/ },
  {
    name: '单元测试',
    // 只保留单进程模式：本机（以及受限沙箱）里默认的「每文件一个子进程」会 spawn EPERM。
    // 以前这里还有一条 fallback，但 fallback 和主命令完全相同，等于没有备选——
    // 主命令失败时会原样再跑一遍，既慢又掩盖真实错误。
    cmd: 'node --test --test-isolation=none --test-force-exit test/*.test.ts',
    expect: /ℹ fail 0/,
  },
  { name: '冒烟', cmd: 'node scripts/smoke.ts', expect: /\d+ \/ \d+ 通过/ },
  { name: '数据体检', cmd: 'node scripts/check-data.ts', expect: /数据检查通过/ },
  { name: '配置检查', cmd: 'node scripts/check-config.ts', expect: /\S/ },
  // 匹配结论行而不是某句固定文案：以前那句「✓ 关键函数都在」是无条件打印的，
  // 于是这项检查永远通过。现在脚本有问题会打「发现 N 类问题」并以 1 退出。
  { name: '控制台审计', cmd: 'node scripts/audit-console.ts', expect: /审计结果：OK/ },
  { name: 'API 边界', cmd: 'node scripts/test-api-edges.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '并发', cmd: 'node scripts/test-concurrency.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '隐私边界', cmd: 'node scripts/test-privacy.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自修复', cmd: 'node scripts/test-selfrepair.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自我观察边界', cmd: 'node scripts/test-self-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  // test-deep 要连控制台（它自己 fetch 127.0.0.1:7788）。不标 live 的话，
  // 服务没起时它会以「退出码 1」失败，看起来像功能坏了，其实只是没环境。
  { name: '功能交互', cmd: 'node scripts/test-deep.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '资源增长', cmd: 'node --env-file-if-exists=.env scripts/test-growth.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '新功能', cmd: 'node --env-file-if-exists=.env scripts/test-features.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '看图', cmd: 'node --env-file-if-exists=.env scripts/test-vision.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '历史压缩', cmd: 'node scripts/test-compress.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '上下文循环边界', cmd: 'node scripts/test-loop-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '会话摘要', cmd: 'node scripts/test-session-summary.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '表情包', cmd: 'node scripts/test-emoji.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '表情包边界', cmd: 'node scripts/test-emoji-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '表情包通道', cmd: 'node scripts/test-emoji-channel.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '表达学习', cmd: 'node --env-file-if-exists=.env scripts/test-expression.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '存储层边界', cmd: 'node scripts/test-store-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '记忆层边界', cmd: 'node scripts/test-memory-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '调度器边界', cmd: 'node scripts/test-sched-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '整理分批与游标', cmd: 'node scripts/test-distill-batch.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '通道层边界', cmd: 'node scripts/test-chan-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '核心边界', cmd: 'node scripts/test-core-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '人物边界', cmd: 'node scripts/test-people-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '关系边界', cmd: 'node scripts/test-relation-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '模型客户端', cmd: 'node scripts/test-llm-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '外部能力', cmd: 'node scripts/test-outward-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '诊断工具', cmd: 'node scripts/test-diagnose-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '控制台与主流程', cmd: 'node --env-file-if-exists=.env scripts/test-console-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '端到端一致性', cmd: 'node --env-file-if-exists=.env scripts/test-integration-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '功能健康度', cmd: 'node --env-file-if-exists=.env scripts/test-feature-health.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '体验改进', cmd: 'node scripts/test-experience.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '记忆去重', cmd: 'node scripts/test-dedup.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '记忆维护', cmd: 'node scripts/test-memory-maintenance.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '旧数据兼容', cmd: 'node scripts/test-compat.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '备份恢复', cmd: 'node scripts/test-backup.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '代码工具', cmd: 'node scripts/test-tools.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '代码地图', cmd: 'node scripts/test-codemap.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '群成员名单', cmd: 'node --env-file-if-exists=.env scripts/test-group.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '名字同步', cmd: 'node --env-file-if-exists=.env scripts/test-names.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '能力诚实性', cmd: 'node --env-file-if-exists=.env scripts/test-honesty.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '人格卡与视觉回归', cmd: 'node --env-file-if-exists=.env scripts/test-persona-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '视觉回归', cmd: 'node --env-file-if-exists=.env scripts/test-vision-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '核心记忆', cmd: 'node --env-file-if-exists=.env scripts/test-core.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '衰减与召回', cmd: 'node --env-file-if-exists=.env scripts/test-decay.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '事实分档', cmd: 'node --env-file-if-exists=.env scripts/test-facts-tier.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '事实矛盾', cmd: 'node scripts/test-fact-conflict.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '情节档位', cmd: 'node --env-file-if-exists=.env scripts/test-episode-tier.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '记忆优化四项', cmd: 'node --env-file-if-exists=.env scripts/test-memory-opt.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '边界扫描', cmd: 'node --env-file-if-exists=.env scripts/scan-bugs.ts', expect: /没发现 bug/ },  { name: '情绪效价', cmd: 'node --env-file-if-exists=.env scripts/test-mood-valence.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '情绪对比基准', cmd: 'node --env-file-if-exists=.env scripts/test-mood-context.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '拟人化', cmd: 'node --env-file-if-exists=.env scripts/test-humanlike.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '改口', cmd: 'node --env-file-if-exists=.env scripts/test-retract.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '引用判定', cmd: 'node --env-file-if-exists=.env scripts/test-quote.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '过滤原因', cmd: 'node --env-file-if-exists=.env scripts/test-reject.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自我所有权', cmd: 'node --env-file-if-exists=.env scripts/test-self-owner.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '申请流程', cmd: 'node --env-file-if-exists=.env scripts/test-requests.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自我页结构', cmd: 'node --env-file-if-exists=.env scripts/test-self-page.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '人物扩展', cmd: 'node --env-file-if-exists=.env scripts/test-people-extras.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '控制台自查', cmd: 'node --env-file-if-exists=.env scripts/selfcheck-console.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '控制台边界', cmd: 'node --env-file-if-exists=.env scripts/test-console-edge.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '群聊发言人', cmd: 'node --env-file-if-exists=.env scripts/test-speaker.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '群名单恢复', cmd: 'node --env-file-if-exists=.env scripts/test-restore-groups.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '名字一致性', cmd: 'node --env-file-if-exists=.env scripts/test-name-consistency.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '名字边界', cmd: 'node --env-file-if-exists=.env scripts/test-name-edge.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '检索边界', cmd: 'node --env-file-if-exists=.env scripts/test-recall-edge.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '群名单并发', cmd: 'node --env-file-if-exists=.env scripts/test-group-concurrent.ts', expect: /通过 \d+ \/ 失败 0/ },

  // 插件系统（阶段 3+4）
  { name: '它能自改角色卡', cmd: 'node scripts/test-autonomy.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '插件注册表', cmd: 'node scripts/selfcheck-plugin-registry.ts', expect: /全部通过/ },
  { name: '插件宿主', cmd: 'node scripts/selfcheck-plugin-host.ts', expect: /全部通过/ },
  { name: '插件权限', cmd: 'node scripts/selfcheck-plugin-permissions.ts', expect: /全部通过/ },
  { name: '插件安装', cmd: 'node scripts/selfcheck-plugin-installer.ts', expect: /全部通过/ },
  { name: '插件接口', cmd: 'node scripts/selfcheck-plugin-api.ts', expect: /全部通过/ },
  { name: '插件前端', cmd: 'node scripts/selfcheck-console-plugins.ts', expect: /全部通过/ },
  { name: '插件端到端', cmd: 'node --env-file-if-exists=.env scripts/test-plugins-e2e.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '插件边界', cmd: 'node --env-file-if-exists=.env scripts/test-plugins-edge.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
]

/**
 * 控制台端口：默认 7788，可用 CONSOLE_PORT 覆盖。
 *
 * 以前写死 7788：换个端口跑就永远「服务没在跑」，6 项 live 检查全被跳过，
 * 而跳过又是绿色——两处错叠在一起，等于集成检查从来没真跑过。
 */
const CONSOLE_PORT = process.env.CONSOLE_PORT ?? '7788'
const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}/api/status`

/**
 * 服务是否**真的就绪**。
 *
 * 401 不算就绪：说明服务在，但 token 不对——后面 6 项 live 检查会全部 401，
 * 与其「跳过」不如直接判环境没准备好（B-48）。用 `--env-file=.env` 跑本脚本可带上 CONSOLE_TOKEN。
 */
async function serviceUp(): Promise<boolean> {
  const token = process.env.CONSOLE_TOKEN ?? ''
  if (!token) {
    console.log('⚠ 没读到 CONSOLE_TOKEN：live 检查会 401。请用 `node --env-file=.env scripts/check-all.ts`')
  }
  try {
    const res = await fetch(CONSOLE_URL, {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(2000),
    })
    return res.status === 200
  } catch {
    return false
  }
}

const ALLOW_SKIP = process.argv.includes('--allow-skip')
const live = await serviceUp()
if (!live) {
  console.log('⚠ 控制台没就绪（200 才算），需要服务的检查会被跳过\n')
}

interface Result {
  name: string
  ok: boolean
  ms: number
  /** 为什么失败 */
  why?: string
  /** 需要服务、但服务没跑，这一项其实**没验证** */
  skipped?: boolean
}

const results: Result[] = []

for (const [index, step] of STEPS.entries()) {
  if (step.live && !live) {
    // 以前这里记成 ok:true —— 于是没起服务时，集成检查全都"通过"，
    // 最后还打印"全部通过 83 项"。这是最危险的一种假绿：
    // 看起来验证过了，其实一个接口都没打过。
    results.push({ name: step.name, ok: true, ms: 0, why: '跳过（服务没跑）', skipped: true })
    continue
  }

  const t0 = Date.now()
  let { out, code } = runStep(step.cmd, index)
  // 判定统一走 gate.ts：退出码 + 输出格式 + "至少跑了 1 项、且没有失败"。
  // 最后那条专门治另一种假绿：脚本里一个用例都没跑，却打印「通过 0 / 失败 0」——
  // 光看退出码和正则，它会稳稳地"通过"。
  let verdict = judge(out, code, step.expect)

  // 正常命令在受限环境里起不来（EPERM）时换备选命令再试一次
  if (!verdict.ok && step.fallback && step.fallbackWhen?.test(out)) {
    ;({ out, code } = runStep(step.fallback, index))
    verdict = judge(out, code, step.expect)
  }

  const ok = verdict.ok
  const why = verdict.why

  const ms = Date.now() - t0
  results.push({ name: step.name, ok, ms, why })

  const mark = ok ? '✓' : '✗'
  const note = why ? `  ${why}` : ''
  console.log(`${mark} ${step.name.padEnd(12, ' ')} ${String(ms).padStart(6)}ms${note}`)

  if (!ok) {
    // 失败就把尾巴打出来，省得再跑一次
    const tail = out.trim().split('\n').slice(-12).join('\n')
    console.log(
      tail
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n'),
    )
  }
}

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
const total = results.length
const ran = total - skipped.length
console.log('')
console.log('─'.repeat(50))
if (skipped.length) {
  // 把"跳过"单独说出来，不能混进"通过"里：
  // 需要服务的检查没跑，就等于集成部分完全没验证过。
  console.log(`⚠ 有 ${skipped.length} 项需要服务、没跑（这些**不算验证过**）：`)
  for (const s of skipped) console.log(`  - ${s.name}`)
  console.log('  想跑全的话：先启动服务（node --env-file=.env src/index.ts），再执行本命令')
}
if (failed.length === 0 && skipped.length > 0 && !ALLOW_SKIP) {
  // 跳过 = 没验证。以前这里 exit 0，于是「没起服务」也能拿到绿色和
  // 「实际通过 77 项」的结论——集成部分一个接口都没打过。现在默认按失败处理，
  // 只留 --allow-skip 给「本地只想跑静态检查」的场景。
  console.log(`⚠ ${skipped.length} 项未验证，按失败退出（这些不算验证过）`)
  console.log('  确认服务已启动并可带 token 访问；只跑静态检查时可加 --allow-skip')
  process.exit(1)
}
if (failed.length === 0) {
  if (skipped.length) console.log(`实际通过：${ran} 项（另有 ${skipped.length} 项跳过）`)
  else console.log(`全部通过：${total} 项`)
  process.exit(0)
} else {
  console.log(`失败 ${failed.length} / ${total} 项：`)
  for (const f of failed) console.log(`  ✗ ${f.name}${f.why ? ` — ${f.why}` : ''}`)
  process.exit(1)
}
