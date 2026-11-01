/**
 * 「它能自改角色卡」的边界。
 *
 * 守两件事：
 *   1. 可改字段是白名单 —— 名字/生日/外貌/身份 永远不行（那是主人定的底子）
 *   2. 「它能自改角色卡」关着时，改动只能走申请（applyRequest）
 *
 * 全部在临时目录里跑，不碰真实的 persona/cards。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${detail ? '  ' + detail : ''}`)
  }
}

const cardMod = await import('../src/persona/card.ts')
const { applyRequest } = await import('../src/self/apply.ts')

const dir = mkdtempSync(join(tmpdir(), 'qqbot-autonomy-'))
cardMod.setCardsRoot(dir)

console.log('=== 1. 可改字段白名单 ===')
{
  const allowed = cardMod.SELF_EDITABLE_FIELDS as readonly string[]
  for (const f of ['核心特质', '优点', '缺点', '语气', '口头禅', '小动作', '喜欢', '讨厌', '反应']) {
    check(`允许改「${f}」`, allowed.includes(f))
  }
  for (const f of ['名字', '生日', '外貌', '身份']) {
    check(`不允许改「${f}」`, !allowed.includes(f))
  }
}

console.log('\n=== 2. applyCardField 的赋值与拒绝 ===')
{
  // 临时目录里种一张卡，并让 current.txt 指向它（loadCard 是靠 current 找卡的）
  cardMod.saveCard({
    id: 't',
    name: '测试卡',
    birthday: '',
    actionDesc: false,
    appearance: '',
    identity: '',
    traits: { core: '', good: '', bad: '' },
    speech: { tone: '', catchphrase: '' },
    actions: [],
    likes: [],
    dislikes: [],
    reactions: {},
  })
  writeFileSync(join(dir, 'current.txt'), 't', 'utf8')

  const card = cardMod.loadCard()
  check('能读到卡（临时目录）', Boolean(card))
  if (!card) {
    console.log(`\n通过 ${pass} / 失败 ${fail + 1}`)
    process.exit(1)
  }

  check('改核心特质', cardMod.applyCardField(card, '核心特质', '更愿意先听完再开口'))
  check('核心特质真的变了', card.traits.core === '更愿意先听完再开口', card.traits.core)

  check('改喜欢（逗号分隔）', cardMod.applyCardField(card, '喜欢', '听人讲具体的事，安静地待着'))
  check('喜欢被拆成两条', card.likes.length === 2, JSON.stringify(card.likes))

  check('改反应（场景：反应）', cardMod.applyCardField(card, '反应', '开心：笑出声'))
  check('反应写进去了', card.reactions['开心'] === '笑出声', JSON.stringify(card.reactions))

  // 白名单外：必须返回 false，而且不能改到卡上
  const before = JSON.stringify(card)
  check('拒绝改名字', !cardMod.applyCardField(card, '名字', '新名字'))
  check('拒绝改外貌', !cardMod.applyCardField(card, '外貌', '很漂亮'))
  check('拒绝后卡没被改动', JSON.stringify(card) === before)

  cardMod.saveCard(card)
}

console.log('\n=== 3. 关着时：申请批准后才生效 ===')
{
  // 非法字段：直接被拒，且不写盘
  const bad = applyRequest(
    { id: 'a1', target: 'card', content: '名字：偷偷改名', reason: '想改', at: Date.now() },
    false,
  )
  check('申请改名字被拒', !bad.ok, bad.detail)
  check('拒绝理由说清范围', bad.detail.includes('不在它能改的范围'), bad.detail)

  // 合法字段：批准后写进角色卡
  const ok = applyRequest(
    { id: 'a2', target: 'card', content: '优点：会先听人说完', reason: '想变好', at: Date.now() },
    false,
  )
  check('申请改优点成功', ok.ok, ok.detail)
  const after = cardMod.loadCard()
  check('优点真的写进卡里', after?.traits.good === '会先听人说完', after?.traits.good)
}

// 清理
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* Windows 下偶发占用，忽略 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
