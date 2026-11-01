/**
 * 角色卡文本解析：把用户从别处复制来的一段人设，认成结构化字段。
 *
 * 为什么要这个：角色卡信息常常是从别的平台（贴吧/character.ai/文档）复制来的，
 * 格式五花八门。让用户逐个字段手抄太反人性。
 *
 * 做法是**规则解析**而不是调模型：
 *   - 快、免费、离线可用
 *   - 认不出来的部分原样留在 rest 里，让用户手动放
 *
 * 认得的写法：
 *   名字：xxx            （中英文冒号都行）
 *   ## 外貌 / 【外貌】 / [外貌]
 *   外貌: xxx
 *   - 列表项（小动作/喜欢/讨厌）
 *   开心：xxx            （反应场景）
 */

export interface ParsedCard {
  name?: string
  appearance?: string
  identity?: string
  traits: { core?: string; good?: string; bad?: string }
  speech: { tone?: string; catchphrase?: string }
  actions: string[]
  likes: string[]
  dislikes: string[]
  reactions: Record<string, string>
  /** 没认出来的原文（前端展示"下面这些没认出来，手动放"） */
  rest: string
}

/** 字段别名 → 目标 */
const ALIAS: Record<string, string> = {
  名字: 'name',
  姓名: 'name',
  名称: 'name',
  称呼: 'name',
  外貌: 'appearance',
  外观: 'appearance',
  长相: 'appearance',
  形象: 'appearance',
  外表: 'appearance',
  样貌: 'appearance',
  身份: 'identity',
  职业: 'identity',
  基础身份: 'identity',
  设定: 'identity',
  核心特质: 'core',
  性格: 'core',
  性格特点: 'core',
  特质: 'core',
  性格特征: 'core',
  优点: 'good',
  长处: 'good',
  缺点: 'bad',
  弱点: 'bad',
  短处: 'bad',
  语气: 'tone',
  说话风格: 'tone',
  语言风格: 'tone',
  说话方式: 'tone',
  口头禅: 'catchphrase',
  小动作: 'actions',
  习惯动作: 'actions',
  习惯的小动作: 'actions',
  习惯: 'actions',
  喜欢: 'likes',
  喜好: 'likes',
  爱好: 'likes',
  讨厌: 'dislikes',
  厌恶: 'dislikes',
  不喜欢: 'dislikes',
  反感: 'dislikes',
  反应: 'reactions',
  不同情境下的反应: 'reactions',
}

/** 反应场景别名 */
const REACTION_ALIAS: Record<string, string> = {
  开心: '开心',
  高兴: '开心',
  难过: '难过',
  伤心: '难过',
  被调侃: '被调侃',
  被开玩笑: '被调侃',
  主动调侃: '主动调侃',
  调侃别人: '主动调侃',
  冲突: '冲突被冒犯',
  被冒犯: '冲突被冒犯',
  被说: '冲突被冒犯',
  压力: '压力大',
  压力大: '压力大',
  无聊: '无聊',
  吵架: '吵架',
  争执: '吵架',
}

function normKey(s: string): string {
  return s
    .replace(/^[#*\-\s]+/, '')
    .replace(/[【\[（(].*?[】\]）)]/g, '')
    .replace(/[：:]\s*$/, '')
    .trim()
}

/** 尝试把一行识别成「键：值」 */
function splitKV(line: string): { key: string; value: string } | null {
  const m = /^\s*(?:[-*]\s*)?([^：:]{1,12})[：:]\s*(.*)$/.exec(line)
  if (!m) return null
  return { key: m[1]!.trim(), value: m[2]!.trim() }
}

/** 裸标题：整行就是别名（外貌 / 基础身份 / 喜好…），不带 # 和冒号 */
function bareHeading(line: string): string | null {
  const t = line.trim()
  if (!t || t.length > 12) return null
  if (/[：:→]/.test(t)) return null
  const k = normKey(t)
  if (!k) return null
  return ALIAS[k] || REACTION_ALIAS[k] ? k : null
}

/** 箭头行：被夸 → 「哦。」…… （很多角色卡用箭头写反应） */
function splitArrow(line: string): { key: string; value: string } | null {
  const m = /^\s*(?:[-*]\s*)?([^→:：]{1,12})\s*→\s*(.+)$/.exec(line)
  if (!m) return null
  return { key: m[1]!.trim(), value: m[2]!.trim() }
}

/** 空白分隔的键值：核心特质    混世小魔头… （表格复制常见） */
function splitSpaceKV(line: string): { key: string; value: string } | null {
  const m = /^\s*([^\s：:]{1,12})\s{2,}(.+)$/.exec(line)
  if (!m) return null
  return { key: m[1]!.trim(), value: m[2]!.trim() }
}


/** 标题行：## 外貌 / 【外貌】 / [外貌] / 外貌: */
function headingKey(line: string): string | null {
  const t = line.trim()
  if (/^#{1,4}\s*\S/.test(t)) return normKey(t.replace(/^#{1,4}\s*/, ''))
  const m = /^[【\[]([^】\]]{1,12})[】\]]\s*$/.exec(t)
  if (m) return normKey(m[1]!)
  return null
}

export function parseCardText(text: string): ParsedCard {
  const out: ParsedCard = {
    traits: {},
    speech: {},
    actions: [],
    likes: [],
    dislikes: [],
    reactions: {},
    rest: '',
  }
  const rest: string[] = []

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  /** 当前正在收集的字段 */
  let cur: string | null = null

  const pushValue = (target: string, value: string): void => {
    if (!value) return
    if (target === 'name') { if (!out.name) out.name = value }
    else if (target === 'appearance') out.appearance = out.appearance ? out.appearance + '\n' + value : value
    else if (target === 'identity') out.identity = out.identity ? out.identity + '\n' + value : value
    else if (target === 'core') out.traits.core = out.traits.core ? out.traits.core + '，' + value : value
    else if (target === 'good') out.traits.good = out.traits.good ? out.traits.good + '，' + value : value
    else if (target === 'bad') out.traits.bad = out.traits.bad ? out.traits.bad + '，' + value : value
    else if (target === 'tone') out.speech.tone = out.speech.tone ? out.speech.tone + '，' + value : value
    else if (target === 'catchphrase') out.speech.catchphrase = out.speech.catchphrase ? out.speech.catchphrase + '，' + value : value
    else if (target === 'actions') out.actions.push(value)
    else if (target === 'likes') out.likes.push(value)
    else if (target === 'dislikes') out.dislikes.push(value)
    else if (target === 'reactions') {
      // 组标题下没写场景名的裸文本：别丢，留给用户手动放
      rest.push(value)
    } else if (target.startsWith('r:')) {
      const k = target.slice(2)
      out.reactions[k] = out.reactions[k] ? out.reactions[k] + '，' + value : value
    } else rest.push(value)
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    // 0) 噪音：从别的 UI 复制时带的按钮字、表格表头
    if (!line.trim()) continue

    const noise = line.trim()
    if (/^(复制|复制代码|复制全部|格\s+填什么|字段\s*填什么)$/.test(noise)) continue
    if (/^(建议|注[:：]|说明[:：])/.test(noise)) {
      rest.push(noise)
      continue
    }

    // 0.5) 裸标题：整行就是别名（外貌 / 基础身份 / 喜好…）
    const bh = bareHeading(line)
    if (bh && !splitKV(line) && !splitArrow(line)) {
      cur = ALIAS[bh] ?? (REACTION_ALIAS[bh] ? 'r:' + REACTION_ALIAS[bh] : null)
      continue
    }


    // 2.5) 空白分隔的键值 / 箭头（表格复制常见）
    const sk = splitSpaceKV(line)
    if (sk) {
      const k2 = normKey(sk.key)
      const t2 = ALIAS[k2]
      const r2 = REACTION_ALIAS[k2]
      if (t2 || r2) {
        if (t2) {
          pushValue(t2, sk.value)
          cur = t2
        } else {
          pushValue('r:' + r2, sk.value)
          cur = 'r:' + r2
        }
        continue
      }
    }
    const ar = splitArrow(line)
    if (ar) {
      // 任意场景名都收（用户常写「被夸 / 被凶 / 深夜」这种自由场景）
      const k3 = normKey(ar.key)
      if (k3) {
        pushValue('r:' + k3, ar.value)
        cur = 'r:' + k3
        continue
      }
    }

    // 1) 标题行
    const hk = headingKey(line)
    if (hk) {
      const target = ALIAS[hk]
      if (target) {
        cur = target
        continue
      }
      const rk = REACTION_ALIAS[hk]
      if (rk) {
        cur = 'r:' + rk
        continue
      }
      // 认不出的标题：当普通文本，结束当前字段
      cur = null
      rest.push(line.trim())
      continue
    }

    // 2) 键：值
    const kv = splitKV(line)
    if (kv) {
      const key = normKey(kv.key)
      const target = ALIAS[key]
      const rk = REACTION_ALIAS[key]
      if (target) {
        if (kv.value) pushValue(target, kv.value.replace(/^[-*]\s*/, ''))
        cur = target
        continue
      }
      if (rk) {
        if (kv.value) pushValue('r:' + rk, kv.value)
        cur = 'r:' + rk
        continue
      }
      // 认不出这个键：当成普通行处理，并且不要让它继承上一个字段
      cur = null
    }

    // 3) 列表项 / 普通行：归到当前字段
    const item = line.replace(/^\s*[-*·]\s*/, '').trim()
    if (!item) continue
    if (cur) pushValue(cur, item)
    else rest.push(line.trim())
  }

  out.rest = rest.join('\n')
  return out
}

