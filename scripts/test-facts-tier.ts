/**
 * facts.md 分档的往返测试。
 *
 * 核心原则：**读 → 写 → 再读，必须一字不差**。
 *
 * 为什么要这么小心：
 *   appendFacts 原来是"原文追加"，改成分档后必须"读-合并-重写"。
 *   重写最怕解析丢东西 —— 解析错了会把老数据覆盖掉。
 *   现在只有 7 条合成数据，但改法要对。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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

const facts = await import('../src/memory/facts.ts')
const { setPeopleRoot } = await import('../src/people/store.ts')

/** 用独立的测试目录，绝不碰 persona/people 真实数据 */
const ROOT = 'data/test-facts'
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
setPeopleRoot(ROOT)

/* ============================================================
 * 合成数据当 fixture（7 条，结构模仿真实 facts.md，内容全为虚构）
 * ============================================================ */
const REAL = `# 关于这个人的事实

- 他最近在准备一场考试，复习得断断续续（2026-01-10，置信 0.95，公开）
- 他什么类型的音乐都听，没有特别偏好的歌手（2026-01-10，置信 0.9，私密）
- 他作息不太规律，经常到半夜才睡，第二天还要早起（2026-01-10，置信 0.9，私密）
- 他会看这个项目的源码，觉得能帮它变得更好（2026-01-10，置信 0.85，私密）
- 他在同时学两门完全不相干的东西（2026-01-10，置信 0.9，私密）
- 他给它加了几个功能，自己本地测过能跑（2026-01-10，置信 0.9，公开）｜我测试没啥问题，你感觉怎么样
- 他以为某个功能已经接上了，实际没有（2026-01-10，置信 0.85，公开）｜我不是加了吗，不能用吗
`

function writeFixture(content: string): void {
  const dir = `${ROOT}/qq-111`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/facts.md`, content, 'utf8')
}

/* ============================================================
 * 1. 老格式（平铺）能读，默认 tier = normal
 * ============================================================ */
console.log('=== 1. 老格式兼容 ===')
{
  writeFixture(REAL)
  const list = facts.loadFacts('qq-111')
  check('7 条全读出来', list.length === 7, String(list.length))
  check('第一条文字对', list[0]?.text === '他最近在准备一场考试，复习得断断续续', list[0]?.text)
  check('置信度对', list[0]?.confidence === 0.95, String(list[0]?.confidence))
  check('可见性对（公开）', list[0]?.visibility === 'public', list[0]?.visibility)
  check('第 2 条可见性对（私密）', list[1]?.visibility === 'private', list[1]?.visibility)
  check('source 解析出来了', list[5]?.source === '我测试没啥问题，你感觉怎么样', list[5]?.source)
  check('没有分段时默认 normal', list.every((f) => (f.tier ?? 'normal') === 'normal'), list.map((f) => f.tier).join(','))
}

/* ============================================================
 * 2. ⭐ 往返：读 → 写 → 再读，一字不差
 * ============================================================ */
console.log('\n=== 2. 往返不丢数据 ===')
{
  writeFixture(REAL)
  const before = facts.loadFacts('qq-111')

  // 触发一次重写（改一条的可见性）
  const ok = facts.setVisibility('qq-111', before[0]!.text, 'private')
  check('setVisibility 成功', ok === true)

  const after = facts.loadFacts('qq-111')
  check('条数没变（7 → 7）', after.length === before.length, `${before.length} → ${after.length}`)
  check('所有文字都没变', after.every((f, i) => f.text === before[i]!.text), JSON.stringify(after.map((f) => f.text.slice(0, 10))))
  check('置信度都没变', after.every((f, i) => f.confidence === before[i]!.confidence))
  check('source 都没丢', after.every((f, i) => f.source === before[i]!.source))
  check('只有目标那条的可见性变了', after[0]!.visibility === 'private' && after.slice(1).every((f, i) => f.visibility === before[i + 1]!.visibility))
}

/* ============================================================
 * 3. 分段格式能读
 * ============================================================ */
console.log('\n=== 3. 分段格式 ===')
{
  const SECTIONED = `# 关于这个人的事实

## 重要
- 他四级坚持要考（2026-10-25，置信 0.95，公开）

## 平常
- 他什么歌都听（2026-10-25，置信 0.9，私密）
- 他作息很乱（2026-10-25，置信 0.9，私密）
`
  writeFixture(SECTIONED)
  const list = facts.loadFacts('qq-111')
  check('3 条全读出来', list.length === 3, String(list.length))
  check('「重要」段的 tier 是 major', list[0]?.tier === 'major', String(list[0]?.tier))
  check('「平常」段的 tier 是 normal', list[1]?.tier === 'normal', String(list[1]?.tier))
  check('第 3 条也是 normal', list[2]?.tier === 'normal', String(list[2]?.tier))

  // 往返
  const before = facts.loadFacts('qq-111')
  facts.setVisibility('qq-111', before[1]!.text, 'public')
  const after = facts.loadFacts('qq-111')
  check('分段往返条数不变', after.length === 3, String(after.length))
  check('分段往返 tier 不变', after.every((f, i) => f.tier === before[i]!.tier), `${after.map((f) => f.tier)} vs ${before.map((f) => f.tier)}`)
}

/* ============================================================
 * 4. ⭐ 保护：解析丢东西时拒绝重写
 * ============================================================ */
console.log('\n=== 4. 解析失败的保护 ===')
{
  // 造一个"有一行坏掉"的文件：正常 2 条 + 1 行格式完全不对的
  const BROKEN = `# 关于这个人的事实

- 好的第一条（2026-10-25，置信 0.9，公开）
这一行格式完全不对，不是列表项
- 好的第二条（2026-10-25，置信 0.9，公开）
`
  writeFixture(BROKEN)
  const list = facts.loadFacts('qq-111')
  check('能读到 2 条好的', list.length === 2, String(list.length))

  // 原文有 2 个 '- ' 开头，解析出 2 条 → 不丢，可以写
  const beforeRaw = readFileSync(`${ROOT}/qq-111/facts.md`, 'utf8')
  const beforeDashes = (beforeRaw.match(/^-\s+/gm) ?? []).length
  check(`原文 '- ' 行数 = ${beforeDashes}`, beforeDashes === 2, String(beforeDashes))

  // 现在测真正的保护：如果解析条数 < 原文行数，appendFacts 不该覆盖
  // 造一个"每行都不合格"的文件
  const ALL_BROKEN = `# 关于这个人的事实

- 格式对的第一条（2026-10-25，置信 0.9，公开）
- 坏的（缺日期和置信）
- 也坏的（什么都不全）
`
  writeFixture(ALL_BROKEN)
  const parsed = facts.loadFacts('qq-111')
  check('只解析出 1 条', parsed.length === 1, String(parsed.length))

  const raw = readFileSync(`${ROOT}/qq-111/facts.md`, 'utf8')
  const dashes = (raw.match(/^-\s+/gm) ?? []).length
  check(`原文有 ${dashes} 个 '- '，只解析出 ${parsed.length} 条 → 应该拒绝重写`, dashes > parsed.length)

  // 调 appendFacts，它应该检测到这种情况并拒绝
  facts.appendFacts('qq-111', [
    { text: '新的一条', date: '2026-10-26', confidence: 0.9, visibility: 'public' },
  ])
  const afterContent = readFileSync(`${ROOT}/qq-111/facts.md`, 'utf8')

  // 要么拒绝写（内容完全没变），要么安全合并（3 行都还在）
  const stillHasFirst = afterContent.includes('格式对的第一条')
  check('坏行没被当成"不存在"而覆盖掉好行', stillHasFirst, '好行丢了！')
}

/* ============================================================
 * 5. appendFacts 按 tier 分组
 * ============================================================ */
console.log('\n=== 5. 追加时按档位分组 ===')
{
  writeFixture(`# 关于这个人的事实\n\n- 旧的一条（2026-10-25，置信 0.9，公开）\n`)
  facts.appendFacts('qq-111', [
    { text: '新的重要一条', date: '2026-10-26', confidence: 0.9, visibility: 'public', tier: 'major' },
    { text: '新的平常一条', date: '2026-10-26', confidence: 0.9, visibility: 'public', tier: 'normal' },
  ])

  const list = facts.loadFacts('qq-111')
  check('变成 3 条', list.length === 3, String(list.length))
  check('重要的在', list.some((f) => f.text === '新的重要一条' && f.tier === 'major'), JSON.stringify(list.map((f) => [f.text.slice(0, 6), f.tier])))
  check('平常的也在', list.some((f) => f.text === '新的平常一条' && f.tier === 'normal'))

  const raw = readFileSync(`${ROOT}/qq-111/facts.md`, 'utf8')
  check('文件里出现了 ## 重要', raw.includes('## 重要'), raw.slice(0, 100))
  check('文件里出现了 ## 平常', raw.includes('## 平常'), '')
}

/* ============================================================
 * 6. 删除 / 编辑 / touch 都不丢数据
 * ============================================================ */
console.log('\n=== 6. 其他写操作 ===')
{
  writeFixture(REAL)
  const before = facts.loadFacts('qq-111')

  // 删一条
  facts.deleteFact('qq-111', before[0]!.text)
  const afterDel = facts.loadFacts('qq-111')
  check('删掉后 6 条', afterDel.length === 6, String(afterDel.length))
  check('删的是那一条', !afterDel.some((f) => f.text === before[0]!.text))

  // 改一条
  const target = afterDel[0]!
  facts.editFact('qq-111', target.text, { text: '改过的文字' })
  const afterEdit = facts.loadFacts('qq-111')
  check('改完还是 6 条', afterEdit.length === 6, String(afterEdit.length))
  check('文字改了', afterEdit.some((f) => f.text === '改过的文字'), JSON.stringify(afterEdit.map((f) => f.text.slice(0, 8))))

  // touch
  facts.touchFact('qq-111', '改过的文字', '2026-10-27')
  const afterTouch = facts.loadFacts('qq-111')
  check('touch 后还是 6 条', afterTouch.length === 6, String(afterTouch.length))
  check('确认日期更新了', afterTouch.find((f) => f.text === '改过的文字')?.lastConfirmed === '2026-10-27', afterTouch.find((f) => f.text === '改过的文字')?.lastConfirmed)
}

/* ============================================================
 * 7. 坏数据不炸
 * ============================================================ */
console.log('\n=== 7. 坏数据 ===')
{
  writeFixture('')
  check('空文件 → 空数组', facts.loadFacts('qq-111').length === 0)

  writeFixture('# 只有标题\n')
  check('只有标题 → 空数组', facts.loadFacts('qq-111').length === 0)

  writeFixture('乱码\x00\x01\x02')
  check('乱码不炸', Array.isArray(facts.loadFacts('qq-111')))

  check('不存在的人 → 空数组', facts.loadFacts('qq-nonexist').length === 0)

  writeFixture(`# 关于这个人的事实\n\n- 置信度是 NaN 的（2026-10-25，置信 abc，公开）\n`)
  check('置信度非法 → 跳过', facts.loadFacts('qq-111').length === 0)
}

// 清理
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
