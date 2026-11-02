/**
 * 通道层体检：send.ts / onebot.ts 里不依赖真实连接的纯函数。
 *
 * 不启动 WS、不连 NapCat、不读本地图片：全部是纯函数或纯数据。
 * 运行：node scripts/test-chan-bugs.ts
 */
import { rand, splitBySentence } from '../src/channel/send.ts'
import {
  extractImages,
  extractText,
  isAddressed,
  isObserveOnly,
  shouldHandle,
  type OBEvent,
  type OnebotOptions,
} from '../src/channel/onebot.ts'

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

const show = (v: unknown): string => JSON.stringify(v)

/* ---------- 1. splitBySentence：长度边界 ---------- */
console.log('=== 1. splitBySentence 长度边界 ===')
{
  // 正好等于上限：必须原样发一条
  const exact = '一'.repeat(20)
  const exactOut = splitBySentence(exact, 20, 10)
  check('正好等于上限时只有一条', exactOut.length === 1 && exactOut[0] === exact, show(exactOut))
  check('正好等于上限时长度不变', exactOut[0]?.length === 20, String(exactOut[0]?.length))

  // 超一个字符：切成 20 + 1，且拼回去不能丢字
  const over = '一'.repeat(21)
  const overOut = splitBySentence(over, 20, 10)
  check('超一字符时切成两条', overOut.length === 2, show(overOut))
  check('超一字符时拼回去等于原文', overOut.join('') === over, show(overOut))
  check('超一字符时每条不超上限', overOut.every((p) => p.length <= 20), show(overOut.map((p) => p.length)))

  // 没有标点的长串：只能硬切，但每段都要在上限内、拼回去完整
  const noPunct = `前面没有标点${'啊'.repeat(80)}后面也没有`
  const noPunctOut = splitBySentence(noPunct, 15, 50)
  check('无标点长串会被切成多条', noPunctOut.length > 1, show(noPunctOut.length))
  check('无标点长串每条都在上限内', noPunctOut.every((p) => p.length <= 15), show(noPunctOut.map((p) => p.length)))
  check('无标点长串拼回去等于原文', noPunctOut.join('') === noPunct, '拼接后对不上')

  // 全是标点：不能返回空，也不能切成空串
  const punctOnly = '。。。！！！？？'
  const punctOut = splitBySentence(punctOnly, 20, 10)
  check('全是标点时不返回空', punctOut.length > 0, show(punctOut))
  check('全是标点时不产生空串', punctOut.every((p) => p.length > 0), show(punctOut))
  check('全是标点且没超上限时原样保留', punctOut.length === 1 && punctOut[0] === punctOnly, show(punctOut))

  // 只有空白：一条都不发
  for (const blank of ['', '   ', '\n\n', ' \t \r\n ']) {
    check(`只有空白 ${show(blank)} 返回空数组`, splitBySentence(blank, 20, 10).length === 0)
  }

  // maxLen 非法时不能死循环（以前 maxLen=0 会在硬切里卡死）
  const zeroLimit = splitBySentence('abcde', 0, 10)
  check('maxLen=0 不会卡死且返回内容', zeroLimit.join('') === 'abcde', show(zeroLimit))

  // 条数上限：截断，且不把剩下的塞进最后一条
  const many = splitBySentence('一。二。三。四。五。', 20, 3)
  check('超过条数上限时只发前 N 条', many.length === 3, show(many))
  check('截断后每条都不拖长', many.every((p) => p.length <= 20), show(many))
}

/* ---------- 2. splitBySentence：emoji / 组合字符不能切半个 ---------- */
console.log('\n=== 2. splitBySentence 字素安全 ===')

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment)
}

/** 原文所有字素边界（累计 UTF-16 长度） */
function graphemeBoundaries(text: string): Set<number> {
  const out = new Set<number>([0])
  let acc = 0
  for (const g of graphemes(text)) {
    acc += g.length
    out.add(acc)
  }
  return out
}

function loneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
}

function checkGraphemeSafe(label: string, text: string, maxLen: number, maxParts = 100): void {
  const parts = splitBySentence(text, maxLen, maxParts)
  check(`${label}：切出了多条`, parts.length > 1, show(parts))
  check(`${label}：拼回去等于原文`, parts.join('') === text, show(parts))

  // 用 Intl.Segmenter 的边界做验证：每个切点都必须落在字素边界上
  const boundaries = graphemeBoundaries(text)
  let offset = 0
  const cuts: number[] = []
  for (const p of parts) {
    offset += p.length
    cuts.push(offset)
  }
  check(
    `${label}：每个切点都在字素边界上`,
    cuts.every((cut) => boundaries.has(cut)),
    show(cuts),
  )

  // 直观看：每段自己不能有半个代理对，也不能以组合符号/ZWJ 开头
  check(`${label}：没有半个代理对`, parts.every((p) => !loneSurrogate(p)), show(parts))
  check(
    `${label}：没有以组合符号/ZWJ 开头的段`,
    parts.every((p) => !/^[\u0300-\u036F\u200D\uFE0F]/.test(p)),
    show(parts),
  )

  // 单段字素不超过上限时，每条长度也必须守规矩
  const maxGrapheme = Math.max(...graphemes(text).map((g) => g.length))
  if (maxLen >= maxGrapheme) {
    check(`${label}：每条都在上限内`, parts.every((p) => p.length <= maxLen), show(parts.map((p) => p.length)))
  }
}

checkGraphemeSafe('单 emoji（奇数上限，最容易切代理对）', '😀'.repeat(11), 9)
checkGraphemeSafe('ZWJ 家庭', '👨‍👩‍👧‍👦'.repeat(6), 12)
checkGraphemeSafe('组合重音 e+́', 'e\u0301'.repeat(11), 7)
checkGraphemeSafe('肤色调 emoji', '👍🏽'.repeat(7), 5)
checkGraphemeSafe('旗帜（两个区域指示符）', '🇨🇳'.repeat(6), 7)
checkGraphemeSafe('混合 emoji 与中文', `你好😀在吗${'🎉'.repeat(3)}`.repeat(5), 9)

/* ---------- 3. rand：返回值必须在区间内 ---------- */
console.log('\n=== 3. rand 区间 ===')
{
  const ranges: Array<[number, number]> = [
    [0, 1],
    [400, 1500],
    [-5, 5],
    [3, 3],
  ]
  for (const [min, max] of ranges) {
    let ok = true
    let bad = ''
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const v = rand([min, max])
      seen.add(v)
      if (!Number.isInteger(v) || v < min || v > max) {
        ok = false
        bad = `第 ${i} 次得到 ${v}`
        break
      }
    }
    check(`rand([${min}, ${max}]) 跑 200 次都落在区间内且是整数`, ok, bad)
    if (min === max) check(`rand([${min}, ${max}]) 固定返回 ${min}`, seen.size === 1 && seen.has(min), show([...seen]))
  }

  // 配置写反（min > max）也不能跑到区间外
  let reversedOk = true
  for (let i = 0; i < 200; i++) {
    const v = rand([1500, 400])
    if (v < 400 || v > 1500) {
      reversedOk = false
      break
    }
  }
  check('rand 区间写反时仍落在 [400, 1500]', reversedOk)
}

/* ---------- 4. extractText：CQ 码 / at / face / image / 混合 ---------- */
console.log('\n=== 4. extractText ===')
{
  check('纯文本段', extractText([{ type: 'text', data: { text: '在吗' } }]) === '在吗')
  check('at 段带昵称用昵称', extractText([{ type: 'at', data: { qq: '12345', name: '小明' } }]) === '@小明')
  check('at 段没昵称退回 QQ 号', extractText([{ type: 'at', data: { qq: '12345' } }]) === '@12345')
  check('at 全体成员', extractText([{ type: 'at', data: { qq: 'all' } }]) === '@全体成员')
  check('at 段没 qq 不产生孤零零的 @', extractText([{ type: 'at', data: {} }]) === '')
  check('face 段', extractText([{ type: 'face', data: { id: '1' } }]) === '[表情]')
  check('image 段', extractText([{ type: 'image', data: { file: 'a.jpg' } }]) === '[图片]')
  check('record 段', extractText([{ type: 'record', data: {} }]) === '[语音]')

  const mixed = extractText([
    { type: 'at', data: { qq: '12345', name: '小明' } },
    { type: 'text', data: { text: ' 看这个' } },
    { type: 'face', data: { id: '1' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ])
  check('混合段按顺序拼接', mixed === '@小明 看这个[表情][图片]', show(mixed))

  // 字符串格式（CQ 码）：不能把原始 CQ 码喂给模型
  check(
    'CQ 码 face / image 转占位符',
    extractText('你好[CQ:face,id=1]看[CQ:image,file=a.jpg]') === '你好[表情]看[图片]',
  )
  check(
    'CQ 码 at 带昵称',
    extractText('[CQ:at,qq=12345,name=小明] 在吗') === '@小明 在吗',
  )
  check('CQ 码 at 全体成员', extractText('[CQ:at,qq=all] 集合') === '@全体成员 集合')
  check('CQ 码 reply 不留在文本里', extractText('[CQ:reply,id=9]在吗') === '在吗')
  check('CQ 码未知类型不留在文本里', extractText('前[CQ:json,data=x]后') === '前后')
  check(
    'CQ 码转义字符还原',
    extractText('&#91;笑&#93;&#44;&amp;') === '[笑],&',
  )
  check('非字符串非数组返回空', extractText(undefined) === '' && extractText(123 as never) === '')

  // 坏段不能把整条消息搞崩
  const dirty = [{ type: 'text', data: { text: '还在' } }, null, { type: 'text' }] as never
  check('坏消息段被跳过', extractText(dirty) === '还在', show(extractText(dirty)))
}

/* ---------- 5. extractImages ---------- */
console.log('\n=== 5. extractImages ===')
{
  const img = (data: Record<string, string>) => ({ type: 'image', data })

  // file 只有文件名 ≠ 本地路径：拼不出能读的地址，只能跳过
  check('只有 file 名、没有路径 → 跳过', extractImages([img({ file: 'b.png' })]).length === 0)
  // file 是本地路径：NapCat 给的原图路径，直接收（不依赖会过期的 URL）
  check(
    'file 是 Windows 绝对路径 → 收',
    show(extractImages([img({ file: 'C:\\Users\\q\\nt_temp\\a.png' })])) === show(['C:\\Users\\q\\nt_temp\\a.png']),
  )
  check(
    'file 是 POSIX 绝对路径 → 收',
    show(extractImages([img({ file: '/root/.config/QQ/a.jpg' })])) === show(['/root/.config/QQ/a.jpg']),
  )
  check(
    'file 是 file:// → 收',
    show(extractImages([img({ file: 'file:///tmp/a.png' })])) === show(['file:///tmp/a.png']),
  )
  check(
    'file 是相对路径 → 收',
    show(extractImages([img({ file: './cache/a.png' })])) === show(['./cache/a.png']),
  )
  check(
    '本地路径优先：有本地就只出本地（不再出 URL 兜底）',
    show(extractImages([img({ url: 'https://x.com/a.jpg', file: 'C:\\tmp\\a.jpg' })])) ===
      show(['C:\\tmp\\a.jpg']),
  )
  check(
    '本地路径 + ftp url → 只收本地',
    show(extractImages([img({ url: 'ftp://x.com/a.jpg', file: '/tmp/b.png' })])) === show(['/tmp/b.png']),
  )
  check(
    '同一地址不会因为 url/file 重复收',
    extractImages([img({ url: 'https://x.com/a.jpg', file: 'https://x.com/a.jpg' })]).length === 1,
  )
  check('url 是 http → 收', show(extractImages([img({ url: 'http://x.com/a.jpg' })])) === show(['http://x.com/a.jpg']))
  check('url 是 https → 收', show(extractImages([img({ url: 'https://x.com/a.jpg' })])) === show(['https://x.com/a.jpg']))
  check('url 是 FTP → 不收', extractImages([img({ url: 'ftp://x.com/a.jpg' })]).length === 0)
  check(
    'url 不是 http 但 file 是 https → 收 file',
    show(extractImages([img({ url: 'ftp://x.com/a.jpg', file: 'https://x.com/b.png' })])) === show(['https://x.com/b.png']),
  )
  check('只有 file、file 本身是 http → 收', show(extractImages([img({ file: 'http://x.com/c.png' })])) === show(['http://x.com/c.png']))
  check('大写 HTTPS 也认', extractImages([img({ url: 'HTTPS://X.COM/A.JPG' })]).length === 1)
  check('前后空格会被 trim', show(extractImages([img({ url: '  https://x.com/a.jpg  ' })])) === show(['https://x.com/a.jpg']))

  const many = Array.from({ length: 6 }, (_, i) => img({ url: `https://x.com/${i}.jpg` }))
  const capped = extractImages(many)
  check('超过 4 张时截断到 4 张', capped.length === 4, show(capped.length))
  check('截断保留前 4 张且顺序不变', show(capped) === show(many.slice(0, 4).map((s) => s.data.url)), show(capped))

  // 本地路径 + URL 成对出现时，仍是同一个 4 条上限（每条引用算一个名额）
  const paired = Array.from({ length: 6 }, (_, i) =>
    img({ url: `https://x.com/${i}.jpg`, file: `C:\\tmp\\${i}.jpg` }),
  )
  const pairedOut = extractImages(paired)
  // 每段只出一条引用：4 张图都能被看到（之前成对输出会让 4 张图只占 2 个名额）
  check('本地+URL 成对时 4 张图仍是 4 条引用', pairedOut.length === 4, show(pairedOut))
  check(
    '本地+URL 成对时顺序是「本地, 本地, 本地, 本地」',
    show(pairedOut) === show(['C:\\tmp\\0.jpg', 'C:\\tmp\\1.jpg', 'C:\\tmp\\2.jpg', 'C:\\tmp\\3.jpg']),
    show(pairedOut),
  )

  check('文本段混在中间不影响', extractImages([
    { type: 'text', data: { text: '看' } },
    img({ url: 'https://x.com/a.jpg' }),
    { type: 'face', data: {} },
  ]).length === 1)

  check('非数组（纯字符串）没图时返回空', extractImages('abc').length === 0)
  check(
    '字符串 CQ 码里的图片地址也能抽出来',
    show(extractImages('看[CQ:image,url=https://x.com/a.jpg]')) === show(['https://x.com/a.jpg']),
  )
}

/* ---------- 6. shouldHandle / isAddressed：私聊、群里 @、群里没 @ ---------- */
console.log('\n=== 6. shouldHandle / isAddressed ===')
{
  const base: OnebotOptions = { host: '127.0.0.1', port: 8765, path: '/onebot/v11/ws', token: 't' }
  const SELF = '10000'

  const priv = (userId: string, text = '在吗'): OBEvent => ({
    post_type: 'message',
    message_type: 'private',
    self_id: SELF,
    user_id: userId,
    message: [{ type: 'text', data: { text } }],
  })
  const group = (groupId: string, userId: string, text = '你好'): OBEvent => ({
    post_type: 'message',
    message_type: 'group',
    self_id: SELF,
    group_id: groupId,
    user_id: userId,
    message: [{ type: 'text', data: { text } }],
  })
  const groupAt = (groupId: string, userId: string, atQq = SELF, text = '你好'): OBEvent => ({
    ...group(groupId, userId, text),
    message: [
      { type: 'at', data: { qq: atQq } },
      { type: 'text', data: { text } },
    ],
  })

  const imageOnly = (ev: OBEvent, data: Record<string, string> = { url: 'https://x.com/a.jpg' }): OBEvent => ({
    ...ev,
    message: [{ type: 'image', data }],
  })

  // 私聊
  check('私聊：主人 → 处理', shouldHandle(priv('1234567890'), { ...base, ownerQQ: '1234567890' }))
  check('私聊：陌生人 → 不处理', !shouldHandle(priv('999'), { ...base, ownerQQ: '1234567890' }))
  check('私聊：没设 ownerQQ → 处理', shouldHandle(priv('999'), base))
  check('私聊：isAddressed 恒为真', isAddressed(priv('999')))

  // 纯图片：以前在 shouldHandle 就被丢了，用户只发一张图等于"它收不到"。
  // 现在放进来走一次视觉，回不回交给业务层判断。
  check(
    '私聊：只有图片（有地址）→ 处理，进视觉',
    shouldHandle(imageOnly(priv('1234567890')), { ...base, ownerQQ: '1234567890' }),
  )
  check(
    '私聊：只有图片（本地路径）→ 处理，进视觉',
    shouldHandle(imageOnly(priv('1234567890'), { file: 'C:\\tmp\\a.jpg' }), { ...base, ownerQQ: '1234567890' }),
  )
  // 看不见的图（既无 url、file 又只是文件名）放进来也只会得到一句空洞的回复
  check(
    '私聊：只有图片但没有任何地址 → 不处理',
    !shouldHandle(imageOnly(priv('1234567890'), {}), { ...base, ownerQQ: '1234567890' }),
  )
  check(
    '私聊：只有图片、file 是纯文件名 → 不处理',
    !shouldHandle(imageOnly(priv('1234567890'), { file: 'b.png' }), { ...base, ownerQQ: '1234567890' }),
  )
  // C3：纯表情包不触发模型
  check(
    '私聊：纯表情 → 不处理（C3 不变）',
    !shouldHandle({ ...priv('1234567890'), message: [{ type: 'face', data: { id: '1' } }] }, {
      ...base,
      ownerQQ: '1234567890',
    }),
  )
  check(
    '私聊：纯语音 → 不处理',
    !shouldHandle({ ...priv('1234567890'), message: [{ type: 'record', data: {} }] }, {
      ...base,
      ownerQQ: '1234567890',
    }),
  )
  check(
    '私聊：表情 + 图片 → 处理（图还是图）',
    shouldHandle(
      {
        ...priv('1234567890'),
        message: [
          { type: 'face', data: { id: '1' } },
          { type: 'image', data: { url: 'https://x.com/a.jpg' } },
        ],
      },
      { ...base, ownerQQ: '1234567890' },
    ),
  )

  // 群里被 @
  check('群里 @ 了它 → 处理', shouldHandle(groupAt('123', '999'), { ...base, allowGroup: true }))
  check(
    '群里 @ 的是别人 → 不回复（消息照进历史）',
    isObserveOnly(groupAt('123', '999', '111'), { ...base, allowGroup: true }),
  )
  check('群里 @ 了它但没开 allowGroup → 不处理', !shouldHandle(groupAt('123', '999'), base))
  check('群里被 @ 时 isAddressed 为真', isAddressed(groupAt('123', '999')))

  // 群里的纯图片：@ 了 → 正常处理；没 @ → 能进历史，但仍然只记录不回复。
  const groupImage = (withAt: boolean): OBEvent => ({
    ...group('123', '999'),
    message: [
      ...(withAt ? [{ type: 'at', data: { qq: SELF } }] : []),
      { type: 'image', data: { url: 'https://x.com/a.jpg' } },
    ],
  })
  check(
    '群里 @ 它 + 纯图片 → 处理且要回复',
    shouldHandle(groupImage(true), { ...base, allowGroup: true }) &&
      !isObserveOnly(groupImage(true), { ...base, allowGroup: true }),
  )
  check('群里没 @ 的纯图片 → 能进来（进历史）', shouldHandle(groupImage(false), { ...base, allowGroup: true }))
  check(
    '群里没 @ 的纯图片 → 仍然只记录不回复（不能变成必回）',
    isObserveOnly(groupImage(false), { ...base, allowGroup: true }),
  )
  check(
    '群里纯表情 → 不处理（C3 不变）',
    !shouldHandle({ ...group('123', '999'), message: [{ type: 'face', data: { id: '1' } }] }, { ...base, allowGroup: true }),
  )

  // 群里没 @：能进来（进历史、能学这个群怎么说话），但不回复
  check('群里没 @ → 默认只记录不回复', isObserveOnly(group('123', '999'), { ...base, allowGroup: true }))
  check('群里没 @ 时 isAddressed 为假', !isAddressed(group('123', '999')))
  check(
    'requireAt=false 时没 @ 也回复',
    !isObserveOnly(group('123', '999'), { ...base, allowGroup: true, requireAt: false }),
  )
  check(
    '没 @ 但叫了名字 → 回复',
    !isObserveOnly(group('123', '999', '小助手在吗'), { ...base, allowGroup: true, botNames: ['小助手'] }),
  )
  check(
    '没 @ 也没叫名字，但刚聊过 → 回复',
    !isObserveOnly(group('123', '999'), {
      ...base,
      allowGroup: true,
      recentTalkers: new Map([['123:999', Date.now()]]),
    }),
  )
  check(
    '刚聊过的是别人 → 不回复',
    isObserveOnly(group('123', '999'), {
      ...base,
      allowGroup: true,
      recentTalkers: new Map([['123:888', Date.now()]]),
    }),
  )
  check(
    '连续对话超过窗口 → 不回复',
    isObserveOnly(group('123', '999'), {
      ...base,
      allowGroup: true,
      recentTalkers: new Map([['123:999', Date.now() - 200_000]]),
    }),
  )

  // 动态权限策略分支
  const policy = (patch: Partial<{ requireAt: boolean; groupAllow: string[] }> = {}) => () => ({
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    requireAt: true,
    ...patch,
  })
  check('策略：群里没 @ → 不回复', isObserveOnly(group('123', '999'), { ...base, allowGroup: true, getPolicy: policy() }))
  check('策略：群里 @ 了 → 处理', shouldHandle(groupAt('123', '999'), { ...base, allowGroup: true, getPolicy: policy() }))
  check(
    '策略：群白名单之外 → 不处理',
    !shouldHandle(groupAt('123', '999'), { ...base, allowGroup: true, getPolicy: policy({ groupAllow: ['888'] }) }),
  )
  check(
    '策略：requireAt=false 时没 @ 也处理',
    shouldHandle(group('123', '999'), { ...base, allowGroup: true, getPolicy: policy({ requireAt: false }) }),
  )

  // 字符串 CQ 码格式也要认 @
  const cqAt = (qq: string): OBEvent => ({
    post_type: 'message',
    message_type: 'group',
    self_id: SELF,
    group_id: '123',
    user_id: '999',
    message: `[CQ:at,qq=${qq}] 你好`,
  })
  check('CQ 字符串：@ 了它 → isAddressed 为真', isAddressed(cqAt(SELF)))
  check('CQ 字符串：@ 了它 → 处理', shouldHandle(cqAt(SELF), { ...base, allowGroup: true }))
  check('CQ 字符串：@ 了别人 → isAddressed 为假', !isAddressed(cqAt('111')))
  check('CQ 字符串：@ 了别人 → 不回复', isObserveOnly(cqAt('111'), { ...base, allowGroup: true }))

  // 缺 self_id 时不能把空 qq 误判成"@ 了我"
  const noSelf = {
    post_type: 'message',
    message_type: 'group',
    group_id: '123',
    user_id: '999',
    message: [{ type: 'at', data: { qq: '' } }],
  } as OBEvent
  check('缺 self_id 且 at qq 为空 → isAddressed 为假', !isAddressed(noSelf))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
