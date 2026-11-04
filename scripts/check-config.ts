/**
 * 检查 rules.yaml 里的每一项配置，代码里到底有没有用到。
 * 有配置但没人读 = 你改了没用，这种最坑。
 *
 * 判定口径（2026-11-04 收紧）：
 * - `config.ts` 里 `DEFAULTS` 的定义不算「被使用」——否则每个键都能自己证明自己。
 * - 其余 src 代码里出现该键名才算被读。
 * - 检出未使用的键时 **以 1 退出**，让 check-all 能红。
 *   之前这里无论检出多少都 exit 0，于是「死配置」永远只是打印一行字，没人会看。
 *
 * `KNOWN_UNUSED` 是临时白名单：只放已经登记在 05-bugs.md B-05 里的 9 个键，
 * B-05 修完后必须清空（届时本文件会因白名单为空而自然收紧）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS } from '../src/core/config.ts'

const SRC = 'src'

/** B-05 登记的死键：接线或删除后清空本表 */
const KNOWN_UNUSED = new Set([
  '说话.分句',
  '记忆.摘要粒度',
  '记忆.反思.触发',
  '记忆.反思.产出条数',
  '记忆.衰减.关系锚点',
  '关系.维度',
  '关系.阶段.主动',
  '外部.刷视频.最短间隔小时',
  '外部.发空间.需要确认',
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 收集所有配置叶子键（带路径） */
function leaves(obj: unknown, path = ''): Array<{ path: string; key: string }> {
  const out: Array<{ path: string; key: string }> = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, p))
      else out.push({ path: p, key: k })
    }
  }
  return out
}

/**
 * config.ts 里「真的在读某个键」的判定。
 *
 * 不能用裸 `includes(key)`：类型定义（`分句?: string`）和 DEFAULTS（`分句: true`）
 * 都会命中，等于每个键都能自己证明自己。只认访问式写法：
 * `x.键名` / `x['键名']` / `x["键名"]`。
 */
function readByAccess(cfgText: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`[.\\[]['"]?${esc}(?![\\w\\u4e00-\\u9fa5])`).test(cfgText)
}

/**
 * config.ts 去掉 DEFAULTS 与 Rules 类型定义后的部分，只留读取逻辑。
 * 这样 `行为.频率规则` 这种「在 config.ts 内部被 getPolicy 读」的键不会被误判为死键。
 */
function configReadable(): string {
  const text = readFileSync(join(SRC, 'core', 'config.ts'), 'utf8')
  const blocks: Array<[string, string]> = [
    ['export const DEFAULTS', '\nexport '],
    ['export interface Rules', '\nexport '],
    ['export type Rules', '\nexport '],
  ]
  let out = text
  for (const [begin, next] of blocks) {
    const s = out.indexOf(begin)
    if (s < 0) continue
    const e = out.indexOf(next, s + begin.length)
    out = out.slice(0, s) + (e < 0 ? '' : out.slice(e))
  }
  return out
}

const files = walk(SRC).filter((f) => f !== join(SRC, 'core', 'config.ts'))
const sources = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }))
const cfgText = configReadable()

const items = leaves(DEFAULTS)
console.log(`配置项总数：${items.length}\n`)

const unused: Array<{ path: string }> = []

for (const { path, key } of items) {
  const hit = sources.some((s) => s.text.includes(key)) || readByAccess(cfgText, key)
  if (!hit) unused.push({ path })
}

const known = unused.filter((u) => KNOWN_UNUSED.has(u.path))
const fresh = unused.filter((u) => !KNOWN_UNUSED.has(u.path))

if (!unused.length) {
  console.log('所有配置项都在代码里被引用了')
  process.exit(0)
}

if (known.length) {
  console.log(`已知未接线（B-05 待处理，暂不阻断）：${known.length} 项`)
  for (const u of known) console.log(`  ${u.path}`)
}

if (fresh.length) {
  console.log(`\n没被引用的配置（改了不会生效）：${fresh.length} 项`)
  for (const u of fresh) console.log(`  ${u.path}`)
  console.log('\n要么在代码里读它，要么从 DEFAULTS / rules.yaml / 控制台 / 文档里删掉。')
  process.exit(1)
}

if (known.length !== unused.length) {
  console.log('\n（以上均为已登记项；未登记的死键会让本检查以 1 退出）')
}
process.exit(0)
