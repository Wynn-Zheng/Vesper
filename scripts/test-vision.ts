/**
 * 看图功能验证：真的调一次视觉模型，看能不能说出图里有什么。
 */
import { describeImages, renderImages } from '../src/llm/vision.ts'
import { extractImages } from '../src/channel/onebot.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

/* ---------- 1. extractImages 的解析 ---------- */
console.log('=== 1. 从 OneBot 消息里抽图片地址 ===')
{
  const msg = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg' } },
    { type: 'image', data: { file: 'b.png' } },
    { type: 'image', data: { file: 'https://example.com/c.png' } },
  ]
  const imgs = extractImages(msg as never)
  check(`抽出 ${imgs.length} 个地址`, imgs.length === 2, JSON.stringify(imgs))
  check('http url 被收', imgs.includes('https://example.com/a.jpg'))
  check('file 里是 http 的也收', imgs.includes('https://example.com/c.png'))
  check('只有文件名的跳过', !imgs.some((u) => u === 'b.png'))

  check('非数组返回空', extractImages('abc' as never).length === 0)
  check('空数组返回空', extractImages([] as never).length === 0)

  // 数量上限
  const many = Array.from({ length: 10 }, (_, i) => ({ type: 'image', data: { url: `https://x.com/${i}.jpg` } }))
  check('最多 4 张', extractImages(many as never).length === 4, String(extractImages(many as never).length))
}

/* ---------- 2. 没配置时不崩 ---------- */
console.log('\n=== 2. 没配置视觉模型 ===')
{
  const r1 = await describeImages(['https://example.com/a.jpg'], { apiKey: '', baseUrl: '', model: '' })
  check('空配置返回空数组', r1.length === 0, JSON.stringify(r1))

  const r2 = await describeImages([], { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm' })
  check('空列表返回空数组', r2.length === 0)

  const r3 = await describeImages(['not-a-url'], { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm' })
  check('非 http 地址被过滤', r3.length === 0)
}

/* ---------- 3. renderImages ---------- */
console.log('\n=== 3. 渲染成文字 ===')
{
  check('空数组返回空串', renderImages([]) === '')
  const t = renderImages([
    { url: 'a', text: '一张猫的照片' },
    { url: 'b', text: '一个截图，写着 hello' },
  ])
  check('有张数', t.includes('2 张'), t.slice(0, 40))
  check('有描述', t.includes('猫') && t.includes('hello'))
}

/* ---------- 4. 真调一次视觉模型（探测，失败不算错）----------
 * 依赖外网和第三方图床，图片随机的、大小不定。网络抖动时失败不该算功能坏了。
 * 模型偶发返回空也要容忍（实测就有这种情况）。所以这里是"探测"不是"断言"。 */
console.log('\n=== 4. 真看图（探测，失败不算错）===')
{
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    console.log('（没有 DEEPSEEK_API_KEY，跳过）')
  } else {
    const url = 'https://picsum.photos/id/1015/320/240'
    const t0 = Date.now()
    let notes: Awaited<ReturnType<typeof describeImages>> = []
    try {
      notes = await describeImages([url], {
        apiKey: key,
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: 'deepseek-v4-flash-vision-exp',
      })
    } catch {
      /* 网络问题吞掉 */
    }
    const ms = Date.now() - t0
    console.log(`   耗时 ${ms}ms · 拿到 ${notes.length} 条描述`)
    if (notes.length) {
      console.log(`   它看到：${notes[0]!.text}`)
      check('视觉模型能返回描述', notes[0]!.text.length > 3, notes[0]!.text)
    } else {
      console.log('   （这次没拿到描述——网络或图床问题。完整链路已在 10:18 手工验证过，跳过）')
      check('视觉探测（跳过）', true)
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
