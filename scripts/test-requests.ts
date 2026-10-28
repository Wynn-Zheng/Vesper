/**
 * 申请 → 批准 → 落到字段 → 写进经历。
 *
 * 这条链路最容易出错的地方是"批准了但没生效"或者"生效了但没留下痕迹"，
 * 所以每个 case 都断言最终的文件内容。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRequests, markRejected, requestChange, takeRequest, REJECT_COOLDOWN_MS } from '../src/self/requests.ts'
import { applyRequest } from '../src/self/apply.ts'
import { loadSelf, saveSelf, setSelfFiles } from '../src/self/store.ts'
import { setMemoryRoot } from '../src/memory/store.ts'

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

const dir = mkdtempSync(join(tmpdir(), 'req-'))
const origin = process.cwd()
process.chdir(dir)
setSelfFiles('persona/self.md', 'persona/life.md')
setMemoryRoot('persona/memory')

const seed = {
  name: '',
  nameReason: '',
  about: '原来的自述',
  aboutExtra: '',
  aboutOwner: 'it' as const,
  thinking: '',
  traits: {},
  abilities: '',
}
saveSelf(seed)

console.log('=== 1. 提申请 ===')
{
  const r = requestChange('name', '阿鱼', '小鲸鱼是随手取的')
  check('提成功', r.ok, r.why)
  check('队列里有 1 条', loadRequests().length === 1)
}
{
  const r = requestChange('name', '阿鱼', '再说一次')
  check('重复的不收', !r.ok, r.why)
}
{
  const r = requestChange('name', '小鱼', '')
  check('没理由的不收', !r.ok, r.why)
}

console.log('\n=== 2. 上限 ===')
{
  requestChange('name', '甲乙丙', '理由甲')
  requestChange('name', '乙丙丁', '理由乙')
  const r = requestChange('name', '丙丁戊', '理由丙')
  check('同一项最多 3 条', !r.ok && r.why.includes('待批'), r.why)
}

console.log('\n=== 3. 批准 → 落到字段 ===')
{
  const before = loadRequests().length
  const one = loadRequests().find((r) => r.target === 'name')!
  const taken = takeRequest(one.id)
  check('取出来并从队列移除', taken !== null && loadRequests().length === before - 1, `before=${before} after=${loadRequests().length}`)

  const r = applyRequest(taken!, false)
  check('应用成功', r.ok, r.detail)
  check('名字真的改了', loadSelf().name === '阿鱼', loadSelf().name)
  check('名字理由是申请里那句', loadSelf().nameReason.includes('随手取'), loadSelf().nameReason)
}

console.log('\n=== 4. 「我写」模式下自述只能进补充区 ===')
{
  saveSelf({ ...loadSelf(), about: '主人写的原文', aboutOwner: 'me', aboutExtra: '' })
  requestChange('about', '它想说的新内容', '最近想明白了一些事')
  const one = loadRequests().find((r) => r.target === 'about')!
  const r = applyRequest(takeRequest(one.id)!, false)

  check('应用成功', r.ok, r.detail)
  const d = loadSelf()
  check('原文没动', d.about === '主人写的原文', d.about)
  check('进了补充区', d.aboutExtra === '它想说的新内容', d.aboutExtra)
  check('所有权还是 me', d.aboutOwner === 'me')
}

console.log('\n=== 5. 批准并交权 ===')
{
  requestChange('about', '彻底改写后的自述', '想自己管这段')
  const one = loadRequests().find((r) => r.target === 'about')!
  const r = applyRequest(takeRequest(one.id)!, true)

  check('应用成功', r.ok, r.detail)
  const d = loadSelf()
  check('所有权变成 it', d.aboutOwner === 'it')
  check('两段合并了', d.about.includes('主人写的原文') && d.about.includes('彻底改写'), d.about)
  check('补充区清空', d.aboutExtra === '')
}

console.log('\n=== 6. ignores 后的冷却 ===')
{
  markRejected('traits')
  const r = requestChange('traits', '说话倾向：更短', '想改改')
  check('刚忽略过的字段提不了', !r.ok, r.why)
  check('理由提到过一天', r.why.includes('一天') || r.why.includes('过一天'), r.why)
}

console.log('\n=== 7. traits 申请能解析「键：值」===')
{
  // 绕过冷却直接塞一条
  const reqs = loadRequests()
  reqs.push({ id: 'test-1', target: 'traits', content: '说话倾向：更短一点', reason: '想试试', at: Date.now() })
  const r = applyRequest(reqs[reqs.length - 1]!, false)
  check('应用成功', r.ok, r.detail)
  check('traits 里有了', loadSelf().traits['说话倾向'] === '更短一点', JSON.stringify(loadSelf().traits))
}

console.log('\n=== 8. 不支持的类型如实说 ===')
{
  const r = applyRequest({ id: 'x', target: 'plays', content: 'x', reason: 'y', at: Date.now() }, false)
  check('plays 不支持申请', !r.ok && r.detail.includes('不支持'), r.detail)
}

// 先切回原目录再删 —— 进程还待在 dir 里的话 Windows 会 EPERM
process.chdir(origin)
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉不影响结论 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
void REJECT_COOLDOWN_MS
void readFileSync
