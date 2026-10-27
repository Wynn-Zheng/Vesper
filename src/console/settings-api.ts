/**
 * 设置页的数据/服务/模型/关于接口。
 *
 * 和 misc-api 的分工：
 *   misc-api     → NapCat 状态、余额（仪表盘在用）
 *   这个文件      → 数据目录、磁盘、备份、模型配置、版本（设置页在用）
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { loadRules } from '../core/config.ts'

type Json = (res: ServerResponse, code: number, body: unknown) => void

/** 递归算目录大小（只算文件，跳过 node_modules/.git） */
function dirSize(dir: string, skip = new Set(['node_modules', '.git', '.agenttree', 'versions'])): number {
  let total = 0
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (skip.has(name)) continue
      const p = join(d, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      } catch {
        /* 跳过 */
      }
    }
  }
  walk(dir)
  return total
}

function human(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024 ** 3).toFixed(2) + ' GB'
}

export async function handleSettingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  _url: URL,
  json: Json,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  /* ============ 数据：目录 / 磁盘 / 备份 ============ */
  /* ============ 日志保留天数 ============ */
  if (method === 'GET' && path === '/api/settings/log-retention') {
    try {
      const { loadRules } = await import('../core/config.ts')
      json(res, 200, { 保留天数: loadRules().rules.日志?.保留天数 ?? 30 })
    } catch (e) {
      json(res, 200, { 保留天数: 30, error: String(e).slice(0, 100) })
    }
    return true
  }

  if (method === 'PUT' && path === '/api/settings/log-retention') {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { 保留天数?: number }
    const days = Math.round(Number(body.保留天数))

    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      json(res, 400, { error: '保留天数要在 1 ~ 3650 之间' })
      return true
    }

    const { setConfigPath } = await import('./config-write.ts')
    const raw = readFileSync('persona/rules.yaml', 'utf8')
    const r = setConfigPath(raw, '日志.保留天数', days)
    if (!r.ok) {
      json(res, 400, { error: r.error ?? '改不了' })
      return true
    }
    writeFileSync('persona/rules.yaml', r.text, 'utf8')
    json(res, 200, { ok: true, 保留天数: days, note: '下次启动时生效' })
    return true
  }

  if (method === 'GET' && path === '/api/settings/data') {
    const cwd = process.cwd()

    const parts: Array<{ name: string; path: string; bytes: number; human: string }> = []
    for (const name of ['persona', 'data', 'console', 'src']) {
      const p = join(cwd, name)
      if (!existsSync(p)) continue
      const b = dirSize(p)
      parts.push({ name, path: p, bytes: b, human: human(b) })
    }

    // 快照数量
    let snapshots = 0
    let snapBytes = 0
    try {
      const vdir = join(cwd, 'data', 'versions')
      if (existsSync(vdir)) {
        const list = readdirSync(vdir)
        snapshots = list.length
        snapBytes = dirSize(vdir, new Set())
      }
    } catch {
      /* 忽略 */
    }

    json(res, 200, {
      cwd,
      parts,
      total: human(parts.reduce((a, x) => a + x.bytes, 0)),
      snapshots,
      snapshotsSize: human(snapBytes),
      logFiles: (() => {
        try {
          const d = join(cwd, 'data', 'logs')
          return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).length : 0
        } catch {
          return 0
        }
      })(),
    })
    return true
  }

  /* ============ 模型：当前配置 + 连通性 ============ */
  if (method === 'GET' && path === '/api/settings/model') {
    const key = (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
    json(res, 200, {
      // key 只露前后各 4 位，防止整串出现在界面上
      apiKey: key ? key.slice(0, 6) + '…' + key.slice(-4) : '',
      hasKey: Boolean(key),
      baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com（默认）',
      model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat（默认）',
      // 配置和数据到底在哪 —— 用户想手动改文件、或者换台机器搬数据时要看这个。
      // 打包后 cwd 是 %APPDATA%\QQBot\data-root，不写出来没人找得到。
      envPath: resolve('.env'),
      dataDir: resolve('.'),
      visionModel: (() => {
        try {
          return loadRules().rules.视觉?.模型 || ''
        } catch {
          return ''
        }
      })(),
    })
    return true
  }

  /* ============ 改模型配置（写入 .env / rules.yaml） ============ */
  // 支持三样：
  //   apiKey      → .env 的 DEEPSEEK_API_KEY
  //   model       → .env 的 DEEPSEEK_MODEL
  //   visionModel → rules.yaml 的 视觉.模型
  //
  // BASE_URL 不在里面：.env 里写它会被忽略（只认启动环境），代码里有默认值。
  if (method === 'PUT' && path === '/api/settings/model') {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      apiKey?: string
      model?: string
      visionModel?: string
    }

    const changed: string[] = []
    const errors: string[] = []

    // ---- .env 里的两项（按行替换，不用正则，省得和转义打架）----
    const envTodo: Array<[string, string]> = []
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      envTodo.push(['DEEPSEEK_API_KEY', body.apiKey])
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      envTodo.push(['DEEPSEEK_MODEL', body.model])
    }

    if (envTodo.length) {
      try {
        const envPath = '.env'
        const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
        // 备份一次（只在还没备份过时）
        if (existsSync(envPath) && !existsSync(envPath + '.bak')) {
          copyFileSync(envPath, envPath + '.bak')
        }

        const lines = text.split('\n')
        for (const [k, raw] of envTodo) {
          // key 去掉前后引号，避免写成 KEY="sk-xxx"
          const val = raw.trim().replace(/^["']|["']$/g, '')
          const idx = lines.findIndex((l) => l.trimStart().startsWith(k + '='))
          if (idx >= 0) lines[idx] = k + '=' + val
          else lines.push(k + '=' + val)
          changed.push(k)
        }

        writeFileSync(envPath, lines.join('\n'), 'utf8')
      } catch (e) {
        errors.push('.env 写入失败：' + String(e).slice(0, 80))
      }
    }

    // ---- rules.yaml 里的视觉模型 ----
    if (typeof body.visionModel === 'string') {
      try {
        const { setConfigPath } = await import('./config-write.ts')
        const raw = readFileSync('persona/rules.yaml', 'utf8')
        const r = setConfigPath(raw, '视觉.模型', body.visionModel.trim())
        if (r.ok) {
          writeFileSync('persona/rules.yaml', r.text, 'utf8')
          changed.push('视觉.模型')
        } else {
          errors.push('rules.yaml 写入失败：' + (r.error ?? '?'))
        }
      } catch (e) {
        errors.push('rules.yaml：' + String(e).slice(0, 80))
      }
    }

    if (errors.length) {
      json(res, 400, { error: errors.join('；'), changed })
      return true
    }
    json(res, 200, {
      ok: true,
      changed,
      // .env 是进程启动时读的，改了要重启才生效
      note: changed.some((c) => c.startsWith('DEEPSEEK')) ? '改 .env 要重启才生效' : '已生效',
    })
    return true
  }

  /* ============ 关于：版本 + git ============ */
  if (method === 'GET' && path === '/api/settings/about') {
    let version = '0.0.0'
    try {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
      version = pkg.version ?? '0.0.0'
    } catch {
      /* 读不到 */
    }

    let git = ''
    let dirty = false
    try {
      git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
      dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    } catch {
      /* 不是 git 仓库 */
    }

    json(res, 200, {
      version,
      git,
      dirty,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.round(process.uptime()),
      // 更新占位：先只显示版本号，不做真更新
      updateAvailable: null,
    })
    return true
  }

  /* ============ 服务：重启（只提示，真重启要外部做） ============ */
  if (method === 'POST' && path === '/api/settings/restart') {
    // 自己杀自己会让响应发不出去。所以返回一句"请手动重启"，
    // 打包成 Electron 之后由主进程管这块（那里能安全重启）。
    json(res, 200, {
      ok: false,
      needManual: true,
      detail: '服务不能自己重启（会掐断正在返回的响应）。请在终端 Ctrl+C 后重新 npm start；打包成软件后这里会变成"重启"按钮。',
    })
    return true
  }

  return false
}
