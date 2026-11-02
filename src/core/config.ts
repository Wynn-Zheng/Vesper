import { readFileSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import { warn } from './log.ts'

export interface StageRule {
  名: string
  至: number
  称呼: string
  主动: string
  /**
   * 主动消息的最小间隔（小时）。
   *
   * 为什么要结构化字段：`主动` 那句是给人看的自然语言（"三五天一次"），
   * 代码没法可靠解析；之前 proactive.ts 里另写了一份硬编码表，
   * 结果配置和实际行为各说各话。现在以这三个字段为准。
   *
   * 数值依据：Roberts & Dunbar (2015) 跟踪 18 个月的社交网络发现，
   * 朋友之间联系间隔的中位数从在校时的 1 天掉到毕业一年后的 **27 天**，
   * 强关系（内层）才明显更密。所以"朋友一周一次"已是偏亲密的设定。
   */
  主动间隔小时?: number
  /** 每天最多主动几次（硬上限，`行为.主动消息.每日上限` 若配成数字会覆盖它） */
  每日上限?: number
  /**
   * 由头分门槛（0-10）：这次"想说话"的理由够不够。
   *
   * 关系越近门槛越低：亲密的人不需要理由，陌生的人必须有具体的事。
   * 这就是"哪怕关系一般，看到/想到什么也会主动"的落点。
   */
  最小由头?: number
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
    /**
     * 允许它自己改角色卡（性格 / 语言风格 / 小动作 / 喜欢 / 讨厌 / 反应）。
     *
     * false（默认）= 它改不了，只能提申请等你批；
     * true = 反思时它可以直接改，每 12 小时最多改 2 项，
     *        特别想改但排不上的会转成「想做的事」留到下次。
     *
     * 名字 / 生日 / 外貌 / 身份 无论开关都不许它改 —— 那是你定的底子。
     */
    它能自改角色卡: boolean
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
    /**
     * 一次看图（整批）的总预算，毫秒。
     *
     * 几张图并发看，到点还没回来的直接放弃、标记"没加载出来"，
     * 不能让一张慢图把整轮回复卡住。0/负数回退默认 8000。
     */
    总预算毫秒: number
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
    /** 打开后日志里打印每次引用判定的得分明细 */
    引用调试: boolean
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
    /** 一次关系变化最多多少（1-3 的幅度都走这个上限） */
    单次最大变化: number
    必须挂锚点: boolean
    维度: string[]
    /**
     * 它对你的专属称呼。留空 = 按阶段自动决定（见 StageRule.称呼）。
     *
     * 为什么要单独配：亲近/亲密阶段的称呼不该是占位符（"昵称"/"专属"），
     * 模型拿到那种词会字面照做。填了这里就用你定的，没填才走阶段提示。
     */
    昵称?: string
    /**
     * 关系/心情评估的额度。
     *
     * 评估是"每条回复后一次模型调用"，再叠加回复自评（`行为.回复自评`）和
     * play 自审，单条回复最多 **4 次**调用，此前完全没有闸门。
     * 这里给个每日上限：超了就跳过评估（心情/关系保持原样），不影响回话。
     */
    评估?: {
      /** 关掉就不再做关系/心情评估（省 token，但关系不再涨） */
      开启?: boolean
      /** 每天最多评估几次；0 = 不评估 */
      每天最多?: number
    }
  }
  行为: {
    静默时段: [string, string]
    /**
     * 防抖：一批消息先收齐再处理。
     * 不同场景等不同时间——同人续发给补话的机会，换人要快，被 @ 更快。
     */
    防抖: {
      /**
       * 档位：一整套配合好的等待时间。
       *
       * 为什么要有档位，而不是只有数值：这几个数之间有比例关系（同人续发
       * 要短、换人更短、安静要长），单独调一个很容易调出互相矛盾的值。
       * 档位是「整体调节奏」，自定义是「逐个调」。
       *
       *   关闭   = 不聚合，每条消息立刻处理
       *   快速   = 安静 1 / 活跃 3 / 同人 1 / 换人 0.5
       *   自然   = 安静 2 / 活跃 5 / 同人 2 / 换人 0.5（默认）
       *   沉稳   = 安静 4 / 活跃 7 / 同人 4 / 换人 2
       *   自定义 = 用下面那几个数
       */
      档位: '关闭' | '快速' | '自然' | '沉稳' | '自定义'
      /** 上一条有效消息超过 30 秒（安静），多等一会儿看有没有补充 */
      安静: number
      /** 上一条刚说完不久（活跃），群里在热聊，多等一会儿能收齐 */
      活跃: number
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
  /**
   * 说完发现自己这条不太行，补一句"说错了"的概率。
   * 默认 0 = 关。只在自评分数很低时才可能触发。
   */
  改口概率?: number
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
  /**
   * NapCat 的启动方式。
   *
   * 默认 **不记录日志**：启动完全无窗口，NapCat 的状态/二维码都在控制台里。
   * 打开之后会走 启动NapCat.cmd（任务栏里一个最小化窗口），
   * 好处是 NapCat 的原始输出会写成 napcat-console.log，排查启动失败时有用。
   */
  NapCat: {
    /** 是否记录 NapCat 的原始控制台日志。默认 false。 */
    记录日志: boolean
    /**
     * NapCat 的安装目录（那个 <版本>.Shell 目录）。
     *
     * 留空 = 自动探测常见位置（C:/NapCat、D:/NapCat、D:/NapCat、用户目录下的 NapCat）。
     * 自动探测找不到时，在控制台「日志 → NapCat」里手动填。
     */
    Shell目录: string
    /**
     * 掉线看门狗：WS 连续几分钟没连上（NapCat/QQ 掉线）就自动重启 NapCat。
     *
     * 默认 true。设 false 就只记日志、不自动重启（比如 NapCat 归别的程序管）。
     * 重启有冷却：最短 5 分钟一次，连续失败翻倍，上限 30 分钟。
     */
    掉线重启: boolean
  }
  /**
   * 运行日志（data/logs/*.jsonl）的保留策略。
   *
   * 这些是"它自己在干什么"的记录（收消息、调模型、用了哪个工具），排查问题用。
   * 每天大约 500KB，30 天约 15MB。
   */
  日志: {
    /** 保留多少天，超出的在启动时删掉。默认 30。 */
    保留天数: number
  }
  /**
   * 电脑操作（看屏幕 / 点鼠标 / 打字）。
   *
   * 默认关。开了之后它才能调 ai-desktop 那套工具。
   * 风险很大：能看见屏幕上的一切，也能点到任何东西。
   */
  电脑操作: {
    /** 总开关。默认 false。 */
    enabled: boolean
    /** 允许改状态的工具（点击/打字/按键）——只读的截图不受这个管 */
    允许操作: boolean
    /** 截图时跳过标题里带这些词的窗口 */
    敏感窗口: string[]
  }
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
    /**
     * 文字回复后配一张表情包的概率（0-1）。
     *
     * 为什么要有：原来是无条件每句都补一张——真人不会这样，
     * 而且会和文字内容完全无关。0.35 是"偶尔会发"的感觉。
     */
    概率: number
    /** 心情越强，发的概率越高。这个值是加成上限（0-1），加到概率上 */
    心情加成: number
  }
  /**
   * 插件。
   *
   * 现在只管网络出口：插件声明了 net 权限会拿到 ctx.fetch，
   * 那是包过一层策略的。内网默认打不进去，这条是硬闸（见 src/plugins/net.ts）。
   */
  插件: {
    网络: {
      /** 允许访问的域名。空 = 不限域名（但仍然禁内网）。支持 .example.com / *.example.com */
      白名单: string[]
      /** 明确禁止的域名，优先于白名单 */
      黑名单: string[]
      /**
       * 允许插件访问内网和本机。
       *
       * 默认关。真要写给本机服务用的插件（比如调 ollama、本地 TTS）
       * 才打开——打开就等于放弃了 SSRF 防护，别在有公网入口的机器上开。
       */
      允许内网: boolean
      /** 单次请求超时（秒） */
      超时: number
      /** 最多跟几次重定向。每跳都会重新过一遍检查 */
      最多跳转: number
    }
  }
}

export const DEFAULTS: Rules = {
  视觉: {
    开启: false,
    模型: '',
    最多张数: 4,
    总预算毫秒: 8_000,
  },
  消息过滤: {
    屏蔽词: [],
    屏蔽正则: [],
  },
  // 默认配几条最通用的，开箱就能用；rules.yaml 里写了就整体替换。
  // 为什么放默认值：留空的话没人知道有这功能，等于白做。
  关键词反应: [
    {
      关键词: ['早上好', '早安', '早啊', '起床了'],
      正则: [],
      反应: '现在是早上，对方在跟你打招呼。愉快地回一句，别太长。',
    },
    {
      关键词: ['晚安', '睡了', '先睡', '去睡'],
      正则: [],
      反应: '对方要去睡了。道个别就行，别拉着继续聊。',
    },
    {
      关键词: ['哭了', '难受', 'emo', '好累', '撑不住'],
      正则: [],
      反应: '对方现在情绪不好。先接住情绪，别急着讲道理、别给建议、别说"加油"。',
    },
    {
      关键词: [],
      // 「生日」这种词太泛（"我生日是几号"也会中），所以用正则卡住上下文
      正则: ['生日快乐|生日(快乐|粗卡)', '祝你生日快乐'],
      反应: '有人在过生日。说句祝福，就一句，不要排比句。',
    },
    {
      关键词: ['谢谢'],
      正则: [],
      反应: '对方在道谢。轻描淡写地接下就行，别说"不客气"这种客套话。',
    },
  ],
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
    它能自改角色卡: false,
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
    引用调试: false,
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
      // 频率按"真实朋友的联系间隔"定，不是按"bot 该多活跃"定：
      // 朋友一周一次、亲近两三天一次已经偏密；陌生不是"永不主动"，
      // 而是"一个月顶多一次，且必须有具体由头"（否则关系一淡就死锁）。
      //
      // 称呼写的是**怎么叫**，不是称呼本身：写成"昵称""专属"这种占位符，
      // 模型会字面照做（真的叫你"昵称"）。
      { 名: '陌生', 至: 10, 称呼: '直接说「你」', 主动: '几乎不主动（有事才说）', 主动间隔小时: 720, 每日上限: 1, 最小由头: 7 },
      { 名: '眼熟', 至: 25, 称呼: '直接说「你」', 主动: '两周左右一次', 主动间隔小时: 336, 每日上限: 1, 最小由头: 5 },
      { 名: '朋友', 至: 45, 称呼: '可以喊「哎」，或者叫名字', 主动: '一周左右一次', 主动间隔小时: 120, 每日上限: 2, 最小由头: 3 },
      { 名: '亲近', 至: 65, 称呼: '叫名字里的一两个字', 主动: '两三天一次', 主动间隔小时: 72, 每日上限: 3, 最小由头: 2 },
      { 名: '亲密', 至: 85, 称呼: '用你给他起的叫法', 主动: '一天一次', 主动间隔小时: 36, 每日上限: 3, 最小由头: 1 },
      { 名: '很亲近', 至: 100, 称呼: '用你们之间习惯的叫法', 主动: '每天一两次', 主动间隔小时: 30, 每日上限: 3, 最小由头: 1 },
    ],
    // 从 2 提到 3：原来一次最多 +2，从 0 走到 86 要 40 多次强事件，
    // 高阶段实际上不可达。现在 3 只留给"长期承诺 / 严重伤害"。
    单次最大变化: 3,
    必须挂锚点: true,
    维度: ['信任', '亲密', '好奇', '依赖'],
    昵称: '',
    评估: { 开启: true, 每天最多: 300 },
  },
  行为: {
    静默时段: ['23:30', '08:30'],
    防抖: { 档位: '自然', 安静: 2, 活跃: 5, 同人续发: 2, 换人: 0.5, 被at最多: 1, 批次上限: 8 },
    发言频率: 0.4,
    频率规则: [],
    私聊暂停: false,
    退避: { 连几次开始: 2, 起始秒: 15, 上限秒: 300, 几条消息打断: 6 },
    偶尔不回概率: 0.15,
    // 这两个必须出现在 DEFAULTS 里：merge 只合并 DEFAULTS 已有的键，
    // 只在 rules.yaml 里写会被当成"未知键"丢掉（这是防拼错的保护，见 merge 的注释）。
    已读不回概率: 0,
    改口概率: 0,
    回复自评: true,
    每分钟上限: 10,
    群每分钟上限: 6,
    主动消息: { 去重相似度: 0.6, 每日上限: '由阶段决定' },
  },
  NapCat: {
    // 默认 false：启动完全无窗口，状态和二维码都在控制台里。
    记录日志: false,
    // 留空 = 自动探测常见位置
    Shell目录: '',
    // 掉线看门狗：WS 连续几分钟没连上就自动重启 NapCat（见 manager.ts）。
    // 默认 **关**：它会 taskkill QQ，可能需要重新扫码登录。
    // 确认 NapCat 归它管、且能接受这个代价，再改成 true。
    掉线重启: false,
  },
  日志: {
    // 每天约 500KB，30 天约 15MB。想留更久就改大。
    保留天数: 30,
  },
  电脑操作: {
    enabled: false,
    允许操作: false,
    敏感窗口: ['银行', '支付', '密码', '支付宝', '微信支付', '网银', 'password'],
  },
  上下文压缩: {
    // 原来是 20/6：10 轮对话就触发，压完只剩 3 轮原文，两小时的历史挤在 400 字里。
    // 40/12 大约能留住最近 6 轮原文，滚动摘要上限也提到了 1500 字（见 loop/compress.ts）。
    摘要阈值: 40,
    保留最近: 12,
  },
  表达学习: {
    审核: true,
    只用精选: false,
  },
  表情包: {
    开启: true,
    每条最多: 1,
    库存上限: 200,
    概率: 0.35,
    心情加成: 0.4,
  },
  插件: {
    网络: {
      白名单: [],
      黑名单: [],
      允许内网: false,
      超时: 20,
      最多跳转: 5,
    },
  },
}

/** 防抖四个档位的实际数值。关档用不到，但仍保留形状，调用方不用分支处理 */
const DEBOUNCE_PRESETS: Record<'快速' | '自然' | '沉稳', DebounceTiming> = {
  快速: { 安静: 1, 活跃: 3, 同人续发: 1, 换人: 0.5, 被at最多: 1, 批次上限: 8 },
  自然: { 安静: 2, 活跃: 5, 同人续发: 2, 换人: 0.5, 被at最多: 1, 批次上限: 8 },
  沉稳: { 安静: 4, 活跃: 7, 同人续发: 4, 换人: 2, 被at最多: 1, 批次上限: 8 },
}

export type DebounceTiming = Omit<Rules['行为']['防抖'], '档位'>

/**
 * 按档位算出这一轮实际该等多久。
 *
 * 返回 null 表示「不聚合」：调用方应该立刻处理，不进 buffer。
 * 档位写错时按「自然」走，不抛——配置写错不该让机器人收不了消息。
 */
export function resolveDebounce(d: Rules['行为']['防抖']): DebounceTiming | null {
  if (d.档位 === '关闭') return null
  if (d.档位 === '自定义') {
    return {
      安静: d.安静,
      活跃: d.活跃,
      同人续发: d.同人续发,
      换人: d.换人,
      被at最多: d.被at最多,
      批次上限: d.批次上限,
    }
  }
  return DEBOUNCE_PRESETS[d.档位] ?? DEBOUNCE_PRESETS.自然
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

  // 少数字段故意允许两种类型：每日上限 0 = 关闭，也可以写 '由阶段决定'。
  // 默认值是字符串、用户按类型声明写数字时，严格比对会直接抛错让启动失败。
  if (path.endsWith('.每日上限') || path === '行为.主动消息.每日上限') {
    if (typeof override === 'number' && Number.isFinite(override as number)) return override as T
    if (typeof override === 'string') return override as T
    throw new Error('配置类型不对：' + path + ' 期望 数字 或 "由阶段决定"，实际 ' + typeof override)
  }
  // 数字字段：允许数字，也允许能解析成数字的字符串（"40" 行，"40字" 报错）。
  // 之前这里直接 return，什么都不校验 —— 写成 "40字" 时 Number() 变 NaN，
  // 发送层兜底成 limit=1，整段回复被切成一个字一条。
  if (typeof base === 'number') {
    const n = typeof override === 'number' ? override : typeof override === 'string' ? Number(override.trim()) : NaN
    if (!Number.isFinite(n)) {
      throw new Error('配置类型不对：' + path + ' 期望数字，实际 ' + JSON.stringify(override))
    }
    return n as T
  }
  if (typeof override !== typeof base) {
    throw new Error('配置类型不对：' + path + ' 期望 ' + typeof base + '，实际 ' + typeof override)
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
  const emojiChance =
    readClampedNumberEnv('EMOJI_CHANCE', DEFAULTS.表情包.概率, 0, 1) ?? rules.表情包.概率
  const emojiMoodBoost =
    readClampedNumberEnv('EMOJI_MOOD_BOOST', DEFAULTS.表情包.心情加成, 0, 1) ?? rules.表情包.心情加成

  return {
    ...rules,
    上下文压缩: { 摘要阈值: summaryThreshold, 保留最近: keepRecent },
    表情包: { 开启: enabled, 每条最多: maxPerReply, 库存上限: libraryCap, 概率: emojiChance, 心情加成: emojiMoodBoost },
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
  // NaN / Infinity 会让下面所有 <= 都变成 false，直接落到最后一个阶段——
  // 实测 stageOf(rules, NaN) 返回「离不开」，比抛错还糟（静默给出最亲近的结论）。
  // 关系值算坏的时候，宁可当「陌生」。
  const v = Number.isFinite(value) ? value : 0

  for (const s of rules.关系.阶段) {
    if (v <= s.至) return s
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
