/**
 * 自动装 ai-desktop（截图/看窗口/操作电脑的后端）。
 *
 * ai-desktop 是个 Python 包（PyPI 上有，0.4.0），所以只要机器上有 Python
 * 就能装。没 Python 的话只能提示去装 —— 我们不能替用户装 Python，
 * 那是几百 MB 的东西。
 *
 * 做成异步 + 轮询：pip install 要几十秒，同步请求会超时。
 * 做单独模块，是为了不把 server.ts 再撑大（那个文件已经改坏过两次）。
 */
import { spawn } from 'node:child_process'

export type InstallState = 'idle' | 'running' | 'done' | 'error'

export type InstallStatus = {
  state: InstallState
  message: string
  /** pip 的原始输出（成功后也有用，能看到装到哪个版本） */
  log: string
  error?: string
}

let status: InstallStatus = { state: 'idle', message: '', log: '' }

export function installStatus(): InstallStatus {
  return { ...status }
}

/**
 * 找 Python 解释器。
 *
 * 先试 PATH 里的（py 启动器 / python / python3），再试 python.org 的
 * 默认安装位置 —— 很多人装 Python 时没勾「Add to PATH」，那样 PATH 里找不到，
 * 但程序确实装了。
 *
 * 注意用 spawn 而不是 exec/execFile：spawn 收的是「程序 + 参数数组」，
 * 不经过 shell，参数里有特殊字符也不会被解释，没法注入。
 */
function findPython(): Promise<string | null> {
  const local = process.env['LOCALAPPDATA'] ?? ''
  const candidates: Array<[string, string[]]> = [
    ['py', ['-3', '--version']],
    ['python', ['--version']],
    ['python3', ['--version']],
  ]

  // 默认安装位置（没加 PATH 时靠这个）
  for (const v of ['313', '312', '311', '310']) {
    candidates.push([`${local}\\Programs\\Python\\Python${v}\\python.exe`, ['--version']])
    candidates.push([`C:\\Python${v}\\python.exe`, ['--version']])
    candidates.push([`C:\\Program Files\\Python${v}\\python.exe`, ['--version']])
  }

  return new Promise((resolve) => {
    let i = 0
    const next = (): void => {
      if (i >= candidates.length) {
        resolve(null)
        return
      }
      const [prog, argv] = candidates[i]!
      i++

      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        if (ok) resolve(prog)
        else next()
      }

      try {
        const child = spawn(prog, argv, { windowsHide: true })
        let out = ''
        const timer = setTimeout(() => {
          child.kill()
          finish(false)
        }, 8000)

        child.stdout?.on('data', (d) => (out += String(d)))
        child.stderr?.on('data', (d) => (out += String(d)))
        child.on('error', () => {
          clearTimeout(timer)
          finish(false)
        })
        child.on('close', () => {
          clearTimeout(timer)
          // 有些 Python 把版本打到 stderr
          finish(/Python 3\.(1[0-9]|[0-9])/.test(out))
        })
      } catch {
        finish(false)
      }
    }
    next()
  })
}

/** 跑 pip install，收全部输出（同样用 spawn，不走 shell） */
function pipInstall(python: string): Promise<{ ok: boolean; log: string }> {
  const args = python === 'py' ? ['-3', '-m', 'pip', 'install', '--upgrade', 'ai-desktop'] : ['-m', 'pip', 'install', '--upgrade', 'ai-desktop']

  return new Promise((resolve) => {
    let log = ''
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      resolve({ ok, log: log.trim() })
    }

    try {
      const child = spawn(python, args, { windowsHide: true })
      // pip 装包可能很慢，给 5 分钟
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, 300_000)

      child.stdout?.on('data', (d) => (log += String(d)))
      child.stderr?.on('data', (d) => (log += String(d)))
      child.on('error', (e) => {
        clearTimeout(timer)
        log += `\n${String(e)}`
        finish(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
    } catch (e) {
      log += String(e)
      finish(false)
    }
  })
}

/** 开始装（异步，立即返回） */
export async function startInstallAiDesktop(): Promise<{ ok: boolean; error?: string }> {
  if (status.state === 'running') return { ok: false, error: '已经在装了，等一下' }

  status = { state: 'running', message: '正在找 Python…', log: '' }

  void (async () => {
    try {
      const python = await findPython()
      if (!python) {
        status = {
          state: 'error',
          message: '没找到 Python',
          log: '',
          error:
            '这台机器上没有 Python。ai-desktop 是 Python 包，得先装 Python 3.10+（python.org 下载，安装时勾 add to PATH），装完再回来点一次。',
        }
        return
      }

      status.message = `正在装 ai-desktop（用 ${python}，可能要一两分钟）…`
      const r = await pipInstall(python)

      if (r.ok) {
        status = {
          state: 'done',
          message: '装好了，重启程序就能用截图和看窗口',
          log: r.log.slice(-3000),
        }
      } else {
        status = {
          state: 'error',
          message: 'pip install 失败',
          log: r.log.slice(-3000),
          error: '装失败。常见原因：连不上 PyPI（换成国内镜像源重试，比如清华或阿里的 pip 源），或者 Python 没装 pip。',
        }
      }
    } catch (e) {
      status = {
        state: 'error',
        message: '装失败',
        log: '',
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })()

  return { ok: true }
}
