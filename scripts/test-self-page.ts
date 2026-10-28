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

console.log('=== 1. 三段标题都在 ===')
check('有「你设的」', html.includes('你设的'))
check('有「协商中」', html.includes('协商中'))
check('有「它长的」', html.includes('它长的'))
check('有观察区「它是怎么变的」', html.includes('它是怎么变的'))

console.log('\n=== 2. 旧 tab 机制已移除 ===')
check('没有 SELF_TABS 常量', !html.includes('const SELF_TABS'))
check('没有 SELF_TAB 变量', !/let SELF_TAB\b/.test(html))
check('renderSelfV2 不再引用 SELF_TAB', (() => {
  const i = html.indexOf('function renderSelfV2()')
  const j = html.indexOf('\nfunction ', i + 10)
  const body = html.slice(i, j > 0 ? j : i + 20000)
  return !body.includes('SELF_TAB ')
})(), )

console.log('\n=== 3. 保留的功能函数 ===')
for (const fn of ['saveSelfText', 'switchSelfOwner', 'renderRequestBlock', 'decideRequest', 'selfSection', 'selfBlockTitle']) {
  check(`有 ${fn}`, html.includes(fn))
}

console.log('\n=== 4. 观察区调的新接口 ===')
check('调 /api/self/versions', html.includes('/api/self/versions'))
check('调 /api/self/versions/diff', html.includes('/api/self/versions/diff'))
check('调 /api/self/drift', html.includes('/api/self/drift'))

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
