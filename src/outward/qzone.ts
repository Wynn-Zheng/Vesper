/**
 * QQ 空间说说：草稿模式。
 *
 * 为什么是草稿：
 *   发出去的内容收不回来（虽然 NapCat 有 delete_qzone_msg，但看到的人已经看到了）。
 *   所以流程是：它想发 → 写草稿 → 人看过点发 → 才真发。
 *
 * 草稿存 persona/qzone-draft.md，人能直接改。
 */
import { existsSync, readFileSync } from 'node:fs'
import { info, warnAt } from '../core/log.ts'
import { writeAtomic } from '../store/fs.ts'
import type { QzonePost, Transport } from '../core/transport.ts'
import type { LlmOptions } from '../llm/types.ts'

const FILE = 'persona/qzone-draft.md'
/** 草稿最多留几条 */
const MAX_DRAFTS = 5

export interface Draft {
  at: number
  content: string
  /** 想配的图 */
  images: string[]
  /** 为什么想发（它自己的一句话） */
  reason?: string
  /** 已经发出去了？发过的保留记录 */
  tid?: string
}

interface DraftFile {
  drafts: Draft[]
  /** 发过的（最多留 20 条，方便回看/删） */
  published: Array<{ tid: string; at: number; content: string }>
}

function load(): DraftFile {
  if (!existsSync(FILE)) return { drafts: [], published: [] }
  try {
    const raw = readFileSync(FILE, 'utf8')
    // 人可能手改过这个文件，所以按 markdown 解析，不是 JSON
    return parseMarkdown(raw)
  } catch {
    warnAt('说说草稿读不出来，按空的处理', { file: FILE })
    return { drafts: [], published: [] }
  }
}

/**
 * 用 markdown 存，人能直接改。
 *
 * 格式：
 *   ## 2026-10-26 19:00
 *   - 为什么想发：今天聊到熬夜
 *   正文第一行
 *   正文第二行
 *   ---
 */
function parseMarkdown(text: string): DraftFile {
  const out: DraftFile = { drafts: [], published: [] }
  const blocks = text.split(/^---$/m)

  for (const block of blocks) {
    const t = block.trim()
    if (!t) continue
    const head = /^##\s+(\d{4}-\d{2}-\d{2}[ T][\d:]+)(?:\s*\[已发\s*(\S+)\])?/m.exec(t)
    if (!head) continue

    const at = Date.parse(head[1]!.replace(' ', 'T')) || Date.now()
    const tid = head[2]
    // 从匹配位置之后切，不是从字符串开头切——
    // 第一段前面还有文件头（"# 想说说的草稿" 和那几行说明）
    const rest = t.slice((head.index ?? 0) + head[0].length).trim()

    const reasonMatch = /^- 为什么想发：(.*)$/m.exec(rest)
    const reason = reasonMatch?.[1]?.trim()
    const body = rest
      .replace(/^- 为什么想发：.*$/m, '')
      .replace(/^- 图片：.*$/m, '')
      .trim()

    const imgs = /^- 图片：(.*)$/m.exec(rest)?.[1]?.split(/[,，\s]+/).filter(Boolean) ?? []

    if (tid) out.published.push({ tid, at, content: body })
    else if (body) out.drafts.push({ at, content: body, images: imgs, ...(reason ? { reason } : {}) })
  }

  out.published = out.published.slice(-20)
  return out
}

function render(c: DraftFile): string {
  const lines: string[] = [
    '# 想说说的草稿',
    '',
    '> 这里是我攒着想发、但还没发的说说。你改完、觉得能发，就在控制台点「发出去」。',
    '> 也可以直接改这个文件，改完刷新控制台就能看到。',
    '',
  ]

  if (!c.drafts.length) {
    lines.push('（现在没有草稿）', '')
  } else {
    for (const d of c.drafts) {
      const when = new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')
      lines.push(`## ${when}`)
      if (d.reason) lines.push(`- 为什么想发：${d.reason}`)
      if (d.images.length) lines.push(`- 图片：${d.images.join(', ')}`)
      lines.push(d.content)
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  if (c.published.length) {
    lines.push('## 已经发过的（留个记录）', '')
    for (const p of c.published.slice(-5).reverse()) {
      const when = new Date(p.at).toISOString().slice(0, 16).replace('T', ' ')
      lines.push(`## ${when} [已发 ${p.tid}]`)
      lines.push(p.content.slice(0, 80))
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  return lines.join('\n')
}

/** 攒一条草稿 */
export async function saveDraft(content: string, opts: { images?: string[]; reason?: string } = {}): Promise<boolean> {
  const text = content.trim().slice(0, 1000)
  if (text.length < 4) return false

  const c = load()
  // 和已有的太像就不攒了。
  // 只做精确比较不够——实测模型连写三条都是"杯子挪了三次还是放回原位…"，
  // 措辞不同但说的是同一件事。
  const { similarity, sharedBigrams } = await import('../core/text.ts')
  const tooSimilar = (a: string, b: string): boolean => {
    if (a === b) return true
    if (similarity(a, b) > 0.5) return true
    const need = Math.max(5, Math.floor(Math.min(a.length, b.length) / 4))
    return sharedBigrams(a, b) >= need
  }
  if (c.drafts.some((d) => tooSimilar(d.content, text))) {
    info('这条和已有草稿太像，不攒了', { 内容: text.slice(0, 20) })
    return false
  }

  c.drafts.push({
    at: Date.now(),
    content: text,
    images: (opts.images ?? []).slice(0, 9),
    ...(opts.reason ? { reason: opts.reason.slice(0, 60) } : {}),
  })
  // 只留最近几条
  while (c.drafts.length > MAX_DRAFTS) c.drafts.shift()

  writeAtomic(FILE, render(c))
  info('攒了一条说说草稿', { 长度: text.length })
  return true
}

/** 读草稿（控制台用） */
export function loadDrafts(): { drafts: Draft[]; published: DraftFile['published'] } {
  const c = load()
  return { drafts: c.drafts, published: c.published }
}

/** 改一条草稿（人可能在控制台改字） */
export function editDraft(index: number, content: string): boolean {
  const c = load()
  const d = c.drafts[index]
  if (!d) return false
  const text = content.trim().slice(0, 1000)
  if (text.length < 4) return false
  d.content = text
  writeAtomic(FILE, render(c))
  return true
}

/** 删一条草稿 */
export function dropDraft(index: number): boolean {
  const c = load()
  if (!c.drafts[index]) return false
  c.drafts.splice(index, 1)
  writeAtomic(FILE, render(c))
  return true
}

/**
 * 真发一条草稿。
 *
 * 只能人触发——它自己调不到这里（没有对应工具）。
 */
export async function publishDraft(
  transport: Transport,
  index: number,
  opts: { ugcRight?: number } = {},
): Promise<{ ok: boolean; tid?: string; reason?: string }> {
  if (!transport.sendQzone) {
    return { ok: false, reason: '当前通道不支持发说说' }
  }

  const c = load()
  const d = c.drafts[index]
  if (!d) return { ok: false, reason: '没有这条草稿' }

  const post: QzonePost = {
    content: d.content,
    ugcRight: opts.ugcRight ?? 1,
    ...(d.images.length ? { images: d.images } : {}),
  }

  try {
    const r = await transport.sendQzone(post)
    c.drafts.splice(index, 1)
    c.published.push({ tid: r.tid, at: Date.now(), content: d.content })
    c.published = c.published.slice(-20)
    writeAtomic(FILE, render(c))
    info('说说发出去了', { tid: r.tid })
    return { ok: true, tid: r.tid }
  } catch (err) {
    warnAt('发说说失败', { err: String(err).slice(0, 100) })
    return { ok: false, reason: String(err).slice(0, 120) }
  }
}

/** 删一条已经发出去的（NapCat 支持 delete_qzone_msg） */
export async function unpublish(transport: Transport, tid: string): Promise<boolean> {
  if (!transport.deleteQzone) return false
  const ok = await transport.deleteQzone(tid)
  if (!ok) return false
  const c = load()
  c.published = c.published.filter((p) => p.tid !== tid)
  writeAtomic(FILE, render(c))
  info('说说删了', { tid })
  return true
}

/**
 * 让它自己想一条说说。
 *
 * 只在人点「让它想一条」时调。它自己不会主动发——
 * 发出去收不回，必须人看过。
 */
export async function composeDraft(
  llm: LlmOptions,
  rules: { 外部?: { 发空间?: { 开启?: boolean } } },
): Promise<{ ok: boolean; content?: string; reason?: string }> {
  if (!rules.外部?.发空间?.开启) return { ok: false, reason: '发空间没开' }
  if (!llm.apiKey || !llm.baseUrl || !llm.model) return { ok: false, reason: '模型没配好' }

  const { loadSelf, recentLife } = await import('../self/store.ts')
  const { loadMood } = await import('../persona/mood.ts')

  const self = loadSelf()
  const mood = loadMood()
  const life = recentLife(3)

  // 把已有的草稿也告诉它：不然会连着写三条一样的
  const { loadDrafts } = await import('./qzone.ts').catch(() => ({ loadDrafts: () => ({ drafts: [] }) }))
  const existing = loadDrafts().drafts.map((d) => d.content).slice(-5)

  const material = [
    self.name ? '我叫「' + self.name + '」' : '我还没有名字',
    self.about ? '我对自己：' + self.about : '',
    mood ? '我现在心情：' + mood.emotion + '（' + mood.intensity.toFixed(1) + '）' : '',
    life.length ? '我最近：' + life.join('；') : '',
    existing.length ? '我之前想发过：\n' + existing.map((x) => '- ' + x).join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n')

  const SYSTEM = [
    '你想往 QQ 空间发一条说说。只输出说说正文，不要解释，不要引号，不要 markdown。',
    '',
    '要求：',
    '- 一到三句，像自己嘀咕，不是写作文。',
    '- 具体，不要"今天也要元气满满"这种空话。',
    '- 不要提"AI""模型""程序"这些。',
    '- 不确定该不该发的，宁可不发（输出空字符串）。',
    '- 如果下面列出了我之前想发的，别写和它们一个意思的东西。',
  ].join('\n')

  try {
    const { chat } = await import('../llm/deepseek.ts')
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 160, temperature: 0.9 },
    )
    const content = res.text.trim().replace(/^["'「」]+|["'「」]+$/g, '').slice(0, 300)
    if (content.length < 6) return { ok: false, reason: '没想出什么想发的' }
    // saveDraft 返回 false = 和已有草稿太像，没攒。
    // 这时候不能报"想出来了"，不然点了没反应还以为是成功了。
    const saved = await saveDraft(content, { reason: '自己想发的' })
    if (!saved) {
      return { ok: false, content, reason: '想出来的和已有的草稿太像，没攒（换个角度再试一次）' }
    }
    return { ok: true, content }
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 80) }
  }
}
