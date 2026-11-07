/**
 * 「对话规则」页的可编辑项声明（单一事实源）。
 *
 * 为什么要有这份东西：
 *   现在每个控件要改三处 —— DOM 一段、前端字段映射一段、后端白名单一段。
 *   105 个配置项里只有 26 个有界面，想加一个就得改三处，于是没人加。
 *   这里把"有哪些项、什么类型、什么范围、说明怎么写"集中成数据，
 *   前端按它渲染、后端按它校验，加一项只改这一处。
 *
 * 判定原则（写每一项前先回答）：
 *   1. 改了之后，聊天里能看出差别吗？看不出就不放（或放高级）。
 *   2. 能用 ≤5 个选项表达吗？能就做选项，别给输入框。
 *   3. 有联动的，必须声明 requires —— 否则用户会"改了没反应"（防抖那 6 个明细就是）。
 *
 * 刻意**没有**收录的项（写在这里防止以后有人"补全"）：
 *   说话.分句 / 记忆.摘要粒度 / 记忆.反思.触发 / 记忆.反思.产出条数 /
 *   记忆.衰减.关系锚点 / 关系.维度 / 关系.阶段.主动 /
 *   外部.刷视频.最短间隔小时 / 外部.发空间.需要确认
 *   —— 这 9 个在代码里没有消费者，改了不生效。要么先接线，要么删掉，
 *   在那之前不给界面，避免造假开关。
 */

export type TalkFieldKind = 'switch' | 'choice' | 'number' | 'list'

export interface TalkOption {
  value: string | number | boolean
  label: string
}

/** 对象数组里每个元素长什么样（B-15） */
export interface TalkListItem {
  key: string
  label: string
  /** tags = 字符串数组（关键词列表），text = 单行文字，number = 数字 */
  kind: 'text' | 'tags' | 'number'
  hint?: string
  /** true = 允许留空（留空就不写这个键，用于 StageRule 里的可选字段） */
  optional?: boolean
}

export interface TalkField {
  /** rules.yaml 里的键路径，如 '行为.发言频率' */
  path: string
  label: string
  /** 一句话说明"改了会怎样"。默认值本身有理由的，直接把理由写进来 */
  hint: string
  kind: TalkFieldKind
  /** 卡片分组（前端按这个分堆，顺序按首次出现） */
  group: string
  /** basic = 普通用户可见；advanced = 收进"高级"折叠区 */
  level: 'basic' | 'advanced'
  /** choice 用 */
  options?: TalkOption[]
  /** kind === 'list' 时：每个元素的字段定义 */
  items?: TalkListItem[]
  /** number 用 */
  min?: number
  max?: number
  step?: number
  unit?: string
  /**
   * 联动：只有当另一个配置项等于某值时这一项才可改。
   * 典型是防抖明细 —— 档位不是「自定义」时，明细会被预设覆盖，改了也不生效。
   */
  requires?: { path: string; label: string; equals: string | number | boolean }
}

/** 防抖预设（和 core/config.ts 的 DEBOUNCE_PRESETS 保持一致） */
const DEBOUNCE_CHOICES: TalkOption[] = [
  { value: '关闭', label: '关闭（每条立刻回）' },
  { value: '快速', label: '快速（1~3 秒）' },
  { value: '自然', label: '自然（2~5 秒）' },
  { value: '沉稳', label: '沉稳（4~7 秒）' },
  { value: '自定义', label: '自定义（下面单独调）' },
]

/** 发言频率：0-1 的概率，做成 5 档，用户不用理解概率 */
const SPEAK_CHOICES: TalkOption[] = [
  { value: 0.1, label: '很少接话' },
  { value: 0.25, label: '偏安静' },
  { value: 0.4, label: '正常' },
  { value: 0.6, label: '偏活跃' },
  { value: 0.8, label: '很爱说' },
]

export const TALK_FIELDS: TalkField[] = [
  /* ---------------- 1. 说话的节奏 ---------------- */
  {
    path: '行为.发言频率',
    label: '群里多爱接话',
    hint: '群里没人叫它时，它主动接话的倾向。调低会更安静，调高会更容易插话。',
    kind: 'choice',
    group: '说话的节奏',
    level: 'basic',
    options: SPEAK_CHOICES,
  },
  {
    path: '行为.防抖.档位',
    label: '等多久再回',
    hint: '群里一句话常分几条发。等一会儿能攒成一段再回，太短会回一半。',
    kind: 'choice',
    group: '说话的节奏',
    level: 'basic',
    options: DEBOUNCE_CHOICES,
  },
  {
    path: '行为.防抖.安静',
    label: '冷场时等（秒）',
    hint: '群里半小时没人说话，它等你多久看看有没有下文。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 0,
    max: 30,
    step: 0.5,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.防抖.活跃',
    label: '热闹时等（秒）',
    hint: '群里正聊得热，它等多久再插。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 0,
    max: 60,
    step: 0.5,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.防抖.同人续发',
    label: '同一个人接着说（秒）',
    hint: '对方正在连续补充，它等你多久。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 0,
    max: 60,
    step: 0.5,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.防抖.换人',
    label: '换人说话（秒）',
    hint: '另一个人接话时，它等多久就接上。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 0,
    max: 30,
    step: 0.5,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.防抖.被at最多',
    label: '@ 它时最多等（秒）',
    hint: '被点名是上限不是替换：本来要等更久的，被 @ 也不用等那么久。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 0,
    max: 10,
    step: 0.5,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.防抖.批次上限',
    label: '一批最多等（秒）',
    hint: '一直有人说话时，最多等这么久就先回，免得无限延后。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 1,
    max: 60,
    step: 1,
    unit: '秒',
    requires: { path: '行为.防抖.档位', label: '等多久再回', equals: '自定义' },
  },
  {
    path: '行为.每分钟上限',
    label: '对同一个人每分钟最多回几条',
    hint: '防刷屏，也防它自己话痨。超出的消息会被丢掉（不会排队补回）。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 1,
    max: 60,
    step: 1,
    unit: '条',
  },
  {
    path: '行为.群每分钟上限',
    label: '每个群每分钟最多回几条',
    hint: '整个群共享的额度，比"对同一个人"更粗一级。',
    kind: 'number',
    group: '说话的节奏',
    level: 'advanced',
    min: 1,
    max: 60,
    step: 1,
    unit: '条',
  },

  /* ---------------- 2. 说话的样子 ---------------- */
  {
    path: '说话.每轮最多条数',
    label: '一次最多分几条',
    hint: '超过 4 条就不像人在打字了，像刷屏。',
    kind: 'choice',
    group: '说话的样子',
    level: 'basic',
    options: [
      { value: 1, label: '1 条' },
      { value: 2, label: '2 条' },
      { value: 3, label: '3 条' },
      { value: 4, label: '4 条' },
    ],
  },
  {
    path: '说话.每条最多字数',
    label: '每句多长',
    hint: '默认 40 字，是"看起来像随手打的"而不是"写小作文"。',
    kind: 'choice',
    group: '说话的样子',
    level: 'basic',
    options: [
      { value: 15, label: '很短（15 字）' },
      { value: 25, label: '偏短（25 字）' },
      { value: 40, label: '正常（40 字）' },
      { value: 60, label: '偏长（60 字）' },
      { value: 100, label: '很长（100 字）' },
    ],
  },
  {
    path: '说话.引用频率',
    label: '要不要引用你那条',
    hint: '群里人多、话不同步时，引用能说清在接谁；一对一私聊引用了反而啰嗦。',
    kind: 'choice',
    group: '说话的样子',
    level: 'basic',
    options: [
      { value: 'never', label: '从不引用' },
      { value: 'occasionally', label: '偶尔引用' },
      { value: 'often', label: '经常引用' },
    ],
  },
  {
    path: '说话.不用Markdown',
    label: '不用 Markdown',
    hint: '关掉之后会出现 **加粗**、列表、标题 —— 聊天框里很扎眼。',
    kind: 'switch',
    group: '说话的样子',
    level: 'basic',
  },
  {
    path: '表情包.开启',
    label: '会发表情包',
    hint: '同时控制"收图入库"：关掉后它既不发表情，也不再学新表情。',
    kind: 'switch',
    group: '说话的样子',
    level: 'basic',
  },
  {
    path: '表情包.概率',
    label: '带表情的频率',
    hint: '有心情加成，实际比这个值更高一点。',
    kind: 'choice',
    group: '说话的样子',
    level: 'advanced',
    options: [
      { value: 0, label: '从不' },
      { value: 0.15, label: '偶尔' },
      { value: 0.35, label: '正常' },
      { value: 0.6, label: '经常' },
    ],
  },

  /* ---------------- 3. 什么时候不打扰 ---------------- */
  {
    path: '行为.私聊暂停',
    label: '暂停私聊',
    hint: '只收消息、记历史，但不回。群里照常。',
    kind: 'switch',
    group: '什么时候不打扰',
    level: 'basic',
  },
  {
    path: '行为.偶尔不回概率',
    label: '偶尔懒得回',
    hint: '对"嗯""哦"这类没信息的话，按这个概率直接不回。0 就是每句都接。',
    kind: 'choice',
    group: '什么时候不打扰',
    level: 'basic',
    options: [
      { value: 0, label: '每句都回' },
      { value: 0.05, label: '很少略过' },
      { value: 0.15, label: '偶尔略过' },
      { value: 0.3, label: '经常略过' },
    ],
  },
  {
    path: '行为.已读不回概率',
    label: '看了不回',
    hint: '有意冷一下。开了之后对方可能以为它挂了，自己权衡。',
    kind: 'choice',
    group: '什么时候不打扰',
    level: 'advanced',
    options: [
      { value: 0, label: '关' },
      { value: 0.05, label: '偶尔' },
      { value: 0.1, label: '有时' },
      { value: 0.2, label: '经常' },
    ],
  },
  {
    path: '行为.改口概率',
    label: '会改口',
    hint: '偶尔说"啊说错了"。很小的概率就够，多了像在演。',
    kind: 'choice',
    group: '什么时候不打扰',
    level: 'advanced',
    options: [
      { value: 0, label: '关' },
      { value: 0.05, label: '偶尔' },
      { value: 0.1, label: '有时' },
    ],
  },
  {
    path: '行为.静默时段',
    label: '静默时段',
    hint: '这段时间不主动说话（被 @ 仍然会回）。',
    kind: 'choice',
    group: '什么时候不打扰',
    level: 'advanced',
    options: [
      { value: '23:30|08:30', label: '23:30 – 08:30（默认）' },
      { value: '01:00|07:00', label: '01:00 – 07:00' },
      { value: 'none', label: '不设静默' },
    ],
  },

  /* ---------------- 4. 记什么、忘多快 ---------------- */
  {
    path: '上下文压缩.摘要阈值',
    label: '多少轮之后开始压缩',
    hint: '阈值越小压得越勤，早期细节丢得越快；太大会撑爆上下文。',
    kind: 'choice',
    group: '记什么、忘多快',
    level: 'advanced',
    options: [
      { value: 20, label: '20 轮（压得勤）' },
      { value: 40, label: '40 轮（默认）' },
      { value: 80, label: '80 轮（记得久）' },
    ],
  },
  {
    path: '上下文压缩.保留最近',
    label: '压缩时保留最近几轮原文',
    hint: '保留下来的原话不进摘要，细节不会失真。',
    kind: 'choice',
    group: '记什么、忘多快',
    level: 'advanced',
    options: [
      { value: 6, label: '6 轮' },
      { value: 12, label: '12 轮（默认）' },
      { value: 20, label: '20 轮' },
    ],
  },

  /* ---------------- 5. 自动行为 ---------------- */
  {
    path: '关系.评估.开启',
    label: '每轮评估关系变化',
    hint: '让关系值能随相处变；关掉之后关系停在当前值。每次会多花一次模型调用。',
    kind: 'switch',
    group: '自动行为',
    level: 'advanced',
  },
  {
    path: '行为.回复自评',
    label: '回复后给自己打分',
    hint: '用来发现"这句回得不好"。关掉省一次调用。',
    kind: 'switch',
    group: '自动行为',
    level: 'advanced',
  },
  {
    path: '人格.不假装',
    label: '不知道就说不知道',
    hint: '关掉会让它更容易编。除非你明确想要，不建议关。',
    kind: 'switch',
    group: '自动行为',
    level: 'advanced',
  },
  {
    path: '关键词反应',
    label: '关键词反应',
    hint: '看到这些话（或匹配这些正则）时，额外告诉它该怎么接。改完对之后的消息生效。',
    kind: 'list',
    group: '自动行为',
    level: 'advanced',
    items: [
      { key: '关键词', label: '关键词', kind: 'tags', hint: '命中任一个就算' },
      { key: '正则', label: '正则', kind: 'tags', hint: '高级，一般留空' },
      { key: '反应', label: '反应', kind: 'text', hint: '追加给模型的一句指令' },
    ],
  },
  {
    path: '行为.频率规则',
    label: '按时段调发言频率',
    hint: '留空就是全天用上面那个「发言频率」。时段写 09:00-18:00，值 0-1，越接近 1 越积极。',
    kind: 'list',
    group: '说话的节奏',
    level: 'advanced',
    items: [
      { key: '时段', label: '时段', kind: 'text', hint: '如 09:00-18:00' },
      { key: '值', label: '频率', kind: 'number', hint: '0-1' },
    ],
  },
  {
    path: '关系.阶段',
    label: '关系阶段',
    hint: '关系值（0-100）到多少算哪个阶段，以及每个阶段怎么称呼你、多久主动一次。改之前先确认「至」是递增的。',
    kind: 'list',
    group: '和你的关系',
    level: 'advanced',
    items: [
      { key: '名', label: '阶段名', kind: 'text' },
      { key: '至', label: '到多少', kind: 'number', hint: '0-100' },
      { key: '称呼', label: '怎么称呼', kind: 'text', hint: '写怎么叫，不是称呼本身' },
      { key: '主动', label: '主动说明', kind: 'text', hint: '给人看的，如「一周左右一次」' },
      { key: '主动间隔小时', label: '间隔(小时)', kind: 'number', optional: true },
      { key: '每日上限', label: '每天最多', kind: 'number', optional: true },
      { key: '最小由头', label: '由头门槛', kind: 'number', hint: '0-10', optional: true },
    ],
  },
]

/** 按路径从配置对象里取值（'行为.防抖.档位' → rules.行为.防抖.档位） */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export interface ValidatedField {
  path: string
  value: unknown
  /** 实际写入的值可能和请求的值不同（比如向上取整、clamp） */
  coerced: boolean
}

/**
 * 校验一批待写入的值。
 *
 * 为什么必须在写入前校验：写坏一个类型会让 `loadRules()` 抛错，
 * 热重载继续用旧值，**下次启动整份回落 DEFAULTS**（用户的全部配置没了）。
 * 现在 `/api/ability/param` 就是裸写，没有这层。
 */
export function validateTalkValues(
  fields: TalkField[],
  input: Record<string, unknown>,
): { ok: true; values: ValidatedField[] } | { ok: false; errors: string[] } {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const values: ValidatedField[] = []
  const errors: string[] = []

  for (const [path, raw] of Object.entries(input)) {
    const field = byPath.get(path)
    if (!field) {
      errors.push(`没有这个设置项：${path}`)
      continue
    }

    if (field.kind === 'list') {
      if (!Array.isArray(raw)) {
        errors.push(`${field.label}：要传数组`)
        continue
      }
      const rules = field.items ?? []
      const out: Record<string, unknown>[] = []
      let bad = ''
      raw.forEach((row, i) => {
        if (bad) return
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          bad = `第 ${i + 1} 行不是一条配置`
          return
        }
        const src = row as Record<string, unknown>
        const item: Record<string, unknown> = {}
        for (const r of rules) {
          const v = src[r.key]
          if (r.kind === 'tags') {
            const arr = Array.isArray(v)
              ? v.map((x) => String(x).trim()).filter(Boolean)
              : String(v ?? '')
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
            // 正则要先能编译：写错的到匹配时才炸，比这里拒绝糟得多
            if (r.key === '正则') {
              for (const re of arr) {
                try {
                  new RegExp(re)
                } catch {
                  bad = `第 ${i + 1} 行的正则不合法：${re}`
                  return
                }
              }
            }
            item[r.key] = arr
            continue
          }
          if (r.kind === 'number') {
            // 可选字段留空 = 不写这个键，别写成 0（0 和「没设」行为不同）
            if (r.optional && (v === '' || v === undefined || v === null)) continue
            const n = Number(v)
            if (!Number.isFinite(n)) {
              bad = `第 ${i + 1} 行的「${r.label}」要是数字`
              return
            }
            item[r.key] = n
            continue
          }
          const s = String(v ?? '').trim()
          if (!s) {
            if (r.optional) continue
            bad = `第 ${i + 1} 行的「${r.label}」不能为空`
            return
          }
          item[r.key] = s
        }
        // 整行都空的就丢掉，别往配置里塞空条目
        const empty = Object.values(item).every((x) => (Array.isArray(x) ? x.length === 0 : !x))
        if (!empty) out.push(item)
      })
      if (bad) {
        errors.push(`${field.label}：${bad}`)
        continue
      }
      values.push({ path, value: out, coerced: false })
      continue
    }
    if (field.kind === 'switch') {
      if (typeof raw !== 'boolean') {
        errors.push(`${field.label}：要传 true / false`)
        continue
      }
      values.push({ path, value: raw, coerced: false })
      continue
    }

    if (field.kind === 'choice') {
      const options = field.options ?? []
      // 特殊：静默时段用 'a|b' 字符串表示数组
      if (path === '行为.静默时段') {
        if (raw === 'none') {
          values.push({ path, value: [], coerced: false })
          continue
        }
        const s = String(raw)
        const m = /^(\d{1,2}:\d{2})\|(\d{1,2}:\d{2})$/.exec(s)
        if (!m) {
          errors.push(`${field.label}：格式要是 HH:MM|HH:MM`)
          continue
        }
        values.push({ path, value: [m[1], m[2]], coerced: false })
        continue
      }
      const hit = options.find((o) => String(o.value) === String(raw))
      if (!hit) {
        errors.push(`${field.label}：只能是 ${options.map((o) => String(o.value)).join(' / ')}`)
        continue
      }
      values.push({ path, value: hit.value, coerced: false })
      continue
    }

    // number
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      errors.push(`${field.label}：要是数字`)
      continue
    }
    const min = field.min ?? Number.NEGATIVE_INFINITY
    const max = field.max ?? Number.POSITIVE_INFINITY
    const step = field.step ?? 1
    let v = Math.min(max, Math.max(min, n))
    // 按步长对齐，避免 0.30000000000000004 这种值写进 yaml
    if (step > 0) v = Math.round(v / step) * step
    v = Number(v.toFixed(4))
    values.push({ path, value: v, coerced: v !== n })
  }

  if (errors.length) return { ok: false, errors }
  if (!values.length) return { ok: false, errors: ['没有要改的项'] }
  return { ok: true, values }
}
