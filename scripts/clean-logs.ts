/**
 * 清理日志里的测试噪音（测试跑的时候会写 warn）。
 * 用法：node scripts/clean-logs.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const NOISE = ['模型挂了', '测试者', 'mock-', '私聊白名单']

for (const day of process.argv.slice(2).length ? process.argv.slice(2) : ['2026-10-25']) {
  const f = `data/logs/${day}.jsonl`
  let text: string
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    console.log(`跳过 ${f}（不存在）`)
    continue
  }
  const lines = text.split('\n').filter(Boolean)
  const keep = lines.filter((l) => !NOISE.some((n) => l.includes(n)))
  writeFileSync(f, `${keep.join('\n')}\n`, 'utf8')
  console.log(`${day}: ${lines.length} → ${keep.length} 条`)
}
