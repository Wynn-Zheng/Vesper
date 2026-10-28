/**
 * 它自己的"身体地图"。
 *
 * 为什么要有这个：每次问"你能看到自己的代码吗"，它都得现场 search_code，
 * 然后反问"想让我看哪段？"——因为不知道自己长什么样。
 * 真人知道自己有手有脚，不用每次摸一遍。
 *
 * 做法：扫描 src/ 生成一份结构化摘要（目录 + 干什么 + 关键函数），
 * 缓存到 persona/codemap.md，进 prompt 时只放精简版。
 * 只在代码改过之后重建（比 mtime），或者用户说"重新扫一遍"时强制重建。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { info, warnAt } from '../core/log.ts'
import { srcRoot } from '../core/paths.ts'
import { writeAtomic } from '../store/fs.ts'

const FILE = 'persona/codemap.md'
// 源码目录：开发时是 cwd/src，打包后是 resources/app/src（见 core/paths.ts）。
// 写死 'src' 的话打包版每次启动都报「扫不了 src/」。
const SRC = srcRoot()

/**
 * 每个目录干什么——这个手写，因为机器从代码里猜不准。
 * 新增目录时记得补一行，不然地图里会显示"（还没写说明）"。
 */
const DIRS: Record<string, string> = {
  '': '入口：启动、消息处理主线',
  channel: '和 QQ 打交道：收消息、发消息、协议解析',
  console: '网页控制台：HTTP 接口、页面数据',
  core: '地基：配置、日志、限流、文本相似度、权限',
  emoji: '表情包：收进来、挑一张发出去',
  learn: '学习：黑话、什么话接什么话',
  llm: '模型调用：DeepSeek 接口、看图',
  loop: '聊天主线：打分、会话历史、压缩、自评、提示词',
  memory: '记忆：事实、情节、召回、整理',
  napcat: 'NapCat：定位安装目录、启动/停止、读二维码和日志',
  outward: '朝外看：B 站、刷视频',
  people: '人：账号、建档、群成员、待问的事',
  plugins: '插件：清单解析、宿主运行时、安装卸载、更新检查',
  persona: '它自己：情绪、画像、快照',
  relation: '关系：评估变化、降温、渲染',
  scheduler: '定时任务：整理记忆、主动找人',
  self: '自我：反思、观察报错、诊断、意愿、能力',
  store: '存盘：原子写、JSONL、串行队列',
  tools: '工具：它能主动调用的动作',
}

export interface ModuleInfo {
  dir: string
  desc: string
  files: number
  lines: number
  /** 每个文件的关键导出，最多几个 */
  exports: Array<{ file: string; names: string[] }>
}

/** 扫 src/，得出每个目录的规模与关键函数 */
export function scanModules(): ModuleInfo[] {
  const out: ModuleInfo[] = []
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    entries = readdirSync(SRC, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch (err) {
    warnAt('扫不了 src/', { err: String(err).slice(0, 60) })
    return out
  }

  // 根目录下的文件（index.ts / boot.ts）
  const rootFiles = entries.filter((e) => !e.isDir && e.name.endsWith('.ts'))
  if (rootFiles.length) {
    out.push(collect('', rootFiles.map((e) => e.name)))
  }

  for (const e of entries) {
    if (!e.isDir) continue
    let names: string[] = []
    try {
      names = readdirSync(join(SRC, e.name))
        .filter((n) => n.endsWith('.ts'))
        .sort()
    } catch {
      continue
    }
    if (names.length) out.push(collect(e.name, names))
  }

  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

function collect(dir: string, files: string[]): ModuleInfo {
  let lines = 0
  const exports: Array<{ file: string; names: string[] }> = []

  for (const f of files) {
    const path = dir ? join(SRC, dir, f) : join(SRC, f)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    lines += text.split('\n').length

    // 只收函数/类，不收类型：类型对"它自己长什么样"没意义
    const names: string[] = []
    for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.push(m[1]!)
    for (const m of text.matchAll(/^export\s+class\s+(\w+)/gm)) names.push(m[1]!)
    if (names.length) exports.push({ file: f.replace(/\.ts$/, ''), names: names.slice(0, 6) })
  }

  return {
    dir: dir || '根',
    desc: DIRS[dir] ?? '（还没写说明）',
    files: files.length,
    lines,
    exports: exports.slice(0, 4),
  }
}

/** 渲染成 markdown（完整版，落盘用） */
export function renderCodeMap(mods: ModuleInfo[]): string {
  const totalFiles = mods.reduce((a, m) => a + m.files, 0)
  const totalLines = mods.reduce((a, m) => a + m.lines, 0)

  const lines: string[] = [
    '# 我长什么样',
    '',
    '> 自动扫描 src/ 生成，不要手改。代码改过之后说一句「你重新扫一遍」就会更新。',
    `> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    '',
    `一共 **${totalFiles}** 个文件、**${totalLines}** 行、**${mods.length}** 个模块。`,
    '',
    '## 模块',
    '',
    '| 模块 | 干什么 | 文件 | 行数 | 里面有什么 |',
    '|---|---|---|---|---|',
  ]

  for (const m of mods) {
    const ex = m.exports.length
      ? m.exports.map((e) => `${e.file}: ${e.names.slice(0, 3).join(', ')}`).join('<br>')
      : '—'
    lines.push(`| \`${m.dir === '根' ? 'src/' : `src/${m.dir}/`}\` | ${m.desc} | ${m.files} | ${m.lines} | ${ex} |`)
  }

  lines.push('')
  lines.push('## 一条消息进来之后怎么走')
  lines.push('')
  lines.push('```')
  lines.push('收到消息')
  lines.push('  → boot.ts 的 handle()')
  lines.push('     · 过滤（消息过滤）→ 限流 → 退避')
  lines.push('     · 打分（loop/score.ts）决定回不回')
  lines.push('  → loop/chat.ts 的 generateReply()')
  lines.push('     · memory/recall.ts 捞记忆')
  lines.push('     · loop/prompt.ts 组装提示词（含自我、关系、情绪序列）')
  lines.push('     · llm/deepseek.ts 调模型')
  lines.push('     · 需要时翻自己的代码（tools/code.ts）')
  lines.push('  → channel/send.ts 分句发出去')
  lines.push('```')
  lines.push('')
  lines.push('## 这套东西是怎么攒起来的')
  lines.push('')
  lines.push('- 记忆分层：事实（facts）/ 情节（episodes）/ 原始（raw）/ 共享（shared）')
  lines.push('- 关系 6 档：陌生 → 眼熟 → 朋友 → 亲近 → 亲密 → 很亲近')
  lines.push('- 情绪有衰减：心情会随时间淡下去，不会一直挂着')
  lines.push('- 表达学习：聊得好的话记下来，写之前要过一遍自审')
  lines.push('')

  return lines.join('\n')
}

/** 精简版：进 prompt 用，只留"有什么模块、各干什么" */
export function renderCodeMapBrief(mods: ModuleInfo[]): string {
  const totalFiles = mods.reduce((a, m) => a + m.files, 0)
  const totalLines = mods.reduce((a, m) => a + m.lines, 0)
  const lines: string[] = []
  lines.push(`- 一共 ${totalFiles} 个文件、${totalLines} 行，分 ${mods.length} 块：`)
  for (const m of mods) {
    lines.push(`  · ${m.dir === '根' ? 'src/' : `${m.dir}/`}（${m.files} 个文件）— ${m.desc}`)
  }
  return lines.join('\n')
}

/** 落盘 */
export function saveCodeMap(mods: ModuleInfo[]): void {
  try {
    writeAtomic(FILE, renderCodeMap(mods))
  } catch (err) {
    warnAt('保存代码地图失败', { err: String(err).slice(0, 60) })
  }
}

/** 读缓存（没有就返回 null） */
export function loadCodeMap(): string | null {
  if (!existsSync(FILE)) return null
  try {
    return readFileSync(FILE, 'utf8')
  } catch {
    return null
  }
}

/** 精简版：从缓存里抠出模块那一段（没有缓存就现场扫） */
export function loadCodeMapBrief(): string {
  const cached = loadCodeMap()
  if (cached) {
    // 缓存里有完整的表格；这里重新扫一遍比解析表格更省事，也保证是对的
  }
  return renderCodeMapBrief(scanModules())
}

/**
 * 代码改过没有：src/ 下最新的 mtime 比缓存文件新，就该重建。
 */
export function isCodeMapStale(): boolean {
  if (!existsSync(FILE)) return true
  let mapAt = 0
  try {
    mapAt = statSync(FILE).mtimeMs
  } catch {
    return true
  }

  const newest = newestSourceMtime(SRC)
  return newest > mapAt
}

function newestSourceMtime(dir: string): number {
  let newest = 0
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) {
        newest = Math.max(newest, newestSourceMtime(p))
      } else if (e.name.endsWith('.ts')) {
        newest = Math.max(newest, statSync(p).mtimeMs)
      }
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return newest
}

/**
 * 确保地图是最新的：过期就重建。
 * 定时任务每天调一次；用户说"重新扫一遍"时传 force=true。
 */
export function refreshCodeMap(force = false): { rebuilt: boolean; modules: number } {
  if (!force && !isCodeMapStale()) {
    return { rebuilt: false, modules: 0 }
  }
  const mods = scanModules()
  saveCodeMap(mods)
  info('代码地图已更新', { 模块: mods.length, 强制: force })
  return { rebuilt: true, modules: mods.length }
}
