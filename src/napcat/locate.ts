/**
 * NapCat 定位模块。
 *
 * 之前所有路径都写死在 misc-api.ts 里（11 处 D:/NapCat/...），换个机器就全废。
 * 这里集中处理：**从 shellDir 推导所有路径**，不写死版本号、不写死盘符。
 *
 * 参考 dsh-napcat-keeper 的经验：
 *   1. OneKey 安装器会留下多个目录，只有带 QQ 本体的那个能拉起来
 *      （壳模板 NapCat\OneKey\bootmain 只有 exe，没有 QQ.exe）
 *   2. 两种装法：
 *      注入型 —— NapCatWinBootMain.exe 注入到 QQ.exe 里跑（OneKey 那种）
 *      Shell 型 —— 顶层有 napcat.mjs，用 node 跑（官方 zip）
 *      注意 versions/xxx/resources/app/napcat/napcat.mjs 那个**不能**当入口，
 *      它是等 QQ 注入用的，拿普通 node 跑必崩。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type NapcatMode = 'inject' | 'shell'

export interface NapcatPaths {
  mode: NapcatMode
  /** <NapCat>/<版本>.Shell 这一层 */
  shellDir: string

  /** 注入型：QQ.exe 和注入器。Shell 型没有 */
  qqExe?: string
  launcher?: string
  hook?: string

  /** Shell 型：顶层 napcat.mjs。注入型没有 */
  shellMjs?: string

  /** 无论哪种装法都有的：配置和缓存目录 */
  napcatDir: string

  /** 配置文件（webui.json） */
  webuiConfig?: string
  /** 二维码图片 */
  qrcode?: string
}

/**
 * 常见安装位置。官方文档推荐 C:\NapCat；OneKey 安装器默认也在那附近。
 *
 * 不做全盘扫描：分盘深扫要 90 秒/盘，代价太大，而且大多数人就装在
 * 这几个地方。找不到就让用户在控制台里手选（设置页有输入框）。
 */
export function commonDirs(): string[] {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const out: string[] = []

  // 一键安装的默认位置：<数据目录>/napcat
  //
  // 之前漏了这个 —— 一键安装时 install.ts 会往 rules.yaml 写 Shell目录，
  // 所以平时没事；一旦那行丢了（换数据目录、手滑清空），就成了
  // 「NapCat 明明在跑，控制台说找不到」，而它就在自己脚下。
  out.push(join(process.cwd(), 'napcat'))

  // 打包后 cwd 是数据目录，但万一不是（比如手动 npm start），
  // 也试一下 %APPDATA%/qqbot/data-root/napcat
  const appData = process.env['APPDATA']
  if (appData) {
    out.push(join(appData, 'qqbot', 'data-root', 'napcat'))
  }

  // 盘符 × 常见目录名
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const name of ['NapCat', 'napcat']) {
      out.push(`${drive}:/${name}`)
    }
  }

  // 用户目录下
  if (home) {
    for (const rel of ['NapCat', 'Desktop/NapCat', 'Downloads/NapCat', 'Documents/NapCat']) {
      out.push(`${home.replace(/\\/g, '/')}/${rel}`)
    }
  }

  return out
}

/**
 * 在 baseDir 下找 Shell 目录。
 *
 * baseDir 本身可能就是 Shell 目录（`D:/NapCat` 下直接有 `NapCat.52230.Shell`，
 * 也可能 baseDir 就是 `NapCat.52230.Shell`）。两种都试。
 */
export function findShellUnder(baseDir: string): string[] {
  const found: string[] = []

  const looksLikeShell = (d: string): boolean => {
    // 真 Shell 的三个标志，任意一个有就算
    return existsSync(d + '/QQ.exe') || existsSync(d + '/versions') || existsSync(d + '/napcat.mjs')
  }

  // 1. baseDir 自己就是 Shell
  if (looksLikeShell(baseDir)) found.push(baseDir)

  // 2. baseDir 下面一层有 *.Shell 目录
  try {
    for (const name of readdirSync(baseDir)) {
      const d = baseDir + '/' + name
      try {
        if (!statSync(d).isDirectory()) continue
      } catch {
        continue
      }
      // 只看名字带 shell / napcat 的，避免把 QQ 目录也扫进来
      if (!/shell|napcat/i.test(name)) continue
      if (looksLikeShell(d)) found.push(d)
    }
  } catch {
    /* baseDir 不存在或读不了 */
  }

  return found
}

/**
 * 从 shellDir 推导所有路径。
 *
 * 返回 error 表示这个目录用不了（不是真 Shell，或者缺关键文件）。
 */
export function resolvePaths(shellDir: string): NapcatPaths | { error: string } {
  const dir = shellDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!existsSync(dir)) return { error: `目录不存在：${dir}` }

  const qqExe = dir + '/QQ.exe'
  const topMjs = dir + '/napcat.mjs'

  // ---- Shell 型：顶层有 napcat.mjs，用 node 跑 ----
  if (existsSync(topMjs)) {
    return {
      mode: 'shell',
      shellDir: dir,
      shellMjs: topMjs,
      napcatDir: dir,
      webuiConfig: pickExisting([dir + '/config/webui.json']),
      qrcode: pickExisting([dir + '/cache/qrcode.png', dir + '/qrcode.png']),
    }
  }

  // ---- 注入型：要有 QQ.exe + versions/*/resources/app/napcat ----
  const versionsDir = dir + '/versions'
  if (!existsSync(versionsDir)) {
    return { error: `${dir} 里既没有顶层 napcat.mjs（Shell 型），也没有 versions/（注入型）` }
  }
  if (!existsSync(qqExe)) {
    return { error: `${dir} 里没有 QQ.exe —— 这可能是 OneKey 的壳模板目录，不是真正的安装目录` }
  }

  let ver = ''
  try {
    ver = readdirSync(versionsDir).find((v) => existsSync(`${versionsDir}/${v}/resources/app/napcat/napcat.mjs`)) ?? ''
  } catch {
    /* 读不了 */
  }
  if (!ver) return { error: `${versionsDir} 下没找到含 napcat.mjs 的版本目录` }

  const napcatDir = `${versionsDir}/${ver}/resources/app/napcat`
  const launcher = napcatDir + '/NapCatWinBootMain.exe'
  const hook = napcatDir + '/NapCatWinBootHook.dll'

  if (!existsSync(launcher)) return { error: `缺 ${launcher}` }
  if (!existsSync(hook)) return { error: `缺 ${hook}` }

  return {
    mode: 'inject',
    shellDir: dir,
    qqExe,
    launcher,
    hook,
    napcatDir,
    webuiConfig: pickExisting([napcatDir + '/config/webui.json']),
    qrcode: pickExisting([napcatDir + '/cache/qrcode.png']),
  }
}

/** 从候选里挑第一个存在的 */
function pickExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * 自动定位。
 *
 * 先看配置里填了没有（调用方负责传），没填就试常见位置。
 * 返回所有能用的候选，让调用方挑第一个或者让用户选。
 */
export function autoLocate(): NapcatPaths[] {
  const out: NapcatPaths[] = []
  const seen = new Set<string>()

  for (const base of commonDirs()) {
    if (!existsSync(base)) continue
    for (const shell of findShellUnder(base)) {
      if (seen.has(shell)) continue
      seen.add(shell)
      const r = resolvePaths(shell)
      if (!('error' in r)) out.push(r)
    }
  }

  return out
}
