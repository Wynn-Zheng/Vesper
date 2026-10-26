#!/usr/bin/env node
/**
 * agenttree 的 act 执行器包装：先试 opencode，不行再换 dsh headless。
 *
 * 为什么需要这个包装：
 *   agenttree 的 worker_for() 只检查「配置里有没有这个 worker」，
 *   不检查「这个 worker 还能不能用」——
 *       for name in chain:
 *           worker = self.workers.get(name)
 *           if worker is not None:
 *               return worker      // 只要配了就用，不管死活
 *   所以 route.act = ["opencode", "dsh"] 不会自动 fallback。
 *
 * opencode 挂的原因已知：免费额度用完
 *   {"type":"provider.quota","message":"Free usage limit reached...","status":429}
 * 订阅或额度恢复后它又能用，所以不能直接删掉它。
 *
 * 用法（在 project.toml 里）：
 *   [[workers]]
 *   name = "act"
 *   kind = "cli"
 *   cmd = ["node", "scripts/act-fallback.mjs", "{spec}"]
 *
 * 环境变量（都可选，用来覆盖默认路径）：
 *   OPENCODE_CLI   默认 C:\Users\<you>\AppData\Local\Programs\@opencodedesktop\resources\opencode-cli.exe
 *   DSH_BIN        默认 <npm-global>\node_modules\@deepseek-ai\dsh\lib\bin.js
 *   ACT_FORCE      设成 opencode 或 dsh 就只用那个（调试用）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const spec = process.argv[2] ?? ''
if (!spec.trim()) {
  process.stderr.write('[act] 没收到 spec\n')
  process.exit(2)
}

const home = homedir()

/**
 * 找 dsh 的 bin.js。
 *
 * 不写死一个路径：npm 全局目录可能是 AppData\Local\npm-global、
 * AppData\Roaming\npm、或者 node 自己的目录，不同机器不一样。
 * 按可能性从高到低试，第一个存在的就用。
 */
function findDshBin() {
  if (process.env['DSH_BIN']) return process.env['DSH_BIN']

  const candidates = [
    join(home, 'AppData', 'Local', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    // node 自己的 lib/node_modules（从 node.exe 推导）
    join(process.execPath, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.execPath, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]

  // PATH 里有 dsh.cmd 的话，用它同级的 node_modules
  for (const dir of (process.env['PATH'] ?? '').split(';')) {
    if (!dir) continue
    const cmd = join(dir, 'dsh.cmd')
    if (existsSync(cmd)) {
      candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0] // 都不存在时返回第一个，报错信息里能看出试过哪
}

const OPENCODE =
  process.env['OPENCODE_CLI'] ??
  join(home, 'AppData', 'Local', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe')

const DSH_BIN = findDshBin()

const TIMEOUT = 20 * 60_000

/** 跑一个命令，返回 { code, stdout, stderr, reason } */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: opts.timeout ?? TIMEOUT,
    // 给足缓冲区：dsh 的 reasoning 输出可能很长
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (r.error) {
    return { code: -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', reason: String(r.error.message).slice(0, 200) }
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', reason: '' }
}

/** opencode 的错误信息里有没有"额度用完"这类可以明确判定的失败 */
function isQuotaError(stderr) {
  return /Free usage limit reached|provider\.quota|FreeUsageLimitError/i.test(stderr)
}

const force = (process.env['ACT_FORCE'] ?? '').toLowerCase()

/* ---------- 1. opencode ---------- */
if (force !== 'dsh') {
  if (!existsSync(OPENCODE)) {
    process.stderr.write(`[act] opencode 不在（${OPENCODE}），跳过\n`)
  } else {
    const r = run(OPENCODE, [
      'run',
      '--standalone',
      '--auto',
      '--format',
      'json',
      '-m',
      'opencode/deepseek-v4.1-flash-free',
      spec,
    ])

    // 即使 exit 0，也要看看 stderr 里有没有额度错误——
    // 实测 opencode 额度用完时 exit=1 且 stdout 里带 error 事件，
    // 但不同版本行为可能不一致，所以两头都查。
    const combined = `${r.stdout}\n${r.stderr}`
    if (r.code === 0 && !isQuotaError(combined)) {
      process.stdout.write(r.stdout)
      if (r.stderr) process.stderr.write(r.stderr)
      process.exit(0)
    }

    // 额度用完是"确定不可用"，换 dsh；其他失败也换（总比整节点失败好）
    const why = isQuotaError(combined) ? 'opencode 免费额度用完' : `opencode 失败（exit=${r.code}${r.reason ? '，' + r.reason : ''}）`
    process.stderr.write(`[act] ${why}，改用 dsh headless\n`)
  }
}

/* ---------- 2. dsh headless ---------- */
if (force === 'opencode') {
  process.stderr.write('[act] ACT_FORCE=opencode，但 opencode 不可用\n')
  process.exit(1)
}

if (!existsSync(DSH_BIN)) {
  process.stderr.write(`[act] dsh 不在（${DSH_BIN}）\n`)
  process.exit(1)
}

const r2 = run('node', [DSH_BIN, '--profile', 'headless', spec])
process.stdout.write(r2.stdout)
if (r2.stderr) process.stderr.write(r2.stderr)
process.exit(r2.code)
