/**
 * 把内置的 NapCat 复制一份到用户数据目录，并写好配置。
 *
 * 为什么内置而不是联网下载：
 *   NapCat 的 release 包（34MB / 118MB）从 GitHub 拉不动（实测 34MB 走镜像
 *   也断流）。而本机装好的那一份是完整的（含 QQ 本体 1.2GB），直接复制
 *   最可靠，而且完全离线。
 *
 * 为什么复制而不是直接用 resources 里那份：
 *   resources 在安装目录（可能只读，而且升级会被覆盖）。
 *   NapCat 运行时会往自己目录里写 config/cache/logs，必须在可写的位置。
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setConfigPath } from '../console/config-write.ts'

export type InstallState = 'idle' | 'copying' | 'configuring' | 'done' | 'error'

export type InstallStatus = {
  state: InstallState
  /** 0~1 */
  percent: number
  message: string
  /** 装好后的 Shell 目录（<数据目录>/napcat/NapCat.xxx.Shell） */
  shellDir?: string
  error?: string
}

/** 单个安装任务的状态（同一时间只允许一个） */
let status: InstallStatus = { state: 'idle', percent: 0, message: '' }

export function installStatus(): InstallStatus {
  return { ...status }
}

export function resetInstallStatus(): void {
  status = { state: 'idle', percent: 0, message: '' }
}

/** 这些是运行产物，不该跟着新机器走 */
function shouldSkip(p: string): boolean {
  const name = p.replace(/\\/g, '/').split('/').pop() ?? ''
  if (/\.log$/i.test(name)) return true
  if (/\.bak\d*$/i.test(name)) return true
  if (/\.db-(wal|shm)$/i.test(name)) return true
  if (name === 'NapCat.Shell.zip') return true
  return false
}

/** 递归数文件数，用来算进度 */
async function countFiles(dir: string): Promise<number> {
  let n = 0
  const walk = async (p: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(p, e.name)
      if (shouldSkip(full)) continue
      if (e.isDirectory()) await walk(full)
      else n++
    }
  }
  await walk(dir)
  return n
}

/** 在目标目录里找 <xxx>.Shell */
async function findShellDir(targetDir: string): Promise<string | null> {
  try {
    const entries = await readdir(targetDir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory() && /\.Shell$/i.test(e.name)) return join(targetDir, e.name)
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 开始安装（异步，立即返回）。
 *
 * 调用方轮询 installStatus() 看进度。
 */
export function startInstall(options: {
  /** 包里的 NapCat 目录（resources/napcat） */
  bundleDir: string
  /** 复制到哪（<数据目录>/napcat） */
  targetDir: string
  /** rules.yaml 路径，用来写 Shell目录 */
  rulesFile: string
}): { ok: boolean; error?: string } {
  if (status.state === 'copying' || status.state === 'configuring') {
    return { ok: false, error: '已经在装了，等一下' }
  }

  if (!existsSync(options.bundleDir)) {
    return { ok: false, error: `包里没有 NapCat（${options.bundleDir} 不存在）` }
  }

  status = { state: 'copying', percent: 0, message: '准备中…' }

  void (async () => {
    try {
      // 1. 数一下有多少文件，好报进度
      const total = await countFiles(options.bundleDir)
      status.message = `正在复制（约 ${total} 个文件，1.2 GB，要一两分钟）…`

      await mkdir(options.targetDir, { recursive: true })

      // 2. 复制。cp 不支持逐文件回调，所以复制完直接跳到 90%
      await cp(options.bundleDir, options.targetDir, {
        recursive: true,
        force: true,
        filter: (src) => !shouldSkip(src),
      })
      status.percent = 0.9

      // 3. 找到真正的 Shell 目录，写进 rules.yaml
      status.state = 'configuring'
      status.message = '正在写配置…'

      const shellDir = await findShellDir(options.targetDir)
      if (!shellDir) {
        status.state = 'error'
        status.error = '复制完了，但没找到 <版本>.Shell 目录'
        status.message = status.error
        return
      }

      const raw = readFileSync(options.rulesFile, 'utf8')
      const r = setConfigPath(raw, 'NapCat.Shell目录', shellDir.replace(/\\/g, '/'))
      if (!r.ok) {
        status.state = 'error'
        status.error = '写 rules.yaml 失败：' + (r.error ?? '?')
        status.message = status.error
        return
      }
      writeFileSync(options.rulesFile, r.text, 'utf8')

      status = {
        state: 'done',
        percent: 1,
        message: '装好了',
        shellDir,
      }
    } catch (e) {
      status = {
        state: 'error',
        percent: 0,
        message: '安装失败',
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })()

  return { ok: true }
}
