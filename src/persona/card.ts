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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../store/fs.ts'

const DIR = 'persona/cards'
const CURRENT = join(DIR, 'current.txt')

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

/* ---------------- 读写 ---------------- */

function cardPath(id: string): string {
  return join(DIR, id + '.md')
}

/** 当前卡片 id（没有就返回空串） */
export function currentCardId(): string {
  try {
    if (existsSync(CURRENT)) return readFileSync(CURRENT, 'utf8').trim()
  } catch {
    /* 读不到当没有 */
  }
  return ''
}

export function listCards(): Array<{ id: string; name: string }> {
  ensureDir()
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith('.md'))
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
  if (!cid) return null
  try {
    if (!existsSync(cardPath(cid))) return null
    return parseCard(cid, readFileSync(cardPath(cid), 'utf8'))
  } catch {
    return null
  }
}

export function saveCard(card: CharCard): void {
  ensureDir()
  writeAtomic(cardPath(card.id), renderCard(card))
  if (currentCardId() !== card.id) writeAtomic(CURRENT, card.id)
}

/**
 * 没有角色卡时，从 self.md 的名字生成一张默认卡。
 * 这样老用户打开页面不会是空的。
 */
export function ensureDefaultCard(fallbackName: string): CharCard {
  const cur = loadCard()
  if (cur) return cur
  const card: CharCard = { ...EMPTY_CARD('default'), name: fallbackName || '' }
  saveCard(card)
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

  if (card.name) lines.push(`你的名字是「${card.name}」。`)
  push('外貌', card.appearance)
  push('基础身份', card.identity)
  if (card.traits.core) push('核心特质', card.traits.core)
  if (card.traits.good) push('优点', card.traits.good)
  if (card.traits.bad) push('缺点', card.traits.bad)
  if (card.speech.tone) push('语气', card.speech.tone)
  if (card.speech.catchphrase) push('口头禅', card.speech.catchphrase)
  if (card.actions.length) lines.push('- 习惯的小动作：' + card.actions.map((a) => a.trim()).filter(Boolean).join('、'))
  if (card.likes.length) lines.push('- 喜欢：' + card.likes.map((a) => a.trim()).filter(Boolean).join('、'))
  if (card.dislikes.length) lines.push('- 讨厌：' + card.dislikes.map((a) => a.trim()).filter(Boolean).join('、'))

  const reactions = REACTIONS.filter((k) => card.reactions[k]?.trim())
  if (reactions.length) {
    lines.push('- 不同情境下的反应：')
    for (const k of reactions) lines.push(`  · ${k}时：${card.reactions[k]!.trim()}`)
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
export function switchCard(id: string): { ok: boolean; error?: string } {
  const cur = currentCardId()
  if (!id) return { ok: false, error: '没指定卡片' }
  const target = loadCard(id)
  if (!target) return { ok: false, error: '没有这张卡' }
  if (cur === id) return { ok: true }

  const SELF = 'persona/self.md'
  ensureDir()
  try {
    if (cur && existsSync(SELF)) copyFileSync(SELF, join(DIR, cur + '.self.md'))
  } catch {
    /* 归档失败不阻断切换 */
  }
  try {
    const saved = join(DIR, id + '.self.md')
    if (existsSync(saved)) {
      copyFileSync(saved, SELF)
    } else {
      // 新卡：从零开始，名字用卡上的名字
      writeAtomic(SELF, '---\n名字: ' + (target.name || '') + '\n---\n\n# 我是谁\n\n')
    }
  } catch {
    /* 恢复失败也不阻断 */
  }
  writeAtomic(CURRENT, id)
  return { ok: true }
}

/** 新建一张空卡（名字可给），并切成当前卡 */
export function createCard(name: string): CharCard {
  const id = 'card' + Date.now().toString(36)
  const card: CharCard = { ...EMPTY_CARD(id), name: name.trim() }
  saveCard(card)
  return card
}