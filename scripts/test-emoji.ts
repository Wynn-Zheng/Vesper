/**
 * 表情包库与挑图逻辑的自测。
 * 跑法：node scripts/test-emoji.ts
 * 退出码 0 = 全过，非 0 = 有失败。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLog } from '../src/core/log.ts'
import { pickEmoji } from '../src/emoji/pick.ts'
import { createEmojiStore, MAX_EMOJI_BYTES, type IndexItem } from '../src/emoji/store.ts'

const root = mkdtempSync(join(tmpdir(), 'qqbot-emoji-'))
const emojiDir = join(root, 'emoji')

// 日志也写临时目录，别碰项目里的 data/
initLog(join(root, 'logs'), true)

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let pass = 0
let fail = 0

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`√ ${name}`)
  } catch (e) {
    fail++
    console.log(`× ${name}`)
    console.log(`    ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

/** 造一张内容确定、彼此不同的"图片" */
function image(seed: string, size = 64): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    out[i] = (seed.charCodeAt(i % seed.length) + i * 31) & 0xff
  }
  return out
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function indexPath(): string {
  return join(emojiDir, 'index.json')
}

function readIndexFile(): { version: number; items: IndexItem[] } {
  return JSON.parse(readFileSync(indexPath(), 'utf8')) as { version: number; items: IndexItem[] }
}

/** 目录里的图片（排除索引、临时文件） */
function imageFiles(): string[] {
  if (!existsSync(emojiDir)) return []
  return readdirSync(emojiDir)
    .filter((f) => f !== 'index.json' && !f.endsWith('.tmp'))
    .sort()
}

function indexItem(over: Partial<IndexItem> & Pick<IndexItem, 'id'>): IndexItem {
  return {
    file: `${over.id}.png`,
    mood: '',
    tags: [],
    size: 1,
    hash: over.id.padEnd(64, '0').slice(0, 64),
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  }
}

const store = createEmojiStore(emojiDir, { libraryCap: 2 })
const first = image('first')
const firstHash = sha256(first)
let firstId = ''

/* ---------- 1. 新增成功并写入 index.json ---------- */

await check('新增成功：图片落盘、index.json 结构正确', async () => {
  const r = await store.add({
    buffer: first,
    ext: '.png',
    mood: '开心',
    tags: ['笑', '开心'],
    source: 'test',
  })
  firstId = r.id

  assert.equal(r.added, true)
  assert.match(r.id, /^[0-9a-f]{16}$/)
  assert.equal(r.id, firstHash.slice(0, 16))

  const img = join(emojiDir, `${r.id}.png`)
  assert.ok(existsSync(img), '图片应该落盘')
  assert.equal(readFileSync(img).byteLength, first.byteLength)
  assert.deepEqual(
    readdirSync(emojiDir).filter((f) => f.endsWith('.tmp')),
    [],
    '不应该留下 .tmp',
  )

  const disk = readIndexFile()
  assert.equal(disk.version, 1)
  assert.equal(disk.items.length, 1)

  const item = disk.items[0]!
  assert.equal(item.id, r.id)
  assert.equal(item.file, `${r.id}.png`)
  assert.equal(item.mood, '开心')
  assert.deepEqual(item.tags, ['笑', '开心'])
  assert.equal(item.size, first.byteLength)
  assert.equal(item.hash, firstHash)
  assert.ok(item.createdAt > 0 && item.lastUsedAt > 0)
  assert.deepEqual(Object.keys(item).sort(), [
    'createdAt',
    'file',
    'hash',
    'id',
    'lastUsedAt',
    'mood',
    'size',
    'tags',
  ])
})

/* ---------- 2. 同图二次 add ---------- */

await check('同图二次 add：added=false，且不新增文件', async () => {
  const before = imageFiles()
  const r = await store.add({ buffer: first, ext: 'png', mood: '难过' })

  assert.equal(r.added, false)
  assert.equal(r.id, firstId)
  assert.deepEqual(imageFiles(), before, '文件数不应该变化')
  assert.equal((await store.list()).length, 1, '索引里不应该多出一条')
})

/* ---------- 3. 超 cap 淘汰最久未用 ---------- */

await check('超 cap：淘汰 lastUsedAt 最旧的条目并删图片', async () => {
  const second = image('second')
  const third = image('third')

  const rb = await store.add({ buffer: second, ext: 'jpg', mood: '难过' })
  assert.equal(rb.added, true)

  // 让 first 比 second 更"新"，这样被淘汰的应该是 second
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(await store.touch(firstId), true)

  const rc = await store.add({ buffer: third, ext: 'png', mood: '平静' })
  assert.equal(rc.added, true)

  const items = await store.list()
  assert.equal(items.length, 2, 'cap=2 应该只剩两条')
  const ids = items.map((i) => i.id)
  assert.ok(ids.includes(firstId), '刚 touch 过的应该保留')
  assert.ok(ids.includes(rc.id), '最新加入的应该保留')
  assert.ok(!ids.includes(rb.id), '最久未用的应该被淘汰')

  assert.equal(existsSync(join(emojiDir, `${rb.id}.jpg`)), false, '淘汰条目的图片应该删掉')
  assert.equal(existsSync(join(emojiDir, `${firstId}.png`)), true)
  assert.equal(existsSync(join(emojiDir, `${rc.id}.png`)), true)
  assert.equal(readIndexFile().items.length, 2)
  assert.equal(imageFiles().length, 2)
})

/* ---------- 4. pickEmoji 三条路径 ---------- */

await check('pickEmoji：mood 精确 / tag 命中 / 兜底随机', async () => {
  const pool: IndexItem[] = [
    indexItem({ id: 'a', mood: '开心', tags: ['笑'] }),
    indexItem({ id: 'b', mood: '难过' }),
    indexItem({ id: 'c', mood: '平静', tags: ['生气'] }),
    indexItem({ id: 'd', mood: '普通', tags: ['日常'] }),
  ]

  const exact = pickEmoji(pool, '开心', () => 0)
  assert.equal(exact?.id, 'a', 'mood 完全相同优先')

  const tagged = pickEmoji(pool, '生气', () => 0)
  assert.equal(tagged?.id, 'c', '没有同 mood 时按 tags 命中')

  const fallback = pickEmoji(pool, '根本没有这个心情', () => 0)
  assert.ok(fallback !== null)
  assert.ok(pool.includes(fallback), '兜底应该从原有 items 里挑')
  assert.equal(fallback.id, 'a', 'rng=0 时取第一个')

  assert.equal(pickEmoji([], '开心'), null, '空库返回 null')
})

/* ---------- 5. 超过 2MB 不落盘 ---------- */

await check('超限：>2MB 返回 too-large 且不写文件', async () => {
  const big = new Uint8Array(MAX_EMOJI_BYTES + 1)
  const r = await store.add({ buffer: big, ext: 'png', mood: '开心' })

  assert.equal(r.added, false)
  assert.equal(r.reason, 'too-large')
  assert.equal(existsSync(join(emojiDir, `${r.id}.png`)), false)
})

/* ---------- 6. 索引损坏后 list() 返回空库且不抛 ---------- */

await check('索引损坏：list() 返回空库、不抛错并重建索引', async () => {
  writeFileSync(indexPath(), '{ 这不是合法 JSON', 'utf8')

  // 抛错会被 check 捕获，这里能拿到返回值就说明没抛
  const items = await store.list()
  assert.deepEqual(items, [])

  const disk = readIndexFile()
  assert.equal(disk.version, 1)
  assert.deepEqual(disk.items, [])
})

console.log('')
if (fail > 0) {
  console.log(`失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(1)
}
console.log(`通过 ${pass} / 失败 0`)
