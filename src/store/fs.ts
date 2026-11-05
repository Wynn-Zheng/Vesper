import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { warnAt } from '../core/log.ts'

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true })
}

/**
 * 同步小睡。
 *
 * writeAtomic 是同步函数（renameSync），没法 await；以前用 `while (Date.now() < until) {}`
 * 空转 30ms —— 那是在真烧 CPU，而且是在"写盘被占用"这种本来就紧张的时刻。
 * Atomics.wait 是真正的阻塞睡眠，线程让出去，不占核。
 */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/** 原子写：先写 .tmp 再 rename。半截 JSON 比没有文件更糟。 */
export function writeAtomic(file: string, content: string): void {
  ensureDir(dirname(file))
  // 临时文件名必须唯一：两个并发写同一文件时，固定叫 .tmp 会互相覆盖，
  // 后一个 rename 时前一个的临时文件已经不在了，直接 ENOENT。
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    // Windows 上目标被占用（杀毒/编辑器/索引器）时 rename 会 EPERM。
    // 重试几次；还不行就直接覆盖写，别让一次短暂占用把整次写盘搞崩。
    let renamed = false
    for (let i = 0; i < 3 && !renamed; i++) {
      try {
        renameSync(tmp, file)
        renamed = true
      } catch {
        sleepSync(30)
      }
    }
    if (!renamed) {
      // 三次 rename 都失败（目标被长期占用）：退回非原子直写，至少别丢这次修改。
      // 此时如果进程在写到一半被杀，文件会是半截 —— 用 warn 留个记录。
      warnAt('原子写失败，已退回非原子写入', { file })
      writeFileSync(file, content, 'utf8')
    }
  } catch (err) {
    // 写一半失败、或者 rename 失败（目标被占用 / 是目录），
    // 都要把临时文件收掉，别在数据目录里越积越多。
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw err
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/** 文件末尾是不是换行；文件不存在或为空也算"可以直接追加" */
function endsWithNewline(file: string): boolean {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    // 刚好被删掉：后面 append 会重新建
    return true
  }
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

export function appendJsonl(file: string, row: unknown): void {
  ensureDir(dirname(file))
  // 上一次要是崩在写一半，文件末尾会是没有换行的半行。
  // 直接往后接会把新行粘在坏行上，两条一起废掉——先补一个换行隔开。
  const needsBreak = !endsWithNewline(file)
  appendFileSync(file, `${needsBreak ? '\n' : ''}${JSON.stringify(row)}\n`, 'utf8')
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
