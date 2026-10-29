/**
 * 拟人化改动的体检。
 *
 * 这一轮做的：
 *   1. 打字中状态（set_input_status）—— 人发消息前对方能看到"正在输入"
 *   2. 生理状态（凌晨困、刚醒、快睡）—— prompt 里按小时给
 *   3. 已读不回（看了再决定不说）—— 默认关
 *   5. 口头禅 / 说话习惯（统计它自己说过的话）
 *   8. 自己的偏好（喜欢 + 不喜欢）
 *   9. 成长的痕迹（对比最早和现在的自述）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

/* ============ 1. 打字中状态 ============ */
console.log('=== 1. 打字中状态 ===')
{
  const transport = readFileSync('src/core/transport.ts', 'utf8')
  const onebot = readFileSync('src/channel/onebot.ts', 'utf8')
  const boot = readFileSync('src/boot.ts', 'utf8')

  check('Transport 有 setTyping', transport.includes('setTyping?('), '')
  check('onebot 调了 set_input_status', onebot.includes("'set_input_status'"), '')
  check('只对私聊设（群聊跳过）', onebot.includes("target.kind !== 'private'") || onebot.includes("kind !== 'private'"), '')
  check('失败静默（不会影响发消息）', /set_input_status[\s\S]{0,300}catch/.test(onebot), '')

  // 顺序：先设 true 再 sleep
  const iTyping = boot.indexOf('setTyping?.(m.from, true)')
  const iSleep = boot.indexOf('await sleep(rand(rules.说话.回复前延迟))')
  check('先亮"正在输入"再等', iTyping > 0 && iSleep > iTyping, `typing@${iTyping} sleep@${iSleep}`)
  check('finally 里收掉', /finally\s*\{[\s\S]{0,200}setTyping\?\.\(m\.from, false\)/.test(boot), '')
}

/* ============ 2. 生理状态 ============ */
console.log('\n=== 2. 生理状态 ===')
{
  const prompt = readFileSync('src/loop/prompt.ts', 'utf8')
  check('有凌晨困的提示', prompt.includes('困得厉害'), '')
  check('有刚醒的提示', prompt.includes('刚醒'), '')
  check('有快睡的提示', prompt.includes('快到睡觉的点了'), '')
  check('按小时判断', prompt.includes('getHours()'), '')

  // 实际渲染
  const p = await import('../src/loop/prompt.ts')
  const { loadRules } = await import('../src/core/config.ts')
  const rules = loadRules().rules
  for (const [h, kw] of [
    [2, '困得厉害'],
    [6, '刚醒'],
    [23, '快到睡觉'],
  ] as Array<[number, string]>) {
    const sys = p.buildSystem({ rules, now: new Date(2026, 9, 26, h, 30) })
    check(`${h} 点有「${kw}」`, sys.includes(kw), '')
  }
  // 下午不该有这些
  const afternoon = p.buildSystem({ rules, now: new Date(2026, 9, 26, 15, 30) })
  check('15 点没有困倦提示', !afternoon.includes('困得厉害') && !afternoon.includes('刚醒'), '')
}

/* ============ 3. 已读不回 ============ */
console.log('\n=== 3. 已读不回 ===')
{
  const boot = readFileSync('src/boot.ts', 'utf8')
  const config = readFileSync('src/core/config.ts', 'utf8')

  check('有已读不回概率配置', config.includes('已读不回概率'), '')
  check('默认 0（关着）', !/已读不回概率:\s*[0-9.]+/.test(config) || /已读不回概率:\s*0/.test(config), '')
  check('在 sleep 之后判断（不是一开始就不看）', boot.indexOf('已读不回概率') > boot.indexOf('回复前延迟'), '')
  check('日志区分"看了没回"', boot.includes('看了没回'), '')
  check('原来的 SKIPPABLE 跳过还在', boot.includes('SKIPPABLE.test(text)'), '')
}

/* ============ 4. 说话习惯 ============ */
console.log('\n=== 4. 说话习惯 ===')
{
  const speech = await import('../src/self/speech.ts')
  const s = speech.analyzeSpeech()

  check('能统计出来', s !== null, '')
  if (s) {
    check(`样本 ${s.samples} 条（>= 20）`, s.samples >= 20, String(s.samples))
    check('中位长度在 5~40 之间', s.medianLen >= 5 && s.medianLen <= 40, String(s.medianLen))
    check('问句比例 [0,1]', s.questionRatio >= 0 && s.questionRatio <= 1, String(s.questionRatio))

    const r = speech.renderSpeechHabit()
    check('渲染出了内容', r.length > 0, '')
    check('提到长度', r.includes('个字'), '')
    // 问句比例现在 24% > 20%，应该提醒
    if (s.questionRatio > 0.2) {
      check('问句偏多时有提醒', r.includes('问句'), r)
    }
  }

  // 过滤器：实词片段不算口音
  const src = readFileSync('src/self/speech.ts', 'utf8')
  check('有口头禅白名单', src.includes('OPENER_WHITELIST'), '')
  check('「能看」这种实词被排除', !(s?.topOpeners ?? []).some((o) => o.text === '能看'), JSON.stringify(s?.topOpeners))

  // 样本不足时返回 null
  check('样本门槛存在', src.includes('texts.length < 20'), '')
}

/* ============ 5. 自己的偏好 ============ */
console.log('\n=== 5. 自己的偏好 ===')
{
  const reflect = readFileSync('src/self/reflect.ts', 'utf8')
  const store = readFileSync('src/self/store.ts', 'utf8')
  const format = readFileSync('src/self/format.ts', 'utf8')

  check('prompt 里让输出「喜欢」', reflect.includes('"喜欢"'), '')
  check('要求喜欢和不喜欢都有', reflect.includes('尽量都有'), '')
  check('特征写进 frontmatter', store.includes('我·'), '')
  // 文案改过（从「你给自己定的规矩」→「你在相处中对自己形成的理解」），断言跟着改语义：\n  // 要验证的是「self.traits 会被拼进 prompt」，不是某一句话的具体说法\n  check('特征进了 prompt', format.includes('self.traits') && format.includes('理解'), '')

  // 真实的 self.md 里有没有
  if (existsSync('persona/self.md')) {
    const self = readFileSync('persona/self.md', 'utf8')
    const fm = self.split('---')[1] ?? ''
    check('self.md 有特征行', fm.includes('我·'), fm.slice(0, 100))
  }
}

/* ============ 6. 成长的痕迹 ============ */
console.log('\n=== 6. 成长的痕迹 ===')
{
  const growth = await import('../src/self/growth.ts')
  const g = growth.renderGrowth()

  check('能渲染出内容', g.length > 0, '')
  check('说了改过几次', g.includes('改过'), g.slice(0, 60))
  check('给了最早的说法', g.includes('你是这么说的'), '')
  check('告诉它别主动提', g.includes('别主动提'), '')

  // 少于 2 条 drift 时不注入
  const src = readFileSync('src/self/growth.ts', 'utf8')
  check('少于 2 条不注入', src.includes('all.length < 2'), '')
  check('首尾一样不注入', src.includes('first.from === last.to'), '')

  // 接入 prompt
  const prompt = readFileSync('src/loop/prompt.ts', 'utf8')
  check('prompt 注入了 growth', prompt.includes('parts.growth'), '')
  check('prompt 注入了 speech', prompt.includes('parts.speech'), '')
}

/* ============ 7. 都不做的那条 ============ */
console.log('\n=== 7. 明确不做的 ===')
{
  const src = readFileSync('src/memory/facts.ts', 'utf8')
  // 记错/记混：查过，对陪伴 bot 是减分项，没做
  check('没有引入"故意记错"', !src.includes('misremember'), '')
  console.log('  （记错/记混没做：对陪伴 bot 是减分项，已确认）')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
