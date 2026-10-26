/**
 * 通道侧表情包自测：识别入库 + 发图。
 * 跑法：node scripts/test-emoji-channel.ts
 * 退出码 0 = 全过，非 0 = 有失败。
 *
 * 全部用临时目录和假 transport / 假取图函数，不联网、不碰真实 persona/data。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEmojiSegments } from '../src/channel/onebot.ts'
import {
  sendImage,
  setImageTransport,
  type OutgoingSegment,
  type SegmentAwareTransport,
} from '../src/channel/send.ts'
import { initLog } from '../src/core/log.ts'
import type { Target } from '../src/core/types.ts'
import { MAX_EMOJI_BYTES, createEmojiStore } from '../src/emoji/store.ts'
import { isEmojiCandidate, isEmojiSegment } from '../src/emoji/detect.ts'

const root = mkdtempSync(join(tmpdir(), 'qqbot-emoji-channel-'))
const emojiDir = join(root, 'emoji')
initLog('', false)

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

/** 一张最小的 PNG 文件头 + 一点内容，足够当测试图片。 */
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const store = createEmojiStore(emojiDir, { libraryCap: 20 })
const target: Target = { kind: 'private', id: '10001' }

/** 假取图：记录调用次数，返回固定图片，不联网。 */
let fetchCalls = 0
const fakeGetImage = async (): Promise<{ buffer: Uint8Array; ext: string }> => {
  fetchCalls++
  return { buffer: pngBytes, ext: 'png' }
}

/* ---------- 1. 纯函数判定 ---------- */

await check('detect：subType / sub_type / summary / 非 image', () => {
  assert.equal(isEmojiSegment({ type: 'text', data: { summary: '表情' } }), false)
  assert.equal(isEmojiSegment({ type: 'image', data: { subType: '1' } }), true)
  assert.equal(isEmojiSegment({ type: 'image', data: { sub_type: '1' } }), true)
  assert.equal(isEmojiSegment({ type: 'image', data: { summary: '动画表情' } }), true)
  assert.equal(isEmojiSegment({ type: 'image', data: { summary: '普通图片' } }), false)

  assert.equal(isEmojiCandidate({ type: 'image', data: { subType: '1' } }, {}), true)
  assert.equal(
    isEmojiCandidate({ type: 'image', data: {} }, { size: 100 * 1024, width: 240, height: 240 }),
    true,
  )
  assert.equal(
    isEmojiCandidate({ type: 'image', data: {} }, { size: 600 * 1024, width: 240, height: 240 }),
    false,
    '超过 512KB 的普通图不算候选',
  )
  assert.equal(
    isEmojiCandidate({ type: 'image', data: {} }, { size: 100 * 1024, width: 1024, height: 240 }),
    false,
    '长宽超过 512 的普通图不算候选',
  )
})

/* ---------- 2. 非 image 段不入库 ---------- */

await check('非 image 段：不取图、不入库', async () => {
  fetchCalls = 0
  const added = await captureEmojiSegments(
    [
      { type: 'text', data: { text: '你好' } },
      { type: 'face', data: { id: '1' } },
    ],
    { enabled: true, store, getImage: fakeGetImage },
  )
  assert.equal(added, 0)
  assert.equal(fetchCalls, 0, '非 image 段不应该触发取图')
  assert.deepEqual(await store.list(), [])
})

/* ---------- 3. subType=1 的 image 段入临时库 ---------- */

await check('subType=1：取图并写入临时表情包库', async () => {
  fetchCalls = 0
  const added = await captureEmojiSegments([{ type: 'image', data: { subType: '1', file: 'fake.png' } }], {
    enabled: true,
    store,
    getImage: fakeGetImage,
  })

  assert.equal(added, 1)
  assert.equal(fetchCalls, 1)
  const items = await store.list()
  assert.equal(items.length, 1)
  assert.match(items[0]!.file, /\.png$/)
  assert.equal(items[0]!.size, pngBytes.byteLength)
})

/* ---------- 4. 大图 / 禁用开关不入库 ---------- */

await check('大图且禁用开关：不入库', async () => {
  const before = (await store.list()).length

  fetchCalls = 0
  const big = await captureEmojiSegments(
    [
      {
        type: 'image',
        data: { file: 'big.jpg', size: String(1024 * 1024), width: '2048', height: '2048' },
      },
    ],
    { enabled: true, store, getImage: fakeGetImage },
  )
  assert.equal(big, 0, '大尺寸普通图不是表情包候选')
  assert.equal(fetchCalls, 0, '不是候选就不该取图')

  const disabled = await captureEmojiSegments([{ type: 'image', data: { subType: '1', file: 'fake.png' } }], {
    enabled: false,
    store,
    getImage: fakeGetImage,
  })
  assert.equal(disabled, 0, 'emoji.enabled=false 时一律不收')
  assert.equal((await store.list()).length, before, '库里的条目数不应该变化')
})

/* ---------- 5. sendImage 组装 image 段 ---------- */

await check('sendImage：发出的段 type=image 且含 file 字段', async () => {
  const imagePath = join(root, 'send.png')
  writeFileSync(imagePath, pngBytes)

  const sent: Array<{ to: Target; seg: OutgoingSegment }> = []
  const fakeTransport: SegmentAwareTransport = {
    kind: 'fake',
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async () => {
      throw new Error('有 sendSegment 时不应该退回文本发送')
    },
    sendSegment: async (to: Target, seg: OutgoingSegment) => {
      sent.push({ to, seg })
      return { messageId: '42' }
    },
  }

  const result = await sendImage(fakeTransport, target, imagePath)
  assert.equal(result && result.messageId, '42')
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.seg.type, 'image')
  assert.equal(typeof sent[0]!.seg.data['file'], 'string')
  assert.ok(sent[0]!.seg.data['file']!.startsWith('base64://'), '图片内容应该以 base64:// 发送')

  // 两参数形式：用注入的默认通道
  setImageTransport(fakeTransport)
  try {
    await sendImage(target, imagePath)
    assert.equal(sent.length, 2, '两参数形式也应该发出去')
  } finally {
    setImageTransport(null)
  }
})

/* ---------- 6. 文件不存在 / 超过 2MB ---------- */

await check('sendImage：文件不存在时抛明确中文错误', async () => {
  const fakeTransport: SegmentAwareTransport = {
    kind: 'fake',
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async () => {},
    sendSegment: async () => {},
  }

  await assert.rejects(
    () => sendImage(fakeTransport, target, join(root, 'not-there.png')),
    /文件不存在/,
  )
})

await check('sendImage：超过 2MB 时抛明确中文错误', async () => {
  const fakeTransport: SegmentAwareTransport = {
    kind: 'fake',
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async () => {},
    sendSegment: async () => {},
  }

  const bigPath = join(root, 'too-big.png')
  writeFileSync(bigPath, Buffer.alloc(MAX_EMOJI_BYTES + 1))

  await assert.rejects(() => sendImage(fakeTransport, target, bigPath), /2MB/)
})

console.log('')
if (fail > 0) {
  console.log(`失败 ${fail} 项 / 通过 ${pass} 项`)
  process.exit(1)
}
console.log(`全部通过：通过 ${pass} / 失败 0`)
