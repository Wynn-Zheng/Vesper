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
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Tool } from './types.ts'

const exec = promisify(execFile)

/** Tool.run 必须返回 string，包一层省得每个 return 都写 JSON.stringify */
function ok(o: Record<string, unknown>): string {
  return JSON.stringify(o)
}

/** ai-desktop.exe 的位置。允许用环境变量覆盖（换机器时不用改代码）。 */
function exePath(): string {
  const fromEnv = process.env['AI_DESKTOP_EXE']
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const guess = [
    'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\Scripts\\ai-desktop.exe',
    `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Python\\Python312\\Scripts\\ai-desktop.exe`,
  ]
  for (const p of guess) if (existsSync(p)) return p
  return 'ai-desktop'
}

/**
 * 跑一条 ai-desktop 命令，返回解析后的 JSON。
 *
 * 超时 20 秒：截图在大屏幕上要 1-2 秒，慢的机器更久，
 * 但超过 20 秒基本是卡住了，不该让整个回复等下去。
 */
async function run(args: string[], timeoutMs = 20_000): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await exec(exePath(), [...args, '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    const line = stdout.trim().split('\n').pop() ?? ''
    return JSON.parse(line) as Record<string, unknown>
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }

    // ai-desktop 的 failsafe 中止是 exit code 3。
    // 要把它和"真出错"分开，不然模型会以为是自己调用错了。
    if (e.code === 3) {
      return { ok: false, failsafe: true, error: '操作被紧急停止（鼠标被推到屏幕角落）。把鼠标挪开再试。' }
    }

    // 它出错时也会打一行 JSON，捞出来用
    const out = (e.stdout ?? '').trim().split('\n').pop() ?? ''
    if (out.startsWith('{')) {
      try {
        return JSON.parse(out) as Record<string, unknown>
      } catch {
        /* 落到下面 */
      }
    }
    return { ok: false, error: (e.stderr || e.message || '执行失败').slice(0, 200) }
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
    const cmd = ['click', '--x', String(Math.round(x)), '--y', String(Math.round(y))]
    const btn = String(args['button'] ?? 'left')
    if (btn === 'right' || btn === 'middle') cmd.push('--button', btn)
    if (args['double'] === true) cmd.push('--double')
    const r = await run(cmd)
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '点击失败' })
    return ok({ ok: true, x: r['x'], y: r['y'] })
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
    const r = await run(['type', '--text', text])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '打字失败' })
    return ok({ ok: true, chars: text.length })
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
    const r = one ? await run(['key', '--key', one]) : await run(['hotkey', '--keys', combo])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '按键失败' })
    return ok({ ok: true })
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
    const cmd = ['scroll', '--direction', String(args['direction'] ?? 'down')]
    const n = Number(args['amount'] ?? 3)
    if (Number.isFinite(n) && n > 0) cmd.push('--amount', String(Math.min(20, Math.round(n))))
    const r = await run(cmd)
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '滚动失败' })
    return ok({ ok: true })
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
    const r = await run(['focus', '--title', title])
    if (r['ok'] === false) return ok({ ok: false, error: r['error'] ?? '切窗口失败' })
    return ok({ ok: true })
  },
}

/* ============================================================
 * 分组：只读的一组、改状态的一组
 * ============================================================ */

export const desktopReadTools: Tool[] = [
  screenshotTool,
  listWindowsTool,
  monitorInfoTool,
  mousePosTool,
  clipReadTool,
]

export const desktopWriteTools: Tool[] = [clickTool, typeTool, keyTool, scrollTool, focusWindowTool]
