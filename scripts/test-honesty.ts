/**
 * 能力诚实性检查：abilities.ts 说的 和 代码里真做的，必须一致。
 *
 * 起因：它说"看了个视频"，被问链接却说"我上不了网"。
 * 查下来是 abilities 里写好几句和实现不符：
 *   - "上网查东西: false" 但 bili.ts 真在 fetch
 *   - "看图片/文件: false" 但 vision.ts 真能看图
 *   - "发空间" 按开关算，但根本没有实现代码
 *
 * 这个测试的做法：**每条能力去代码里找证据**，对不上就报错。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

/** 把 src 下所有 .ts 拼成一个大字符串，方便搜实现证据 */
function allSource(): string {
  let out = ''
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out += readFileSync(p, 'utf8') + '\n'
    }
  }
  walk('src')
  return out
}

const SRC = allSource()
const abilities = await import('../src/self/abilities.ts')
const { DEFAULTS } = await import('../src/core/config.ts')

const byName = new Map(abilities.listAbilities(DEFAULTS).map((a) => [a.name, a]))

/** 声明了某能力，返回它的 available */
function claim(name: string): { found: boolean; available: boolean; hint: string } {
  const a = byName.get(name)
  return { found: !!a, available: a?.available ?? false, hint: a?.hint ?? '' }
}

/* ============ 1. 说"能做"的，代码里必须真有实现 ============ */
console.log('=== 1. 说能做 → 代码里要有 ===')

{
  const c = claim('聊天')
  check('聊天: 声明能做', c.found && c.available)
  check('聊天: 有 generateReply', SRC.includes('export async function generateReply'))
}
{
  const c = claim('记事')
  check('记事: 声明能做', c.found && c.available)
  check('记事: 有 appendFacts', SRC.includes('export function appendFacts'))
  check('记事: 有 saveEpisode', SRC.includes('export function saveEpisode'))
}
{
  const c = claim('想事情')
  check('想事情: 声明能做', c.found && c.available)
  check('想事情: 有 reflectSelf', SRC.includes('export async function reflectSelf'))
}
{
  const c = claim('查 B站')
  check('查B站: 声明能做', c.found && c.available)
  check('查B站: 代码里真 fetch bilibili', SRC.includes('api.bilibili.com') && SRC.includes('fetch('))
  check('查B站: 说明提到"这是真联网"', c.hint.includes('真联网'), c.hint)
}

/* ============ 2. 说"不能做"的，代码里确实没有 ============ */
console.log('\n=== 2. 说不能 → 代码里确实没有 ===')

{
  const c = claim('执行代码')
  check('执行代码: 声明不能', c.found && !c.available)
  // 要排除两种情况：
  //   1. regex.exec 这类正则方法（不是真执行）
  //   2. tools/desktop.ts —— 它用 execFile 跑的是**固定的 ai-desktop.exe**，
  //      参数是我们自己拼的（截图/点击），不是"执行任意代码"。
  //      "执行任意代码"得是 shell / 用户给什么就跑什么。
  // 过滤掉这些"合法的进程控制"：
  //   - ai-desktop：电脑操作工具（已知，单独测）
  //   - NapCat 的启动/停止：taskkill NapCatWinBootMain / Start-Process 提权
  //   - node:child_process 的 import 行本身
  // 它们都不是"让模型执行任意代码"，只是固定的进程管理。
  // 这个检查的目的是：确认**模型自己不能执行任意命令**。
  //
  // 真正危险的是这些东西：
  //   eval / new Function —— 能跑任意字符串
  //   spawnSync / execSync —— 同步跑任意程序
  //   exec( / execFile( 的**第一个参数是变量**（那才是"用户/模型决定跑什么"）
  //
  // 而下面这些是**固定的进程管理**，不算：
  //   - ai-desktop：电脑操作工具（单独测）
  //   - spawn(launcher, [args])：启动 NapCat，路径写死
  //   - execFile('taskkill', [...])：停 NapCat，命令写死
  //   - execFile('powershell', [...])：提权停 NapCat，命令写死
  //
  // 所以判断改成：看有没有 eval / new Function / spawnSync / execSync，
  // 以及 exec/execFile 后面紧跟的是不是**字符串字面量还是变量**。
  const dangerous: string[] = []
  const lines = SRC.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.includes('ai-desktop')) continue
    if (/\beval\s*\(/.test(l)) dangerous.push(`eval: ${l.trim()}`)
    if (/new\s+Function\s*\(/.test(l)) dangerous.push(`new Function: ${l.trim()}`)
    if (/\bspawnSync\s*\(/.test(l)) dangerous.push(`spawnSync: ${l.trim()}`)
    if (/\bexecSync\s*\(/.test(l)) dangerous.push(`execSync: ${l.trim()}`)
    // exec(变量) / execFile(变量) —— 第一个参数不是引号开头就危险
    // 注意：
    //   - 要排除 `xxx.exec(...)`（正则的 exec，不是 child_process 的）
    //   - 要排除 `exec(exePath(), ...)`（ai-desktop 的路径是写死的，不是模型决定）
    const m = /(?<![.\w])(?:exec|execFile)\s*\(\s*([^\s)])/.exec(l)
    if (m && m[1] !== "'" && m[1] !== '"' && m[1] !== '`' && !l.includes('exePath()')) {
      dangerous.push(`exec(非字面量): ${l.trim()}`)
    }
  }

  check(
    '执行代码: 没有真进程执行',
    dangerous.length === 0,
    dangerous.length ? '危险调用：' + dangerous.slice(0, 3).join(' | ') : '',
  )
}
{
  const c = claim('打开网页/搜索')
  check('打开网页/搜索: 声明不能', c.found && !c.available)
  // 只能有 bilibili 的接口，不能有别的域名
  const domains = new Set<string>()
  for (const m of SRC.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) domains.add(m[1]!.toLowerCase())
  // qzone.qq.com 只是 Referer（防盗链用的请求头），不是"打开网页"
  // localhost / 127.0.0.1 是本地假服务（测试和探针用的）
  // github.com / api.github.com 是**更新检查**（update.ts 查 Release），
// 不是"它能上网"的能力 —— 那是用户在设置页点「检查更新」才发的请求。
const ALLOW = [
  'bilibili',
  'deepseek',
  'qlogo',
  'qzone.qq.com',
  'localhost',
  '127.0.0.1',
  'example',
  'github.com',
  'api.github.com',
]
  const external = [...domains].filter((d) => !ALLOW.some((a) => d.includes(a)))
  check('打开网页/搜索: 没有别的外部域名（只剩 bili/deepseek/referer/github/本地）', external.length === 0, external.join(','))
}
{
  const c = claim('看视频画面')
  check('看视频画面: 声明不能', c.found && !c.available)
  check('看视频画面: 说明提到只看标题简介', c.hint.includes('标题'), c.hint)
  // 代码里不该有视频流下载
  check('看视频画面: 没有下载视频流', !/\.mp4|\.m4s|videoStream|playurl/i.test(SRC))
}

/* ============ 3. 边界能力：按开关算，但开关为 false 时不能吹 ============ */
console.log('\n=== 3. 开关类能力 ===')

{
  // 用 DEFAULTS 测：那里开关是关的，所以应该显示"还没接上"
  const off = claim('刷视频')
  check('刷视频: 存在', off.found)
  check('刷视频: DEFAULTS 关闭时应为 false', off.available === false, `${off.available}`)

  // 打开开关再看：措辞必须是"标题和简介"，不是"看视频"
  const onRules = {
    ...DEFAULTS,
    外部: { ...DEFAULTS.外部, 刷视频: { ...DEFAULTS.外部.刷视频, 开启: true, 每天最多: 2 } },
  }
  const onList = abilities.listAbilities(onRules as typeof DEFAULTS)
  const on = onList.find((a) => a.name === '刷视频')!
  check('刷视频: 打开后为 true', on.available === true)
  check('刷视频: 措辞是"标题和简介"不是"看视频"', on.hint.includes('标题'), on.hint)
  check('刷视频: 说明提到上限和手动不占额度', on.hint.includes('上限') || on.hint.includes('不占'), on.hint)
}
{
  // 发空间：草稿模式。代码是真有了（qzone.ts），但**发出去要人点**。
  // 所以它说的是"能写草稿"，不是"能发"。
  const off = claim('发空间')
  check('发空间: 存在', off.found)
  check('发空间: DEFAULTS 关闭时应为 false', off.available === false, String(off.available))
  check('发空间: 说明提到"草稿"或"人看过"', /草稿|人看过|人说了算/.test(off.hint), off.hint)

  // 打开开关再看
  const onRules = {
    ...DEFAULTS,
    外部: { ...DEFAULTS.外部, 发空间: { ...DEFAULTS.外部.发空间, 开启: true } },
  }
  const onList = abilities.listAbilities(onRules as typeof DEFAULTS)
  const on = onList.find((a) => a.name === '发空间')!
  check('发空间: 打开后为 true（能攒草稿）', on.available === true)
  check('发空间: 说明讲清"要人点才发"', on.hint.includes('人') && /发出去|点/.test(on.hint), on.hint)

  // 代码里确实有实现
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk('src')
  const hasImpl = files.some((f) => f.includes('qzone.ts'))
  check('发空间: 有 qzone.ts 实现', hasImpl)
  check('发空间: onebot 里调了 send_qzone_msg', SRC.includes('send_qzone_msg'))
  check('发空间: 有删除接口（发错能收回）', SRC.includes('delete_qzone_msg'))

  // 关键：它自己调不到"发"这个动作
  // 工具注册表里不该有 publish 类工具
  const toolNames = abilities.listAbilities(DEFAULTS).filter((a) => a.name.startsWith('publish') || a.name.includes('发出去'))
  check('发空间: 没有给模型注册"发出去"的工具', toolNames.length === 0, toolNames.map((x) => x.name).join(','))
}

{
  const c = claim('看图片')
  check('看图片: 存在（不再是笼统的"看图片/文件"）', c.found)
  check('看图片: 有 vision.ts', existsSync('src/llm/vision.ts'))
  check('看图片: 按 视觉.开启 算', c.available === Boolean(DEFAULTS.视觉?.开启), `${c.available}`)
  check('看图片: 关着时说明讲清楚', !c.available ? c.hint.includes('关着') || c.hint.includes('开了') : true, c.hint)
}
{
  const c = claim('打开文件')
  check('打开文件: 声明不能（只能读 src/ 下的 .ts）', c.found && !c.available)
  check('打开文件: 说明提到只能读 src', c.hint.includes('src/'), c.hint)
  // diagnose 的 safePath 确实限制了 src/
  check('打开文件: safePath 只允许 src/', SRC.includes("if (!file.startsWith('src/')) return null"))
}

/* ============ 4. 不该再出现的旧说法 ============ */
console.log('\n=== 4. 旧的错误说法 ===')
{
  check('没有「上网查东西: false」这条', !byName.has('上网查东西'))
  check('没有「看图片/文件: false」这条', !byName.has('看图片/文件'))

  const prompt = readFileSync('src/loop/prompt.ts', 'utf8')
  check('prompt 不再说「不能上网查东西」', !prompt.includes('上网查东西'))
  check('prompt 说了「别说我上不了网」', prompt.includes('别说"我上不了网"'))
  check('prompt 说了「看不到视频画面」', prompt.includes('看不到视频画面'))
  check('prompt 说了发空间是草稿模式', prompt.includes('草稿模式'))
}

/* ============ 5. 措辞不夸大 ============ */
console.log('\n=== 5. 措辞不夸大 ===')
{
  const watch = readFileSync('src/outward/watch.ts', 'utf8')
  check('watch 的 THINK_SYSTEM 说了"没看画面"', watch.includes('没看画面'))
  check('watch 不再写"看了个视频"', !watch.includes('看了个视频'))
  // 2026-11-01：watch 不再把视频观感写进 life.md（那条文案随之删掉），
  // 但「翻到」这个措辞要保留 —— 是"翻到"，不是"看了"（它只拿到标题和简介）。
  check('watch 用"翻到"而不是"看了"', watch.includes('翻到') && !watch.includes('看了个视频'))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
