/**
 * 表情包三件套（store / pick / detect）的体检脚本。
 * 跑法：node scripts/test-emoji-bugs.ts
 * 退出码 0 = 全绿，非 0 = 有失败。
 *
 * 只碰临时目录，不联网、不读写真实 persona/data。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLog } from '../src/core/log.ts'
import { EMOJI_MAX_EDGE, EMOJI_MAX_SIZE, isEmojiCandidate } from '../src/emoji/detect.ts'
import { pickEmoji } from '../src/emoji/pick.ts'
import { createEmojiStore, type IndexItem } from '../src/emoji/store.ts'

const base = mkdtempSync(join(tmpdir(), 'qqbot-emoji-bugs-'))
// 日志写临时目录，别碰项目里的 data/
initLog(join(base, 'logs'), true)

process.on('exit', () => {
  try {
    rmSync(base, { recursive: true, force: true })
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

function indexPath(dir: string): string {
  return join(dir, 'index.json')
}

function readIndexFile(dir: string): { version: number; items: IndexItem[] } {
  const text = readFileSync(indexPath(dir), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text) as { version: number; items: IndexItem[] }
}

function writeIndexFile(dir: string, items: unknown[], version: unknown = 1): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(indexPath(dir), `${JSON.stringify({ version, items }, null, 2)}\n`, 'utf8')
}

/** 目录里的图片（排除索引、临时文件） */
function imageFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f !== 'index.json' && !f.endsWith('.tmp'))
    .sort()
}

function tmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'))
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

/** 直接铺一个索引 + 对应文件，用来构造容量/坏索引场景 */
function seedIndex(dir: string, items: IndexItem[], createFiles = true): void {
  mkdirSync(dir, { recursive: true })
  if (createFiles) {
    for (const item of items) writeFileSync(join(dir, item.file), image(item.id))
  }
  writeIndexFile(dir, items)
}

/* ============================================================
 * 1. 并发 add 去重
 * ============================================================ */

console.log('\n=== 1. 并发 add 去重 ===')

await check('同一内容 12 路并发 add（两个 store 实例）：只入库一次', async () => {
  const dir = join(base, 'concurrent-same')
  // 刻意建两个 store 指向同一目录：chat 和通道侧各有实例是真实情况
  const a = createEmojiStore(dir, { libraryCap: 50 })
  const b = createEmojiStore(dir, { libraryCap: 50 })
  const buffer = image('same-content')
  const hash = sha256(buffer)

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 === 0 ? a : b).add({ buffer, ext: 'png', mood: '开心' }),
    ),
  )

  assert.equal(results.filter((r) => r.added).length, 1, '只应该有一次 added=true')
  assert.equal(new Set(results.map((r) => r.id)).size, 1, '所有调用应该返回同一个 id')
  assert.equal(results[0]!.id, hash.slice(0, 16))

  const items = await a.list()
  assert.equal(items.length, 1, '索引里只应该有一条')
  assert.equal(items[0]!.hash, hash)
  assert.equal(readIndexFile(dir).items.length, 1)

  assert.deepEqual(imageFiles(dir), [`${results[0]!.id}.png`], '只应该落一张图')
  assert.deepEqual(tmpFiles(dir), [], '不应该留下 .tmp')
})

await check('不同内容并发 add（两个 store 实例）：不丢条目', async () => {
  const dir = join(base, 'concurrent-different')
  const a = createEmojiStore(dir, { libraryCap: 50 })
  const b = createEmojiStore(dir, { libraryCap: 50 })
  const buffers = Array.from({ length: 8 }, (_, i) => image(`different-${i}`))

  const results = await Promise.all(
    buffers.map((buffer, i) => (i % 2 === 0 ? a : b).add({ buffer, ext: 'png' })),
  )
  assert.ok(results.every((r) => r.added), '8 条都应该入库')
  assert.equal(new Set(results.map((r) => r.id)).size, 8, 'id 不应该撞车')

  const items = await a.list()
  assert.equal(items.length, 8, '并发读改写不能互相覆盖')
  assert.equal(new Set(items.map((i) => i.id)).size, 8)
  for (const item of items) assert.ok(existsSync(join(dir, item.file)), `${item.file} 应该存在`)
  assert.equal(readIndexFile(dir).items.length, 8)
})

/* ============================================================
 * 2. 容量淘汰
 * ============================================================ */

console.log('\n=== 2. 容量淘汰 ===')

await check('超 cap：按 lastUsedAt 淘汰最旧，并删文件', async () => {
  const dir = join(base, 'evict')
  // cap=3，先铺 3 条，lastUsedAt 顺序：b 最旧、c 次之、a 最新
  seedIndex(dir, [
    indexItem({ id: 'a', lastUsedAt: 300, createdAt: 1 }),
    indexItem({ id: 'b', lastUsedAt: 100, createdAt: 1 }),
    indexItem({ id: 'c', lastUsedAt: 200, createdAt: 1 }),
  ])
  const store = createEmojiStore(dir, { libraryCap: 3 })

  const d = await store.add({ buffer: image('d'), ext: 'png' })
  assert.equal(d.added, true)
  let items = await store.list()
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'c', d.id].sort(), '应该淘汰 b')
  assert.equal(existsSync(join(dir, 'b.png')), false, '被淘汰的文件应该删掉')
  assert.equal(existsSync(join(dir, 'a.png')), true)
  assert.equal(readIndexFile(dir).items.length, 3)

  // touch c 之后，a 变成最久未用
  assert.equal(await store.touch('c'), true)
  const e = await store.add({ buffer: image('e'), ext: 'png' })
  items = await store.list()
  assert.deepEqual(items.map((i) => i.id).sort(), ['c', d.id, e.id].sort(), '应该淘汰 a')
  assert.equal(existsSync(join(dir, 'a.png')), false)
  assert.equal(existsSync(join(dir, 'c.png')), true, 'touch 过的 c 应该保留')
  assert.equal(imageFiles(dir).length, 3, '目录里不应该留下孤儿图片')
  assert.deepEqual(tmpFiles(dir), [])
})

await check('lastUsedAt 相同：按 createdAt 淘汰更旧的', async () => {
  const dir = join(base, 'evict-tie')
  seedIndex(dir, [
    indexItem({ id: 'old', lastUsedAt: 100, createdAt: 1 }),
    indexItem({ id: 'new', lastUsedAt: 100, createdAt: 2 }),
  ])
  const store = createEmojiStore(dir, { libraryCap: 2 })

  const z = await store.add({ buffer: image('z'), ext: 'png' })
  const ids = (await store.list()).map((i) => i.id).sort()
  assert.deepEqual(ids, ['new', z.id].sort(), 'createdAt 更旧的那条先走')
  assert.equal(existsSync(join(dir, 'old.png')), false)
  assert.equal(existsSync(join(dir, 'new.png')), true)
})

await check('淘汰后重新打开 store：索引和文件仍然一致', async () => {
  const dir = join(base, 'evict')
  const reopened = createEmojiStore(dir, { libraryCap: 3 })
  const items = await reopened.list()
  assert.equal(items.length, 3)
  for (const item of items) assert.ok(existsSync(join(dir, item.file)), `${item.file} 应该还在`)
  assert.equal(await reopened.touch('b'), false, '已淘汰的条目不该还能 touch')
  assert.equal(await reopened.remove('b'), false, '已淘汰的条目不该还能 remove')
})

await check('cap=0：如实返回未入库，不落图也不留孤儿文件', async () => {
  const dir = join(base, 'evict-zero')
  const store = createEmojiStore(dir, { libraryCap: 0 })

  const r = await store.add({ buffer: image('zero'), ext: 'png', mood: '开心' })
  assert.equal(r.added, false, '没有容量时不能回报 added=true')
  assert.equal(r.reason, 'library-full')
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(imageFiles(dir), [], '既然没入库就不该写图片')
  assert.deepEqual(tmpFiles(dir), [])
})

/* ============================================================
 * 3. 坏 JSON 恢复
 * ============================================================ */

console.log('\n=== 3. 坏 JSON 恢复 ===')

await check('截断/非法 JSON：list 返回空库、不抛，索引重建为合法 JSON', async () => {
  const dir = join(base, 'corrupt')
  mkdirSync(dir, { recursive: true })
  writeFileSync(indexPath(dir), '{"version":1,"items":[{ "id": "half', 'utf8')
  const store = createEmojiStore(dir, { libraryCap: 10 })

  const items = await store.list()
  assert.deepEqual(items, [], '坏索引按空库处理')
  const disk = readIndexFile(dir)
  assert.equal(disk.version, 1)
  assert.deepEqual(disk.items, [])
  assert.deepEqual(tmpFiles(dir), [])

  // 坏索引之后还能正常写入
  const r = await store.add({ buffer: image('after-corrupt'), ext: 'png', mood: '开心' })
  assert.equal(r.added, true)
  assert.equal((await store.list()).length, 1)
  assert.equal(readIndexFile(dir).items.length, 1)
})

await check('JSON 合法但结构不对：null / 错 version / items 非数组都按空库重建', async () => {
  const dir = join(base, 'corrupt-shape')
  const store = createEmojiStore(dir, { libraryCap: 10 })

  for (const text of ['null', '[]', '{"version":2,"items":[]}', '{"version":1,"items":{}}', '"hello"']) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(indexPath(dir), text, 'utf8')
    assert.deepEqual(await store.list(), [], `内容 ${text} 应该被当成坏索引`)
    const disk = readIndexFile(dir)
    assert.equal(disk.version, 1)
    assert.deepEqual(disk.items, [])
  }
})

await check('条目部分损坏：跳过坏条目，保留好条目', async () => {
  const dir = join(base, 'corrupt-items')
  const good = indexItem({ id: 'good' })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'good.png'), image('good'))
  writeFileSync(
    indexPath(dir),
    JSON.stringify({
      version: 1,
      items: [
        good,
        null,
        { id: 1, file: 'x.png', hash: 'h' },
        { id: 'escape', file: '../escape.png', hash: 'h' },
        { id: 'nofile', file: 'nofile.png', hash: 'h' },
      ],
    }),
    'utf8',
  )

  const store = createEmojiStore(dir, { libraryCap: 10 })
  const items = await store.list()
  assert.deepEqual(items.map((i) => i.id), ['good'], '只保留结构和文件都正常的条目')

  // 再写一次索引，坏条目应该被彻底清掉
  const r = await store.add({ buffer: image('new-one'), ext: 'png' })
  assert.equal(r.added, true)
  const disk = readIndexFile(dir)
  assert.equal(disk.items.length, 2)
  assert.ok(disk.items.every((i) => typeof i.id === 'string' && Array.isArray(i.tags)))
})

await check('带 UTF-8 BOM 的索引：剥掉 BOM 后正常读取，不能整库清空', async () => {
  const dir = join(base, 'corrupt-bom')
  const buffer = image('bom-entry')
  const item = indexItem({ id: 'bom', hash: sha256(buffer), mood: '开心' })
  seedIndex(dir, [item])

  // 模拟 Windows 记事本保存：合法 JSON 前面多一个 BOM
  const text = readFileSync(indexPath(dir), 'utf8')
  writeFileSync(indexPath(dir), `\uFEFF${text}`, 'utf8')

  const store = createEmojiStore(dir, { libraryCap: 10 })
  const items = await store.list()
  assert.deepEqual(items.map((i) => i.id), ['bom'], 'BOM 不应该被当成坏索引')
  assert.deepEqual(readIndexFile(dir).items.map((i) => i.id), ['bom'])
})

/* ============================================================
 * 4. 索引引用了不存在的文件
 * ============================================================ */

console.log('\n=== 4. 索引引用不存在文件 ===')

await check('list 过滤掉文件不存在的条目，并回写索引', async () => {
  const dir = join(base, 'missing-file')
  seedIndex(dir, [
    indexItem({ id: 'keep', mood: '开心' }),
    indexItem({ id: 'gone', mood: '难过' }),
  ])
  // 删掉 gone.png，模拟手工删文件/同步丢文件
  rmSync(join(dir, 'gone.png'), { force: true })

  const store = createEmojiStore(dir, { libraryCap: 10 })
  const items = await store.list()
  assert.deepEqual(items.map((i) => i.id), ['keep'], '失效条目不应该返回给调用方')
  assert.deepEqual(readIndexFile(dir).items.map((i) => i.id), ['keep'], '失效条目应该从磁盘索引清掉')

  // pickEmoji 拿到的候选里不会再有失效条目
  const picked = pickEmoji(items, '难过', () => 0)
  assert.equal(picked?.id, 'keep', 'mood 未命中时兜底也只能挑到有效条目')
})

await check('库里只有失效条目：list 为空，重新 add 同一内容能正常落盘', async () => {
  const dir = join(base, 'missing-only')
  const buffer = image('revive')
  const hash = sha256(buffer)
  const id = hash.slice(0, 16)
  seedIndex(dir, [indexItem({ id, hash })], false)

  const store = createEmojiStore(dir, { libraryCap: 10 })
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(readIndexFile(dir).items, [])

  const r = await store.add({ buffer, ext: 'png' })
  assert.equal(r.added, true)
  assert.equal(r.id, id)
  assert.ok(existsSync(join(dir, `${id}.png`)), '图片应该重新写盘')
  assert.equal((await store.list()).length, 1)
})

/* ============================================================
 * 5. pickEmoji 空库
 * ============================================================ */

console.log('\n=== 5. pickEmoji 空库 ===')

await check('空库返回 null，而且不应该调用 rng', async () => {
  let called = false
  const picked = pickEmoji([], '开心', () => {
    called = true
    throw new Error('空库不应该调用 rng')
  })
  assert.equal(picked, null)
  assert.equal(called, false)
})

await check('单条库：rng 返回 NaN / Infinity / 越界值也不会拿到 undefined', () => {
  const only = indexItem({ id: 'only' })
  for (const rng of [() => Number.NaN, () => Infinity, () => -1, () => 2, () => 1]) {
    assert.equal(pickEmoji([only], '随便', rng)?.id, 'only')
  }
})

/* ============================================================
 * 6. mood 未命中走 tag
 * ============================================================ */

console.log('\n=== 6. mood 未命中走 tag ===')

await check('mood 精确 > tags 命中 > 兜底', () => {
  const pool: IndexItem[] = [
    indexItem({ id: 'happy', mood: '开心', tags: ['笑'] }),
    indexItem({ id: 'angry-by-tag', mood: '普通', tags: ['生气', '不爽'] }),
    indexItem({ id: 'angry-tag-2', mood: '平静', tags: ['生气'] }),
    indexItem({ id: 'plain', mood: '无聊', tags: ['日常'] }),
  ]

  // 精确 mood 优先，即使别的条目 tag 命中也一样
  const exact = pickEmoji(pool, '开心', () => 0.99)
  assert.equal(exact?.id, 'happy')

  // mood 没有完全相同的，走 tag
  const tagged = pickEmoji(pool, '生气', () => 0)
  assert.equal(tagged?.id, 'angry-by-tag', 'rng=0 取第一个 tag 命中项')
  const tagged2 = pickEmoji(pool, '生气', () => 0.999)
  assert.equal(tagged2?.id, 'angry-tag-2', 'tag 候选内部按 rng 挑')
  assert.ok(['angry-by-tag', 'angry-tag-2'].includes(tagged2!.id))

  // 都没有才兜底，且只能从原数组里挑
  const fallback = pickEmoji(pool, '根本不存在', () => 0)
  assert.equal(fallback?.id, 'happy')
  assert.ok(pool.includes(fallback!), '兜底必须返回原有对象')
})

await check('有精确 mood 时不会被 tag 抢走', () => {
  const pool: IndexItem[] = [
    indexItem({ id: 'tag-first', mood: '普通', tags: ['生气'] }),
    indexItem({ id: 'exact-second', mood: '生气', tags: [] }),
  ]
  assert.equal(pickEmoji(pool, '生气', () => 0)?.id, 'exact-second')
})

/* ============================================================
 * 7. isEmojiCandidate：大图 / 非图片
 * ============================================================ */

console.log('\n=== 7. isEmojiCandidate 大图/非图片 ===')

await check('非 image 段一律不是候选（即使体积/尺寸很小）', () => {
  const tiny = { size: 1, width: 1, height: 1 }
  assert.equal(isEmojiCandidate({ type: 'text', data: { text: '你好' } }, tiny), false)
  assert.equal(isEmojiCandidate({ type: 'face', data: { id: '1' } }, tiny), false)
  assert.equal(isEmojiCandidate({ type: 'file', data: {} }, tiny), false)
  // 平台文案里有"表情"也不行：类型不是 image
  assert.equal(isEmojiCandidate({ type: 'text', data: { summary: '动画表情' } }, tiny), false)
})

await check('大图不是候选：超体积 / 超长 / 超宽', () => {
  const img = { type: 'image', data: {} }
  assert.equal(
    isEmojiCandidate(img, { size: 100 * 1024, width: 240, height: 240 }),
    true,
    '小图应该是候选',
  )
  assert.equal(
    isEmojiCandidate(img, { size: EMOJI_MAX_SIZE + 1, width: 240, height: 240 }),
    false,
    '超过 512KB 不是候选',
  )
  assert.equal(
    isEmojiCandidate(img, { size: 100 * 1024, width: EMOJI_MAX_EDGE + 1, height: 240 }),
    false,
    '宽超过 512 不是候选',
  )
  assert.equal(
    isEmojiCandidate(img, { size: 100 * 1024, width: 240, height: EMOJI_MAX_EDGE + 1 }),
    false,
    '高超过 512 不是候选',
  )
  assert.equal(
    isEmojiCandidate(img, { size: EMOJI_MAX_SIZE, width: EMOJI_MAX_EDGE, height: EMOJI_MAX_EDGE }),
    true,
    '刚好卡在上限应该算候选',
  )
})

await check('元信息缺失/非法：普通图不猜，平台明确标记的仍然收', () => {
  const img = { type: 'image', data: {} }
  assert.equal(isEmojiCandidate(img, {}), false, '没有体积和尺寸不能蒙')
  assert.equal(
    isEmojiCandidate(img, { size: Number.NaN, width: 100, height: 100 }),
    false,
    'NaN 体积不算候选',
  )
  assert.equal(
    isEmojiCandidate(img, { size: 100, width: Number.POSITIVE_INFINITY, height: 100 }),
    false,
    'Infinity 尺寸不算候选',
  )
  assert.equal(isEmojiCandidate(img, { size: 0, width: 100, height: 100 }), false, '0 体积不算候选')
  assert.equal(isEmojiCandidate(img, { size: 100, width: 0, height: 100 }), false, '0 宽不算候选')
  assert.equal(
    isEmojiCandidate(img, { size: 100, width: 100, height: -1 }),
    false,
    '负数高不算候选',
  )

  // 平台已经标了表情包：即使拿不到 meta 也收（大图标记属于平台判断，不再二次过滤）
  assert.equal(isEmojiCandidate({ type: 'image', data: { subType: '1' } }, {}), true)
  assert.equal(isEmojiCandidate({ type: 'image', data: { sub_type: '1' } }, {}), true)
  assert.equal(isEmojiCandidate({ type: 'image', data: { summary: '动画表情' } }, {}), true)
  // 普通图 + 大尺寸仍然不收
  assert.equal(
    isEmojiCandidate(
      { type: 'image', data: { summary: '普通图片' } },
      { size: 1024 * 1024, width: 2048, height: 2048 },
    ),
    false,
  )
})

/* ---------- 汇总 ---------- */

console.log('')
if (fail > 0) {
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(1)
}
console.log(`通过 ${pass} / 失败 0`)
