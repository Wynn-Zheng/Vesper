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
import { compareVersions } from '../plugins/manifest.ts'

const DIR = 'update'

export interface LatestInfo {
  version: string
  buildTime: string
  git?: string
  app?: { url: string; sha256: string; size: number }
  /** 这个版本信息从哪来：官网（能增量更新）还是 GitHub Release（只能整包下载） */
  source?: 'self' | 'github'
  /** 整包的下载页（GitHub Release 时用） */
  pageUrl?: string
}

export interface CheckResult {
  ok: boolean
  error?: string
  latest?: LatestInfo
  hasNew?: boolean
}

/** GitHub 仓库（双渠道的第二个来源） */
const GITHUB_REPO = process.env['UPDATE_GITHUB_REPO'] ?? 'Wynn-Zheng/Vesper'

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

/** 去掉 v 前缀，方便和 package.json 的版本号比 */
function normVer(v: string): string {
  return String(v ?? '').trim().replace(/^v/i, '')
}

/** 从官网拉 latest.json（能增量更新） */
async function checkSelf(current: string): Promise<CheckResult> {
  if (!baseUrl()) return { ok: false, error: '没配置 UPDATE_URL' }
  try {
    const r = await fetch(joinUrl('latest.json') + '?t=' + Date.now(), { headers: headers() })
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status }
    const latest = (await r.json()) as LatestInfo
    if (!latest || !latest.version) return { ok: false, error: '版本信息格式不对' }
    return {
      ok: true,
      latest: { ...latest, source: 'self' },
      hasNew: normVer(latest.version) !== normVer(current),
    }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) }
  }
}

/**
 * 从 GitHub Releases 查最新版（整包，只能手动下载）。
 *
 * 双渠道的意义：官网挂了或者忘了更新，用户至少还能从 GitHub 拿到新版。
 * 走公开 API，不带 token（限速 60 次/小时，够用）。
 */
async function checkGitHub(current: string): Promise<CheckResult> {
  const repo = GITHUB_REPO.trim()
  if (!repo || !repo.includes('/')) return { ok: false, error: '没配置 GitHub 仓库' }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'vesper-updater' },
    })
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status }
    const rel = (await r.json()) as {
      tag_name?: string
      html_url?: string
      published_at?: string
      assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>
    }
    const version = normVer(rel.tag_name ?? '')
    if (!version) return { ok: false, error: 'release 里没有 tag' }
    // 优先找 win-x64 的 zip
    const asset =
      rel.assets?.find((a) => /win-x64\.zip$/i.test(a.name ?? '')) ?? rel.assets?.find((a) => /\.zip$/i.test(a.name ?? ''))
    return {
      ok: true,
      latest: {
        version,
        buildTime: rel.published_at ?? '',
        source: 'github',
        pageUrl: rel.html_url ?? `https://github.com/${repo}/releases/latest`,
        ...(asset?.browser_download_url
          ? { app: { url: asset.browser_download_url, sha256: '', size: asset.size ?? 0 } }
          : {}),
      },
      hasNew: version !== normVer(current),
    }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) }
  }
}

/**
 * 查更新：两个渠道都问，取版本号更高的那个。
 *
 * 官网的能增量更新（下载 app.tar.gz 只换代码）；GitHub 的是整包 zip，
 * 只能引导用户去下载页 —— 让用户知道"两个地方都能拿"，比只认一个源可靠。
 */
export async function checkUpdate(current: string): Promise<CheckResult> {
  const [self, gh] = await Promise.all([checkSelf(current), checkGitHub(current)])

  // 两个都失败才算失败
  if (!self.ok && !gh.ok) {
    const parts = [self.error ? '官网：' + self.error : '', gh.error ? 'GitHub：' + gh.error : ''].filter(Boolean)
    return { ok: false, error: '两个更新源都连不上（' + parts.join('；') + '）' }
  }

  const pick = (): CheckResult => {
    if (self.ok && gh.ok) {
      const a = normVer(self.latest!.version)
      const b = normVer(gh.latest!.version)
      if (a === b) return self // 一样高就优先官网（能增量更新）
      try {
        // compareVersions 返回 >0 表示 a 更高
        return compareVersions(a, b) >= 0 ? self : gh
      } catch {
        return self
      }
    }
    return self.ok ? self : gh
  }

  // 取版本更高的那个；一样高时优先官网（它支持增量更新）
  return pick()
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
