/**
 * 能力诚实性检查：它说的话和它真能做到的事要一致。
 *
 * 起因：它说"看了个讲医学界包装翻车的视频"，被问链接却说"我上不了网"，
 * 最后说"我调的是本地记录"。三句话互相矛盾。
 *
 * 事实：
 *   - bili.ts 真的 fetch api.bilibili.com —— 能联网
 *   - 但只看标题/简介，不看画面
 *   - 之前 abilities 写着"上网查东西：false"，prompt 写着"不能上网查东西"，
 *     于是它自己都说不清
 */
import { existsSync, readFileSync } from 'node:fs'

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

/* ---------- 1. bili 确实联网 ---------- */
console.log('=== 1. 事实核对：它到底能不能联网 ===')
{
  const bili = readFileSync('src/outward/bili.ts', 'utf8')
  check('bili.ts 里有 fetch 调用', bili.includes('fetch('))
  check('调的是 bilibili.com 的接口', bili.includes('api.bilibili.com'))
  check('用 https（真网络请求）', bili.includes('https://api.bilibili.com'))
}

/* ---------- 2. abilities 描述准确 ---------- */
console.log('\n=== 2. abilities 说得准不准 ===')
{
  const abilities = await import('../src/self/abilities.ts')
  const { DEFAULTS } = await import('../src/core/config.ts')
  const list = abilities.listAbilities(DEFAULTS)

  const byName = new Map(list.map((a) => [a.name, a]))

  check('有「查 B站」并且标为能做', byName.get('查 B站')?.available === true, JSON.stringify(byName.get('查 B站')))
  check('「查 B站」的说明提到接口', byName.get('查 B站')?.hint?.includes('接口') === true, byName.get('查 B站')?.hint)
  check('不再有笼统的「上网查东西: false」', !byName.has('上网查东西'), [...byName.keys()].join(','))
  check('有「打开网页/搜索」并标为不能', byName.get('打开网页/搜索')?.available === false)
  check('有「看视频画面」并标为不能', byName.get('看视频画面')?.available === false, JSON.stringify(byName.get('看视频画面')))
  check('「看视频画面」说明里点明只看标题简介', byName.get('看视频画面')?.hint?.includes('标题') === true, byName.get('看视频画面')?.hint)
}

/* ---------- 3. prompt 说得准 ---------- */
console.log('\n=== 3. prompt 的能力边界 ===')
{
  const { buildSystem } = await import('../src/loop/prompt.ts')
  const { DEFAULTS } = await import('../src/core/config.ts')
  const sys = buildSystem({ rules: DEFAULTS, now: new Date() })

  check('prompt 不再说「不能上网查东西」', !sys.includes('不能执行代码、运行程序、上网查东西'))
  check('prompt 说「能调 B站接口」', sys.includes('能') && sys.includes('B站') && sys.includes('接口'), '')
  check('prompt 明确「看不到视频画面」', sys.includes('看不到视频画面'), '')
  check('prompt 明确「别说我上不了网」', sys.includes('别说"我上不了网"'), '')
}

/* ---------- 4. watch 的措辞 ---------- */
console.log('\n=== 4. 生活记录不夸大成"看了视频" ===')
{
  const watch = readFileSync('src/outward/watch.ts', 'utf8')
  check('THINK_SYSTEM 说了"没看画面"', watch.includes('没看画面'), '')
  check('生活记录写"翻到个视频"', watch.includes('翻到个视频'), '')
  check('不再写"看了个视频"', !watch.includes('看了个视频'), '')
}

/* ---------- 5. 真实数据里有没有"看了视频"这种夸大 ---------- */
console.log('\n=== 5. 已有的生活记录 ===')
{
  const p = 'persona/life.md'
  if (!existsSync(p)) {
    check('（没有 life.md，跳过）', true)
  } else {
    const life = readFileSync(p, 'utf8')
    const watched = life.split('\n').filter((l) => l.includes('看了个视频'))
    check(`旧记录里有 ${watched.length} 条"看了个视频"（历史数据，不阻断）`, true)
    if (watched.length) {
      console.log(`   （历史措辞，新的会写"翻到"）`)
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
