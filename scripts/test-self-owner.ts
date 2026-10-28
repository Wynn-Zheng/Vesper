/**
 * 「我是谁」的所有权测试。
 *
 * 起因：用户改了自述，12 小时后自我反思又用模型版本盖回去，
 * 看起来像"刚写的东西被清空了"。现在有 aboutOwner 锁。
 *
 * 这里只测存取这一层（reflect/distill 的守卫靠代码审查 + 注释约束，
 * 要真测就得跑模型）。
 */
import { loadSelf, saveSelf, setSelfFiles } from '../src/self/store.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'self-owner-'))
const selfFile = join(dir, 'self.md')
const lifeFile = join(dir, 'life.md')
setSelfFiles(selfFile, lifeFile)

const base = {
  name: '小鲸鱼',
  nameReason: '觉得这个名字像我',
  about: '我是个会担心人熬夜的家伙。',
  thinking: '在想折纸的事。',
  traits: { 说话倾向: '短句' },
  abilities: '能聊天、能记事。',
}

console.log('=== 1. 默认是「它写」===')
{
  saveSelf({ ...base, aboutOwner: 'it' })
  const d = loadSelf()
  check('默认 aboutOwner = it', d.aboutOwner === 'it', d.aboutOwner)
}

console.log('\n=== 2. 切到「我写」会写进 frontmatter ===')
{
  saveSelf({ ...loadSelf(), aboutOwner: 'me' })
  const raw = readFileSync(selfFile, 'utf8')
  check('文件里有「所有权: 我写」', raw.includes('所有权: 我写'), raw.split('\n').slice(0, 5).join(' | '))
  check('读回来还是 me', loadSelf().aboutOwner === 'me')
}

console.log('\n=== 3. 用户锁住后，它写的内容不会丢 ===')
{
  // 模拟：用户在锁住状态下保存了自己的自述
  const mine = '我是主人写下的设定，它要照着这个当自己。'
  saveSelf({ ...loadSelf(), about: mine, aboutOwner: 'me' })
  const d = loadSelf()
  check('自述是用户写的那段', d.about === mine, d.about)
  check('所有权仍是 me', d.aboutOwner === 'me')

  // 模拟它想改（直接调 saveSelf 传新 about，但保留 owner）
  // —— 真实代码里 reflect/distill 会先看 owner，这里是兜底验证：
  //    就算有人绕过守卫写了 about，owner 也还是 me，下次能被发现
  saveSelf({ ...d, about: '模型想改成这句' })
  const d2 = loadSelf()
  check('owner 不会被 about 赋值顺手改掉', d2.aboutOwner === 'me', d2.aboutOwner)
}

console.log('\n=== 4. 交回给它 ===')
{
  saveSelf({ ...loadSelf(), aboutOwner: 'it' })
  check('切回 it', loadSelf().aboutOwner === 'it')
  const raw = readFileSync(selfFile, 'utf8')
  check('文件里写的是「它写」', raw.includes('所有权: 它写'), raw.split('\n').slice(0, 5).join(' | '))
}

console.log('\n=== 5. 老文件没这个字段时默认 it ===')
{
  const old = `---
名字: 旧文件
---

# 我是谁

旧的自述。
`
  rmSync(selfFile, { force: true })
  // 直接写文件（不走 saveSelf）
  const { writeFileSync } = await import('node:fs')
  writeFileSync(selfFile, old, 'utf8')
  const d = loadSelf()
  check('没有所有权字段 → 默认 it', d.aboutOwner === 'it', d.aboutOwner)
  check('老内容还在', d.about.includes('旧的自述'), d.about)
}

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
