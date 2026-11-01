/**
 * 角色卡：一张卡 = 一套人设。
 *
 * 为什么独立成文件（persona/cards/<id>.md）而不是塞进 self.md：
 *   1. 以后要做「角色卡切换」——换人设只要改 current 指针，不动数据
 *   2. self.md 是它自己写的东西（自述/心情），角色卡是你定的设定，两者生命周期不同
 *
 * 文件格式：frontmatter 放名字/生日/开关，正文按二级标题分节。
 * 没有卡时 ensureDefaultCard() 会从 self.md 的名字生成一张空卡。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'
import { warnAt } from '../core/log.ts'

// 角色卡目录。用 let 是为了测试能指向临时目录（和 setPeopleRoot / setMemoryRoot 一致），
// 生产环境永远是 'persona/cards'。
let DIR = 'persona/cards'
let CURRENT = join(DIR, 'current.txt')

/** 测试用：把角色卡根目录指到别处 */
export function setCardsRoot(p: string): void {
  DIR = p
  CURRENT = join(p, 'current.txt')
}

/** 当前角色卡根目录（给测试/诊断看） */
export function cardsRoot(): string {
  return DIR
}

/** 反应场景（顺序就是页面里的顺序） */
export const REACTIONS = [
  '开心',
  '难过',
  '被调侃',
  '主动调侃',
  '冲突被冒犯',
  '压力大',
  '无聊',
  '吵架',
] as const

export type ReactionKey = (typeof REACTIONS)[number]

export interface CharCard {
  id: string
  /** 卡片显示名（也是对话里的自称来源之一） */
  name: string
  /** 生日 = 第一次和它对话的日期（YYYY-MM-DD） */
  birthday: string
  /** 开启时，对话里带小括号动作描写 */
  actionDesc: boolean
  appearance: string
  identity: string
  /** 核心特质 / 优点 / 缺点 */
  traits: { core: string; good: string; bad: string }
  /** 语气 / 口头禅 */
  speech: { tone: string; catchphrase: string }
  /** 习惯的小动作，一行一条 */
  actions: string[]
  likes: string[]
  dislikes: string[]
  /** 反应：场景 → 表现 */
  reactions: Record<string, string>
  /** 原始正文（保存时整体写回，避免丢用户手写的其他段落） */
  raw?: string
}

const EMPTY_CARD = (id: string): CharCard => ({
  id,
  name: '',
  birthday: '',
  actionDesc: false,
  appearance: '',
  identity: '',
  traits: { core: '', good: '', bad: '' },
  speech: { tone: '', catchphrase: '' },
  actions: [],
  likes: [],
  dislikes: [],
  reactions: {},
})

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true })
}

/* ---------------- 解析 / 渲染 ---------------- */

function splitFront(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: m[2] ?? '' }
}

/** 取某个二级标题下的正文 */
function section(body: string, title: string): string {
  const re = new RegExp(`(?:^|\\n)##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)
  const m = re.exec(body)
  return m ? (m[1] ?? '').trim() : ''
}

/** 取列表（一行一条，去掉 - 前缀和空行） */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s?/, '').trim())
    .filter(Boolean)
}

/** 解析「key：value」行 */
function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('：')
    const j = i > 0 ? i : line.indexOf(':')
    if (j > 0) out[line.slice(0, j).trim()] = line.slice(j + 1).trim()
  }
  return out
}

export function parseCard(id: string, text: string): CharCard {
  const { meta, body } = splitFront(text)
  const card = EMPTY_CARD(id)
  card.raw = body.trim()
  card.name = meta['名字'] ?? ''
  card.birthday = meta['生日'] ?? ''
  card.actionDesc = meta['小动作描写'] === '开'
  card.appearance = section(body, '外貌')
  card.identity = section(body, '基础身份')

  const t = pairs(section(body, '性格'))
  card.traits = { core: t['核心特质'] ?? '', good: t['优点'] ?? '', bad: t['缺点'] ?? '' }

  const s = pairs(section(body, '语言风格'))
  card.speech = { tone: s['语气'] ?? '', catchphrase: s['口头禅'] ?? '' }

  card.actions = lines(section(body, '习惯的小动作'))
  card.likes = lines(section(body, '喜欢'))
  card.dislikes = lines(section(body, '讨厌'))

  const r = pairs(section(body, '反应'))
  card.reactions = r
  return card
}

/** 序列化回 markdown。保留卡片里用户手写的其他段落（raw 里除已知节的都留着？）
 *
 * 简化：已知字段全部重写，未知段落（raw 里不属于已知节的）不保留 ——
 * 因为页面是唯一编辑入口。以后要保留再改。
 */
export function renderCard(card: CharCard): string {
  const meta = [
    '---',
    '名字: ' + (card.name || ''),
    '生日: ' + (card.birthday || ''),
    '小动作描写: ' + (card.actionDesc ? '开' : '关'),
    '---',
    '',
  ].join('\n')

  const parts: string[] = [meta]
  const sec = (title: string, content: string): void => {
    if (!content.trim()) return
    parts.push('## ' + title + '\n' + content.trim() + '\n')
  }

  sec('外貌', card.appearance)
  sec('基础身份', card.identity)

  const traitLines = [
    card.traits.core ? '核心特质：' + card.traits.core : '',
    card.traits.good ? '优点：' + card.traits.good : '',
    card.traits.bad ? '缺点：' + card.traits.bad : '',
  ]
    .filter(Boolean)
    .join('\n')
  sec('性格', traitLines)

  const speechLines = [
    card.speech.tone ? '语气：' + card.speech.tone : '',
    card.speech.catchphrase ? '口头禅：' + card.speech.catchphrase : '',
  ]
    .filter(Boolean)
    .join('\n')
  sec('语言风格', speechLines)

  sec('习惯的小动作', card.actions.map((a) => '- ' + a).join('\n'))
  sec('喜欢', card.likes.map((a) => '- ' + a).join('\n'))
  sec('讨厌', card.dislikes.map((a) => '- ' + a).join('\n'))

  const reactionLines = REACTIONS.filter((k) => card.reactions[k]?.trim())
    .map((k) => k + '：' + card.reactions[k]!.trim())
    .join('\n')
  sec('反应', reactionLines)

  return parts.join('\n')
}

/* ---------------- 它自己能改哪些字段 ---------------- */

/**
 * 允许它自己改的角色卡字段。
 *
 * 名字 / 生日 / 外貌 / 身份 **不在**这里 —— 那是主人定的底子，
 * 无论「它能自改角色卡」开着还是关着都不许它动。
 */
export const SELF_EDITABLE_FIELDS = [
  '核心特质',
  '优点',
  '缺点',
  '语气',
  '口头禅',
  '小动作',
  '喜欢',
  '讨厌',
  '反应',
] as const

/** 把 "a、b、c" / "a,b,c" / 换行分隔 拆成数组 */
function splitList(v: string): string[] {
  return v
    .split(/[、,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
}

/**
 * 把一条「字段 + 新值」合并进角色卡（原地改）。
 *
 * @returns 字段不在白名单里（或值不合法）时返回 false，调用方据此跳过。
 */
export function applyCardField(card: CharCard, field: string, value: string): boolean {
  const v = value.trim()
  if (!v) return false
  switch (field) {
    case '核心特质':
      card.traits.core = v
      return true
    case '优点':
      card.traits.good = v
      return true
    case '缺点':
      card.traits.bad = v
      return true
    case '语气':
      card.speech.tone = v
      return true
    case '口头禅':
      card.speech.catchphrase = v
      return true
    case '小动作': {
      const list = splitList(v)
      if (!list.length) return false
      card.actions = list
      return true
    }
    case '喜欢': {
      const list = splitList(v)
      if (!list.length) return false
      card.likes = list
      return true
    }
    case '讨厌': {
      const list = splitList(v)
      if (!list.length) return false
      card.dislikes = list
      return true
    }
    case '反应': {
      // 格式：「开心：笑出声」
      const m = /^(.{1,10}?)[：:]\s*(.+)$/.exec(v)
      if (!m?.[1] || !m[2]) return false
      card.reactions[m[1].trim()] = m[2].trim().slice(0, 120)
      return true
    }
    default:
      return false
  }
}

/* ---------------- 读写 ---------------- */

function cardPath(id: string): string {
  return join(DIR, id + '.md')
}

/**
 * 卡片 id 合法性。
 *
 * 踩过的坑：切换时把 <id>.self.md（self.md 的归档）当成了角色卡，
 * 切一次多一张，越滚越多。所以 id 里不允许出现 .self，也不允许路径分隔符。
 */
function validCardId(id: string): boolean {
  const v = String(id || '').trim()
  if (!v || v.length > 64) return false
  // .self 后缀（Windows 大小写不敏感，x.SELF 和 x.self 是同一个文件）
  if (v.toLowerCase().endsWith('.self')) return false
  // 路径分隔符和 .. 一律拒绝：否则 join 归一化后会写到 cards 目录外面
  if (/[\\/]/.test(v) || v.includes('..') || v.includes(':')) return false
  // Windows 保留设备名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)) return false
  return true
}

/** 当前卡片 id（没有就返回空串） */
export function currentCardId(): string {
  try {
    if (existsSync(CURRENT)) {
      const id = readFileSync(CURRENT, 'utf8').trim()
      // 指向不存在的卡 / 脏 id 都当没有，否则后续会越切越多
      if (validCardId(id) && existsSync(cardPath(id))) return id
    }
  } catch {
    /* 读不到当没有 */
  }
  return ''
}

// 当前卡 id 的小缓存：这些按卡隔离的文件（生活线/说话方式/黑话/心情）每条消息都要读，
// 每次都读 current.txt 太亏。切卡时会清掉。
let curCardCache: { id: string; at: number } | null = null

export function currentCardIdCached(): string {
  const now = Date.now()
  if (curCardCache && now - curCardCache.at < 1000) return curCardCache.id
  const id = currentCardId()
  curCardCache = { id, at: now }
  return id
}

/**
 * 当前角色的「私有」数据文件：life / plays / jargon / mood。
 *
 * 换卡就是换人：这些是这个人自己的经历和学到的说法，必须跟着卡走。
 * 没有卡的时候（老数据/异常）回退到原来的全局路径，保证不丢。
 */
/**
 * 「某个人」和「某个角色」的关系文件：relation.yaml / impression.md。
 *
 * 同一个 QQ 好友，在不同角色卡眼里是不同的人（关系深浅、印象都不同），
 * 所以按卡再分一层；没有卡时回退到老路径。
 */
export function personScopedPath(personId: string, name: string, fallback: string): string {
  const id = currentCardIdCached()
  if (!id) return fallback
  return join('persona', 'people', personId, 'cards', id, name)
}

/** 当前角色的记忆根目录（episodes / insights / raw 都在这下面） */
export function cardMemoryRoot(): string {
  return cardScopedPath('memory', 'persona/memory')
}
export function cardScopedPath(name: string, globalPath: string): string {
  const id = currentCardIdCached()
  if (!id) return globalPath
  return join(DIR, id, name)
}

/** 切卡后清缓存，下一次读路径立刻生效 */
export function resetCardCache(): void {
  curCardCache = null
}

export function listCards(): Array<{ id: string; name: string }> {
  ensureDir()
  try {
    return readdirSync(DIR)
      .filter((f) => /\.md$/i.test(f) && !/\.self\.md$/i.test(f))
      .map((f) => {
        const id = f.slice(0, -3)
        let name = id
        try {
          name = parseCard(id, readFileSync(cardPath(id), 'utf8')).name || id
        } catch {
          /* 坏文件用 id */
        }
        return { id, name }
      })
  } catch {
    return []
  }
}

export function loadCard(id?: string): CharCard | null {
  const cid = id || currentCardId()
  if (!cid || !validCardId(cid)) return null
  try {
    if (!existsSync(cardPath(cid))) return null
    return parseCard(cid, readFileSync(cardPath(cid), 'utf8'))
  } catch {
    return null
  }
}

export function saveCard(card: CharCard): void {
  ensureDir()
  if (!validCardId(card.id)) throw new Error('角色卡 id 不合法：' + card.id)
  writeAtomic(cardPath(card.id), renderCard(card))
}

/**
 * 没有角色卡时，从 self.md 的名字生成一张默认卡。
 * 这样老用户打开页面不会是空的。
 */
export function ensureDefaultCard(fallbackName: string): CharCard {
  const cur = loadCard()
  if (cur) return cur
  // 只有「从来没有过卡」时才建默认卡。current.txt 缺失/指向已删的卡时，
  // 之前每次 GET /api/card 都重写一遍 cards/default.md —— 用户编辑过的默认卡
  // 刷新页面就被清空，而且指针一直不写，对话里根本不用这张卡。
  if (existsSync(cardPath('default'))) {
    const existing = loadCard('default')
    if (existing) {
      // 已经在磁盘上：只补指针，不重写内容
      try {
        writeAtomic(CURRENT, 'default')
      } catch {
        /* 写不了指针也不影响读 */
      }
      return existing
    }
  }
  const card: CharCard = { ...EMPTY_CARD('default'), name: fallbackName || '' }
  saveCard(card)
  try {
    writeAtomic(CURRENT, 'default')
  } catch {
    /* ignore */
  }
  return card
}

/**
 * 把角色卡渲染成 prompt 里的一段人设。
 *
 * 只输出有内容的字段，避免一堆空标签把 prompt 撑长。
 */
export function cardPromptBlock(card: CharCard | null): string {
  if (!card) return ''
  const lines: string[] = []
  const push = (label: string, v: string): void => {
    if (v && v.trim()) lines.push(`- ${label}：${v.trim()}`)
  }

  // 每个字段都截断：粘贴导入的长卡会把 system 撑到几千字，
  // 挤压硬约束还涨每轮成本。600 字/字段、2000 字总量封顶。
  const clip = (s: string, n = 600): string => {
    const t = String(s || '').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  // 名字不在这里写：self 段统一说（它可能自己取过名，两处都写会互相打架）
  push('外貌', clip(card.appearance))
  push('基础身份', clip(card.identity))
  if (card.traits.core) push('核心特质', clip(card.traits.core))
  if (card.traits.good) push('优点', clip(card.traits.good))
  if (card.traits.bad) push('缺点', clip(card.traits.bad))
  if (card.speech.tone) push('语气', clip(card.speech.tone))
  if (card.speech.catchphrase) push('口头禅', clip(card.speech.catchphrase))
  if (card.actions.length) lines.push('- 习惯的小动作：' + clip(card.actions.map((a) => a.trim()).filter(Boolean).join('、'), 300))
  if (card.likes.length) lines.push('- 喜欢：' + clip(card.likes.map((a) => a.trim()).filter(Boolean).join('、'), 300))
  if (card.dislikes.length) lines.push('- 讨厌：' + clip(card.dislikes.map((a) => a.trim()).filter(Boolean).join('、'), 300))

  // 白名单场景排前面，其余场景（用户自己写的「被夸 / 深夜」）也带上：
  // 之前只渲染白名单，粘贴进来的自定义场景全丢了。
  const customKeys = Object.keys(card.reactions).filter((k) => card.reactions[k]?.trim())
  const ordered = [
    ...REACTIONS.filter((k) => customKeys.includes(k)),
    ...customKeys.filter((k) => !(REACTIONS as readonly string[]).includes(k)),
  ]
  const reactions = ordered
  if (reactions.length) {
    lines.push('- 不同情境下的反应：')
    for (const k of reactions) lines.push(`  · ${k}：${card.reactions[k]!.trim()}`)
  }

  if (!lines.length) return ''
  return ['关于你这个人的设定：', ...lines].join('\n')
}

/**
 * 切换角色卡。
 *
 * 用户要的是「跟着走」——换卡就是换一个人，所以 self.md（名字/自述）
 * 也要跟着换：
 *   1. 当前 self.md 归档成 <旧卡>.self.md
 *   2. 新卡的 <新卡>.self.md 恢复成 self.md（没有就按卡名新建）
 *   3. 改 current 指针
 *
 * 这样每张卡有自己的名字和自述，互不覆盖。
 */
/** self.md 里有没有实质内容（空模板不算，免得覆盖掉旧归档） */
function selfHasContent(text: string): boolean {
  if (/我·[^:]+:\s*\S/.test(text)) return true
  const body = text.replace(/^---[\s\S]*?---\s*/, '')
  return body.split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('#'))
}

/**
 * 把老的「全局」生活线/说话方式/黑话/心情，复制到当前卡自己的目录里。
 *
 * 只复制不删除：老文件留着当备份，万一哪里还读它也不会空。
 * 只在目标不存在时复制，所以重复调用是幂等的。
 */
export function ensureCardScopedData(): void {
  const id = currentCardId()
  if (!id) return
  const dir = join(DIR, id)
  mkdirSync(dir, { recursive: true })
  const pairs: Array<[string, string]> = [
    ['life.md', 'persona/life.md'],
    ['plays.md', 'persona/learned/plays.md'],
    ['jargon.yaml', 'persona/jargon.yaml'],
    ['mood.yaml', 'persona/mood.yaml'],
  ]
  for (const [name, legacy] of pairs) {
    const dest = join(dir, name)
    if (existsSync(dest)) continue
    if (!existsSync(legacy)) continue
    try {
      copyFileSync(legacy, dest)
    } catch {
      /* 复制失败就算了，下次启动再试 */
    }
  }
  const memDest = join(dir, 'memory')
  if (!existsSync(memDest) && existsSync('persona/memory')) {
    try {
      cpSync('persona/memory', memDest, { recursive: true })
    } catch {
      /* 下次启动再试 */
    }
  }

  // 每个人和这个角色的关系/印象：按人复制到 people/<id>/cards/<card>/
  try {
    const peopleRoot = 'persona/people'
    for (const e of readdirSync(peopleRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const srcDir = join(peopleRoot, e.name)
      const destDir = join(srcDir, 'cards', id)
      for (const f of ['relation.yaml', 'impression.md']) {
        const src = join(srcDir, f)
        const dest = join(destDir, f)
        if (existsSync(dest) || !existsSync(src)) continue
        try {
          mkdirSync(destDir, { recursive: true })
          copyFileSync(src, dest)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* people 目录不存在就算了 */
  }
}
export function switchCard(id: string): { ok: boolean; error?: string } {
  const clean = String(id || '').trim()
  if (!validCardId(clean)) return { ok: false, error: '卡片 id 不合法' }
  const target = loadCard(clean)
  if (!target) return { ok: false, error: '没有这张卡' }

  const cur = currentCardId()
  if (cur === clean) return { ok: true }

  const SELF = 'persona/self.md'
  ensureDir()

  // 1) 归档当前 self.md —— 短自述也要归档（之前用长度启发式，短的自述会丢）
  try {
    if (existsSync(SELF)) {
      const text = readFileSync(SELF, 'utf8')
      if (cur) {
        const saved = join(DIR, cur + '.self.md')
        // 有内容就覆盖；没内容且已有归档时，保留旧归档（别用空模板砸掉）
        if (selfHasContent(text) || !existsSync(saved)) copyFileSync(SELF, saved)
      } else {
        // current 指针脏/缺失：不知道该归给哪张卡，单独存一份，绝不丢
        copyFileSync(SELF, join(DIR, '_orphan.self.md'))
      }
    }
  } catch (e) {
    warnAt('切换角色卡：归档 self.md 失败', { err: String(e) })
  }

  // 2) 恢复目标卡的 self.md
  try {
    const saved = join(DIR, clean + '.self.md')
    if (existsSync(saved)) copyFileSync(saved, SELF)
    else writeAtomic(SELF, '---\n名字: ' + (target.name || '') + '\n---\n\n# 我是谁\n\n')
  } catch (e) {
    // 恢复失败就别改指针了，否则卡和 self.md 会错位
    warnAt('切换角色卡：恢复 self.md 失败', { err: String(e) })
    return { ok: false, error: '恢复 self.md 失败：' + String(e) }
  }

  // 3) 指针放最后
  try {
    writeAtomic(CURRENT, clean)
    resetCardCache()
  } catch (e) {
    return { ok: false, error: '写 current 指针失败：' + String(e) }
  }
  return { ok: true }
}

/** 新建一张空卡（名字可给），并切成当前卡 */
export function createCard(name: string): CharCard {
  const id = 'card' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const card: CharCard = { ...EMPTY_CARD(id), name: name.trim() }
  saveCard(card)
  return card
}
