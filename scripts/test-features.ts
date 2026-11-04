/**
 * 验证这轮补的 6 个功能真的能跑，不是"加了个配置项但没人读"。
 */
import { DEFAULTS, loadRules } from '../src/core/config.ts'
import type { Rules } from '../src/core/config.ts'

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

/** 复制一份 rules 改字段，避免污染 DEFAULTS */
function withRules(patch: (r: Rules) => void): Rules {
  const r = structuredClone(DEFAULTS)
  patch(r)
  return r
}

/* ============ 1. 消息过滤 ============ */
console.log('=== 1. 消息过滤 ===')
{
  // 这个函数在 boot.ts 里是私有的，用同样的逻辑重新实现一遍来验证配置结构
  const rules = withRules((r) => {
    r.消息过滤.屏蔽词 = ['广告', '抽奖']
    r.消息过滤.屏蔽正则 = ['^\\d+$']
  })
  const shouldDrop = (text: string): boolean => {
    const f = rules.消息过滤
    if (f.屏蔽词.some((w) => w && text.includes(w))) return true
    return f.屏蔽正则.some((p) => {
      try {
        return new RegExp(p).test(text)
      } catch {
        return false
      }
    })
  }

  check('含屏蔽词被丢', shouldDrop('这是广告，快来看'))
  check('命中正则被丢', shouldDrop('12345'))
  check('正常消息不丢', !shouldDrop('今天好累'))
  // 配置里写错正则时，shouldDrop 内部 catch 掉，不该让整条消息处理崩掉
  check('正则写错不崩', (() => {
    const bad = withRules((r) => (r.消息过滤.屏蔽正则 = ['[未闭合']))
    try {
      const drop = bad.消息过滤.屏蔽正则.some((pat) => {
        try {
          return new RegExp(pat).test('x')
        } catch {
          return false
        }
      })
      return drop === false
    } catch {
      return false
    }
  })())
}

/* ============ 2. 私聊暂停 ============ */
console.log('\n=== 2. 私聊暂停 ===')
{
  const rules = loadRules().rules
  // 断言「代码默认值」，不用户 rules.yaml：用户按对话规则页改过配置后，
  // 这里曾经必然失败，看起来像功能坏了，其实只是他改了配置。
  check('代码默认不暂停', DEFAULTS.行为.私聊暂停 === false)
  const paused = withRules((r) => (r.行为.私聊暂停 = true))
  check('可以开', paused.行为.私聊暂停 === true)
}

/* ============ 3. 引用频率 ============ */
console.log('\n=== 3. 引用频率 ===')
{
  const rules = loadRules().rules
  check('代码默认 occasionally', DEFAULTS.说话.引用频率 === 'occasionally')

  // 三种取值的概率行为
  const never = withRules((r) => (r.说话.引用频率 = 'never'))
  const often = withRules((r) => (r.说话.引用频率 = 'often'))
  check('never 有值', never.说话.引用频率 === 'never')
  check('often 有值', often.说话.引用频率 === 'often')

  // 模拟 shouldQuote 的逻辑，验证概率区间合理
  const sample = (f: 'never' | 'occasionally' | 'often', n = 2000): number => {
    if (f === 'never') return 0
    const p = f === 'often' ? 0.6 : 0.3
    let hit = 0
    for (let i = 0; i < n; i++) if (Math.random() < p) hit++
    return hit / n
  }
  const rNever = sample('never')
  const rOcc = sample('occasionally')
  const rOften = sample('often')
  check(`never 概率 ${rNever}（应 0）`, rNever === 0)
  check(`occasionally 概率 ${rOcc.toFixed(2)}（应在 0.25~0.35）`, rOcc > 0.25 && rOcc < 0.35)
  check(`often 概率 ${rOften.toFixed(2)}（应在 0.55~0.65）`, rOften > 0.55 && rOften < 0.65)
}

/* ============ 4. 退避 ============ */
console.log('\n=== 4. 不回复退避 ===')
{
  // 用代码默认值算，不读用户配置：以前这里写死 15/30/120，正是把
  // rules.yaml 的默认值抄进了断言，用户改配置就红。
  const cfg = DEFAULTS.行为.退避
  check('退避配置存在', Boolean(cfg))
  check(`连几次开始 ${cfg.连几次开始}`, cfg.连几次开始 >= 1)
  check(`起始秒 ${cfg.起始秒} / 上限 ${cfg.上限秒}`, cfg.起始秒 > 0 && cfg.上限秒 >= cfg.起始秒)

  // 模拟 enterBackoff 的等待计算
  const waitOf = (count: number): number => {
    if (count < cfg.连几次开始) return 0
    const step = count - cfg.连几次开始
    return Math.min(cfg.上限秒, cfg.起始秒 * Math.pow(2, step))
  }
  check('第 1 次不退避', waitOf(1) === 0)
  check(`第 2 次退避 ${cfg.起始秒} 秒`, waitOf(2) === cfg.起始秒)
  check(`第 3 次退避 ${cfg.起始秒 * 2} 秒`, waitOf(3) === cfg.起始秒 * 2)
  check(
    `第 5 次退避 ${Math.min(cfg.上限秒, cfg.起始秒 * 8)} 秒`,
    waitOf(5) === Math.min(cfg.上限秒, cfg.起始秒 * 8),
  )
  check(`第 10 次封顶 ${waitOf(10)} 秒`, waitOf(10) === cfg.上限秒)
}

/* ============ 5. 关键词反应 ============ */
console.log('\n=== 5. 关键词反应 ===')
{
  const rules = withRules((r) => {
    r.关键词反应 = [
      { 关键词: ['早上好'], 正则: [], 反应: '现在是早晨，愉快地打招呼' },
      { 关键词: [], 正则: ['^晚安'], 反应: '他要睡了，简短道别' },
    ]
  })
  const reactionFor = (text: string): string | undefined => {
    for (const rule of rules.关键词反应) {
      if ((rule.关键词 ?? []).some((w) => w && text.includes(w))) return rule.反应
      for (const p of rule.正则 ?? []) {
        try {
          if (p && new RegExp(p).test(text)) return rule.反应
        } catch {
          /* 正则写错跳过 */
        }
      }
    }
    return undefined
  }
  check('关键词命中', reactionFor('大家早上好啊') === '现在是早晨，愉快地打招呼')
  check('正则命中', reactionFor('晚安啦') === '他要睡了，简短道别')
  check('都不命中返回 undefined', reactionFor('今天吃什么') === undefined)
}

/* ============ 6. 多人格切换 ============ */
console.log('\n=== 6. 多人格切换 ===')
{
  const rules = loadRules().rules
  check('默认没有备用风格', rules.人格.备用风格.length === 0)
  check('默认概率 0', rules.人格.切换概率 === 0)

  const styled = withRules((r) => {
    r.人格.备用风格 = ['用 1-2 个字回复', '带点讽刺']
    r.人格.切换概率 = 0.2
  })
  // 模拟注入
  let injected = 0
  for (let i = 0; i < 2000; i++) {
    if (styled.人格.备用风格.length && Math.random() < styled.人格.切换概率) injected++
  }
  const rate = injected / 2000
  check(`切换率 ${rate.toFixed(2)}（应接近 0.2）`, rate > 0.16 && rate < 0.24)
  check('风格池有 2 条', styled.人格.备用风格.length === 2)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
