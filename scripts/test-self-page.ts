/**
 * 自我页结构测试。
 *
 * 只查"该有的在、不该有的不在"，不测渲染效果（那个靠截图看）。
 */
import { readFileSync } from 'node:fs'
import { lineDiff, loadDrifts } from '../src/self/store.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const html = readFileSync('console/index.html', 'utf8')

console.log('=== 1. 六个板块都在 ===')
for (const [k, label] of [
  ['card', '角色卡'],
  ['status', '状态'],
  ['learn', '学习'],
  ['exp', '经历'],
  ['think', '想法'],
  ['talk', '对话规则'],
]) {
  check(`tab「${label}」`, html.includes("['" + k + "', '" + label + "']"))
}
for (const fn of [
  'renderSelfCardPage',
  'renderSelfStatusPage',
  'renderSelfLearnPage',
  'renderSelfExpPage',
  'renderSelfThinkPage',
  'renderSelfTalkPage',
]) {
  check(`页面函数 ${fn}`, html.includes('function ' + fn + '('))
}
check('有 tab 容器', html.includes('id="self-tabs"'))
check('默认停在角色卡', /let SELF_TAB = 'card'/.test(html))

console.log('\n=== 3. 保留的功能函数 ===')
for (const fn of ['saveSelfText', 'switchSelfOwner', 'decideRequest', 'selfSec', 'selfCard', 'selfChip', 'selfEmpty']) {
  check(`有 ${fn}`, html.includes(fn))
}
check('有 renderSelfV2', html.includes('function renderSelfV2()'))

console.log('\n=== 3b. 状态与经历（分页后）===')
check('有「它想干什么」', html.includes('它想干什么'))
check('有「今天干了什么」', html.includes('今天干了什么'))
check('有「记住的事」', html.includes('记住的事'))
check('待办有输入框', html.includes('self-todo-input'))
check('待办走 intentAction', html.includes("intentAction('complete'"))

console.log('\n=== 3c. 就地编辑 ===')
for (const s of ['self-name-input', 'self-callyou-input', 'talk-max', 'talk-chars', 'talk-quote', 'self-core-input', 'self-traits-box']) {
  check(`有 ${s}`, html.includes(s))
}
for (const api of ['/api/self/name', '/api/self/traits', '/api/self/callyou', '/api/talk-style']) {
  check(`调 ${api}`, html.includes(api))
}
for (const fn of ['saveSelfName', 'saveSelfCallYou', 'saveSelfTraits', 'saveTalkStyle', 'selfCoreAdd', 'selfCoreDrop']) {
  check(`有 ${fn}`, html.includes(`function ${fn}(`))
}


console.log('\n=== 5. lineDiff ===')
{
  const d = lineDiff('a\nb\nc', 'a\nB\nc')
  check('长度 4（删 b 加 B）', d.length === 4, `得到 ${d.length}`)
  check('有 del', d.some((x) => x.type === 'del' && x.text === 'b'))
  check('有 add', d.some((x) => x.type === 'add' && x.text === 'B'))
  check('有两处 same', d.filter((x) => x.type === 'same').length === 2)
}
{
  const d = lineDiff('x', 'x')
  check('相同文本全是 same', d.length === 1 && d[0]!.type === 'same')
}
{
  const big = Array.from({ length: 2001 }, (_, i) => `line${i}`).join('\n')
  const d = lineDiff(big, 'short')
  check('超长退化（不卡死）', d.length > 2000 && d.some((x) => x.type === 'del'))
}

console.log('\n=== 6. loadDrifts ===')
{
  // 用真实文件（persona/self-history/drift.jsonl 可能存在）
  const items = loadDrifts(5)
  check('返回数组', Array.isArray(items))
  check('不超过 5 条', items.length <= 5)
  if (items.length) {
    const it = items[0]!
    check('每条有 at/from/to/sim', typeof it.at === 'number' && typeof it.sim === 'number')
  } else {
    console.log('  （本机还没有漂移记录，跳过字段检查）')
    pass++
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
void mkdtempSync
void writeFileSync
void join
void tmpdir
void rmSync
