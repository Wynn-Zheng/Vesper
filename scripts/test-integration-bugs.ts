/**
 * 第 9 轮：换角度。不按模块查，查三件事：
 *   1) 端到端：一条消息从进来到出去，中间每一步用的是同一套配置吗
 *   2) 配置组合：极端组合下有没有模块崩
 *   3) 真实数据：现有 persona/ 下所有数据文件互相自洽吗
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/* ================= 1. 真实数据自洽 ================= */
console.log('=== 1. persona/ 数据自洽 ===')
{
  const peopleDir = 'persona/people'
  if (existsSync(peopleDir)) {
    const people = readdirSync(peopleDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    console.log(`   （${people.length} 个人）`)

    for (const p of people) {
      const dir = join(peopleDir, p.name)
      // meta.json 必须能解析
      const metaPath = join(dir, 'meta.json')
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { id?: string; name?: string }
          check(`${p.name}/meta.json 能解析`, true)
          check(`${p.name}/meta.json 的 id 和目录名一致`, meta.id === p.name, `${meta.id} vs ${p.name}`)
        } catch (e) {
          check(`${p.name}/meta.json 能解析`, false, String(e).slice(0, 50))
        }
      }

      // relation.yaml 能被 loadRelation 读
      const relPath = join(dir, 'relation.yaml')
      if (existsSync(relPath)) {
        const rel = await import('../src/relation/store.ts')
        const r = rel.loadRelation(p.name)
        check(`${p.name}/relation.yaml 关系值在 [0,100]`, r.closeness >= 0 && r.closeness <= 100, String(r.closeness))
        check(`${p.name}/relation.yaml 锚点数组`, Array.isArray(r.anchors))
      }

      // facts.md 每行都是列表项或者是标题/空行
      const factsPath = join(dir, 'facts.md')
      if (existsSync(factsPath)) {
        const lines = readFileSync(factsPath, 'utf8').split(/\r?\n/)
        const bad = lines.filter((l) => {
          const t = l.trim()
          if (!t || t.startsWith('#') || t.startsWith('- ')) return false
          return true
        })
        check(`${p.name}/facts.md 每行格式合法`, bad.length === 0, JSON.stringify(bad.slice(0, 2)))
      }
    }
  } else {
    console.log('   （没有 persona/people，跳过）')
  }
}

/* ================= 2. 配置组合 ================= */
console.log('\n=== 2. 极端配置组合 ===')
{
  const { DEFAULTS, loadRules } = await import('../src/core/config.ts')
  const { buildSystem } = await import('../src/loop/prompt.ts')
  const { scoreReply } = await import('../src/loop/score.ts')

  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

  const combos: Array<[string, (r: typeof DEFAULTS) => void]> = [
    ['所有开关关掉', (r) => {
      r.消息过滤.屏蔽词 = []
      r.关键词反应 = []
      r.人格.备用风格 = []
      r.人格.切换概率 = 0
      r.表达学习.审核 = false
      r.外部.刷视频.开启 = false
      r.视觉.开启 = false
    }],
    ['所有开关打开', (r) => {
      r.消息过滤.屏蔽词 = ['广告']
      r.关键词反应 = [{ 关键词: ['早'], 正则: [], 反应: '打招呼' }]
      r.人格.备用风格 = ['短句']
      r.人格.切换概率 = 1
      r.表达学习.审核 = true
      r.外部.刷视频.开启 = true
      r.视觉.开启 = true
    }],
    ['数值全为 0', (r) => {
      r.说话.每轮最多条数 = 1
      r.说话.每条最多字数 = 1
      r.行为.发言频率 = 0
      r.行为.偶尔不回概率 = 1
      r.记忆.检索.取回条数 = [1, 1]
      r.上下文压缩.摘要阈值 = 2
      r.上下文压缩.保留最近 = 1
    }],
    ['数值极大', (r) => {
      r.说话.每轮最多条数 = 99
      r.说话.每条最多字数 = 9999
      r.行为.发言频率 = 1
      r.行为.每分钟上限 = 999999
      r.记忆.检索.取回条数 = [99, 99]
      r.上下文压缩.摘要阈值 = 99999
      r.上下文压缩.保留最近 = 9999
    }],
  ]

  for (const [name, mutate] of combos) {
    const r = clone(DEFAULTS)
    mutate(r)
    try {
      const sys = buildSystem({ rules: r, now: new Date() })
      check(`「${name}」prompt 能组装`, sys.length > 0, String(sys.length))
    } catch (e) {
      check(`「${name}」prompt 能组装`, false, String(e).slice(0, 60))
    }
    try {
      const s = scoreReply({ addressed: false, isPrivate: false, text: 'x', idleMinutes: 0, recentReplies: 0, talkValue: 0.5 })
      check(`「${name}」评分概率合法`, s.probability >= 0 && s.probability <= 1, String(s.probability))
    } catch (e) {
      check(`「${name}」评分概率合法`, false, String(e).slice(0, 60))
    }
  }

  // 真实配置能加载
  const loaded = loadRules()
  check('真实 rules.yaml 无警告', loaded.warnings.length === 0, loaded.warnings.join('; '))
}

/* ================= 3. 端到端：同一套配置贯穿 ================= */
console.log('\n=== 3. 端到端配置一致 ===')
{
  const { loadRules } = await import('../src/core/config.ts')
  const { buildSystem } = await import('../src/loop/prompt.ts')
  const { splitBySentence } = await import('../src/channel/send.ts')
  const { talkValueOf } = await import('../src/core/config.ts')
  const { stageOf } = await import('../src/core/config.ts')

  const rules = loadRules().rules

  // 说话条数配置 → 分句函数真的用了它
  const parts = splitBySentence('一。二。三。四。五。', rules.说话.每条最多字数, rules.说话.每轮最多条数)
  check(`分句结果不超过 ${rules.说话.每轮最多条数} 条`, parts.length <= rules.说话.每轮最多条数, `${parts.length} 条`)
  check(`每条不超过 ${rules.说话.每条最多字数} 字`, parts.every((p) => p.length <= rules.说话.每条最多字数), parts.map((p) => p.length).join(','))

  // prompt 里的条数约束和配置一致
  const sys = buildSystem({ rules, now: new Date() })
  check('prompt 里有条数约束', sys.includes(`最多说 ${rules.说话.每轮最多条数} 句`), sys.match(/最多说 \d+ 句/)?.[0] ?? '没找到')
  check('prompt 里有字数约束', sys.includes(`不超过 ${rules.说话.每条最多字数} 个字`), sys.match(/不超过 \d+ 个字/)?.[0] ?? '没找到')

  // talkValue 落在 [0,1]
  const tv = talkValueOf(rules)
  check(`talkValue ${tv} 在 [0,1]`, tv >= 0 && tv <= 1, String(tv))

  // 阶段阈值单调递增
  const stages = rules.关系.阶段
  let mono = true
  for (let i = 1; i < stages.length; i++) {
    if (stages[i]!.至 <= stages[i - 1]!.至) mono = false
  }
  check('关系阶段阈值单调递增', mono, stages.map((s) => s.至).join(','))

  // stageOf 的返回值一定在阶段列表里
  for (const v of [0, 5, 10, 11, 25, 26, 45, 46, 65, 66, 85, 86, 100]) {
    const s = stageOf(rules, v)
    check(`关系值 ${v} 落在已知阶段「${s.名}」`, stages.some((x) => x.名 === s.名))
  }
}

/* ================= 4. 文件引用完整性 ================= */
console.log('\n=== 4. 代码里引用的路径都存在 ===')
{
  // rules.yaml 引用的文件
  const rulesText = readFileSync('persona/rules.yaml', 'utf8')
  check('rules.yaml 不含明显路径错误', !rulesText.includes('..\\') && !rulesText.includes('../'))

  // check-all 里引用的每个脚本都存在
  const checkAll = readFileSync('scripts/check-all.ts', 'utf8')
  const cmds = [...checkAll.matchAll(/cmd: 'node (?:--env-file-if-exists=\S+ )?(scripts\/[\w-]+\.ts)'/g)].map((m) => m[1]!)
  const missing = cmds.filter((c) => !existsSync(c))
  check(`check-all 引用的 ${cmds.length} 个脚本都存在`, missing.length === 0, missing.join(', '))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
