/**
 * 检查 rules.yaml 里的每一项配置，代码里到底有没有用到。
 * 有配置但没人读 = 你改了没用，这种最坑。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS } from '../src/core/config.ts'

const SRC = 'src'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const sources = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }))

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

const items = leaves(DEFAULTS)
console.log(`配置项总数：${items.length}\n`)

const unused: Array<{ path: string }> = []

for (const { path, key } of items) {
  // 在代码里找这个键名（去掉 config.ts 自己的定义）
  const hits = sources.filter((s) => s.f !== join(SRC, 'core', 'config.ts') && s.text.includes(key))
  if (!hits.length) {
    unused.push({ path })
  }
}

if (!unused.length) {
  console.log('所有配置项都在代码里被引用了')
} else {
  console.log(`没被引用的配置（改了不会生效）：${unused.length} 项`)
  for (const u of unused) console.log(`  ${u.path}`)
}
