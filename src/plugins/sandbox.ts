import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * 把插件给的相对路径解析成**它自己数据目录内**的绝对路径。
 *
 * 抽成独立模块是为了能单独测：这段逻辑是插件沙箱的唯一一道门，
 * 判错一次就等于给了插件整个数据目录的读写权（`.env` 里是 API Key）。
 *
 * 三道防线，缺一条都能绕出去：
 *   1. `resolve` 之后比对根 —— 挡住 `..` 的各种嵌套写法
 *      （`data/../../../etc/passwd` 拼出来字符串里没有 `..` 前缀，
 *      但 resolve 之后就跑到外面去了）
 *   2. 根必须是**插件自己的 dataDir**，不是 `process.cwd()` ——
 *      后者等于给插件整个项目目录（含 .env、rules.yaml、别的插件代码）
 *   3. `realpath` 之后再比对 —— 挡住 junction / 符号链接。
 *      踩过的坑：注释一直写着"符号链接也按真实路径算（realpath）"，
 *      但代码从来没调用过 realpath，随便建个 junction 就能读根外文件。
 *
 * @param root 允许的根目录（插件自己的 dataDir），必须已存在
 * @param relPath 插件传进来的相对路径
 */
export function resolvePluginPath(root: string, relPath: string): string {
  const absRoot = resolve(root)
  const abs = resolve(absRoot, String(relPath ?? ''))
  // 必须等于根，或者以「根 + 分隔符」开头（防止 /root2 被 /root 误判为子目录）
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new Error('路径越界：' + relPath)
  }

  // 目标可能还不存在（要写新文件）：找到最近的已存在祖先，对它做 realpath。
  // 这样"先建 junction、再往里写"也会被拦下。
  let probe = abs
  for (let i = 0; i < 64; i++) {
    if (existsSync(probe)) break
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  let realProbe: string
  let realRoot: string
  try {
    realProbe = realpathSync.native(probe)
    realRoot = realpathSync.native(absRoot)
  } catch {
    throw new Error('路径不可解析：' + relPath)
  }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    throw new Error('路径越界（指向了插件目录之外）：' + relPath)
  }
  return abs
}
