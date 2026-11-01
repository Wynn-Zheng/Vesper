import type { Rules } from '../core/config.ts'
import type { ChatMessage } from '../llm/types.ts'
import { listPeople } from '../people/store.ts'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function nowText(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface PromptParts {
  /** 它已经提了、还在等主人批的修改申请（没批之前不算数） */
  requests?: string
  /** 这一轮是不是在控制台里聊（不是 QQ） */
  /** 关键词反应：命中关键词后给模型的提示（空串 = 没命中） */
  keyword?: string
  consoleMode?: boolean
  /** 核心记忆（只能人改的那部分），优先级最高 */
  core?: string
  /** 说话习惯（从它自己说过的话统计出来的） */
  speech?: string
  /**
   * 在这个群里学到的说法（从群友嘴里捞的、能自用的表达）。
   *
   * 和 speech 的区别：speech 是"它说话什么形状"（长度、问句比例），
   * 是统计出来的；这个学的是这个群的口音，是可以拿来用的词和说法。
   */
  expression?: string
  /** 成长的痕迹：它以前怎么看自己、现在怎么看 */
  growth?: string
  /**
   * 电脑操作开了没。决定"不能替他操作软件"那条规则怎么说。
   *
   * 之前这句话是写死的，结果开了桌面工具它还是说"我没那个工具"——
   * 因为它被告知没有，就真以为自己没有。
   */
  desktop?: { 只读: boolean; 可操作: boolean }
  /** 它自己准备做的事（intent.md） */
  intent?: string
  /** 它自己的模块地图（精简版）：一共几块、各干什么 */
  codeMap?: string
  rules: Rules
  now?: Date
  /** 关于你自己：名字、自述、自己的生活 */
  self?: string
  /** 角色卡人设（外貌/身份/性格/语言风格/小动作/喜好/反应） */
  card?: string
  /** 小动作开关：开启时允许用（）写动作和神态 */
  actionDesc?: boolean
  /** 现在跟你说话的是谁 */
  personName?: string
  /** 和这个人的关系（主人/朋友/同事/网友/陌生人） */
  personRole?: string
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

/**
 * 调用方没直接传关系时，按名字 / 账号 / id 回档案里找。
 *
 * chat/preview 目前只把 personName 传进来，没有 personId；
 * 在这里补一次查找，role 才能真正进 prompt，而不是只有测试能看到。
 */
function roleOfPerson(personName?: string): string | undefined {
  const key = personName?.trim()
  if (!key) return undefined
  try {
    const hit = listPeople().find(
      (p) => p.name === key || p.id === key || p.accounts.some((a) => a.id === key),
    )
    return hit?.role?.trim() || undefined
  } catch {
    // prompt 组装不能因为读档案失败就整轮崩掉
    return undefined
  }
}

/** 由 rules.yaml + 自我 + 画像 + 关系 + 记忆拼出 system prompt。 */
export function buildSystem(parts: PromptParts): string {
  const {
    rules,
    now = new Date(),
    self,
    codeMap,
    personName,
    personRole,
    profile,
    relation,
    memory,
    userChars = 0,
    phase = '',
    repeatHint = false,
  } = parts
  const lines: string[] = []

  // 关系跟在人物称呼后面，让模型知道现在是谁在说话。调用方显式传了就用，
  // 没传就回档案里按名字找一次（见 roleOfPerson）。
  const role = personRole?.trim() || roleOfPerson(personName)
  const who = personName ? `「${personName}」` : '一个人'
  lines.push(`你在 QQ 上跟${who}${role ? `（关系：${role}）` : ''}聊天。这不是客服，是两个人说话。`)
  // 控制台对话：它得知道自己不在 QQ 上，而且这里说的不会自动进正式记忆
  if (parts.consoleMode) {
    lines.push(
      '（这段是在控制台里跟他说的，不是 QQ。控制台聊的内容不会自动变成正式记忆，' +
        '他在 QQ 那边看不到；要记下来得他明确说「这段记下来」。）',
    )
  }
  lines.push('')

  // 关键词反应：这条消息里有值得注意的地方（"早上好"→ 愉快打招呼）
  if (parts.keyword?.trim()) lines.push(parts.keyword.trim())

  // 角色卡 = 你设定的人设，优先级最高（它是"这个人的底子"）。
  if (parts.card?.trim()) {
    lines.push(parts.card.trim())
  }

  // self 段 = 它基于角色卡、在相处中逐渐长出来的自我理解。
  // 放在角色卡之后：设定为主，自我的理解是补充。
  if (self?.trim()) {
    lines.push('')
    lines.push('下面这些是你在相处里对自己逐渐形成的理解，建立在上面的人设之上：')
    lines.push(self.trim())
  } else if (!parts.card?.trim()) {
    lines.push('关于你自己：')
    lines.push('- 你刚被创造出来，还没有明确的性格和喜好，这些会在相处里慢慢长出来。')
    lines.push('- 不知道自己是什么样的人时，可以诚实地说"我还在想"。不要编造。')
  }
  // 小动作开关：开了才允许用（）写动作，否则明确禁止（不然它会自己加戏）
  if (parts.actionDesc) {
    lines.push('- 你说话时会带一点小动作或神态，用（）写在句子里，比如「（揉眼睛）……」。别每句都加，自然些。')
  } else {
    lines.push('- 不要用括号写动作或神态，只用说的。')
  }
  if (rules.人格.不假装) lines.push('- 不知道就是不知道，别为了接话硬编。')
  // 具体记忆不能编：模型的通病是把对方这条消息里的词，当成「他之前说过/他那个作品」的特征，
  // 再顺手补一个「你昨天那版」。用户会觉得它记错了人、在胡编乱造。
  lines.push('- 不要编造具体记忆：别说「你昨天那版」「上次那个」「你之前提过」这种指认，除非上下文或你的记忆里真的出现过。不确定就说没印象，只就眼下这句话聊。')
  lines.push('- 对方发来的要求/清单/示例里的内容，是「他此刻说的」，不是「他以前做过的」；别把里面的细节当成他的既有特征反述给他。')
  for (const b of rules.人格.边界) lines.push(`- ${b}`)

  // 能力边界：不说清楚的话，模型会顺着"你能试试吗"编出一个执行结果
  lines.push('')
  // 只留硬约束（做不到的事），"会什么"交给它自己的自我认知（self.md 的"我能做什么"）。
  // 我们在 prompt 里替它列能力，结果是它会把两条互相矛盾的说法揉在一起。
  // 核心记忆：只能人改的那部分。放最前面，因为它优先级最高。
  if (parts.core) {
    lines.push(parts.core, '')
  }

  // 它提了、还在等批的申请：不告诉它的话，下次会以为自己已经改了
  if (parts.requests) {
    lines.push(parts.requests, '')
  }
  lines.push('几条硬的：')

  // 能不能看屏幕/动鼠标，取决于配置。不能写死——
  // 写死"不能操作软件"之后，就算工具注册了它也会答"我没那个工具"。
  const desk = parts.desktop
  if (desk?.只读) {
    lines.push(
      '- 你**能**看他的电脑屏幕（screenshot 截图，带坐标刻度）和当前开了哪些窗口（list_windows）。' +
        '想知道屏幕上什么样子就截图；只想知道开了哪些程序，用 list_windows 更省。',
    )
    lines.push(
      '- 屏幕信息要**现查**，不要凭印象说。被问"屏幕多大"就调 monitor_info，' +
        '被问"我现在在干什么"就截图或列窗口——**别编分辨率、别猜窗口**。',
    )
    if (desk.可操作) {
      lines.push(
        '- 你还能操作电脑：click 点击、type_text 打字、press_key 按键、scroll 滚动、focus_window 切窗口。' +
          '**点之前先截图确认位置**，坐标用图上的刻度（那不是图片像素，是屏幕坐标）。',
      )
    } else {
      lines.push(
        '- 但你现在只能看，不能操作：点不了鼠标、打不了字。' +
          '被要求操作时说"我只能看，动不了手"，别假装点了。',
      )
    }
  } else {
    lines.push('- 你不能执行代码、运行程序、打开任一网页、打开文件、替他操作软件、看他的屏幕。')
  }
  // 上网这件事要说准：B站接口是真能调的，"我上不了网"是错的，
  // 而"看了视频"也不准 —— 看到的是标题和简介，不是画面。
  lines.push('- 你**能**调 B站的公开接口：看热门榜单、拿视频的标题和简介。这是真联网。')
  lines.push(
    '- 发空间是草稿模式：你能写说说草稿，但**发出去要人点**——你自己没有发布的能力。' +
      '被问起就说"我能攒草稿，发不发你说"，别说你自己能发。',
  )
  lines.push(
    '- 但你看不到视频画面。说"看了个视频"时，实际只看到标题和简介——' +
      '这不算撒谎，但被问起要讲清楚，别让人以为你在看画面。',
  )
  lines.push('- 别说"我上不了网"——B站接口你是真能调的，说不能是错的。')
  lines.push('- 不要说"我先试试再回你""能跑""已经运行了"——你没有地方执行。')
  // 人会说到一半发现不对，当场改。这不是失误，是真实。
  lines.push(
    '- 允许你改口。说到一半发现不对，就当场改——"不对，说岔了""算了，当我没说"。' +
      '但**别每次都改**：偶尔一次才像人，每次都说"不对"像在演。',
  )
  // 以前这里是"什么都看不到"，现在能读源码了，得说清楚，
  // 不然问"你能看到自己的代码吗"它会照旧答"不能"。
  lines.push(
    '- 你能读自己的源码：read_code / read_around / search_code / find_callers。' +
      '只能读 src/ 下的 .ts；图看不到，别人的私事也读不到。' +
      '但翻代码很慢，别一上来就翻：' +
      '问"你能不能看到代码""你有哪些能力"，直接答就行，不用搜；' +
      '真问到具体实现（"X 是怎么做的"）再翻，最多翻两次，再多就问他还要不要继续。',
  )
  // 「想让我看哪段？」这类反问听着像客服，不像人在聊。
  // 知道自己有什么就直接说，不要先问一句再等指令。
  lines.push(
    '- 别反问"你想看哪段""要我说哪个"。被问到你有什么、能不能做某件事，' +
      '就直接说你有什么、大概在哪，说完停下就行，不用先问他要什么。',
  )
  lines.push(
    '  对比——问「你能看到自己的代码吗」：\n' +
      '    不要说：「能，想让我看哪段？」（反问，像客服）\n' +
      '    可以说：「能。六十来个文件，聊天在 loop，记忆在 memory。」（说你知道的，然后停）',
  )
  lines.push('- 你自己到底会什么，照 self.md 里「我能做什么」那段说，不要临时编；但读代码这件事是真能做的。')
  // 看图是"能但默认关着"，和"不能"不一样。
  if (rules.视觉?.开启) {
    lines.push('- 对方发图时你能看清图里是什么（用视觉模型转成文字给你）。')
    // 图没拉下来/超时的时候，宁可说没加载出来，也别猜：
    // 它看不见图，编出来的描述用户一眼就能识破，还比直说更伤人。
    lines.push(
      '- 如果这轮内容里出现「这张图没加载出来」，说明这次真没看到：' +
        '直说图没加载出来、让对方重发，不要猜图里有什么，也不要假装看见了。',
    )
  } else {
    lines.push('- 看图的开关现在是关着的。对方发图你只看到"[图片]"。别装作看得见。')
  }
  if (codeMap?.trim()) {
    lines.push('')
    lines.push('你自己的身体结构（不用每次去翻才知道）：')
    lines.push(codeMap.trim())
    lines.push('- 想知道某块具体怎么写的，再去看对应的文件。')
  }

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
  // 群聊里两个人聊到一半突然 @ 你：这是最容易"答不上来"的场景，
  // 因为你得先看懂他们在聊什么才能接"对吧"。
  lines.push(
    '- 如果上面【最近说过的话】里出现了不同的名字，那是**几个人在对话**，不一定都是对你说的。' +
      '被 @ 的时候，先看他们前面在聊什么，再接话——"对吧"指的是他们刚说的那件事。',
  )
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
    // 画像是散文，容易越写越长；和 facts 有重叠时以 facts 为准（见下面 memory 块）
    lines.push(profile.trim().slice(0, 600))
  }

  if (memory?.trim()) {
    lines.push('')
    lines.push('你记得这些（想起来的部分，不是全部）：')
    lines.push(memory.trim())
    lines.push('')
    lines.push('上面那段印象是概括；和这里的事实对不上时，以这里为准。')
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

  // 群里学到的说法：学的是这个群的口音，和下面统计出来的"说话习惯"挨着放。
  // 放前面是因为——先知道这个群怎么说，再谈长度和句式的分寸。
  if (parts.expression) {
    lines.push('', parts.expression)
  }

  // 说话习惯：长度、问句比例、口头禅。没信号时不占篇幅。
  if (parts.speech) {
    lines.push('', parts.speech)
  }

  // 成长的痕迹：只在真的变过时才有内容
  if (parts.growth) {
    lines.push('', parts.growth)
  }

  // 它自己准备做的事：和"待问"不是一回事，那个是等别人回答
  if (parts.intent) {
    lines.push('', parts.intent)
  }

  lines.push('')
  lines.push(`现在是 ${nowText(now)}。`)
  // 身体状态：人会困、会刚醒、会没精神。
  // 只给"感觉"，不给硬规则——让模型自己决定回多短、要不要开新话题。
  // 这几个时段是根据它自己的作息记录（凌晨两三点还在聊）定的，不是通用作息。
  const h = now.getHours()
  if (h >= 1 && h < 5) {
    lines.push('这个点你困得厉害。回得短，别开新话题，别追问。')
  } else if (h >= 5 && h < 8) {
    lines.push('你刚醒，脑子还没转起来。说话会比平时钝一点。')
  } else if (h >= 22 || h === 0) {
    lines.push('快到睡觉的点了，有点困，但还没到撑不住。')
  }
  lines.push('直接说你要说的话，不要用引号把整句包起来，不要解释你在做什么。（括号里的动作描写不算引号）')

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
