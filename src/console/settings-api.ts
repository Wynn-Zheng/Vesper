/**
 * 设置页的数据/服务/模型/关于接口。
 *
 * 和 misc-api 的分工：
 *   misc-api     → NapCat 状态、余额（仪表盘在用）
 *   这个文件      → 数据目录、磁盘、备份、模型配置、版本（设置页在用）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
