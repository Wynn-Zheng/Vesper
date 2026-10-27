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
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/**
 * 不该跟着新机器走的东西。
 *
 * 分两类：
 *   1. 运行产物：日志、备份、sqlite 临时文件
 *   2. **用户数据**：NapCat 跑过之后才会生成的那些，里面有账号/token/二维码。
 *      包里的源已经清过了（scripts/package-electron.ts 里有一份一样的规则），
 *      这里再挡一道 —— 万一源是开发机上的 E:\NapCat，也不能把用户的号带出去。
 */
function shouldSkip(p: string): boolean {
  const s = p.replace(/\\/g, '/')
  const name = s.split('/').pop() ?? ''

  // 运行产物
  if (/\.log$/i.test(name)) return true
  if (/\.bak\d*$/i.test(name)) return true
  if (/\.db-(wal|shm)$/i.test(name)) return true
  if (name === 'NapCat.Shell.zip') return true

  // 用户数据
  if (/\/config\/webui\.json$/i.test(s)) return true
  if (/\/config\/passkey\.json$/i.test(s)) return true
  if (/\/config\/napcat_\d+\.json$/i.test(s)) return true
  if (/\/config\/napcat_protocol_\d+\.json$/i.test(s)) return true
  if (/\/config\/onebot11_\d+\.json$/i.test(s)) return true
  if (/\/cache\/qrcode\.png$/i.test(s)) return true
  if (/\/guild1\.db$/i.test(s)) return true

  return false
}

/**
 * 收集要复制的文件（带大小），用来算按字节的进度。
 *
 * 为什么不用 fs.cp：它是一次性的，没有逐文件回调，只能报"开始/结束"，
 * 对 1.2GB 这种量级等于没进度。
 */
async function collectFiles(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
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
      if (e.isDirectory()) {
        await walk(full)
      } else {
        try {
          out.push({ path: full, size: (await stat(full)).size })
        } catch {
          /* 单个文件 stat 失败就跳过 */
        }
      }
    }
  }
  await walk(dir)
  return out
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
      // 1. 先扫一遍：要复制哪些文件、总共多少字节
      status.message = '正在统计文件…'
      const files = await collectFiles(options.bundleDir)
      const totalBytes = files.reduce((s, f) => s + f.size, 0)
      const totalMB = totalBytes / (1024 * 1024)
      if (files.length === 0) {
        status = { state: 'error', percent: 0, message: '包里没有文件', error: '包里没有文件' }
        return
      }

      await mkdir(options.targetDir, { recursive: true })

      // 2. 逐文件复制，按字节报进度
      let doneBytes = 0
      let doneFiles = 0
      let lastPush = 0

      for (const f of files) {
        const rel = f.path.slice(options.bundleDir.length).replace(/^[\\/]+/, '')
        const dst = join(options.targetDir, rel)
        try {
          await mkdir(dirname(dst), { recursive: true })
          await copyFile(f.path, dst)
        } catch (e) {
          // 单个文件失败（被杀毒锁住之类）不算致命，继续，最后看总数
          status.message = `跳过 ${rel}（${e instanceof Error ? e.message : String(e)}）`
        }
        doneBytes += f.size
        doneFiles++

        // 每 120ms 推一次，别把状态刷爆
        const now = Date.now()
        if (now - lastPush > 120 || doneFiles === files.length) {
          lastPush = now
          status.percent = Math.min(0.9, (doneBytes / totalBytes) * 0.9)
          status.message =
            `正在复制 ${(doneBytes / (1024 * 1024)).toFixed(0)} / ${totalMB.toFixed(0)} MB` +
            `（${doneFiles} / ${files.length} 个文件）`
        }
      }

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
