/**
 * 表情包打标不堵队头（B-28）。
 *
 * 缺陷原样：每轮都从 pending 头部取前 N 张，失败只 `continue`、不记次数。
 * 只要队头有几张永远打不出来的图（文件损坏、模型读不懂），每一轮都在重试
 * 同一批，后面的新图永远轮不到。表现是"库存越攒越多，标签一直不长"。
 *
 * 这里用一个能手动跑轮的 runner 连续跑 4 轮来验证修好没有：
 * 队列里放 3 张"坏图"（tag 恒返回 null）排在 5 张好图前面。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import { createEmojiStore } from '../src/emoji/store.ts'
import { createEmojiTaggerRunner } from '../src/scheduler/emoji-tagger.ts'
import type { LlmOptions } from '../src/llm/types.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'vesper-emoji-tagger-'))
  dirs.push(d)
  return d
}

function rules(over: Partial<typeof DEFAULTS.视觉> = {}): typeof DEFAULTS {
  const r = structuredClone(DEFAULTS)
  r.表情包.开启 = true
  r.视觉.开启 = true
  Object.assign(r.视觉, over)
  return r
}

/** 造 n 张图，返回 id 顺序（= 索引里的顺序，也就是 pending 的顺序） */
async function seed(root: string, n: number): Promise<string[]> {
  const store = createEmojiStore(root, { libraryCap: 200 })
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    // 每张内容不同，否则 hash 相同会被当成重复不入库
    const buf = Buffer.from(`fake-emoji-${i}`)
    const r = await store.add({ buffer: buf, ext: 'png' })
    ids.push(r.id)
  }
  return ids
}

const llm = { apiKey: 'test', baseUrl: 'http://localhost', model: 'x' } as LlmOptions

test('队头的坏图不会堵住后面的好图', async () => {
  const root = tempRoot()
  const ids = await seed(root, 8)
  const bad = new Set(ids.slice(0, 3)) // 前 3 张永远打不出来

  const runner = createEmojiTaggerRunner({
    root,
    llm,
    batch: 5,
    getRules: () => rules(),
    // 坏图返回 null，好图返回标签
    tag: async (image) => {
      const text = Buffer.from(image.buffer).toString()
      const i = Number(text.replace('fake-emoji-', ''))
      return i < 3 ? null : { mood: '开心', tags: [`t${i}`] }
    },
  })

  // 第 1 轮：取 5 张（3 坏 + 2 好）→ 好图成功
  assert.equal(await runner.runOnce(), 2, '第一轮应该只打成 2 张好图')
  // 第 2 轮：坏图失败次数到 2，仍然占位，但后面的好图继续推进
  assert.equal(await runner.runOnce(), 2, '第二轮应该再打成 2 张')
  // 第 3 轮：坏图失败 3 次后被过滤掉，最后 1 张好图能打到
  assert.equal(await runner.runOnce(), 1, '第三轮应该打成最后 1 张好图')
  // 第 4 轮：只剩坏图，且都超限 → 不再空转
  assert.equal(await runner.runOnce(), 0, '第四轮不该再动')

  // 5 张好图全部打上标，3 张坏图仍然没有
  const store = createEmojiStore(root, { libraryCap: 200 })
  const items = await store.list()
  const tagged = items.filter((x) => x.mood || x.tags.length)
  assert.equal(tagged.length, 5, '5 张好图应该全部打上标')
  assert.ok(
    tagged.every((x) => !bad.has(x.id)),
    '打上标的不该包含坏图',
  )

  // 失败计数能被看到，便于排查"哪几张一直打不出来"
  assert.equal(runner.failures().size, 3)
})

test('每轮都在推进，不会原地重试同一批', async () => {
  const root = tempRoot()
  const ids = await seed(root, 10)
  const bad = new Set(ids.slice(0, 2))

  const runner = createEmojiTaggerRunner({
    root,
    llm,
    batch: 4,
    getRules: () => rules(),
    tag: async (image) => {
      const text = Buffer.from(image.buffer).toString()
      const i = Number(text.replace('fake-emoji-', ''))
      return i < 2 ? null : { mood: '无语', tags: [`t${i}`] }
    },
  })

  const rounds: number[] = []
  for (let i = 0; i < 6; i++) rounds.push(await runner.runOnce())
  // 每轮都至少打成一张，直到好图打完（8 张好图）
  assert.equal(
    rounds.reduce((a, b) => a + b, 0),
    8,
    `6 轮应该把 8 张好图全打完，实际 ${rounds.join('+')}`,
  )
  assert.ok(!rounds.slice(0, 4).includes(0), '前几轮不该出现 0（说明卡住了）')
  assert.equal(await runner.runOnce(), 0, '打好之后应返回 0')

  const items = await createEmojiStore(root, { libraryCap: 200 }).list()
  assert.equal(items.filter((x) => bad.has(x.id)).length, 2, '坏图仍在库里（没有被误删）')
})

test('视觉没开时什么都不做', async () => {
  const root = tempRoot()
  await seed(root, 3)
  const r = rules()
  r.视觉.开启 = false
  const runner = createEmojiTaggerRunner({
    root,
    llm,
    getRules: () => r,
    tag: async () => ({ mood: '开心', tags: ['x'] }),
  })
  assert.equal(await runner.runOnce(), 0)
  const items = await createEmojiStore(root, { libraryCap: 200 }).list()
  assert.ok(items.every((x) => !x.mood), '不该打标')
})
