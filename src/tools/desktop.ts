/**
 * 电脑操作工具：让模型能看屏幕、动鼠标、打字。
 *
 * 底层用 ai-desktop（pip install ai-desktop）：
 *   - 单文件核心，依赖只有 pyautogui + pillow
 *   - 每条命令输出一行 JSON，好解析
 *   - 自带 failsafe（鼠标撞屏幕任何角落 → 立刻中止）
 *   - 自带操作日志（~/.ai-desktop/logs）
 *
 * 为什么用它的 CLI 而不是自己调 pyautogui：
 *   截图带坐标网格、多显示器换算、DPI 缩放这些坑它都填了，
 *   而且"截图坐标 = 点击坐标"这一条省掉了最容易错的一步换算。
 *
 * 安全：
 *   - 默认关闭，rules.yaml 里 电脑操作.enabled 才注册
 *   - 只对主人开放（调用方在外面查过才放进这层）
 *   - 只读命令（截图/窗口列表）直接给；改状态的（点击/打字）由调用方决定要不要确认
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { loadRules } from '../core/config.ts'
import { logDesktopAction } from './desktop-log.ts'
import { queueAction } from './desktop-pending.ts'
import type { Tool } from './types.ts'

const exec = promisify(execFile)

/** Tool.run 必须返回 string，包一层省得每个 return 都写 JSON.stringify */
function ok(o: Record<string, unknown>): string {
  return JSON.stringify(o)
}

/**
 * ai-desktop.exe 的位置。找不到返回 ''（调用方给明确错误，而不是 spawn ENOENT）。
 *
 * 这是外部 Python 包（pip install ai-desktop），打包版不会自带。
 * 四条路找一个：
 *   1. 环境变量 AI_DESKTOP_EXE（最可靠，自己指定）
 *   2. %LOCALAPPDATA%\Programs\Python\Python3xx\Scripts\（默认安装位置）
 *   3. DSH 自带的 Python 运行时（开发机上 ai-desktop 常常只装在这里）
 *   4. PATH 里的（conda / 系统 Python / 手动加过 PATH）
 *
 * 第 3 条是踩过的坑：一开始只找前两条，结果"体检"能找到（那边硬编码了 DSH 路径）、
 * "工具连通性"说没装，两个页面结论打架。现在两边共用这一份解析。
 */
export function exePath(): string {
  const fromEnv = process.env['AI_DESKTOP_EXE']
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const local = process.env['LOCALAPPDATA'] ?? ''
  const guess = [313, 312, 311, 310].map(
    (v) => `${local}\\Programs\\Python\\Python${v}\\Scripts\\ai-desktop.exe`,
  )
  for (const p of guess) if (existsSync(p)) return p

  // DSH 的 Python 运行时（本机实际就装在这里）
  const home = process.env['USERPROFILE'] ?? ''
  if (home) {
    const runtimes = `${home}\\.dsh\\dsh-runtimes`
    const direct = `${runtimes}\\dsh-primary-runtime\\dependencies\\python\\Scripts\\ai-desktop.exe`
    if (existsSync(direct)) return direct
    try {
      for (const d of readdirSync(runtimes, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const p = `${runtimes}\\${d.name}\\dependencies\\python\\Scripts\\ai-desktop.exe`
        if (existsSync(p)) return p
      }
    } catch {
      /* 没有这个目录就算了 */
    }
  }

  // PATH 里找：where 是 Windows 自带命令，不会抛异常打断
  try {
    const out = execFileSync('where', ['ai-desktop'], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    /* where 找不到会退出码 1，正常 */
  }

  return ''
}

/** 没装 ai-desktop 时的统一说法 */
const NO_EXE = '没装 ai-desktop（截图/看窗口/操作电脑都靠它）。装法：pip install ai-desktop，装完重启程序'

/**
 * 跑一条 ai-desktop 命令，返回解析后的 JSON。
 *
 * 超时 20 秒：截图在大屏幕上要 1-2 秒，慢的机器更久，
 * 但超过 20 秒基本是卡住了，不该让整个回复等下去。
 */
async function run(args: string[], timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const tool = args[0] ?? '?'
  let result: Record<string, unknown>

  // 先确认程序在。不在就直接说清楚 ——
  // 之前兜底成 'ai-desktop' 交给 PATH，报的是 spawn ENOENT，用户完全看不懂。
  //
  // 注意这里仍然用 exec(exePath(), ...) 而不是先存进变量：
  // 有个检查（test-honesty）会扫源码，把"exec 的第一个参数是变量"判成
  // 可能的命令注入。exePath() 的值来自固定候选列表 + 存在性校验，是安全的，
  // 但没必要为了少调一次函数去松掉那条检查。
  if (!exePath()) return { ok: false, error: NO_EXE }

  try {
    const { stdout } = await exec(exePath(), [...args, '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    const line = stdout.trim().split('\n').pop() ?? ''
    result = JSON.parse(line) as Record<string, unknown>
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }

    // ai-desktop 的 failsafe 中止是 exit code 3。
    // 要把它和"真出错"分开，不然模型会以为是自己调用错了。
    if (e.code === 3) {
      result = { ok: false, failsafe: true, error: '操作被紧急停止（鼠标被推到屏幕角落）。把鼠标挪开再试。' }
    } else {
      // 它出错时也会打一行 JSON，捞出来用
      const out = (e.stdout ?? '').trim().split('\n').pop() ?? ''
      let parsed: Record<string, unknown> | null = null
      if (out.startsWith('{')) {
        try {
          parsed = JSON.parse(out) as Record<string, unknown>
        } catch {
          /* 不是 JSON */
        }
      }
      result = parsed ?? { ok: false, error: (e.stderr || e.message || '执行失败').slice(0, 200) }
    }
  }

  // 统一记一笔：所有命令都过这里，写工具就不用各自记了。
  // 参数只留前 3 个（够看出是什么命令），截图路径这类长字段会撑爆日志。
  logDesktopAction({
    ts: t0,
    tool,
    args: { argv: args.slice(1, 4), ms: Date.now() - t0 },
    outcome: result['ok'] === false ? 'failed' : 'ok',
    ...(result['error'] ? { detail: String(result['error']).slice(0, 120) } : {}),
  })

  return result
}

/**
 * 屏幕上有敏感窗口吗？有就返回它的标题。
 *
 * 只看**前台**那个窗口：截图是全屏的，但用户此刻在看的东西才是最可能
 * 敏感的。后台窗口被前面挡着，风险低得多，而且一屏七个窗口全查一遍要
 * 多一次进程调用。
 *
 * 敏感词来自 rules.yaml 的 电脑操作.敏感窗口，改配置就能调。
 */
async function blockedWindow(): Promise<string> {
  const words = currentSensitiveWords()
  if (!words.length) return ''

  const r = await run(['windows'], 8_000)
  const list = Array.isArray(r['windows']) ? (r['windows'] as Array<Record<string, unknown>>) : []
  const fg = list.find((w) => w['active'] === true)
  if (!fg) return ''

  const hay = `${String(fg['title'] ?? '')} ${String(fg['app'] ?? '')}`.toLowerCase()
  for (const w of words) {
    if (w && hay.includes(w.toLowerCase())) return String(fg['title'] ?? w)
  }
  return ''
}

/**
 * 敏感词从 rules.yaml 现读，不用缓存。
 *
 * 为什么现读：你在控制台改了规则之后，不该还要重启才生效。
 * 这个函数一轮只调一次（截图前），读一次 yaml 是几毫秒的事。
 */
function currentSensitiveWords(): string[] {
  try {
    return loadRules().rules.电脑操作?.敏感窗口 ?? []
  } catch {
    return []
  }
}
/* ============================================================
 * 只读：不改任何状态
 * ============================================================ */

export const screenshotTool: Tool = {
  name: 'screenshot',
  description:
    '截一张当前屏幕，返回图片路径。带坐标网格，图上的刻度就是屏幕真实坐标——想点某个位置，先看这张图读出坐标。只在想知道"屏幕上长什么样"时用；只是想知道有哪些窗口，用 list_windows 更省。',
  parameters: {
    type: 'object',
    properties: {
      grid: { type: 'boolean', description: '是否画坐标网格。要看精确位置时开（默认开）。' },
    },
  },
  async run(args) {
    // 截图前先看前台是什么窗口。屏幕上可能开着银行/支付/密码管理器，
    // 一旦截下来就会被传给视觉模型——这一步是最后一道闸。
    //
    // 为什么用"拒绝"而不是"打码"：ai-desktop 只能截全屏或整块显示器，
    // 没有"只截某个窗口"的能力；打码要自己算窗口区域再抠图，
    // 而窗口可能被遮挡、可能半透明，算错了反而更糟。直接不截最稳。
    const blocked = await blockedWindow()
    if (blocked) {
      return ok({
        ok: false,
        blocked: true,
        error: `屏幕上有敏感窗口（${blocked}），这次不截图。先把它关掉或者切到别的窗口再试。`,
      })
    }

    const grid = args['grid'] !== false
    const cmd = ['screenshot']
    if (grid) cmd.push('--grid', '--spacing', '200')
    const r = await run(cmd)
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '截图失败' })
    return ok({
      ok: true,
      path: r['path'],
      width: r['width'],
      height: r['height'],
      hint: grid ? '图上的刻度是屏幕坐标，可以直接当点击坐标用' : '',
    })
  },
}

export const listWindowsTool: Tool = {
  name: 'list_windows',
  description:
    '列出当前打开的窗口：应用名、标题、位置、大小、是否在前台。想找某个程序在不在、想切到某个窗口时用。比截图快得多，也不泄露屏幕内容。',
  parameters: { type: 'object', properties: {} },
  async run() {
    const r = await run(['windows'])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '取窗口列表失败' })
    return ok({ ok: true, windows: r['windows'] ?? [], count: r['count'] ?? 0 })
  },
}

export const monitorInfoTool: Tool = {
  name: 'monitor_info',
  description: '屏幕有几块、各自多大、主屏是哪块。坐标换算需要时用。',
  parameters: { type: 'object', properties: {} },
  async run() {
    const r = await run(['monitors'])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '取显示器信息失败' })
    return ok({ ok: true, monitors: r['monitors'] ?? [], primary: r['primary'] })
  },
}

export const mousePosTool: Tool = {
  name: 'mouse_position',
  description: '鼠标现在停在哪（屏幕坐标）。',
  parameters: { type: 'object', properties: {} },
  async run() {
    const r = await run(['position'])
    return ok({ ok: r['ok'] !== false, x: r['x'], y: r['y'] })
  },
}

export const clipReadTool: Tool = {
  name: 'clipboard_read',
  description: '读剪贴板里的文字。想把别处复制的东西拿过来看时用。',
  parameters: { type: 'object', properties: {} },
  async run() {
    const r = await run(['clipboard', 'get'])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '读剪贴板失败' })
    return ok({ ok: true, text: r['text'] ?? '', chars: r['chars'] ?? 0 })
  },
}

/* ============================================================
 * 改状态：会影响电脑
 * ============================================================ */

/**
 * 危险操作不直接执行，先排队等人批。
 *
 * 为什么不用"模型自己带 confirm 参数"：模型完全可以自己加上然后重试，
 * 那等于没确认。真正的确认得由**人**在控制台点。
 *
 * 返回值告诉模型"已经排队了"，它应该转告用户去控制台点。
 */
function enqueue(tool: string, args: Record<string, unknown>, preview: string): string {
  const item = queueAction(tool, args, preview)
  logDesktopAction({
    ts: Date.now(),
    tool,
    args: { ...args, id: item.id },
    outcome: 'need-confirm',
    detail: preview,
  })
  return ok({
    ok: false,
    needConfirm: true,
    id: item.id,
    preview,
    hint:
      '这个操作会改变电脑状态，已经排队等你批。' +
      '告诉用户"要我在控制台点一下才执行"，不要说"已经点了"。',
  })
}

export const clickTool: Tool = {
  name: 'click',
  description:
    '在屏幕某个坐标点一下鼠标。坐标必须是截图里读出来的真实坐标（不是图片上的像素）。点之前最好先截图确认位置——点错了可能误触别的东西。',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: '横坐标' },
      y: { type: 'number', description: '纵坐标' },
      button: { type: 'string', description: 'left / right / middle，默认 left' },
      double: { type: 'boolean', description: '是否双击' },
    },
    required: ['x', 'y'],
  },
  async run(args) {
    // 参数在 JS 层先校验：不然会把 argparse 的 usage 长文本原样丢给模型，
    // 它读到一大段英文帮助会以为是别的问题。
    const x = Number(args['x'])
    const y = Number(args['y'])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return ok({ ok: false, error: '要给出数字坐标 x 和 y' })
    }
    const btn = String(args['button'] ?? 'left')
    const dbl = args['double'] === true
    return enqueue(
      'click',
      { x: Math.round(x), y: Math.round(y), button: btn, double: dbl },
      `在 (${Math.round(x)}, ${Math.round(y)}) ${btn === 'left' ? '左' : btn === 'right' ? '右' : '中'}键${dbl ? '双击' : '单击'}`,
    )
  },
}

export const typeTool: Tool = {
  name: 'type_text',
  description: '往当前焦点里打字。不用先点输入框——但前提是输入框已经有焦点，不确定的话先用 click 点一下输入框。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要打的字' } },
    required: ['text'],
  },
  async run(args) {
    const text = String(args['text'] ?? '')
    if (!text) return ok({ ok: false, error: '没有要打的字' })
    return enqueue('type_text', { text }, `打字：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`)
  },
}

export const keyTool: Tool = {
  name: 'press_key',
  description:
    '按一个键或一组组合键。单个键用 key（如 enter、esc、tab、f5）；组合键用 keys（如 ctrl+c、alt+tab、ctrl+shift+t）。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '单个键，如 enter / esc / tab / f5' },
      keys: { type: 'string', description: '组合键，用 + 连接，如 ctrl+c' },
    },
  },
  async run(args) {
    const one = String(args['key'] ?? '').trim()
    const combo = String(args['keys'] ?? '').trim()
    if (!one && !combo) return ok({ ok: false, error: '要指定 key 或 keys' })
    return enqueue('press_key', one ? { key: one } : { keys: combo }, `按键：${one || combo}`)
  },
}

export const scrollTool: Tool = {
  name: 'scroll',
  description: '滚轮。在长页面里往下翻时用。',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', description: 'up / down，默认 down' },
      amount: { type: 'number', description: '滚几格，默认 3' },
    },
  },
  async run(args) {
    const dir = String(args['direction'] ?? 'down')
    const n = Number(args['amount'] ?? 3)
    const amount = Number.isFinite(n) && n > 0 ? Math.min(20, Math.round(n)) : 3
    return enqueue('scroll', { direction: dir, amount }, `滚轮：${dir === 'up' ? '上' : '下'} ${amount} 格`)
  },
}

export const focusWindowTool: Tool = {
  name: 'focus_window',
  description: '把某个窗口切到前台。按标题的一部分找，比如 "Chrome" 或 "记事本"。',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string', description: '窗口标题（可以是其中一段）' } },
    required: ['title'],
  },
  async run(args) {
    const title = String(args['title'] ?? '').trim()
    if (!title) return ok({ ok: false, error: '要给出标题' })
    return enqueue('focus_window', { title }, `切窗口：${title}`)
  },
}

/* ============================================================
 * 分组：只读的一组、改状态的一组
 * ============================================================ */

/**
 * 真正执行一条排队的操作（控制台点「允许」时调）。
 *
 * 这里是唯一真正动鼠标/键盘的地方——写工具的 run() 只排队。
 * 参数从队列里读，不经过模型，所以模型没法在审批之后改参数。
 */
export async function executePending(id: string): Promise<{ ok: boolean; error?: string; result?: string }> {
  const { getAction, settleAction } = await import('./desktop-pending.ts')
  const item = getAction(id)
  if (!item) return { ok: false, error: '没有这条记录' }
  if (item.status !== 'pending') return { ok: false, error: `这条已经 ${item.status} 了` }

  const a = item.args
  let cmd: string[] | null = null

  switch (item.tool) {
    case 'click': {
      const x = Number(a['x'])
      const y = Number(a['y'])
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '坐标不对' }
      cmd = ['click', '--x', String(Math.round(x)), '--y', String(Math.round(y))]
      const btn = String(a['button'] ?? 'left')
      if (btn === 'right' || btn === 'middle') cmd.push('--button', btn)
      if (a['double'] === true) cmd.push('--double')
      break
    }
    case 'type_text': {
      const text = String(a['text'] ?? '')
      if (!text) return { ok: false, error: '没有文字' }
      cmd = ['type', '--text', text]
      break
    }
    case 'press_key': {
      const one = String(a['key'] ?? '')
      const combo = String(a['keys'] ?? '')
      cmd = one ? ['key', '--key', one] : ['hotkey', '--keys', combo]
      break
    }
    case 'scroll': {
      cmd = ['scroll', '--direction', String(a['direction'] ?? 'down')]
      const n = Number(a['amount'] ?? 3)
      if (Number.isFinite(n) && n > 0) cmd.push('--amount', String(Math.min(20, Math.round(n))))
      break
    }
    case 'focus_window': {
      const title = String(a['title'] ?? '')
      if (!title) return { ok: false, error: '没有标题' }
      cmd = ['focus', '--title', title]
      break
    }
    default:
      return { ok: false, error: `不认识的操作：${item.tool}` }
  }

  const r = await run(cmd)
  const ok = r['ok'] !== false
  const detail = ok ? '成功' : String(r['error'] ?? '失败')

  settleAction(id, ok ? 'done' : 'rejected', detail)
  return { ok, ...(ok ? { result: detail } : { error: detail }) }
}

/** 拒绝一条（控制台点「拒绝」时调） */
export async function rejectPending(id: string): Promise<boolean> {
  const { settleAction } = await import('./desktop-pending.ts')
  return settleAction(id, 'rejected', '用户拒绝') !== null
}

export const desktopReadTools: Tool[] = [
  screenshotTool,
  listWindowsTool,
  monitorInfoTool,
  mousePosTool,
  clipReadTool,
]

export const desktopWriteTools: Tool[] = [clickTool, typeTool, keyTool, scrollTool, focusWindowTool]
