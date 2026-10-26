/**
 * 调度器纯逻辑体检：src/scheduler/proactive.ts + src/scheduler/distiller.ts
 *
 * 覆盖静默时段跨夜、主动消息门控、相似度、阶段额度兜底、跨天日期键、
 * 以及自动整理的轮数/时间门控。
 *
 * 只调用纯函数，不启动定时器、不发网络请求、不读写真实的 memory/。
 * 运行：node scripts/test-sched-bugs.ts
 */
import { DEFAULTS } from '../src/core/config.ts'
import type { RawTurn } from '../src/memory/types.ts'
import {
  inQuietHours,
  proactiveBudget,
  shouldProactive,
  tooSimilar,
  todayKey,
} from '../src/scheduler/proactive.ts'
import { shouldDistill } from '../src/scheduler/distiller.ts'

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

/** 用本地时间构造，别用 UTC 字符串：静默时段和 todayKey 都按本地日期算 */
function at(h: number, m = 0, s = 0): Date {
  return new Date(2026, 0, 15, h, m, s, 0)
}

const NOW = at(15, 0)

/* ---------- 1. 静默时段：23:30 → 08:30 跨夜 ---------- */
console.log('=== 1. inQuietHours 跨夜时段 ===')
{
  const cases: Array<[string, Date, boolean]> = [
    ['23:29 睡前', at(23, 29), false],
    ['23:30 刚进静默', at(23, 30), true],
    ['02:00 半夜', at(2, 0), true],
    ['08:29 快结束', at(8, 29), true],
    ['08:30 刚解除', at(8, 30), false],
    ['15:00 白天', at(15, 0), false],
  ]
  for (const [label, now, want] of cases) {
    check(`静默时段 ${label} → ${want}`, inQuietHours(DEFAULTS, now) === want)
  }

  // 非跨夜时段也不能被跨夜逻辑误伤
  const dayRules = {
    ...DEFAULTS,
    行为: { ...DEFAULTS.行为, 静默时段: ['12:00', '14:00'] as [string, string] },
  }
  check('非跨夜 11:59 不静默', inQuietHours(dayRules, at(11, 59)) === false)
  check('非跨夜 12:00 静默', inQuietHours(dayRules, at(12, 0)) === true)
  check('非跨夜 13:59 静默', inQuietHours(dayRules, at(13, 59)) === true)
  check('非跨夜 14:00 不静默', inQuietHours(dayRules, at(14, 0)) === false)
}

/* ---------- 2. shouldProactive 门控 ---------- */
console.log('\n=== 2. shouldProactive 门控 ===')
{
  const base = {
    rules: DEFAULTS,
    now: NOW,
    stageName: '朋友',
    lastTalkAt: NOW.getTime() - 30 * 3_600_000,
    lastProactiveAt: 0,
    todayCount: 0,
    openCount: 1,
  }

  check('全都满足时可以主动', shouldProactive(base).ok === true, shouldProactive(base).reason)
  check('陌生阶段（dailyMax=0）不主动', shouldProactive({ ...base, stageName: '陌生' }).ok === false)
  check(
    '陌生阶段即使刚聊过也不主动',
    shouldProactive({ ...base, stageName: '陌生', lastTalkAt: NOW.getTime() - 60_000 }).ok === false,
  )

  const quota = shouldProactive({ ...base, todayCount: proactiveBudget('朋友').dailyMax })
  check('额度刚好用完不主动', quota.ok === false, quota.reason)
  check('额度原因准确', quota.reason.includes('额度'), quota.reason)
  check(
    '额度还剩一次时可以主动',
    shouldProactive({ ...base, todayCount: proactiveBudget('朋友').dailyMax - 1 }).ok === true,
  )

  const tooSoon = shouldProactive({ ...base, lastTalkAt: NOW.getTime() - 2 * 3_600_000 })
  check('距上次说话间隔不够不主动', tooSoon.ok === false, tooSoon.reason)
  check('间隔原因准确', tooSoon.reason.includes('间隔'), tooSoon.reason)

  const recentProactive = shouldProactive({ ...base, lastProactiveAt: NOW.getTime() - 3_600_000 })
  check('距上次主动太近也不主动', recentProactive.ok === false, recentProactive.reason)

  // 朋友阶段最小间隔 24 小时：正好 24 小时应该放行（判断用的是 <）
  check(
    '间隔正好等于下限时可以主动',
    shouldProactive({ ...base, lastTalkAt: NOW.getTime() - 24 * 3_600_000 }).ok === true,
  )

  const quietNow = at(2, 0)
  const quiet = shouldProactive({
    ...base,
    now: quietNow,
    lastTalkAt: quietNow.getTime() - 30 * 3_600_000,
  })
  check('静默时段不主动', quiet.ok === false, quiet.reason)
  check('静默原因准确', quiet.reason.includes('静默'), quiet.reason)

  // 没有未完成的事、也没聊过，算"没有由头"——这是门控里额外的一条
  const noReason = shouldProactive({
    ...base,
    lastTalkAt: 0,
    lastProactiveAt: 0,
    openCount: 0,
  })
  check('没有由头也不主动', noReason.ok === false, noReason.reason)
  check(
    '有未完成的事就算有由头',
    shouldProactive({ ...base, lastTalkAt: 0, lastProactiveAt: 0, openCount: 1 }).ok === true,
  )
}

/* ---------- 3. tooSimilar 去重 ---------- */
console.log('\n=== 3. tooSimilar 相似度 ===')
{
  const same = '我今天下午去图书馆借了两本书'
  check('空串 vs 空串不算重复', tooSimilar('', '') === false)
  check('一边空串不算重复', tooSimilar('', same) === false)
  check('只有空白也不算重复', tooSimilar('   ', same) === false)
  check('完全一样算重复', tooSimilar(same, same) === true)
  check('差一个字仍算重复', tooSimilar(same, '我今天下午去图书馆借了一本书') === true)
  check('完全不同不算重复', tooSimilar('明天可能要下雨记得带伞', '四级复习得如何了') === false)
  check('单字相同也算重复', tooSimilar('嗯', '嗯') === true)
  check('不同的单字不算重复', tooSimilar('嗯', '哦') === false)
  check(
    '忽略空格后相同算重复',
    tooSimilar('今天 下午 去图书馆', '今天下午去图书馆') === true,
  )
}

/* ---------- 4. proactiveBudget 阶段额度 ---------- */
console.log('\n=== 4. proactiveBudget 兜底 ===')
{
  check('陌生阶段 dailyMax=0', proactiveBudget('陌生').dailyMax === 0)
  for (const stage of ['眼熟', '朋友', '亲近', '亲密', '离不开']) {
    const b = proactiveBudget(stage)
    check(
      `已知阶段「${stage}」额度有效`,
      Number.isFinite(b.minGapHours) && b.minGapHours >= 0 && Number.isFinite(b.dailyMax) && b.dailyMax > 0,
      JSON.stringify(b),
    )
  }

  const unknown = proactiveBudget('还没定义的阶段')
  check('未知阶段有两个有限数值', Number.isFinite(unknown.minGapHours) && Number.isFinite(unknown.dailyMax), JSON.stringify(unknown))
  check('未知阶段兜底为默认额度', unknown.minGapHours === 4 && unknown.dailyMax === 5, JSON.stringify(unknown))
  check('未知阶段额度不会被 JSON 变成 null', JSON.stringify(unknown).includes('null') === false, JSON.stringify(unknown))
}

/* ---------- 5. todayKey 跨天 ---------- */
console.log('\n=== 5. todayKey 跨天 ===')
{
  const before = new Date(2026, 0, 31, 23, 59, 59, 999)
  const after = new Date(2026, 1, 1, 0, 0, 0, 0)
  check('23:59:59 的日期键', todayKey(before) === '2026-01-31', todayKey(before))
  check('00:00:00 的日期键', todayKey(after) === '2026-02-01', todayKey(after))
  check('跨过午夜后日期键不同', todayKey(before) !== todayKey(after))
  check('同一天中午仍是同一个键', todayKey(new Date(2026, 0, 31, 12, 0, 0)) === todayKey(before))
  check('月份和日期补零', todayKey(new Date(2026, 8, 5, 9, 0, 0)) === '2026-09-05', todayKey(new Date(2026, 8, 5, 9, 0, 0)))
}

/* ---------- 6. shouldDistill 整理门控 ---------- */
console.log('\n=== 6. shouldDistill 门控 ===')
{
  const turns = (n: number): RawTurn[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: NOW.getTime() - (n - i) * 1000,
      scope: 'private:1' as const,
      role: 'user' as const,
      text: `m${i}`,
    }))

  const hourAgo = NOW.getTime() - 3_600_000
  const dayAgo = NOW.getTime() - 24 * 3_600_000

  check('没有新消息不整理', shouldDistill([], 0, NOW.getTime(), 20) === false)
  check('轮数不够且刚整理过，不整理', shouldDistill(turns(5), hourAgo, NOW.getTime(), 20) === false)
  check('轮数不够且从没整理过，也不误触发', shouldDistill(turns(5), 0, NOW.getTime(), 20) === false)
  check('轮数够就整理（即使刚整理过）', shouldDistill(turns(20), hourAgo, NOW.getTime(), 20) === true)
  check('正好达到阈值就整理', shouldDistill(turns(20), 0, NOW.getTime(), 20) === true)
  check('差一轮不整理', shouldDistill(turns(19), hourAgo, NOW.getTime(), 20) === false)

  check('超过一天且有 4 轮，兜底整理', shouldDistill(turns(4), dayAgo, NOW.getTime(), 20) === true)
  check('超过一天但不足 4 轮，不整理', shouldDistill(turns(3), dayAgo, NOW.getTime(), 20) === false)
  check('刚好 24 小时按兜底整理', shouldDistill(turns(5), dayAgo, NOW.getTime(), 20) === true)
  check('每天至少=0 时关闭兜底', shouldDistill(turns(5), dayAgo, NOW.getTime(), { 阈值: 20, 每天至少: 0 }) === false)
  check('自定义阈值生效', shouldDistill(turns(10), hourAgo, NOW.getTime(), { 阈值: 10, 每天至少: 1 }) === true)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
