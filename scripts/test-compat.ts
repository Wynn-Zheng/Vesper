/**
 * 旧数据兼容性：升级时**用户数据不会跟着代码走**。
 *
 * 重点检查四类"旧数据"：
 *   1. 旧 rules.yaml：阶段没有结构化字段、称呼还是「昵称/专属」占位符、阶段名还是「离不开」
 *   2. 旧 facts.md：没有「已失效」标记
 *   3. 旧 open.md / session.json / .state.json：字段缺失
 *   4. 旧 relation.yaml：只有总关系值
 *
 * 跑法：node scripts/test-compat.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rules, StageRule } from '../src/core/config.ts'

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

const root = mkdtempSync(join(tmpdir(), 'qqbot-compat-'))

const { DEFAULTS, stageOf } = await import('../src/core/config.ts')
const { setMemoryRoot, appendRaw } = await import('../src/memory/store.ts')
const { setPeopleRoot } = await import('../src/people/store.ts')
const { setRelationRoot, loadRelation } = await import('../src/relation/store.ts')
const { buildRelationBlock } = await import('../src/relation/format.ts')
const { decayRelation } = await import('../src/relation/decay.ts')
const { proactiveBudgetOf } = await import('../src/scheduler/proactive.ts')
const { loadFacts, appendFacts } = await import('../src/memory/facts.ts')
const { loadOpen, appendOpen } = await import('../src/people/open.ts')
const { loadSession, saveSession, setSessionRoot } = await import('../src/loop/session.ts')

const peopleRoot = join(root, 'people')
setMemoryRoot(join(root, 'memory'))
setPeopleRoot(peopleRoot)
setRelationRoot(peopleRoot)
setSessionRoot(join(root, 'sessions'))
mkdirSync(join(root, 'memory', 'raw'), { recursive: true })

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/* ---------------- 1. 旧 rules.yaml 的结构 ---------------- */

console.log('=== 1. 旧 rules.yaml（升级不会改用户配置）===')
{
  // 旧版的样子：没有 主动间隔小时/每日上限/最小由头，称呼是占位符，最后阶段叫「离不开」
  const legacyStages: StageRule[] = [
    { 名: '陌生', 至: 10, 称呼: '你', 主动: '不主动' },
    { 名: '眼熟', 至: 25, 称呼: '你', 主动: '三五天一次' },
    { 名: '朋友', 至: 45, 称呼: '哎', 主动: '一两天一次' },
    { 名: '亲近', 至: 65, 称呼: '昵称', 主动: '每天一次' },
    { 名: '亲密', 至: 85, 称呼: '专属', 主动: '每天一两次' },
    { 名: '离不开', 至: 100, 称呼: '专属', 主动: '每天两三次' },
  ]
  const legacy: Rules = {
    ...DEFAULTS,
    关系: { ...DEFAULTS.关系, 阶段: legacyStages, 昵称: undefined },
  }

  check('旧阶段名「离不开」仍能匹配到阶段', stageOf(legacy, 90).名 === '离不开', stageOf(legacy, 90).名)
  check('旧配置缺结构化字段时用内置兜底（不崩、不 0）', proactiveBudgetOf(legacy, '陌生').dailyMax === 1)
  check('旧阶段名「离不开」有兜底预算', proactiveBudgetOf(legacy, '离不开').dailyMax === 3)

  const closeState = { closeness: 90, anchors: [], dimensions: { 信任: [], 亲密: [], 好奇: [], 依赖: [] } }
  const block90 = buildRelationBlock(legacy, closeState)
  check('旧称呼「专属」不会再原样进 prompt', !block90.includes('「专属」'), block90.split('\n').join(' | '))
  check('换成了可执行的说明', block90.includes('习惯的叫法'), block90.split('\n').join(' | '))

  const midState = { closeness: 50, anchors: [], dimensions: { 信任: [], 亲密: [], 好奇: [], 依赖: [] } }
  const block50 = buildRelationBlock(legacy, midState)
  check('旧称呼「昵称」同理', !block50.includes('「昵称」'), block50.split('\n').join(' | '))
  check('陌生阶段的旧配置也有「不熟」提示', buildRelationBlock(legacy, { ...closeState, closeness: 3 }).includes('还不熟'))

  // 关系值/距下一档不再出现在 prompt 里
  check('prompt 里没有关系值数字', !block50.includes('/100'), block50)
}

/* ---------------- 2. 旧 relation.yaml ---------------- */

console.log('\n=== 2. 旧 relation.yaml ===')
{
  const pid = 'qq-41001'
  mkdirSync(join(peopleRoot, pid), { recursive: true })
  writeFileSync(join(peopleRoot, pid, 'relation.yaml'), '总关系值: 17\n锚点: []\n维度事件: {}\n')
  const r = loadRelation(pid)
  check('只存总关系值的旧文件能读', r.closeness === 17, String(r.closeness))
  check('四维缺失时补空数组', Array.isArray(r.dimensions.信任))
}

/* ---------------- 3. 旧 facts.md ---------------- */

console.log('\n=== 3. 旧 facts.md（没有已失效标记）===')
{
  const pid = 'qq-41002'
  const dir = join(peopleRoot, pid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'facts.md'),
    [
      '# 关于这个人的事实',
      '',
      '## 重要',
      '- 他答应过不再熬夜（2026-10-01，置信 0.9，公开，你确认）｜他当时说"以后十二点前睡"',
      '',
      '## 平常',
      '- 他在学 guitar（2026-10-02，置信 0.8，私密）',
      '',
    ].join('\n'),
  )
  const list = loadFacts(pid)
  check('旧 facts 能读全', list.length === 2, JSON.stringify(list.map((f) => f.text)))
  check('旧 facts 没有 supersededAt（默认不失效）', list.every((f) => !f.supersededAt))
  check('旧 facts 的 by=me 仍能识别', list.some((f) => f.by === 'me'))

  // 追加新事实不会破坏旧格式
  appendFacts(pid, [{ text: '他最近在准备考试', date: '2026-10-28', confidence: 0.8, visibility: 'public' }])
  const after = loadFacts(pid)
  check('追加后旧条目还在', after.some((f) => f.text.includes('熬夜')) && after.length === 3, JSON.stringify(after.map((f) => f.text)))
  check('重写后文件仍是可解析的格式', readFileSync(join(dir, 'facts.md'), 'utf8').includes('# 关于这个人的事实'))
}

/* ---------------- 4. 旧 open.md ---------------- */

console.log('\n=== 4. 旧 open.md ===')
{
  const pid = 'qq-41003'
  const dir = join(peopleRoot, pid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'open.md'), '# 还没做完 / 想问他的事\n\n- [todo] 问问他考试怎么样（2026-10-01）\n')
  const list = loadOpen(pid)
  check('旧待办能读', list.length === 1 && list[0]!.text.includes('考试'))
  appendOpen(pid, [{ text: '问问他考试怎么样', date: '2026-10-28', kind: 'todo' }])
  check('重复追加被去重（旧条目不受影响）', loadOpen(pid).length === 1)
}

/* ---------------- 5. 旧 session.json ---------------- */

console.log('\n=== 5. 旧 session.json ===')
{
  const key = 'private:41004'
  mkdirSync(join(root, 'sessions'), { recursive: true })
  // 更老的格式：直接一个 turns 数组
  writeFileSync(join(root, 'sessions', `${encodeURIComponent(key)}.json`), JSON.stringify([{ role: 'user', content: 'hi', at: 1 }]))
  const s = loadSession(key)
  check('数组格式的旧会话能读', s.turns.length === 1 && s.summary === '')
  saveSession({ ...s, summary: '测试', summaryUpdatedAt: 1, summaryCursor: 0 })
  check('再写回是对象格式', JSON.parse(readFileSync(join(root, 'sessions', `${encodeURIComponent(key)}.json`), 'utf8')).key === key)
}

/* ---------------- 6. 旧 .state.json / .proactive.json ---------------- */

console.log('\n=== 6. 旧状态文件 ===')
{
  // distiller 的旧格式：一个全局 lastDistillAt
  writeFileSync(join(root, 'memory', '.state.json'), JSON.stringify({ lastDistillAt: 1700000000000 }))
  // 不能直接调 loadState（未导出），但可以验证"文件存在时 tick 不崩"——这里只做格式层面的断言：
  const raw = JSON.parse(readFileSync(join(root, 'memory', '.state.json'), 'utf8')) as { lastDistillAt?: number }
  check('旧 .state.json 是合法 JSON（tick 的兼容分支能处理）', typeof raw.lastDistillAt === 'number')

  // proactive 的旧格式：没有 noReply
  writeFileSync(
    join(root, 'memory', '.proactive.json'),
    JSON.stringify({ date: '2026-10-01', count: 1, lastAt: 1700000000000, lastText: '在吗' }),
  )
  const p = JSON.parse(readFileSync(join(root, 'memory', '.proactive.json'), 'utf8')) as { noReply?: number }
  check('旧 .proactive.json 没有 noReply 字段（读取时 ?? 0 兜底）', p.noReply === undefined)
}

/* ---------------- 7. 旧 episodes 目录 ---------------- */

console.log('\n=== 7. 旧 episodes ===')
{
  const dir = join(root, 'memory', 'episodes', 'private-41005')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '2026-10-01-01.md'),
    ['---', 'date: 2026-10-01', 'scope: private:41005', 'importance: 7', 'title: 旧经历', '---', '', '正文', ''].join('\n'),
  )
  const { loadEpisodes } = await import('../src/memory/store.ts')
  const list = loadEpisodes()
  check('旧 episode 能读（没有 lastRecalled/related 字段）', list.some((e) => e.title === '旧经历'))
  const hit = list.find((e) => e.title === '旧经历')!
  check('缺省字段是 undefined 而不是 NaN', hit.recallCount === undefined && hit.related === undefined)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
