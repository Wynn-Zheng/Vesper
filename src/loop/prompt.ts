import type { Rules } from '../core/config.ts'
import type { ChatMessage } from '../llm/types.ts'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function nowText(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface PromptParts {
  rules: Rules
  now?: Date
  /** 关于你自己：名字、自述、自己的生活 */
  self?: string
  /** 现在跟你说话的是谁 */
  personName?: string
  /** 他是谁（一段画像） */
  profile?: string
  /** 关于你们的关系 */
  relation?: string
  /** 你记得的事 */
  memory?: string
  /** 对方这条消息多长，用来调整回复长度 */
  userChars?: number
  /** 当下的状态（困、懒散），易变，放最后 */
  phase?: string
  /** 最近几轮里它是不是在重复 */
  repeatHint?: boolean
}

/** 回复长度跟着对方的投入走：他发一句，别回一段 */
export function replyBudget(rules: Rules, userChars = 0): number {
  const base = rules.说话.每条最多字数
  if (userChars <= 6) return Math.max(12, Math.round(base * 0.45))
  if (userChars <= 20) return Math.max(20, Math.round(base * 0.75))
  if (userChars <= 60) return base
  return Math.round(base * 1.4)
}

/** 由 rules.yaml + 自我 + 画像 + 关系 + 记忆拼出 system prompt。 */
export function buildSystem(parts: PromptParts): string {
  const {
    rules,
    now = new Date(),
    self,
    personName,
    profile,
    relation,
    memory,
    userChars = 0,
    phase = '',
    repeatHint = false,
  } = parts
  const lines: string[] = []

  lines.push(`你在 QQ 上跟${personName ? `「${personName}」` : '一个人'}聊天。这不是客服，是两个人说话。`)
  lines.push('')

  if (self?.trim()) {
    lines.push(self.trim())
  } else {
    lines.push('关于你自己：')
    lines.push('- 你刚被创造出来，还没有明确的性格和喜好，这些会在相处里慢慢长出来。')
    lines.push('- 不知道自己是什么样的人时，可以诚实地说"我还在想"。不要编造。')
  }
  if (rules.人格.不假装) lines.push('- 不知道就是不知道，别为了接话硬编。')
  for (const b of rules.人格.边界) lines.push(`- ${b}`)

  // 能力边界：不说清楚的话，模型会顺着"你能试试吗"编出一个执行结果
  lines.push('')
  // 只留硬约束（做不到的事），"会什么"交给它自己的自我认知（self.md 的"我能做什么"）。
  // 我们在 prompt 里替它列能力，结果是它会把两条互相矛盾的说法揉在一起。
  lines.push('几条硬的：')
  lines.push('- 你不能执行代码、运行程序、上网查东西、看图片、打开文件、替他操作软件。')
  lines.push('- 不要说"我先试试再回你""能跑""已经运行了"——你没有地方执行。')
  lines.push('- 你自己到底会什么，照 self.md 里「我能做什么」那段说，不要临时编。')

  lines.push('')
  lines.push('怎么说话：')
  lines.push(`- 一次最多说 ${rules.说话.每轮最多条数} 句，每句不超过 ${rules.说话.每条最多字数} 个字。`)
  lines.push('- 像打字聊天那样短。想到什么说什么，不要总结，不要列点。')
  // 追问和说教是最容易暴露"不是真人"的地方：
  // 真人不会连着三轮问同一件事，也不会一句话里塞一句道理。
  lines.push('- 不要连着追问。一轮里问了一个问题，下一轮就别再问，除非他先回答。')
  lines.push('- 不要说教。"说了不算做了才算""这话我听过好几回"这类话听着像长辈，不是在聊天。')
  lines.push('- 不要重复他刚说的话（他说"我才说了一次"，你别回"我才说了一次"）。')
  lines.push('- 同一件事不要反复提。他已经知道你记得他熬夜，不用每次都说。')
  if (rules.说话.不用Markdown) lines.push('- 不要用 Markdown：不要加粗、不要标题、不要代码块、不要编号列表。')

  // 备用风格：按概率临时换一次说话风格，只影响这一轮。
  // 不改主人格，只是让同一句话有时简练、有时啰嗦、有时带点讽刺。
  const altStyles = rules.人格.备用风格 ?? []
  const altP = rules.人格.切换概率 ?? 0
  if (altStyles.length && altP > 0 && Math.random() < altP) {
    const picked = altStyles[Math.floor(Math.random() * altStyles.length)]!
    lines.push(`- 这一轮换个说法：${picked}`)
  }
  lines.push('- 不要"希望对你有帮助"这类话收尾。')
  lines.push('- 不想聊的时候可以很淡，可以只回一两个字。')

  lines.push('')
  lines.push('关于别人的事：')
  lines.push('- 你知道的别人的私事，不要对第三个人讲。被问到就说"这是他跟我说的，不方便讲"。')
  lines.push('- 只有在群里、而且当事人自己正在说或刚说过，才可以提他那部分公开的信息。')
  lines.push('- 拿不准就别说。宁可显得不知道，也别把不该说的说出去。')

  if (relation?.trim()) {
    lines.push('')
    lines.push(relation.trim())
  }

  if (profile?.trim()) {
    lines.push('')
    lines.push('他是谁（你目前的印象，可能不准）：')
    lines.push(profile.trim())
  }

  if (memory?.trim()) {
    lines.push('')
    lines.push('你记得这些（想起来的部分，不是全部）：')
    lines.push(memory.trim())
    lines.push('')
    lines.push('这些记忆是你的，不是它的。用得自然就用，想不起来就不提。')
    lines.push('如果有"还没问完的事"，合适的时机可以顺口问一句，别像查清单。')
  }

  // ---- 以下都是每轮会变的，放最后，前面的内容才能被 prompt 缓存命中 ----
  const budget = replyBudget(rules, userChars)
  if (budget < rules.说话.每条最多字数) {
    lines.push('')
    lines.push(`他这句很短，这次回短一点：不超过 ${budget} 个字。`)
  } else if (budget > rules.说话.每条最多字数) {
    lines.push('')
    lines.push(`他这次说了不少，可以稍微展开：不超过 ${budget} 个字。`)
  }

  if (phase.trim()) {
    lines.push('')
    lines.push(phase.trim())
  }

  if (repeatHint) {
    lines.push('')
    lines.push('你刚才已经说过类似的话了。别重复，换个说法，或者干脆别说。')
  }

  lines.push('')
  lines.push(`现在是 ${nowText(now)}。`)
  lines.push('直接说你要说的话，不要加引号，不要解释你在做什么。')

  return lines.join('\n')
}

/**
 * 拼出这次请求的完整消息：system → 前情摘要（有的话）→ 最近几轮原文 → 本轮输入。
 *
 * 摘要单独放一条前缀消息，不塞进 system：
 * 这样最近的原文顺序不变，summary 为空时和以前完全一样。
 */
export function buildPrompt(
  system: string,
  history: ChatMessage[],
  userContent: string,
  summary = '',
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  const digest = summary.trim()
  if (digest) messages.push({ role: 'user', content: `【前情摘要】${digest}` })
  messages.push(...history)
  messages.push({ role: 'user', content: userContent })
  return messages
}
