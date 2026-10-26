import { readFileSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import { warn } from './log.ts'

export interface StageRule {
  名: string
  至: number
  称呼: string
  主动: string
}

export interface Rules {
  人格: {
    名字: string
    不假装: boolean
    边界: string[]
    /**
     * 备用说话风格：按 切换概率 随机临时注入一条，只影响本次回复。
     * 想让"同一句话有时简练有时啰嗦"就填几条，概率 0.1~0.3。
     */
    备用风格: string[]
    切换概率: number
  }
  /** 它自己出去看东西 / 发东西 */
  /** 内容层面的过滤：含这些词/正则的消息直接丢，不进上下文 */
  消息过滤: {
    屏蔽词: string[]
    屏蔽正则: string[]
  }
  /**
   * 命中关键词后，给这一轮追加一段"反应提示"。
   * 比硬编码口令灵活：不用改代码就能让它对"早上好"换个回应方式。
   */
  关键词反应: Array<{
    关键词: string[]
    正则: string[]
    /** 命中后追加给模型的指令 */
    反应: string
  }>
  外部: {
    刷视频: {
      开启: boolean
      每天最多: number
      /** 分区名，空数组就走总热门 */
      分区: string[]
      最短间隔小时: number
    }
    发空间: {
      开启: boolean
      /** true = 发之前会先问你 */
      需要确认: boolean
      /** 1 所有人 / 4 好友 / 64 仅自己 */
      默认权限: number
    }
  }
  /** 看图用的模型。留空 = 不识别图片，只留 [图片] 占位 */
  视觉: {
    开启: boolean
    /** 模型名；空 = 用环境变量 DEEPSEEK_VISION_MODEL，再空就不识别 */
    模型: string
    /** 一次最多看几张 */
    最多张数: number
  }
  说话: {
    每轮最多条数: number
    每条最多字数: number
    分句: string
    条间延迟: [number, number]
    回复前延迟: [number, number]
    不用Markdown: boolean
    /** 引用对方消息的频率：never 从不 / occasionally 偶尔（默认）/ often 经常 */
    引用频率: 'never' | 'occasionally' | 'often'
  }
  记忆: {
    值得记: string[]
    不值得记: string[]
    摘要粒度: string
    衰减: Record<string, number>
    检索: {
      取回条数: [number, number]
      /** 低于这个分数的不返回，宁可少给 */
      最低分: number
      权重: { 新近: number; 相关: number; 重要: number }
    }
    反思: {
      触发: string
      阈值: number
      每天至少: number
      产出条数: number
    }
  }
  关系: {
    总值: [number, number]
    阶段: StageRule[]
    单次最大变化: number
    必须挂锚点: boolean
    维度: string[]
  }
  行为: {
    静默时段: [string, string]
    /**
     * 防抖：一批消息先收齐再处理。
     * 不同场景等不同时间——同人续发给补话的机会，换人要快，被 @ 更快。
     */
    防抖: {
      /** 上一条有效消息超过 30 秒（安静），多等一会儿看有没有补充 */
      安静: number
      /** 同一个人连着发 */
      同人续发: number
      /** 换人说话了 */
      换人: number
      /** 被 @ 时的等待上限 */
      被at最多: number
      /** 一批从第一条起最多等这么久，防止一直等下去 */
      批次上限: number
    }
    /** 群聊活跃度 0~1：越小越安静。没被 @ 时按这个概率决定接不接 */
    发言频率: number
    /** 按时段覆盖发言频率，留空就是全天一个值 */
    频率规则: Array<{ 时段: string; 值: number }>
    /** 全局暂停私聊：true = 只收消息、维护历史，不进入思考 */
    私聊暂停: boolean
    /**
     * 连续决定不回复后放慢检查频率。
     * 不加这个的话，它决定不说话时每条新消息还会全速跑一遍打分。
     */
    退避: {
      /** 连续几次不回复后开始放慢 */
      连几次开始: number
      /** 第一次退避等多久（秒） */
      起始秒: number
      /** 退避上限（秒） */
      上限秒: number
      /** 等待期间新消息到这么多条就立刻重新处理；0 = 不打断 */
      几条消息打断: number
    }
    /** 对"嗯""哦"这类短消息，不回的概率 */
    偶尔不回概率: number
  /** 看了不回的概率（有意义的话也懒得接）。默认 0 = 关 */
  已读不回概率?: number
    /** 每条回复发完让模型自评一次，会多一次调用；关掉省钱 */
    回复自评: boolean
    /** 同一个人每分钟最多处理几轮，防刷 */
    每分钟上限: number
    /** 群里每个群每分钟最多发几条 */
    群每分钟上限: number
    主动消息: {
      去重相似度: number
      每日上限: number | '由阶段决定'
    }
  }
  /**
   * 会话上下文压缩：
   * 未压缩的历史消息超过 summaryThreshold 条时触发压缩，
   * 压缩后最近 keepRecent 条消息保留原文。
   */
  上下文压缩: {
    摘要阈值: number
    保留最近: number
  }
  /**
   * 表达学习：从好的回复里学"什么话接什么话"。
   *
   * 不加审核的话，它会学到一些奇怪的句式（模型自我评分偏高的时候尤其明显）。
   */
  表达学习: {
    /** 写入前让模型自己审一遍：这句真的值得学吗 */
    审核: boolean
    /** 只用人工精选过的（checked=true）；false 时未精选的也用 */
    只用精选: boolean
  }
  /** 回复里的表情包 */
  表情包: {
    开启: boolean
    每条最多: number
    库存上限: number
  }
}

export const DEFAULTS: Rules = {
  视觉: {
    开启: false,
    模型: '',
    最多张数: 4,
  },
  消息过滤: {
    屏蔽词: [],
    屏蔽正则: [],
  },
  关键词反应: [],
  外部: {
    刷视频: {
      开启: false,
      每天最多: 2,
      分区: [],
      最短间隔小时: 6,
    },
    发空间: {
      开启: false,
      需要确认: true,
      默认权限: 1,
    },
  },
  人格: {
    名字: '未定',
    备用风格: [],
    切换概率: 0,
    不假装: true,
    边界: ['不编造共同经历', '不每句都热情', '没话题时可以沉默'],
  },
  说话: {
    每轮最多条数: 3,
    每条最多字数: 40,
    分句: '按标点',
    条间延迟: [400, 1500],
    回复前延迟: [1000, 4000],
    不用Markdown: true,
    引用频率: 'occasionally',
  },
  记忆: {
    值得记: ['对方说的关于自己的事', '情绪强烈的事', '约定与承诺'],
    不值得记: ['寒暄', '重复内容', '无信息的语气词'],
    摘要粒度: 'episode',
    衰减: { 普通: 0.02, 高情绪: 0.005, 关系锚点: 0.001 },
    检索: { 取回条数: [5, 8], 最低分: 1.2, 权重: { 新近: 0.5, 相关: 3.0, 重要: 2.0 } },
    反思: { 触发: '累计重要性', 阈值: 150, 每天至少: 1, 产出条数: 5 },
  },
  关系: {
    总值: [0, 100],
    阶段: [
      { 名: '陌生', 至: 10, 称呼: '你', 主动: '不主动' },
      { 名: '眼熟', 至: 25, 称呼: '你', 主动: '三五天一次' },
      { 名: '朋友', 至: 45, 称呼: '哎', 主动: '一两天一次' },
      { 名: '亲近', 至: 65, 称呼: '昵称', 主动: '每天一次' },
      { 名: '亲密', 至: 85, 称呼: '专属', 主动: '每天一两次' },
      { 名: '离不开', 至: 100, 称呼: '专属', 主动: '每天两三次' },
    ],
    单次最大变化: 2,
    必须挂锚点: true,
    维度: ['信任', '亲密', '好奇', '依赖'],
  },
  行为: {
    静默时段: ['23:30', '08:30'],
    防抖: { 安静: 5, 同人续发: 2, 换人: 0.5, 被at最多: 1, 批次上限: 8 },
    发言频率: 0.4,
    频率规则: [],
    私聊暂停: false,
    退避: { 连几次开始: 2, 起始秒: 15, 上限秒: 300, 几条消息打断: 6 },
    偶尔不回概率: 0.15,
    回复自评: true,
    每分钟上限: 10,
    群每分钟上限: 6,
    主动消息: { 去重相似度: 0.6, 每日上限: '由阶段决定' },
  },
  上下文压缩: {
    摘要阈值: 20,
    保留最近: 6,
  },
  表达学习: {
    审核: true,
    只用精选: false,
  },
  表情包: {
    开启: true,
    每条最多: 1,
    库存上限: 200,
  },
}

/** 拼接配置路径；根路径为空时不要产生 ".键" 这种前缀。 */
function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

/** 只合并 DEFAULTS 里已有的键；未知键会被收集起来警告，防止拼错字段静默失效。 */
function merge<T>(base: T, override: unknown, path: string, unknown: string[]): T {
  if (override === undefined || override === null) return base
  if (Array.isArray(base)) return (Array.isArray(override) ? override : base) as T

  if (typeof base === 'object' && base !== null) {
    const src = override as Record<string, unknown>
    if (typeof override !== 'object' || override === null || Array.isArray(override)) return base
    const out = { ...(base as Record<string, unknown>) }
    for (const key of Object.keys(out)) {
      if (key in src) out[key] = merge(out[key], src[key], joinPath(path, key), unknown)
    }
    for (const key of Object.keys(src)) {
      if (!(key in out)) unknown.push(joinPath(path, key))
    }
    return out as T
  }

  if (typeof override !== typeof base) {
    throw new Error(`配置类型不对：${path} 期望 ${typeof base}，实际 ${typeof override}`)
  }
  return override as T
}

/** 读取正整数环境变量；未设置返回 null，非法值 warn 后返回回退默认值。 */
function readPositiveIntEnv(name: string, fallback: number): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n <= 0) {
    warn(`环境变量 ${name} 非法（${raw.trim()}），回退默认值 ${fallback}`)
    return fallback
  }
  return n
}

/** 读取数值环境变量并夹到 [min, max]；未设置返回 null，非法值 warn 后返回回退默认值。 */
function readClampedNumberEnv(name: string, fallback: number, min: number, max: number): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) {
    warn(`环境变量 ${name} 不是数字（${raw.trim()}），回退默认值 ${fallback}`)
    return fallback
  }
  return Math.min(max, Math.max(min, n))
}

/** 0 / false / off 视为关闭；未设置返回 null，其余取值一律视为开启。 */
function readBoolEnv(name: string): boolean | null {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return null
  return !['0', 'false', 'off'].includes(raw.trim().toLowerCase())
}

/**
 * 用环境变量覆盖 context / emoji 两组配置。
 * 非法值不抛错：回退默认值，并在日志里 warn。
 */
function applyEnvOverrides(rules: Rules): Rules {
  let summaryThreshold = rules.上下文压缩.摘要阈值
  let keepRecent = rules.上下文压缩.保留最近

  const envThreshold = readPositiveIntEnv('CTX_SUMMARY_THRESHOLD', DEFAULTS.上下文压缩.摘要阈值)
  if (envThreshold !== null) summaryThreshold = envThreshold
  const envKeepRecent = readPositiveIntEnv('CTX_KEEP_RECENT', DEFAULTS.上下文压缩.保留最近)
  if (envKeepRecent !== null) keepRecent = envKeepRecent

  if (keepRecent >= summaryThreshold) {
    warn(
      `上下文压缩配置非法（keepRecent=${keepRecent}，summaryThreshold=${summaryThreshold}），` +
        `keepRecent 必须小于 summaryThreshold，回退默认值 ${DEFAULTS.上下文压缩.摘要阈值}/${DEFAULTS.上下文压缩.保留最近}`,
    )
    summaryThreshold = DEFAULTS.上下文压缩.摘要阈值
    keepRecent = DEFAULTS.上下文压缩.保留最近
  }

  const enabled = readBoolEnv('EMOJI_ENABLED') ?? rules.表情包.开启
  const maxPerReply =
    readClampedNumberEnv('EMOJI_MAX_PER_REPLY', DEFAULTS.表情包.每条最多, 0, 3) ?? rules.表情包.每条最多
  const libraryCap =
    readClampedNumberEnv('EMOJI_LIBRARY_CAP', DEFAULTS.表情包.库存上限, 1, 5000) ?? rules.表情包.库存上限

  return {
    ...rules,
    上下文压缩: { 摘要阈值: summaryThreshold, 保留最近: keepRecent },
    表情包: { 开启: enabled, 每条最多: maxPerReply, 库存上限: libraryCap },
  }
}

export interface LoadResult {
  rules: Rules
  warnings: string[]
  path: string
}

export function loadRules(path = 'persona/rules.yaml'): LoadResult {
  const warnings: string[] = []
  if (!existsSync(path)) {
    warnings.push(`没找到 ${path}，全部使用默认值`)
    return { rules: applyEnvOverrides(DEFAULTS), warnings, path }
  }

  let parsed: unknown
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} 不是合法 YAML：${(err as Error).message}`)
  }

  // 空文件按"全默认"处理；但数组/标量根节点说明文件结构写错了，
  // 直接给明确错误，别悄悄退回默认值让人以为配置生效了。
  if (parsed !== undefined && parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    const actual = Array.isArray(parsed) ? '数组' : typeof parsed
    throw new Error(`${path} 的顶层必须是键值映射，实际是 ${actual}`)
  }

  const unknownKeys: string[] = []
  const rules = merge(DEFAULTS, parsed ?? {}, '', unknownKeys)
  for (const k of unknownKeys) warnings.push(`忽略未知配置项 ${k}（检查是否拼错）`)

  return { rules: applyEnvOverrides(rules), warnings, path }
}

/** 用当前关系值查出所处阶段。 */
export function stageOf(rules: Rules, value: number): StageRule {
  for (const s of rules.关系.阶段) {
    if (value <= s.至) return s
  }
  return rules.关系.阶段[rules.关系.阶段.length - 1]!
}

/** "HH:mm" → 分钟数 */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 时段匹配，支持跨夜 "23:00-02:00" */
function inRange(nowMin: number, range: string): boolean {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(range.trim())
  if (!m) return false
  const a = minutes(m[1]!)
  const b = minutes(m[2]!)
  return a <= b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b
}

/**
 * 当前时段的群聊活跃度。规则命中就用规则，否则用默认值。
 * 这是"它有多想说话"的旋钮：0 几乎不插话，1 很正常。
 */
export function talkValueOf(rules: Rules, now = new Date()): number {
  const clamp = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null
  }
  const nowMin = now.getHours() * 60 + now.getMinutes()
  for (const r of rules.行为.频率规则) {
    if (!inRange(nowMin, r.时段)) continue
    const v = clamp(r.值)
    if (v !== null) return v
  }
  // 配置写错（比如 "abc"）时回落到默认 0.4，不要让 NaN 传下去
  return clamp(rules.行为.发言频率) ?? 0.4
}