/**
 * 一把梭：跑完所有检查，并**校验输出格式**。
 *
 * 为什么要校验输出：之前有过 exit=0 但一个字没打印的情况——
 * 脚本自己崩在输出之前，退出码还是 0。只看退出码会被骗。
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

interface Step {
  name: string
  cmd: string
  /** 输出里必须匹配这个正则，否则算失败（防止静默不工作） */
  expect: RegExp
  /** 需要服务在跑 */
  live?: boolean
}

const STEPS: Step[] = [
  { name: '类型检查', cmd: 'node node_modules/typescript/bin/tsc --noEmit', expect: /^$/ },
  { name: '类型检查（严格）', cmd: 'node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals', expect: /^$/ },
  { name: '单元测试', cmd: 'node --test test/*.test.ts', expect: /ℹ fail 0/ },
  { name: '冒烟', cmd: 'node scripts/smoke.ts', expect: /\d+ \/ \d+ 通过/ },
  { name: '数据体检', cmd: 'node scripts/check-data.ts', expect: /数据检查通过/ },
  { name: '配置检查', cmd: 'node scripts/check-config.ts', expect: /\S/ },
  { name: '控制台审计', cmd: 'node scripts/audit-console.ts', expect: /关键函数都在/ },
  { name: 'API 边界', cmd: 'node scripts/test-api-edges.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '并发', cmd: 'node scripts/test-concurrency.ts', expect: /通过 \d+ \/ 失败 0/, live: true },
  { name: '隐私边界', cmd: 'node scripts/test-privacy.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自修复', cmd: 'node scripts/test-selfrepair.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '自我观察边界', cmd: 'node scripts/test-self-bugs.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '功能交互', cmd: 'node scripts/test-deep.ts', expect: /通过 \d+ \/ 失败 0/ },
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
  { name: '代码工具', cmd: 'node scripts/test-tools.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '代码地图', cmd: 'node scripts/test-codemap.ts', expect: /通过 \d+ \/ 失败 0/ },
  { name: '群成员名单', cmd: 'node --env-file-if-exists=.env scripts/test-group.ts', expect: /通过 \d+ \/ 失败 0/ },
]

const CONSOLE_URL = 'http://127.0.0.1:7788/api/status'

async function serviceUp(): Promise<boolean> {
  try {
    const res = await fetch(CONSOLE_URL, {
      headers: { 'x-console-token': process.env.CONSOLE_TOKEN ?? 'REDACTED' },
      signal: AbortSignal.timeout(2000),
    })
    return res.status === 200 || res.status === 401
  } catch {
    return false
  }
}

const live = await serviceUp()
if (!live) console.log('⚠ 控制台没在跑，跳过需要服务的检查\n')

interface Result {
  name: string
  ok: boolean
  ms: number
  /** 为什么失败 */
  why?: string
}

const results: Result[] = []

for (const step of STEPS) {
  if (step.live && !live) {
    results.push({ name: step.name, ok: true, ms: 0, why: '跳过（服务没跑）' })
    continue
  }

  const t0 = Date.now()
  let out = ''
  let ok = true
  let why: string | undefined

  try {
    out = execSync(step.cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
      env: { ...process.env, NO_COLOR: '1' },
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number; message?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    ok = false
    why = `退出码 ${err.status ?? '?'}`
  }

  // 关键：校验输出格式，防止"跑了但什么都没发生"
  if (ok && !step.expect.test(out)) {
    ok = false
    why = `输出里没有预期内容（${step.expect}）——可能静默失败`
  }

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
const total = results.length
console.log('')
console.log('─'.repeat(50))
if (failed.length === 0) {
  console.log(`全部通过：${total} 项`)
  process.exit(0)
} else {
  console.log(`失败 ${failed.length} / ${total} 项：`)
  for (const f of failed) console.log(`  ✗ ${f.name}${f.why ? ` — ${f.why}` : ''}`)
  process.exit(1)
}
