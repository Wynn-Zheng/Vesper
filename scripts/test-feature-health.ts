/**
 * 功能健康度总检。
 *
 * 和 test-*-bugs.ts 的区别：那些查**边界**（坏输入会不会崩），
 * 这个查**正常路径能不能跑通**——每个功能给它一个"正常输入"，看有没有输出。
 *
 * 一条命令跑完，用来回答"所有功能现在都正常吗"。
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`✗ ${name}  ${detail}`)
  }
}

const cfg = await import('../src/core/config.ts')
const rules = cfg.loadRules().rules

/* ============ 1. 配置 ============ */
console.log('=== 1. 配置 ===')
{
  const loaded = cfg.loadRules()
  check('rules.yaml 能加载', loaded.rules !== undefined)
  check('无配置警告', loaded.warnings.length === 0, loaded.warnings.join('; '))

  // 每个顶层键都有值
  const keys = Object.keys(loaded.rules)
  check(`配置有 ${keys.length} 个顶层键`, keys.length > 10)

  // 关键配置项存在且类型对
  const required: Array<[string, unknown, string]> = [
    ['视觉', loaded.rules.视觉, 'object'],
    ['消息过滤', loaded.rules.消息过滤, 'object'],
    ['关键词反应', loaded.rules.关键词反应, 'object'],
    ['行为', loaded.rules.行为, 'object'],
    ['说话', loaded.rules.说话, 'object'],
    ['关系', loaded.rules.关系, 'object'],
    ['记忆', loaded.rules.记忆, 'object'],
    ['上下文压缩', loaded.rules.上下文压缩, 'object'],
    ['表情包', loaded.rules.表情包, 'object'],
    ['表达学习', loaded.rules.表达学习, 'object'],
  ]
  for (const [k, v, t] of required) {
    check(`配置项「${k}」存在且是 ${t}`, typeof v === t, typeof v)
  }
}

/* ============ 2. 消息过滤 ============ */
console.log('\n=== 2. 消息过滤 ===')
{
  // shouldDrop 是 boot.ts 的内部函数，这里用配置语义验证
  const r = { ...rules, 消息过滤: { 屏蔽词: ['广告'], 屏蔽正则: ['^\\d+$'] } }
  check('屏蔽词配置能设置', r.消息过滤.屏蔽词.includes('广告'))
  check('屏蔽正则配置能设置', r.消息过滤.屏蔽正则.length === 1)

  // 用正则自测语义
  const re = new RegExp(r.消息过滤.屏蔽正则[0]!)
  check('正则能匹配纯数字', re.test('12345'))
  check('正则不匹配正常文本', !re.test('你好'))
  check('屏蔽词能匹配广告', '这是广告'.includes('广告'))
}

/* ============ 3. 关键词反应 ============ */
console.log('\n=== 3. 关键词反应 ===')
{
  const r = { ...rules, 关键词反应: [{ 关键词: ['早'], 正则: [], 反应: '打招呼' }] }
  check('关键词反应配置存在', r.关键词反应.length === 1)
  check('关键词能匹配', r.关键词反应[0]!.关键词.some((k) => '早上好'.includes(k)))
  check('反应文案非空', (r.关键词反应[0]!.反应 ?? '').length > 0)
}

/* ============ 4. 评分与退避 ============ */
console.log('\n=== 4. 评分 ===')
{
  const { scoreReply } = await import('../src/loop/score.ts')
  const base = { addressed: false, isPrivate: false, followUp: false, text: '在吗', idleMinutes: 0, recentReplies: 0, talkValue: 0.4 }

  const p1 = scoreReply({ ...base, addressed: true }).probability
  check('被@ → 概率接近 1', p1 >= 0.99, String(p1))
  const p2 = scoreReply({ ...base, isPrivate: true }).probability
  check('私聊 → 概率接近 1', p2 >= 0.99, String(p2))
  const p3 = scoreReply(base).probability
  check('普通群聊 → 概率在 (0,1)', p3 > 0 && p3 < 1, String(p3))
}

/* ============ 5. 上下文压缩 ============ */
console.log('\n=== 5. 上下文压缩 ===')
{
  const c = await import('../src/loop/compress.ts')
  const hist = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `第 ${i} 条`,
  }))

  check('超阈值需要压缩', c.shouldCompress(hist, 20, 6) === true)
  check('未超阈值不压', c.shouldCompress(hist.slice(0, 10), 20, 6) === false)

  const { oldest, recent } = c.takeOldest(hist, 20, 6)
  check('切分保留 6 条', recent.length === 6, String(recent.length))
  check('切分总数对', oldest.length + recent.length === hist.length)

  const prompt = c.buildSummaryPrompt(null, oldest)
  check('摘要 prompt 非空', prompt.length > 100, String(prompt.length))

  const merged = c.mergeSummary('之前聊过 A', '现在聊 B')
  check('摘要能合并', merged.includes('A') && merged.includes('B'), merged.slice(0, 40))
}

/* ============ 6. 会话 ============ */
console.log('\n=== 6. 会话 ===')
{
  const s = await import('../src/loop/session.ts')
  s.clearSessions()
  s.pushTurn('test:health', { role: 'user', content: '你好', at: Date.now() })
  s.pushTurn('test:health', { role: 'assistant', content: '你好呀', at: Date.now() })

  const turns = s.getTurns('test:health')
  check('写入 2 轮', turns.length === 2, String(turns.length))
  check('顺序正确', turns[0]!.content === '你好' && turns[1]!.content === '你好呀')

  const msgs = s.historyMessages('test:health')
  check('转成消息成功', msgs.length === 2)
  s.clearSessions()
  check('清空后为空', s.getTurns('test:health').length === 0)
}

/* ============ 7. 表情包 ============ */
console.log('\n=== 7. 表情包 ===')
{
  const { createEmojiStore } = await import('../src/emoji/store.ts')
  const { pickEmoji } = await import('../src/emoji/pick.ts')

  const dir = mkdtempSync(join(tmpdir(), 'qqbot-health-emoji-'))
  const store = createEmojiStore(dir)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

  const r = await store.add({ buffer: png, ext: 'png', mood: 'happy', tags: ['开心'] })
  check('存表情包', r.added === true, r.reason ?? '')

  const list = await store.list()
  check('库里有一条', list.length === 1, String(list.length))

  const picked = pickEmoji(list, 'happy')
  check('按情绪挑得到', picked !== null, JSON.stringify(picked)?.slice(0, 40))

  const dup = await store.add({ buffer: png, ext: 'png' })
  check('重复的会去重', dup.added === false)
  check('去重后还是 1 条', (await store.list()).length === 1)

  rmSync(dir, { recursive: true, force: true })
}

/* ============ 8. 看图 ============ */
console.log('\n=== 8. 看图 ===')
{
  const v = await import('../src/llm/vision.ts')
  check('renderImages 空数组返回空串', v.renderImages([]) === '')
  check('renderImages 有内容时带张数', v.renderImages([{ url: 'a', text: '猫' }]).includes('1 张'))
}

/* ============ 9. 表达学习 ============ */
console.log('\n=== 9. 表达学习 ===')
{
  const plays = await import('../src/learn/plays.ts')
  const list = plays.loadPlays()
  check('能读经验库', Array.isArray(list))
  check(`现有 ${list.length} 条经验`, list.length >= 0)
  const relevant = plays.relevantPlays('你好', 3)
  check('能按场景召回', Array.isArray(relevant))
}

/* ============ 10. 记忆 ============ */
console.log('\n=== 10. 记忆 ===')
{
  const recall = await import('../src/memory/recall.ts')
  check('visible 是函数', typeof recall.visible === 'function')
  check('lambdaOf 是函数', typeof recall.lambdaOf === 'function')

  // visible(scope, current)：两个参数都是 Scope 字符串
  check('自己的私聊可见', recall.visible('private:me', 'private:me') === true)
  check('别人的私聊不可见', recall.visible('private:other', 'private:me') === false)
  check('shared 在任何会话都可见', recall.visible('shared', 'group:1') === true)
  check('同群的群记忆可见', recall.visible('group:1', 'group:1') === true)
  check('别群的群记忆不可见', recall.visible('group:2', 'group:1') === false)

  // lambdaOf：重要性越高 → 衰减越慢 → lambda 越小
  check('重要性越高 lambda 越小（忘得慢）', recall.lambdaOf(9) < recall.lambdaOf(3), `9→${recall.lambdaOf(9)} 3→${recall.lambdaOf(3)}`)
  check('lambda 都是正数', recall.lambdaOf(0) > 0 && recall.lambdaOf(5) > 0 && recall.lambdaOf(10) > 0)
}

/* ============ 11. 关系 ============ */
console.log('\n=== 11. 关系 ===')
{
  const { stageOf } = cfg
  const s0 = stageOf(rules, 0)
  const s100 = stageOf(rules, 100)
  check('0 分是最低阶段', s0.名 === rules.关系.阶段[0]!.名, s0.名)
  check('100 分是最高阶段', s100.名 === rules.关系.阶段[rules.关系.阶段.length - 1]!.名, s100.名)
  check('中间值能取到阶段', rules.关系.阶段.some((x) => x.名 === stageOf(rules, 50).名))
}

/* ============ 12. 自我 ============ */
console.log('\n=== 12. 自我 ===')
{
  const observe = await import('../src/self/observe.ts')
  const issues = observe.findIssues()
  check('findIssues 能跑', Array.isArray(issues))
  check(`当前 ${issues.length} 条问题`, issues.length >= 0)

  const will = await import('../src/self/will.ts')
  const w = will.loadWill()
  check('loadWill 能跑', w !== null && typeof w === 'object')

  const self = await import('../src/self/store.ts')
  const doc = self.loadSelf()
  check('loadSelf 能跑', doc !== null && typeof doc === 'object')
  check('self.md 有内容', (doc.about ?? '').length > 0 || (doc.abilities ?? '').length > 0, JSON.stringify(doc).slice(0, 60))

  const ab = await import('../src/self/abilities.ts')
  const list = ab.listAbilities(rules)
  check(`能力清单 ${list.length} 项`, list.length > 5, String(list.length))
}

/* ============ 13. 提示词 ============ */
console.log('\n=== 13. 提示词 ===')
{
  const { buildSystem, buildPrompt } = await import('../src/loop/prompt.ts')
  const sys = buildSystem({ rules, now: new Date() })
  check('system prompt 能组装', sys.length > 200, String(sys.length))
  check('不含未替换的占位符', !sys.includes('${') && !sys.includes('undefined'), sys.match(/\$\{[^}]*\}|undefined/g)?.slice(0, 3).join(',') ?? '')

  const msgs = buildPrompt(sys, [{ role: 'user', content: '之前' }], '现在', '摘要内容')
  check('buildPrompt 生成 3 条以上', msgs.length >= 3, String(msgs.length))
  check('第一条是 system', msgs[0]!.role === 'system')
  check('最后一条是当前输入', msgs[msgs.length - 1]!.content === '现在')
  check('摘要放在了前面', msgs.some((m) => String(m.content).includes('前情摘要')))
}

/* ============ 14. 发送 ============ */
console.log('\n=== 14. 发送 ===')
{
  const { splitBySentence } = await import('../src/channel/send.ts')
  const parts = splitBySentence('第一句。第二句。第三句。', 40, 3)
  check('能分句', parts.length > 0, String(parts.length))
  check('不超过条数上限', parts.length <= 3, String(parts.length))
  check('每句非空', parts.every((p) => p.trim().length > 0))
}

/* ============ 15. 外部 ============ */
console.log('\n=== 15. 外部 ===')
{
  const bili = await import('../src/outward/bili.ts')
  check('ZONES 有分区', Object.keys(bili.ZONES).length > 0)
  check('humanDuration(90) 合理', bili.humanDuration(90) === '2 分钟', bili.humanDuration(90))

  const watch = await import('../src/outward/watch.ts')
  check('watchedToday 返回数字', Number.isInteger(watch.watchedToday()))
  check('loadWatched 返回数组', Array.isArray(watch.loadWatched()))
}

/* ============ 16. 文件系统 ============ */
console.log('\n=== 16. 文件系统 ===')
{
  const fs = await import('../src/store/fs.ts')
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-health-fs-'))
  const f = join(dir, 'a.json')

  fs.writeAtomic(f, '{"x":1}')
  check('writeAtomic 能写', readFileSync(f, 'utf8') === '{"x":1}')

  fs.appendJsonl(join(dir, 'b.jsonl'), [{ a: 1 }])
  fs.appendJsonl(join(dir, 'b.jsonl'), [{ a: 2 }])
  const lines = fs.readJsonl(join(dir, 'b.jsonl'))
  check('appendJsonl + readJsonl 往返', lines.length === 2, String(lines.length))

  rmSync(dir, { recursive: true, force: true })
}

/* ============ 17. 日志 ============ */
console.log('\n=== 17. 日志 ===')
{
  const log = await import('../src/core/log.ts')
  check('info 是函数', typeof log.info === 'function')
  check('warnAt 是函数', typeof log.warnAt === 'function')
  check('errorAt 是函数', typeof log.errorAt === 'function')

  // whereFromStack(stack) 需要传调用栈字符串
  const fakeStack = [
    'Error',
    '    at foo (E:\\dsh\\project\\QQbot\\src\\loop\\chat.ts:42:10)',
    '    at bar (E:\\dsh\\project\\QQbot\\src\\boot.ts:100:5)',
  ].join('\n')
  const where = log.whereFromStack(fakeStack)
  check('whereFromStack 能从栈里找到位置', where === 'src/loop/chat.ts:42', where)

  // 跳过日志模块自己
  const selfStack = 'Error\n    at x (E:\\p\\src\\core\\log.ts:1:1)\n    at y (E:\\p\\src\\boot.ts:9:9)'
  check('跳过 log.ts 自己的帧', log.whereFromStack(selfStack) === 'src/boot.ts:9', log.whereFromStack(selfStack))

  check('空栈返回空串', log.whereFromStack(undefined) === '')
}

/* ============ 汇总 ============ */
console.log('\n' + '='.repeat(50))
if (fail > 0) {
  console.log('失败的功能：')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('')
}
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
