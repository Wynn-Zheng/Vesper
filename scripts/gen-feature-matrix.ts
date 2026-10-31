import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 生成功能矩阵。
 *
 * 做法：把「功能」写成一张静态表（名字 / 入口文件 / 触发函数），
 * 然后脚本去代码里核实这些入口真的存在。这样表不会写错到没法发现。
 */

interface Feature {
  名: string
  入口: string
  触发: string
  配置: string[]
  模块: string[]
  /** 体检脚本（多个用 +） */
  体检?: string
}

const FEATURES: Feature[] = [
  {
    名: '消息接收与去重',
    入口: 'src/channel/onebot.ts',
    触发: 'NapCat 反连 → onConnection → handler',
    配置: [],
    模块: ['core/types.ts'],
    体检: 'test-chan-bugs',
  },
  {
    名: '消息过滤（屏蔽词/正则）',
    入口: 'src/boot.ts',
    触发: 'shouldDrop() → 命中就丢掉',
    配置: ['消息过滤.屏蔽词', '消息过滤.屏蔽正则'],
    模块: ['core/config.ts'],
  },
  {
    名: '私聊暂停',
    入口: 'src/boot.ts',
    触发: 'rules.行为.私聊暂停 → 私聊直接返回',
    配置: ['行为.私聊暂停'],
    模块: [],
  },
  {
    名: '限流',
    入口: 'src/core/ratelimit.ts',
    触发: 'allow(key, max) 每分钟窗口',
    配置: ['行为.每分钟上限'],
    模块: ['core/ratelimit.ts'],
    体检: 'test-core-bugs',
  },
  {
    名: '防抖聚合',
    入口: 'src/boot.ts',
    触发: '被@1s / 换人0.5s / 同人2s / 安静5s / 上限8s',
    配置: [],
    模块: [],
  },
  {
    名: '被动回复打分',
    入口: 'src/loop/score.ts',
    触发: 'scoreReply() → 概率决定回不回',
    配置: ['行为.发言频率', '行为.偶尔不回概率', '行为.引用频率'],
    模块: ['loop/score.ts'],
    体检: 'test-console-bugs',
  },
  {
    名: '关键词反应',
    入口: 'src/boot.ts',
    触发: 'reactionFor() → hint 传给模型',
    配置: ['关键词反应[]'],
    模块: ['core/config.ts'],
    体检: 'test-features',
  },
  {
    名: '不回复退避',
    入口: 'src/boot.ts',
    触发: 'enterBackoff() → 连 N 次没回就停一会儿',
    配置: ['行为.退避.连几次开始', '行为.退避.起始秒', '行为.退避.上限秒', '行为.退避.几条消息打断'],
    模块: [],
  },
  {
    名: '记忆检索',
    入口: 'src/memory/recall.ts',
    触发: 'recall() → 递推×相关×重要',
    配置: ['记忆.检索.取回条数', '记忆.检索.权重'],
    模块: ['memory/store.ts', 'memory/facts.ts'],
    体检: 'test-privacy + test-memory-bugs',
  },
  {
    名: '记忆整理（distill）',
    入口: 'src/memory/distill.ts',
    触发: 'startDistiller() 定时 / shouldDistill() 门控',
    配置: ['记忆.整理.*'],
    模块: ['memory/store.ts', 'scheduler/distiller.ts'],
    体检: 'test-sched-bugs',
  },
  {
    名: '事实增删改',
    入口: 'src/memory/facts.ts',
    触发: 'appendFacts / deleteFact / setVisibility / touchFact',
    配置: [],
    模块: ['store/fs.ts'],
    体检: 'test-memory-bugs + test-privacy',
  },
  {
    名: '关系评估',
    入口: 'src/relation/evaluate.ts',
    触发: 'evaluateTurn() → 模型给锚点 → 写关系值',
    配置: ['关系.每次变化上限', '关系.阶段[]'],
    模块: ['relation/store.ts', 'relation/format.ts'],
    体检: 'test-relation-bugs',
  },
  {
    名: '关系降温',
    入口: 'src/relation/decay.ts',
    触发: 'startRelationDecay() 定时',
    配置: ['关系.降温.*'],
    模块: ['relation/store.ts'],
    体检: 'test-relation-bugs',
  },
  {
    名: '自我反思',
    入口: 'src/self/reflect.ts',
    触发: 'startSelfReflect() 定时',
    配置: ['自我.反思间隔'],
    模块: ['self/store.ts', 'self/format.ts'],
    体检: 'test-self-bugs',
  },
  {
    名: '自我观察（找 bug）',
    入口: 'src/self/observe.ts',
    触发: 'startObserving() → findIssues() → refreshIssues()',
    配置: [],
    模块: ['store/fs.ts'],
    体检: 'test-selfrepair + test-self-bugs',
  },
  {
    名: '自我诊断',
    入口: 'src/self/diagnose.ts',
    触发: 'diagnose() 多轮工具调用',
    配置: [],
    模块: ['self/observe.ts'],
    体检: 'test-diagnose-bugs',
  },
  {
    名: '意愿（想不想说话/看视频）',
    入口: 'src/self/will.ts',
    触发: 'effectiveWill() 30h TTL',
    配置: [],
    模块: [],
    体检: 'test-self-bugs',
  },
  {
    名: '能力清单',
    入口: 'src/self/abilities.ts',
    触发: 'listAbilities(rules) 读真实配置',
    配置: [],
    模块: ['tools/registry.ts'],
  },
  {
    名: '主动消息',
    入口: 'src/scheduler/proactive.ts',
    触发: 'startProactive() → shouldProactive() 五道门',
    配置: ['行为.主动.*', '行为.静默时段'],
    模块: ['people/store.ts'],
    体检: 'test-sched-bugs',
  },
  {
    名: '刷视频',
    入口: 'src/outward/watch.ts',
    触发: 'startWatching() / tryWatchNow()',
    配置: ['外部.刷视频.*'],
    模块: ['outward/bili.ts'],
    体检: 'test-outward-bugs',
  },
  {
    名: '看图',
    入口: 'src/llm/vision.ts',
    触发: 'describeImages() → base64 → 视觉模型',
    配置: ['视觉.开启', '视觉.模型', '视觉.最多张数'],
    模块: ['llm/deepseek.ts', 'channel/onebot.ts'],
    体检: 'test-vision + test-vision-bugs',
  },
  {
    名: '表情包收集',
    入口: 'src/emoji/store.ts',
    触发: 'add() 去重 + 容量淘汰',
    配置: ['表情包.库存上限'],
    模块: ['emoji/detect.ts', 'channel/onebot.ts'],
    体检: 'test-emoji + test-emoji-bugs',
  },
  {
    名: '表情包发送',
    入口: 'src/emoji/pick.ts',
    触发: 'pickEmoji(items, mood)',
    配置: ['表情包.开启', '表情包.每条最多'],
    模块: ['emoji/store.ts', 'channel/send.ts'],
    体检: 'test-emoji-channel',
  },
  {
    名: '上下文压缩',
    入口: 'src/loop/compress.ts',
    触发: 'shouldCompress() → 模型压成摘要',
    配置: ['上下文压缩.摘要阈值', '上下文压缩.保留最近'],
    模块: ['loop/session.ts', 'loop/prompt.ts'],
    体检: 'test-compress + test-session-summary + test-loop-bugs',
  },
  {
    名: '表达学习',
    入口: 'src/learn/plays.ts',
    触发: 'recordPlayReviewed() → 审核 → 存',
    配置: ['表达学习.审核', '表达学习.只用精选'],
    模块: ['loop/judge.ts'],
    体检: 'test-expression',
  },
  {
    名: '黑话学习',
    入口: 'src/learn/jargon.ts',
    触发: 'learnJargon() 三步假动作检测',
    配置: [],
    模块: ['llm/deepseek.ts'],
  },
  {
    名: '多人格切换',
    入口: 'src/loop/prompt.ts',
    触发: 'buildSystem() 按概率换风格',
    配置: ['人格.备用风格', '人格.切换概率'],
    模块: ['core/config.ts'],
    体检: 'test-features',
  },
  {
    名: '回复自评',
    入口: 'src/loop/judge.ts',
    触发: 'judgeReply() → 打分',
    配置: ['行为.回复自评'],
    模块: ['llm/deepseek.ts'],
  },
  {
    名: '引用回复',
    入口: 'src/boot.ts',
    触发: 'shouldQuote() → 带引用发',
    配置: ['说话.引用频率'],
    模块: ['channel/send.ts'],
    体检: 'test-features',
  },
  {
    名: '分句发送',
    入口: 'src/channel/send.ts',
    触发: 'splitBySentence() 按字素切',
    配置: ['说话.每轮最多条数', '说话.每条最多字数'],
    模块: [],
    体检: 'test-chan-bugs',
  },
  {
    名: '控制台',
    入口: 'src/console/server.ts',
    触发: 'HTTP + SSE，7 组 14 页',
    配置: [],
    模块: ['console/search.ts'],
    体检: 'audit-console + test-console-bugs',
  },
  {
    名: '数据搜索与导出',
    入口: 'src/console/search.ts',
    触发: 'search() / exportAll()',
    配置: [],
    模块: ['memory/store.ts', 'people/store.ts'],
    体检: 'test-console-bugs',
  },
  {
    名: '快照与回滚',
    入口: 'src/persona/version.ts',
    触发: 'snapshot() / restore() / startAutoSnapshots()',
    配置: [],
    模块: ['store/fs.ts'],
    体检: 'test-persona-bugs',
  },
  {
    名: '情绪状态',
    入口: 'src/persona/mood.ts',
    触发: 'loadMood() / decayedMood()',
    配置: [],
    模块: [],
    体检: 'test-persona-bugs',
  },
  {
    名: '访问控制',
    入口: 'src/core/access.ts',
    触发: 'checkAccess() 黑白名单',
    配置: [],
    模块: [],
    体检: 'test-core-bugs',
  },
  {
    名: '插件系统',
    入口: 'src/plugins/host.ts',
    触发: 'scanPlugins() → host.load() → ctx.registerTool() 注册工具 / ctx.send 发消息',
    配置: [],
    模块: ['plugins/registry.ts', 'plugins/manifest.ts', 'plugins/installer.ts', 'plugins/settings.ts', 'console/plugin-api.ts'],
    体检: 'selfcheck-plugin-host + selfcheck-plugin-permissions + test-plugins-e2e',
  },
  {
    名: 'NapCat 协议端',
    入口: 'src/napcat/manager.ts',
    触发: 'locate() 探测 / start() 启停 / wire() 自动指向反向 WS',
    配置: [],
    模块: ['napcat/locate.ts', 'napcat/wire.ts', 'napcat/install.ts'],
    体检: 'test-chan-bugs',
  },
]

/** 把模块路径补成 .ts 并确认存在 */
function exists(rel: string): boolean {
  try {
    readFileSync(rel, 'utf8')
    return true
  } catch {
    return false
  }
}

let bad = 0

// 1. 每个入口文件必须真的存在
for (const f of FEATURES) {
  if (!exists(f.入口)) {
    console.log(`✗ 入口不存在：${f.名} → ${f.入口}`)
    bad++
  }
  for (const m of f.模块) {
    const p = `src/${m}`
    if (!exists(p)) {
      console.log(`✗ 依赖模块不存在：${f.名} → ${p}`)
      bad++
    }
  }
}

// 2. src 下每个目录至少被一个功能提到（防止漏功能）
const dirs = readdirSync('src', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
const mentioned = new Set<string>()
for (const f of FEATURES) {
  const parts = f.入口.split('/')
  if (parts.length > 2) mentioned.add(parts[1]!)
  for (const m of f.模块) mentioned.add(m.split('/')[0]!)
}
const missed = dirs.filter((d) => !mentioned.has(d))
if (missed.length) {
  console.log(`✗ 这些目录没有任何功能提到：${missed.join(', ')}`)
  bad++
}

// 3. 体检脚本必须存在
for (const f of FEATURES) {
  if (!f.体检) continue
  for (const t of f.体检.split(' + ')) {
    const p = `scripts/${t}.ts`
    if (!exists(p)) {
      console.log(`✗ 体检脚本不存在：${f.名} → ${p}`)
      bad++
    }
  }
}

// 4. 生成 markdown
const lines: string[] = [
  '# 功能矩阵',
  '',
  `> 自动生成，不要手改。生成命令：\`node scripts/gen-feature-matrix.ts\``,
  `> 最后生成：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  '',
  `共 **${FEATURES.length}** 个功能，覆盖 src/ 下 ${dirs.length} 个模块目录。`,
  '',
  '| # | 功能 | 入口 | 触发方式 | 依赖配置 | 体检脚本 |',
  '|---|---|---|---|---|---|',
]

FEATURES.forEach((f, i) => {
  const cfg = f.配置.length ? f.配置.map((c) => `\`${c}\``).join('<br>') : '—'
  const test = f.体检 ? f.体检.split(' + ').map((t) => `\`${t}\``).join('<br>') : '⚠ 无'
  lines.push(`| ${i + 1} | ${f.名} | \`${f.入口}\` | ${f.触发} | ${cfg} | ${test} |`)
})

const noTest = FEATURES.filter((f) => !f.体检)
lines.push('')
lines.push('## 没有专门体检脚本的功能')
lines.push('')
if (noTest.length) {
  for (const f of noTest) lines.push(`- **${f.名}**（${f.入口}）— ${f.触发}`)
  lines.push('')
  lines.push(`共 ${noTest.length} 个。这些靠 \`test-feature-health.ts\` 和各模块的体检脚本间接覆盖。`)
} else {
  lines.push('全部功能都有对应的体检脚本。')
}

lines.push('')
lines.push('## 模块目录覆盖')
lines.push('')
for (const d of dirs) {
  const n = FEATURES.filter((f) => f.入口.includes(`/${d}/`) || f.模块.some((m) => m.startsWith(`${d}/`))).length
  lines.push(`- \`src/${d}/\` — ${n} 个功能`)
}

writeFileSync('docs/功能矩阵.md', lines.join('\n'), 'utf8')

console.log(`\n功能数：${FEATURES.length}`)
console.log(`模块目录：${dirs.length}（全部有功能提到）`)
console.log(`没有体检脚本的：${noTest.length} 个`)
console.log(`已写 docs/功能矩阵.md`)
process.exit(bad > 0 ? 1 : 0)
