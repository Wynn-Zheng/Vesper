/**
 * 人物档案与事实的来源测试（A+B 节点的产物）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensurePerson, loadPerson, savePerson, setPeopleRoot } from '../src/people/store.ts'
import { appendFacts, loadFacts, type PersonFact } from '../src/memory/facts.ts'

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

const dir = mkdtempSync(join(tmpdir(), 'people-x-'))
setPeopleRoot(dir)

console.log('=== 1. PersonMeta 能存 role / nameLocked ===')
{
  ensurePerson('qq', '123456', '测试人')
  const id = 'qq-123456'
  const meta = loadPerson(id)!
  check('建出来了', Boolean(meta))

  savePerson({ ...meta, role: '朋友', nameLocked: true })
  const after = loadPerson(id)!
  check('role 存住了', after.role === '朋友', String(after.role))
  check('nameLocked 存住了', after.nameLocked === true)

  savePerson({ ...after, role: '主人' })
  check('role 能改', loadPerson(id)!.role === '主人')
  check('nameLocked 不受影响', loadPerson(id)!.nameLocked === true)
}

console.log('\n=== 2. facts 的 by 字段往返 ===')
{
  const id = 'qq-123456'
  const facts: PersonFact[] = [
    { text: '他喜欢熬夜', date: '2026-10-28', confidence: 0.9, visibility: 'private', by: 'it' },
    { text: '他叫小王', date: '2026-10-28', confidence: 1, visibility: 'public', by: 'me' },
  ]
  appendFacts(id, facts)

  const back = loadFacts(id)
  check('读回两条', back.length === 2, `得到 ${back.length}`)

  const me = back.find((f) => f.text.includes('小王'))
  const it = back.find((f) => f.text.includes('熬夜'))
  check('by=me 的那条读回来是 me', me?.by === 'me', String(me?.by))
  check('by=it 的那条读回来是 it 或空', !it?.by || it.by === 'it', String(it?.by))

  // 文件里应该有人能读的标记
  const raw = readFileSync(join(dir, id, 'facts.md'), 'utf8')
  check('文件里写了「你确认」', raw.includes('你确认'), raw.slice(0, 200))
}

console.log('\n=== 3. 老格式（没有 by）照样能读 ===')
{
  const id = 'qq-654321'
  ensurePerson('qq', '654321', '老头')
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(
    join(dir, id, 'facts.md'),
    '# 关于这个人的事实\n\n## 重要\n\n- 他在学英语（2026-10-20，置信 0.9，私密）\n',
    'utf8',
  )
  const back = loadFacts(id)
  check('老格式能解析', back.length === 1, `得到 ${back.length}`)
  check('by 为空或 it', !back[0]?.by || back[0].by === 'it', String(back[0]?.by))
}

rmSync(dir, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
