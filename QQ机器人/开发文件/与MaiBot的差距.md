# 与 MaiBot 的功能差距清单

> **进度**：
> - 第 1 轮：消息过滤 / 私聊暂停 / 引用频率 / 不回复退避 / 关键词反应 / 多人格切换（6 项）
> - 第 2 轮：图片识别（主模型纯文本也能看图）
> - 剩下：上下文压缩、表情包、表达学习升级

> 基准：[MaiBot](https://github.com/Mai-with-u/MaiBot)（GPL-3.0，正在运行，文档最全）
> 用途：对照它，把我们缺的和不完善的补到同一水平线，再谈优化。
> 最后更新：2026-10-26

---

## 一、结论先说

**我们比 MaiBot 强的**（不用补）：

| 能力 | 说明 |
|---|---|
| 记忆分层 | facts / open / episodes / insights / profile / impression 六层，MaiBot 是 A_Memorix 一整套 |
| 关系值 | 单一 closeness + 4 维事件锚点，MaiBot 没有显式关系模型 |
| 自我反思 | self.md / life.md / will.json，MaiBot 有"人格"但是静态配置 |
| 隐私分级 | public / private / unsure + 三层过滤，MaiBot 靠 prompt |
| 主动消息 | 阶段额度 + 意愿，MaiBot 有主动但没这么细 |
| 自己的事 | 刷视频 / 生活线，MaiBot 没有 |
| 自诊断 | 扫日志 → 定位到行 → 多轮读代码 → 给判断，MaiBot 没有 |
| 控制台 | 6 组 13 页，MaiBot 有 WebUI 但更偏配置 |

**我们缺的**（按体感排序）：

---

## 二、P0 · 缺了体感最差

### 1. 表情包 ⬜ 未做

**MaiBot 有**：

```toml
[emoji]
steal_emoji = true     # 自动收集群里别人发的表情
max_reg_num = 64       # 最多保存 64 个
do_replace = true      # 满了替换旧的
check_interval = 10    # 每 10 分钟检查
```

**我们**：完全没有。

**为什么重要**：QQ 聊天里表情包占一半。没有表情包的 bot 一眼就是机器人。

**成本**：中（1.5 小时）
- 存表情（`persona/emoji/`）
- 识别消息里的表情 → 收进库
- 回复时按情绪/语境挑一个发

**要做的判断**：图床还是本地文件？QQ 图片有有效期。

---

### 2. 图片识别 ✅ 已做

**MaiBot 有**：

```toml
[message_receive]
image_parse_threshold = 5   # 单条消息图片数不超过此值才识图

[visual]
image_quality = "normal"    # normal 512 / high 1024
max_image_num = 64
handle_oversized_images = true
max_image_size_mb = 16.0
```

**我们**：完全没有。用户发图我们只能看到 `[图片]`。

**为什么重要**：别人发图给它，它说"我看不到"——体验断崖。

**成本**：低（1 小时）
- DeepSeek 现在支持视觉了
- 拿图片 URL → 传给模型

**依赖**：确认 `deepseek-chat` 是否支持多模态，还是要换 `deepseek-vl`。

---

### 3. 消息过滤 ✅ 已做

**MaiBot 有**：

```toml
[message_receive]
ban_words = ["广告", "抽奖"]      # 含这些词直接丢
ban_msgs_regex = ["^\\d+$"]       # 正则过滤
```

**我们**：只有权限（群白/群黑/成员白/成员黑），**没有内容过滤**。

**为什么重要**：群里刷屏、广告、纯数字，它会全部读进上下文，白烧 token。

**成本**：极低（20 分钟）

---

## 三、P1 · 影响体验

### 4. 上下文压缩 ⬜ 未做

**MaiBot 有**：

```toml
max_context_size = 40               # 群聊参考最近 40 条
max_private_context_size = 60       # 私聊 60 条
context_compaction_summary_max_chars = 6000   # 超了压成摘要
```

> 上下文快满时，用 utils 模型把更早的对话压成一段滚动状态摘要

**我们**：`session.ts` 固定保留 N 条（多少？要看代码），**没有压缩**。

**问题**：长对话会把早期内容硬丢掉，而不是压缩保留。

**成本**：中（1 小时）

---

### 5. 不回复的退避 ✅ 已做

**MaiBot 有**：

```toml
no_action_backoff_base_seconds = 15        # 决定不回复后等 15 秒再看
no_action_backoff_cap_seconds = 300        # 最多等 5 分钟
no_action_backoff_start_count = 2          # 连续 2 次不回复开始放慢
no_action_backoff_bypass_pending_count = 6 # 新消息到 6 条立刻处理
```

**我们**：`talkValue` 决定回不回，但**连续不回复后会一直全速检查**。

**问题**：它决定不说话时，每条新消息还是全速跑一遍打分。

**成本**：低（30 分钟）

---

### 6. 私聊暂停 ✅ 已做

**MaiBot 有**：

```toml
private_reply_paused = false                      # 全局暂停私聊
private_reply_pause_rules = [...]                 # 按人单独暂停
```

**我们**：没有。要静音只能改 access.yaml 把人拉黑。

**成本**：极低（20 分钟）

---

### 7. 引用频率 ✅ 已做

**MaiBot 有**：

```toml
group_quote_frequency = "occasionally"    # never / occasionally / often
private_quote_frequency = "occasionally"
```

**我们**：硬编码「只有第一句引用」。

**问题**：不能调。想让它多引用或少引用都不行。

**成本**：低（30 分钟）

---

## 四、P2 · 锦上添花

### 8. 表达学习（我们很简陋）⬜ 未做

**MaiBot 有**：

```toml
[expression]
expression_checked_only = false     # 只用人工精选过的
expression_self_reflect = true      # 写入前 AI 审核
use_vector_expression = false       # 快速（加权随机）/ 精细（向量召回）
expression_vector_candidate_pool_size = 50
max_expression_learner = 3
learning_list = [...]               # 按群/私聊分别控制
expression_groups = []              # 多群共享
```

**我们**：`plays.md`（高/低分的应对 + 每日反思），**没有审核、没有向量、不能按群控制**。

**差距**：
- 学的质量没把关（可能学到奇怪的话）
- 没有「精选」概念（不能手动标记"这句好"）

**成本**：中（1.5 小时）

---

### 9. 黑话学习（我们有但简单）

**MaiBot 有**：和表达一样的 `learning_list` + `jargon_groups`。

**我们**：`jargon.yaml` + 三步假动作检测。

**差距**：不能按群开关、不能多群共享。

**成本**：低（30 分钟）

---

### 10. 关键词反应 ✅ 已做

**MaiBot 有**：

```toml
[[keyword_reaction.keyword_rules]]
keywords = ["早上好"]
reaction = "现在是早晨，愉快地打招呼"

[[keyword_reaction.regex_rules]]
regex = ["^早(上|安)[~！!]"]
reaction = "对方在问早，简短回应即可"
```

**我们**：没有。只有 `RECALL_HINT` / `WATCH_HINT` 两个硬编码口令。

**成本**：低（30 分钟）
- 加配置项
- 命中就追加一段 prompt

---

### 11. 多人格切换 ✅ 已做

**MaiBot 有**：

```toml
multiple_reply_style = ["风格A", "风格B", "用1-2个字回复"]
multiple_probability = 0.2     # 20% 概率换风格
```

**我们**：没有。

**成本**：低（20 分钟）

---

### 12. 子代理

**MaiBot 有**：

```toml
[capabilities]
planner_subagent = false      # 给 Planner 提供 subagent 工具
advanced_sub_agent = false    # 后台运行，结论作为新消息送回
tool_result_condense = false  # 超长工具结果先整理
tool_result_condense_threshold = 3000
```

**我们**：工具注册表是空的，没有子代理。

**成本**：高（需要先有工具系统）

---

### 13. 注意力漂移

**MaiBot 有**：

```toml
[experimental.attention_drift]
enabled = false
drift_level = "scattered"    # subtle / active / scattered / wild
anchor_policy = "balanced"
reaction_style = "lively"
```

**我们**：没有。

**评价**：这是"让回复更跳脱"的实验功能。**不建议做**——不做它，回复也不会差。

---

### 14. Focus 模式

**MaiBot 有**：

```toml
[experimental]
focus_mode = false           # 同组聊天共享一个持续思考的 Planner
```

**我们**：没有。

**评价**：跨群共享上下文。**不建议做**——我们是"一个人一个人"的关系模型，跨群共享会破坏隔离。

---

## 五、待确认（MaiBot 有，但文档被截断没看完）

| 段 | 大概是什么 |
|---|---|
| `[log]` | 日志级别/轮转/清理（我们有，但没这些开关） |
| `[webui]` | 面板配置（我们有控制台） |
| `[mcp]` | 外部工具（我们没有） |
| `[plugin_runtime]` | 插件运行时（我们没有，也不打算有） |
| `[debug]` | 调试开关 |

---

## 六、建议顺序

| 序 | 项 | 成本 | 理由 |
|---|---|---|---|
| 1 | **消息过滤** | 20 分钟 | 最小成本，立刻省 token |
| 2 | **私聊暂停** | 20 分钟 | 你肯定用得上 |
| 3 | **引用频率** | 30 分钟 | 现在是硬编码的 |
| 4 | **不回复退避** | 30 分钟 | 省算力 |
| 5 | **关键词反应** | 30 分钟 | 小功能，实用 |
| 6 | **多人格切换** | 20 分钟 | 小功能，有趣 |
| 7 | **图片识别** | 1 小时 | 体感最大，但要先确认模型支持 |
| 8 | **上下文压缩** | 1 小时 | 长对话质量 |
| 9 | **表情包** | 1.5 小时 | 体感最大，但最复杂（图床/有效期） |
| 10 | **表达学习升级** | 1.5 小时 | 质量把关 |

**做 1-6 大约 2.5 小时，能消掉一批「明显不如 MaiBot」的点。**

---

## 七、不打算补的

| 项 | 原因 |
|---|---|
| 多平台适配器（TG/邮件/iMessage） | 只用 QQ |
| 插件系统 | 我们是单 bot，不需要 |
| MCP | 同上 |
| Focus 模式 | 破坏按人隔离 |
| 注意力漂移 | 实验功能，不做也不差 |
| 子代理 | 要先有工具系统，优先级低 |
