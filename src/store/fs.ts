import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true })
}

/** 原子写：先写 .tmp 再 rename。半截 JSON 比没有文件更糟。 */
export function writeAtomic(file: string, content: string): void {
  ensureDir(dirname(file))
  // 临时文件名必须唯一：两个并发写同一文件时，固定叫 .tmp 会互相覆盖，
  // 后一个 rename 时前一个的临时文件已经不在了，直接 ENOENT。
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export function appendJsonl(file: string, row: unknown): void {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
}

/** 坏行跳过，不让一行脏数据废掉整份记录。 */
export function readJsonl<T = unknown>(file: string): T[] {
  if (!existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* skip */
    }
  }
  return out
}
