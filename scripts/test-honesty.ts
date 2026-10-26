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
  // 要排除 regex.exec
  const realExec = /child_process|spawnSync|execSync|spawn\(/.test(SRC)
  check('执行代码: 没有真进程执行', !realExec, 'src 里有 child_process / spawn')
}
{
  const c = claim('打开网页/搜索')
  check('打开网页/搜索: 声明不能', c.found && !c.available)
  // 只能有 bilibili 的接口，不能有别的域名
  const domains = new Set<string>()
  for (const m of SRC.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) domains.add(m[1]!.toLowerCase())
  // qzone.qq.com 只是 Referer（防盗链用的请求头），不是"打开网页"
  // localhost / 127.0.0.1 是本地假服务（测试和探针用的）
  const ALLOW = ['bilibili', 'deepseek', 'qlogo', 'qzone.qq.com', 'localhost', '127.0.0.1', 'example']
  const external = [...domains].filter((d) => !ALLOW.some((a) => d.includes(a)))
  check('打开网页/搜索: 没有别的外部域名（只剩 bili/deepseek/referer/本地）', external.length === 0, external.join(','))
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
  const c = claim('发空间')
  check('发空间: 声明不能（因为没实现）', c.found && !c.available, `${c.available} / ${c.hint}`)
  // 逐个文件查，排除 abilities.ts 自己（它只是声明）
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && e.name !== 'abilities.ts') files.push(p)
    }
  }
  walk('src')
  const qzoneFiles = files.filter((f) => /send_story|send_qzone|发说说/.test(readFileSync(f, 'utf8')))
  check('发空间: 代码里确实没有实现（abilities 之外）', qzoneFiles.length === 0, qzoneFiles.join(','))
  check('发空间: 说明讲清"配置能开但代码没有"', c.hint.includes('代码没有') || c.hint.includes('还没接上'), c.hint)
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
  check('prompt 说了发空间还没接上', prompt.includes('发空间还没接上'))
}

/* ============ 5. 措辞不夸大 ============ */
console.log('\n=== 5. 措辞不夸大 ===')
{
  const watch = readFileSync('src/outward/watch.ts', 'utf8')
  check('watch 的 THINK_SYSTEM 说了"没看画面"', watch.includes('没看画面'))
  check('watch 不再写"看了个视频"', !watch.includes('看了个视频'))
  check('watch 写的是"翻到个视频"', watch.includes('翻到个视频'))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
