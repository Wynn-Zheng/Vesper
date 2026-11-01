/**
 * 核心四件套体检：config.ts / ratelimit.ts / text.ts / access.ts
 *
 * 全部是纯函数或临时文件，不启动服务、不读写 persona/ 下的真实数据。
 * 运行：node scripts/test-core-bugs.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, loadRules, talkValueOf } from '../src/core/config.ts'
import type { Rules } from '../src/core/config.ts'
import { checkAccess } from '../src/core/access.ts'
import type { AccessPolicy, AccessResult } from '../src/core/access.ts'
import { initLog } from '../src/core/log.ts'
import { allow, resetRateLimit } from '../src/core/ratelimit.ts'
import { similarity } from '../src/core/text.ts'

// 别把体检过程中的日志写进 data/logs
initLog('', false)

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

const show = (v: unknown): string => JSON.stringify(v)
const inUnitRange = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1

const dir = mkdtempSync(join(tmpdir(), 'qqbot-core-bugs-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function yamlFile(name: string, text: string): string {
  const p = join(dir, name)
  writeFileSync(p, text, 'utf8')
  return p
}

function captureError(fn: () => unknown): Error | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

/* ================= 1. similarity 基本边界 ================= */

console.log('=== 1. similarity 返回范围 ===')
{
  const long = '今天有点累，想早点休息。'.repeat(2000) // 约 2.4 万字
  const cases: Array<[string, string, string]> = [
    ['空串 vs 空串', '', ''],
    ['空串 vs 非空', '', 'abc'],
    ['完全相同（中文）', '今天有点累', '今天有点累'],
    ['完全相同（单字）', 'a', 'a'],
    ['单字 vs 单字', 'a', 'b'],
    ['完全相同（超长）', long, long],
    ['超长 vs 自己的前缀', long, long.slice(0, 5000)],
    ['超长 vs 完全不同', long, 'b'.repeat(20_000)],
  ]
  for (const [name, a, b] of cases) {
    const n = similarity(a, b)
    check(`${name} 落在 [0,1]`, inUnitRange(n), String(n))
  }

  check('完全相同的中文返回 1', similarity('今天有点累', '今天有点累') === 1)
  check('空串返回 0', similarity('', 'abc') === 0)
  check('单字没有二元组，返回 0', similarity('a', 'a') === 0)
  check('超长文本也不会越界', similarity(long, long) === 1)
}

/* ================= 2. similarity 防御式输入 ================= */

console.log('\n=== 2. similarity 空值防御 ===')
{
  const samples: Array<[string, unknown, unknown]> = [
    ['null / 字符串', null, 'abc'],
    ['字符串 / null', 'abc', null],
    ['undefined / 字符串', undefined, 'abc'],
    ['字符串 / undefined', 'abc', undefined],
    ['null / null', null, null],
    ['undefined / undefined', undefined, undefined],
    ['数字 / 字符串', 123, 'abc'],
    ['对象 / 字符串', {}, 'abc'],
  ]

  for (const [name, a, b] of samples) {
    let value = Number.NaN
    const err = captureError(() => {
      value = similarity(a as string, b as string)
    })
    check(`${name} 不抛错`, err === null, err?.message)
    check(`${name} 返回 [0,1]`, inUnitRange(value), String(value))
  }
}

/* ================= 3. ratelimit 滑动窗口 ================= */

function withFakeClock<T>(fn: (advance: (ms: number) => void) => T): T {
  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now
  try {
    return fn((ms) => {
      now += ms
    })
  } finally {
    Date.now = realNow
    resetRateLimit()
  }
}

console.log('\n=== 3. ratelimit allow 窗口 ===')
withFakeClock((advance) => {
  resetRateLimit()

  // 窗口内前 N 次通过，第 N+1 次拒绝
  let passed = 0
  for (let i = 0; i < 3; i++) if (allow('win', 3, 1000)) passed++
  check('窗口内前 3 次通过', passed === 3, `${passed}/3`)
  check('第 4 次被拒', allow('win', 3, 1000) === false)

  // 没滑完继续拒绝；滑过后恢复
  advance(999)
  check('窗口未滑过时继续拒绝', allow('win', 3, 1000) === false)
  advance(1)
  check('窗口滑过后恢复', allow('win', 3, 1000) === true)

  // 连续调用时，额度随最早的时间戳逐条释放
  resetRateLimit()
  check('滑窗：第 1 次通过', allow('slide', 2, 1000) === true)
  advance(400)
  check('滑窗：第 2 次通过', allow('slide', 2, 1000) === true)
  check('滑窗：第 3 次被拒', allow('slide', 2, 1000) === false)
  advance(600)
  check('滑窗：最早一条过期后恢复', allow('slide', 2, 1000) === true)
  check('滑窗：刚补的这条继续占额度', allow('slide', 2, 1000) === false)

  // max <= 0 / 非法值：一次都不允许，而且时间过去也不会放开
  resetRateLimit()
  for (let i = 1; i <= 3; i++) {
    check(`max=0 第 ${i} 次拒绝`, allow('zero', 0, 1000) === false)
  }
  advance(10_000)
  check('max=0 时间过去仍然拒绝', allow('zero', 0, 1000) === false)
  check('max<0 拒绝', allow('negative', -1, 1000) === false)
  check('max=NaN 拒绝', allow('nan', Number.NaN, 1000) === false)
})

/* ================= 4. resetRateLimit 真清空 ================= */

console.log('\n=== 4. resetRateLimit ===')
withFakeClock(() => {
  resetRateLimit()
  check('reset 前先把额度用满', allow('reset', 1, 60_000) === true && allow('reset', 1, 60_000) === false)

  resetRateLimit()
  check('reset 后同一个 key 立刻恢复', allow('reset', 1, 60_000) === true)

  resetRateLimit()
  check('key A 用满', allow('r:a', 1, 60_000) === true && allow('r:a', 1, 60_000) === false)
  check('key B 用满', allow('r:b', 1, 60_000) === true && allow('r:b', 1, 60_000) === false)
  resetRateLimit()
  check('reset 清空全部 key（A）', allow('r:a', 1, 60_000) === true)
  check('reset 清空全部 key（B）', allow('r:b', 1, 60_000) === true)
})

/* ================= 5. config merge ================= */

console.log('\n=== 5. config merge ===')

// 5.1 未知键收集成 warning
{
  const p = yamlFile(
    'unknown.yaml',
    [
      '人格:',
      '  名字: 体检',
      '  拼错的键: 1',
      '行为:',
      '  防抖:',
      '    安静: 3',
      '    多余字段: 2',
      '顶层不存在:',
      '  x: 1',
      '',
    ].join('\n'),
  )
  const { rules, warnings } = loadRules(p)
  check('已知键仍然生效', rules.人格.名字 === '体检' && rules.行为.防抖.安静 === 3, show(rules.人格.名字))
  check(
    '未知键（一级）被警告',
    warnings.some((w) => w.includes('人格.拼错的键')),
    show(warnings),
  )
  check(
    '未知键（嵌套）被警告',
    warnings.some((w) => w.includes('行为.防抖.多余字段')),
    show(warnings),
  )
  check(
    '未知键（顶层）被警告且没有 ".前缀"',
    warnings.some((w) => w.includes('忽略未知配置项 顶层不存在')),
    show(warnings),
  )
  check('warning 里说明了忽略原因', warnings.some((w) => w.includes('检查是否拼错')), show(warnings))
}

// 5.2 嵌套对象深合并
{
  const p = yamlFile(
    'deep-merge.yaml',
    ['行为:', '  防抖:', '    安静: 3', '说话:', '  每轮最多条数: 2', ''].join('\n'),
  )
  const { rules, warnings } = loadRules(p)
  check('嵌套对象：覆盖值生效', rules.行为.防抖.安静 === 3, String(rules.行为.防抖.安静))
  check(
    '嵌套对象：未写的同级保留默认',
    rules.行为.防抖.同人续发 === DEFAULTS.行为.防抖.同人续发,
    String(rules.行为.防抖.同人续发),
  )
  check('嵌套对象：未写的其他字段保留默认', rules.行为.发言频率 === DEFAULTS.行为.发言频率, String(rules.行为.发言频率))
  check(
    '嵌套对象：更深层的默认值也保留',
    rules.记忆.检索.最低分 === DEFAULTS.记忆.检索.最低分 && rules.记忆.检索.权重.相关 === DEFAULTS.记忆.检索.权重.相关,
  )
  check(
    '嵌套对象：其他分支不受影响',
    rules.说话.每轮最多条数 === 2 && rules.说话.每条最多字数 === DEFAULTS.说话.每条最多字数,
  )
  // 断言的是"合并没把默认值改掉"，所以拿当前默认值（防抖档位「自然」的安静值）当基准
  check('深合并没有污染 DEFAULTS', DEFAULTS.行为.防抖.安静 === 2 && DEFAULTS.说话.每轮最多条数 === 3)
  check('深合并不产生未知键警告', !warnings.some((w) => w.includes('忽略未知')), show(warnings))
}

// 5.3 数组整体替换
{
  const p = yamlFile(
    'arrays.yaml',
    [
      '人格:',
      '  边界:',
      '    - 只留这一条',
      '关系:',
      '  阶段:',
      '    - 名: 新阶段',
      '      至: 5',
      '      称呼: 你',
      '      主动: 不主动',
      '',
    ].join('\n'),
  )
  const { rules } = loadRules(p)
  check('数组替换：长度等于配置', rules.人格.边界.length === 1, show(rules.人格.边界))
  check('数组替换：内容等于配置', rules.人格.边界[0] === '只留这一条', show(rules.人格.边界))
  check('数组替换：没有拼接默认值', !rules.人格.边界.includes('不编造共同经历'), show(rules.人格.边界))
  check(
    '对象数组也整体替换',
    rules.关系.阶段.length === 1 && rules.关系.阶段[0]?.名 === '新阶段',
    show(rules.关系.阶段),
  )
  check(
    '替换数组不污染 DEFAULTS',
    DEFAULTS.人格.边界.length === 3 && DEFAULTS.关系.阶段.length === 6,
    `${DEFAULTS.人格.边界.length}/${DEFAULTS.关系.阶段.length}`,
  )

  const empty = loadRules(yamlFile('empty-array.yaml', '人格:\n  边界: []\n')).rules
  check('空数组也整体替换，不会回退默认值', empty.人格.边界.length === 0, show(empty.人格.边界))
}

/* ================= 6. 非法 YAML ================= */

console.log('\n=== 6. 非法 YAML ===')
{
  const p = yamlFile('tab-indent.yaml', '人格:\n\t名字: 体检\n')
  const err = captureError(() => loadRules(p))
  check('tab 缩进会抛错', err !== null)
  check('错误信息带文件路径', err?.message.includes('tab-indent.yaml') ?? false, err?.message ?? '')
  check('错误信息说明不是合法 YAML', err?.message.includes('不是合法 YAML') ?? false, err?.message ?? '')
  check(
    '错误信息带位置（line/column）',
    /line\s+\d+|column\s+\d+/i.test(err?.message ?? ''),
    err?.message ?? '',
  )

  const root = yamlFile('root-array.yaml', '- 1\n- 2\n')
  const rootErr = captureError(() => loadRules(root))
  check('顶层是数组时给出清晰错误', rootErr?.message.includes('顶层必须是键值映射') ?? false, rootErr?.message ?? '')
}

/* ================= 7. access 优先级 ================= */

console.log('\n=== 7. access checkAccess ===')

function policy(over: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    requireAt: true,
    ...over,
  }
}

function accessCase(
  name: string,
  p: AccessPolicy,
  groupId: string,
  userId: string,
  ok: boolean,
  reason?: AccessResult['reason'],
): void {
  const r = checkAccess(p, groupId, userId)
  check(name, r.ok === ok && (reason === undefined || r.reason === reason), show(r))
}

{
  accessCase(
    '群黑名单优先于群白名单',
    policy({ groupDeny: ['g1'], groupAllow: ['g1'], memberAllow: ['u1'] }),
    'g1',
    'u1',
    false,
    '群黑名单',
  )
  accessCase(
    '成员黑名单优先于成员白名单',
    policy({ groupAllow: ['g1'], memberDeny: ['u1'], memberAllow: ['u1'] }),
    'g1',
    'u1',
    false,
    '成员黑名单',
  )
  accessCase(
    '群黑和成员黑同时命中时，群黑优先',
    policy({ groupDeny: ['g1'], memberDeny: ['u1'] }),
    'g1',
    'u1',
    false,
    '群黑名单',
  )
  accessCase(
    '成员黑名单优先于群白名单',
    policy({ groupAllow: ['g1'], memberDeny: ['u1'] }),
    'g1',
    'u1',
    false,
    '成员黑名单',
  )
  accessCase(
    '群黑名单优先于成员白名单',
    policy({ groupDeny: ['g1'], memberAllow: ['u1'] }),
    'g1',
    'u1',
    false,
    '群黑名单',
  )

  accessCase('两个白名单都为空表示不限', policy(), '任意群', '任意人', true)
  accessCase('群白名单为空时，成员白名单单独生效', policy({ memberAllow: ['u1'] }), '任意群', 'u1', true)
  accessCase('群白名单命中放行', policy({ groupAllow: ['g1'] }), 'g1', 'u1', true)
  accessCase('群白名单未命中拒绝', policy({ groupAllow: ['g1'] }), 'g2', 'u1', false, '不在群白名单')
  accessCase('成员白名单命中放行', policy({ memberAllow: ['u1'] }), 'g1', 'u1', true)
  accessCase('成员白名单未命中拒绝', policy({ memberAllow: ['u1'] }), 'g1', 'u2', false, '不在成员白名单')
  accessCase(
    '群白和成员白都命中才放行',
    policy({ groupAllow: ['g1'], memberAllow: ['u1'] }),
    'g1',
    'u2',
    false,
    '不在成员白名单',
  )
}

/* ================= 8. talkValueOf 时段 ================= */

console.log('\n=== 8. talkValueOf 时段 ===')

function timeline(频率规则: Rules['行为']['频率规则'], 发言频率 = DEFAULTS.行为.发言频率): Rules {
  return {
    ...DEFAULTS,
    行为: { ...DEFAULTS.行为, 发言频率, 频率规则 },
  }
}

function at(h: number, m = 0): Date {
  return new Date(2026, 9, 26, h, m, 0, 0)
}

{
  const night = timeline([{ 时段: '23:00-02:00', 值: 0.05 }])
  check('跨夜：22:59 不命中', talkValueOf(night, at(22, 59)) === 0.4, String(talkValueOf(night, at(22, 59))))
  check('跨夜：23:00 起点命中', talkValueOf(night, at(23, 0)) === 0.05, String(talkValueOf(night, at(23, 0))))
  check('跨夜：00:00 命中', talkValueOf(night, at(0, 0)) === 0.05, String(talkValueOf(night, at(0, 0))))
  check('跨夜：01:59 命中', talkValueOf(night, at(1, 59)) === 0.05, String(talkValueOf(night, at(1, 59))))
  check('跨夜：02:00 终点不命中', talkValueOf(night, at(2, 0)) === 0.4, String(talkValueOf(night, at(2, 0))))
  check('跨夜：03:00 不命中', talkValueOf(night, at(3, 0)) === 0.4, String(talkValueOf(night, at(3, 0))))

  const day = timeline([{ 时段: '09:00-18:00', 值: 0.8 }])
  check('同日：09:00 起点命中', talkValueOf(day, at(9, 0)) === 0.8, String(talkValueOf(day, at(9, 0))))
  check('同日：17:59 命中', talkValueOf(day, at(17, 59)) === 0.8, String(talkValueOf(day, at(17, 59))))
  check('同日：18:00 终点不命中', talkValueOf(day, at(18, 0)) === 0.4, String(talkValueOf(day, at(18, 0))))
  check('同日：08:59 不命中', talkValueOf(day, at(8, 59)) === 0.4, String(talkValueOf(day, at(8, 59))))

  const noMatch = timeline([{ 时段: '03:00-04:00', 值: 0.1 }])
  check('没有匹配的规则时回落到 0.4', talkValueOf(noMatch, at(12, 0)) === 0.4, String(talkValueOf(noMatch, at(12, 0))))
  check('规则为空时回落到 0.4', talkValueOf(timeline([]), at(12, 0)) === 0.4, String(talkValueOf(timeline([]), at(12, 0))))

  const badValue = timeline([{ 时段: '00:00-23:59', 值: Number.NaN }])
  check('规则值非法时回落到 0.4', talkValueOf(badValue, at(12, 0)) === 0.4, String(talkValueOf(badValue, at(12, 0))))

  const overlapping = timeline([
    { 时段: '00:00-23:59', 值: 0.2 },
    { 时段: '12:00-13:00', 值: 0.9 },
  ])
  check('重叠时段按顺序取第一条', talkValueOf(overlapping, at(12, 30)) === 0.2, String(talkValueOf(overlapping, at(12, 30))))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
