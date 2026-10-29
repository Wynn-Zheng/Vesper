/**
 * 在线更新：查版本、下载更新包、解压、标记待替换。
 *
 * 真正"替换 resources/app"这步不在这里做 —— 后端正跑在 app 目录里，
 * 在 Windows 上覆盖自己加载中的 js 会失败。所以这里只负责：
 *   1. 下载 app.tar.gz 并校验 sha256
 *   2. 解压到 update/unpacked/app
 *   3. 写 update/pending.json
 * Electron 主进程在**下次启动后端之前**读 pending.json 完成替换（那时文件没被占用）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'update'

export interface LatestInfo {
  version: string
  buildTime: string
  git?: string
  app?: { url: string; sha256: string; size: number }
}

export interface CheckResult {
  ok: boolean
  error?: string
  latest?: LatestInfo
  hasNew?: boolean
}

function baseUrl(): string {
  return (process.env['UPDATE_URL'] ?? '').trim().replace(/\/+$/, '')
}

function headers(): Record<string, string> {
  const token = (process.env['UPDATE_TOKEN'] ?? '').trim()
  return token ? { 'x-update-token': token } : {}
}

function joinUrl(path: string): string {
  return baseUrl() + '/' + path
}

/** 拉 latest.json，和当前版本比一比 */
export async function checkUpdate(current: string): Promise<CheckResult> {
  if (!baseUrl()) return { ok: false, error: '没配置 UPDATE_URL（在 .env 里加一行）' }
  try {
    const r = await fetch(joinUrl('latest.json') + '?t=' + Date.now(), { headers: headers() })
    if (!r.ok) return { ok: false, error: '取版本信息失败：HTTP ' + r.status }
    const latest = (await r.json()) as LatestInfo
    if (!latest || !latest.version) return { ok: false, error: '版本信息格式不对' }
    return { ok: true, latest, hasNew: latest.version !== current }
  } catch (err) {
    return { ok: false, error: '连不上更新源：' + String(err).slice(0, 160) }
  }
}

/** 下载 + 校验 + 解压 + 标记待替换 */
export async function downloadUpdate(latest: LatestInfo): Promise<{ ok: boolean; error?: string }> {
  if (!latest.app?.url || !latest.app.sha256) return { ok: false, error: '版本信息里没有包地址或校验值' }
  const dir = DIR
  const tar = join(dir, 'app.tar.gz')
  const unpacked = join(dir, 'unpacked')
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(unpacked, { recursive: true })

    const r = await fetch(joinUrl(latest.app.url) + '?t=' + Date.now(), { headers: headers() })
    if (!r.ok) return { ok: false, error: '下载失败：HTTP ' + r.status }
    const buf = Buffer.from(await r.arrayBuffer())
    if (latest.app.size && buf.length !== latest.app.size) {
      return { ok: false, error: `包大小不对（${buf.length} ≠ ${latest.app.size}）` }
    }
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== latest.app.sha256) return { ok: false, error: '校验失败：包可能下坏了，重试一次' }
    writeFileSync(tar, buf)

    // 用系统 tar 解压（Windows 10+ / Linux 都自带）
    execFileSync('tar', ['-xzf', tar, '-C', unpacked], { stdio: 'ignore' })

    const appDir = join(unpacked, 'app')
    for (const must of ['main.js', 'build', 'console']) {
      if (!existsSync(join(appDir, must))) {
        return { ok: false, error: `包内容不完整（缺 ${must}）` }
      }
    }

    writeFileSync(
      join(dir, 'pending.json'),
      JSON.stringify({ version: latest.version, at: Date.now(), from: latest.git ?? '' }, null, 2),
      'utf8',
    )
    rmSync(tar, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: '更新失败：' + String(err).slice(0, 200) }
  }
}

/** 有没有已经下好、等重启生效的更新 */
export function pendingUpdate(): { version: string; at: number } | null {
  try {
    const f = join(DIR, 'pending.json')
    if (!existsSync(f)) return null
    return JSON.parse(readFileSync(f, 'utf8')) as { version: string; at: number }
  } catch {
    return null
  }
}
