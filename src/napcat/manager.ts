/**
 * NapCat 管理器：启动 / 停止 / 状态查询。
 *
 * 所有路径都从 locate.ts 推导（配置里的 Shell目录 → 自动探测），
 * **不再写死盘符和版本号**。
 *
 * 两种装法都支持：
 *   注入型（OneKey）—— spawn NapCatWinBootMain.exe，注入到 QQ.exe
 *   Shell 型（官方 zip）—— node napcat.mjs
 *
 * 不依赖任何 .cmd 启动脚本：别人装 NapCat 不一定有我们改过的那个。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { loadRules } from '../core/config.ts'
import { autoLocate, resolvePaths, type NapcatPaths } from './locate.ts'
import { hideQqConsole } from './win.ts'

/* ============================================================
 * 定位
 * ============================================================ */

/** 按配置定位；配置为空就自动探测。返回错误原因字符串 */
export function locate(override?: string): NapcatPaths | { error: string } {
  let configured = ''
  try {
    configured = (loadRules().rules.NapCat?.Shell目录 ?? '').trim()
  } catch {
    configured = ''
  }

  const want = (override ?? configured).trim()

  // 1. 配置里填了 → 用它
  if (want) {
    const r = resolvePaths(want)
    if ('error' in r) return { error: `配置的 Shell目录 用不了：${r.error}` }
    return r
  }

  // 2. 自动探测
  const found = autoLocate()
  if (found.length) return found[0]!

  return {
    error:
      '找不到 NapCat。请在控制台「日志 → NapCat → 安装目录」里填一个，' +
      '或者装一个 OneKey 版的 NapCat（下载地址见 docs/NapCat安装.md）。',
  }
}

/* ============================================================
 * 启动
 * ============================================================ */

/**
 * 启动 NapCat。
 *
 * 记录日志 = false（默认）：stdio 忽略，完全无窗口
 * 记录日志 = true：捕获输出写到 napcat-console.log
 *                   （注入型的输出很少，但至少能看到启动失败的原因）
 */
export function start(): { ok: boolean; detail: string } {
  const p = locate()
  if ('error' in p) return { ok: false, detail: p.error }

  let wantLog = false
  try {
    wantLog = loadRules().rules.NapCat?.记录日志 === true
  } catch {
    wantLog = false
  }

  const logFile = p.shellDir + '/napcat-console.log'
  if (wantLog) {
    try {
      mkdirSync(p.shellDir, { recursive: true })
      appendFileSync(logFile, `\n===== 启动于 ${new Date().toLocaleString('zh-CN')} =====\n`, 'utf8')
    } catch {
      /* 写不了就算了 */
    }
  }

  // ---- 注入型 ----
  if (p.mode === 'inject') {
    if (!p.qqExe || !p.launcher || !p.hook) {
      return { ok: false, detail: '注入型缺少 QQ.exe / NapCatWinBootMain.exe / 注入 DLL' }
    }

    // 先清掉上次的二维码，免得控制台显示一张过期的
    try {
      if (p.qrcode && existsSync(p.qrcode)) unlinkSync(p.qrcode)
    } catch {
      /* 删不掉不影响启动 */
    }

    try {
      const child = spawn(p.launcher, [p.qqExe, p.hook], {
        cwd: p.napcatDir,
        env: {
          ...process.env,
          NAPCAT_PATCH_PACKAGE: p.napcatDir + '/qqnt.json',
          NAPCAT_LOAD_PATH: p.napcatDir + '/loadNapCat.js',
          NAPCAT_INJECT_PATH: p.hook,
          NAPCAT_LAUNCHER_PATH: p.launcher,
          NAPCAT_MAIN_PATH: p.napcatDir + '/napcat.mjs',
        },
        detached: true,
        stdio: wantLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        // 关键：不弹任何窗口
        windowsHide: true,
      })

      if (wantLog) {
        const w = (d: Buffer): void => {
          try {
            appendFileSync(logFile, d.toString('utf8'), 'utf8')
          } catch {
            /* ignore */
          }
        }
        child.stdout?.on('data', w)
        child.stderr?.on('data', w)
        child.on('exit', (code) => {
          try {
            appendFileSync(logFile, `\n===== 退出，code = ${code} =====\n`, 'utf8')
          } catch {
            /* ignore */
          }
        })
      }

      child.unref()

      // QQ 起来之后会多出一个控制台窗口（NapCatWinBootMain 启动 QQ 时没加
      // CREATE_NO_WINDOW，QQ 就继承到一个）。Node 的 windowsHide 管不到孙进程，
      // 只能等它出现后用 Win32 藏起来。
      //
      // 为什么要试好几次：QQ 起得有快有慢，5 秒时窗口可能还没建好；
      // 后台还会补开新的（实测有 3 个 QQ 进程各带一个控制台）。
      //
      // 第一次 1.5 秒就开始找：QQ 起来后窗口几乎立刻出现，
      // 等 5 秒才藏的话用户会看到"弹一下就没了"的闪屏。
      for (const delay of [1_500, 3_000, 5_000, 8_000, 12_000, 20_000, 35_000]) {
        setTimeout(() => {
          hideQqConsole().catch(() => {})
        }, delay)
      }

      return {
        ok: true,
        detail: wantLog ? '已启动（无窗口）。日志会写到 napcat-console.log。' : '已启动（无窗口）。',
      }
    } catch (e) {
      return { ok: false, detail: String(e).slice(0, 150) }
    }
  }

  // ---- Shell 型 ----
  if (!p.shellMjs) return { ok: false, detail: 'Shell 型缺少 napcat.mjs' }

  try {
    const child = spawn('node', [p.shellMjs], {
      cwd: p.shellDir,
      detached: true,
      stdio: wantLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    })

    if (wantLog) {
      const w = (d: Buffer): void => {
        try {
          appendFileSync(logFile, d.toString('utf8'), 'utf8')
        } catch {
          /* ignore */
        }
      }
      child.stdout?.on('data', w)
      child.stderr?.on('data', w)
    }

    child.unref()
    return { ok: true, detail: '已启动（Shell 型，用 node 跑 napcat.mjs）' }
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 150) }
  }
}

/* ============================================================
 * 停止
 * ============================================================ */

/**
 * 停掉 NapCat。
 *
 * 只杀 NapCatWinBootMain（注入型）—— 不动 QQ.exe：
 * 那可能是你日常用的 QQ，杀掉太粗暴。注入的那个 QQ 会跟着一起退。
 */
export async function stop(): Promise<{ ok: boolean; detail: string }> {
  const { execFile } = await import('node:child_process')

  const kill = (): Promise<{ ok: boolean; msg: string }> =>
    new Promise((resolve) => {
      execFile('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/F'], (err, _out, stderr) => {
        if (!err) return resolve({ ok: true, msg: '' })
        const msg = String(stderr || err.message).trim()
        if (/not found|找不到/i.test(msg)) return resolve({ ok: true, msg: '' })
        resolve({ ok: false, msg })
      })
    })

  const first = await kill()
  if (first.ok) return { ok: true, detail: '已停止' }

  if (/access is denied|拒绝访问|could not be terminated/i.test(first.msg)) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "Start-Process -FilePath 'taskkill' -ArgumentList '/IM','NapCatWinBootMain.exe','/F' -Verb RunAs -WindowStyle Hidden",
          ],
          (err) => (err ? reject(err) : resolve()),
        )
      })
      await new Promise((r) => setTimeout(r, 2500))
      return { ok: true, detail: '已尝试停止（弹了 UAC 的话要点「是」）' }
    } catch (e) {
      return { ok: false, detail: '需要管理员权限才能停：' + String(e).slice(0, 100) }
    }
  }

  return { ok: false, detail: first.msg.slice(0, 150) }
}

/* ============================================================
 * 二维码文件
 * ============================================================ */

/** 二维码图片路径（不存在返回 null）*/
export function qrcodeFile(override?: string): string | null {
  const p = locate(override)
  if ('error' in p) return null
  if (p.qrcode && existsSync(p.qrcode)) return p.qrcode
  return null
}

/* ============================================================
 * 日志文件
 * ============================================================ */

/** 日志路径（不存在返回 null）*/
export function logFile(): string | null {
  const p = locate()
  if ('error' in p) return null
  const f = p.shellDir + '/napcat-console.log'
  return existsSync(f) ? f : null
}

/** 日志文件大小和最后修改时间 */
export function logStat(): { bytes: number; mtime: number } {
  const f = logFile()
  if (!f) return { bytes: 0, mtime: 0 }
  try {
    const st = statSync(f)
    return { bytes: st.size, mtime: st.mtimeMs }
  } catch {
    return { bytes: 0, mtime: 0 }
  }
}

/** 读日志（原样文本，调用方自己按行切）*/
export function readLog(): string {
  const f = logFile()
  if (!f) return ''
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
