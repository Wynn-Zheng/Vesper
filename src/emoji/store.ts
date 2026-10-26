import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { warn } from '../core/log.ts'

/** 单张表情包上限：2MB。再大就不像表情包了，也容易被平台拒收。 */
export const MAX_EMOJI_BYTES = 2 * 1024 * 1024

export interface IndexItem {
  id: string
  /** 相对 rootDir 的文件名 */
  file: string
  mood: string
  tags: string[]
  size: number
  hash: string
  createdAt: number
  lastUsedAt: number
}

export interface EmojiIndex {
  version: 1
  items: IndexItem[]
}

export interface AddEmojiInput {
  buffer: Uint8Array
  /** 带不带点都行：png / .png / .PNG */
  ext: string
  mood?: string
  tags?: string[]
  source?: string
}

export interface AddEmojiResult {
  id: string
  added: boolean
  reason?: string
}

export interface EmojiStore {
  add(input: AddEmojiInput): Promise<AddEmojiResult>
  list(): Promise<IndexItem[]>
  remove(id: string): Promise<boolean>
  touch(id: string): Promise<boolean>
}

const DEFAULT_ROOT = join('persona', 'emoji')
const DEFAULT_CAP = 200

/**
 * 按目录串行化。只按 store 实例排队不够：chat 和通道可能各建一个指向同一
 * 目录的 store，两个实例同时 read-modify-write 会互相覆盖索引。
 * key 是绝对路径，不同目录之间不会互相阻塞。
 */
const dirLocks = new Map<string, Promise<unknown>>()

function serialByDir<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(key) ?? Promise.resolve()
  const run = prev.then(job, job)
  const tail = run.catch(() => undefined)
  dirLocks.set(key, tail)
  // 队列空了就把 key 清掉，避免长期运行攒一堆 Promise
  void tail.then(() => {
    if (dirLocks.get(key) === tail) dirLocks.delete(key)
  })
  return run
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** 扩展名只留字母数字，避免调用方传进来的值拼出奇怪路径。 */
function safeExt(ext: string): string {
  const cleaned = ext
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  return cleaned || 'bin'
}

/** 索引里的 file 只允许是 rootDir 下的普通文件名。 */
function safeFile(file: string): boolean {
  return file.length > 0 && file === basename(file) && !file.includes('..')
}

function normalizeItem(raw: unknown): IndexItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o['id'] !== 'string' || typeof o['file'] !== 'string' || typeof o['hash'] !== 'string') return null
  if (!safeFile(o['file'])) return null
  return {
    id: o['id'],
    file: o['file'],
    mood: typeof o['mood'] === 'string' ? o['mood'] : '',
    tags: Array.isArray(o['tags']) ? o['tags'].filter((t): t is string => typeof t === 'string') : [],
    size: typeof o['size'] === 'number' && Number.isFinite(o['size']) ? o['size'] : 0,
    hash: o['hash'],
    createdAt: typeof o['createdAt'] === 'number' && Number.isFinite(o['createdAt']) ? o['createdAt'] : 0,
    lastUsedAt: typeof o['lastUsedAt'] === 'number' && Number.isFinite(o['lastUsedAt']) ? o['lastUsedAt'] : 0,
  }
}

/**
 * 表情包库：图片文件 + 一份 index.json。
 *
 * 目录结构和 people/memory 一致：一个目录放数据，索引单独一个 json。
 * 索引坏了宁可当成空库重建，也不要让整个 bot 起不来。
 */
export function createEmojiStore(
  rootDir: string = DEFAULT_ROOT,
  opts: { libraryCap: number } = { libraryCap: DEFAULT_CAP },
): EmojiStore {
  const root = rootDir
  const indexPath = join(root, 'index.json')
  /** 同一目录的所有读写都走同一把锁，避免读改写互相覆盖。 */
  const lockKey = resolve(rootDir)
  const cap = Number.isFinite(opts.libraryCap) ? Math.max(0, Math.floor(opts.libraryCap)) : DEFAULT_CAP

  function serial<T>(job: () => Promise<T>): Promise<T> {
    return serialByDir(lockKey, job)
  }

  /** 先写唯一临时文件再 rename；半截索引比没有索引更糟。 */
  async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, data)
      await rename(tmp, file)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  }

  async function saveIndex(items: IndexItem[]): Promise<void> {
    const index: EmojiIndex = { version: 1, items }
    await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  }

  async function rebuildEmpty(reason: string, err?: unknown): Promise<EmojiIndex> {
    warn(`表情包索引${reason}，已重建为空库`, {
      path: indexPath,
      ...(err === undefined ? {} : { error: errorMessage(err) }),
    })
    const empty: EmojiIndex = { version: 1, items: [] }
    try {
      await saveIndex(empty.items)
    } catch (e) {
      // 重建失败也按空库继续跑，不能让读索引变成致命错误
      warn('重建表情包索引失败，按空库处理', { path: indexPath, error: errorMessage(e) })
    }
    return empty
  }

  /**
   * 索引里可能有指向已删除/丢失文件的条目。留在库里只会让 pickEmoji 挑中它，
   * 发图时再失败。读索引时顺手清掉并回写，保证 list() 返回的每条都能用。
   */
  async function pruneMissing(items: IndexItem[]): Promise<IndexItem[]> {
    if (items.length === 0) return items

    const checked = await Promise.all(
      items.map(async (item) => ((await fileExists(join(root, item.file))) ? item : null)),
    )
    const kept = checked.filter((item): item is IndexItem => item !== null)
    if (kept.length === items.length) return items

    warn('表情包索引里有文件已不存在的条目，已清理', {
      path: indexPath,
      missing: items.length - kept.length,
    })
    try {
      await saveIndex(kept)
    } catch (err) {
      // 清理失败也先把有效条目返回，下次读索引再试
      warn('清理失效表情包索引失败', { path: indexPath, error: errorMessage(err) })
    }
    return kept
  }

  async function readIndex(): Promise<EmojiIndex> {
    let text: string
    try {
      text = await readFile(indexPath, 'utf8')
    } catch (err) {
      if (isNotFound(err)) return rebuildEmpty('不存在')
      return rebuildEmpty('读取失败', err)
    }

    // Windows 记事本等工具可能给 UTF-8 文件加 BOM，JSON.parse 会直接报错
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      return rebuildEmpty('损坏', err)
    }

    if (typeof parsed !== 'object' || parsed === null) return rebuildEmpty('损坏')
    const o = parsed as Record<string, unknown>
    if (o['version'] !== 1 || !Array.isArray(o['items'])) return rebuildEmpty('损坏')

    const items: IndexItem[] = []
    let skipped = 0
    for (const raw of o['items']) {
      const item = normalizeItem(raw)
      if (item) items.push(item)
      else skipped++
    }
    if (skipped > 0) warn('表情包索引里有无法识别的条目，已跳过', { path: indexPath, skipped })
    return { version: 1, items: await pruneMissing(items) }
  }

  /** 超 cap 时按 lastUsedAt、其次 createdAt 从旧到新淘汰，并删掉图片文件。 */
  async function evict(items: IndexItem[]): Promise<IndexItem[]> {
    if (items.length <= cap) return items

    const byAge = [...items].sort(
      (a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt,
    )
    const drop = new Set(byAge.slice(0, items.length - cap))
    for (const item of drop) {
      try {
        await rm(join(root, item.file), { force: true })
      } catch (err) {
        warn('淘汰表情包时删除文件失败', { file: item.file, error: errorMessage(err) })
      }
    }
    return items.filter((item) => !drop.has(item))
  }

  async function add(input: AddEmojiInput): Promise<AddEmojiResult> {
    // source 目前只作为调用方的来源标记，索引结构里不落盘
    void input.source

    const hash = createHash('sha256').update(input.buffer).digest('hex')
    const id = hash.slice(0, 16)
    if (input.buffer.byteLength > MAX_EMOJI_BYTES) {
      return { id, added: false, reason: 'too-large' }
    }

    const ext = safeExt(input.ext)
    return serial(async () => {
      const index = await readIndex()
      const existing = index.items.find((item) => item.hash === hash)
      if (existing) return { id: existing.id, added: false }

      // cap=0 表示不保留任何表情：不要先写图再被 evict 删掉，还回报 added=true
      if (cap === 0) return { id, added: false, reason: 'library-full' }

      const file = `${id}.${ext}`
      const target = join(root, file)
      const now = Date.now()

      // 索引丢了但图片还在时，直接补一条索引，不重复写盘
      if (!(await fileExists(target))) {
        await mkdir(root, { recursive: true })
        await writeAtomic(target, input.buffer)
      }

      index.items.push({
        id,
        file,
        mood: input.mood ?? '',
        tags: (input.tags ?? []).filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()),
        size: input.buffer.byteLength,
        hash,
        createdAt: now,
        lastUsedAt: now,
      })
      await saveIndex(await evict(index.items))
      return { id, added: true }
    })
  }

  async function list(): Promise<IndexItem[]> {
    // 也进队列：读索引可能触发重建/清理并回写，不能和 add 的读改写交错
    return serial(async () => {
      const index = await readIndex()
      // 返回副本，调用方改 tags 不会污染下次读盘结果
      return index.items.map((item) => ({ ...item, tags: [...item.tags] }))
    })
  }

  async function remove(id: string): Promise<boolean> {
    return serial(async () => {
      const index = await readIndex()
      const at = index.items.findIndex((item) => item.id === id)
      if (at < 0) return false

      const [removed] = index.items.splice(at, 1)
      if (removed) {
        try {
          await rm(join(root, removed.file), { force: true })
        } catch (err) {
          warn('删除表情包文件失败', { file: removed.file, error: errorMessage(err) })
        }
      }
      await saveIndex(index.items)
      return true
    })
  }

  async function touch(id: string): Promise<boolean> {
    return serial(async () => {
      const index = await readIndex()
      const item = index.items.find((it) => it.id === id)
      if (!item) return false
      item.lastUsedAt = Date.now()
      await saveIndex(index.items)
      return true
    })
  }

  return { add, list, remove, touch }
}
