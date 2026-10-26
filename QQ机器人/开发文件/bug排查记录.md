# bug 排查记录

## 第 1 轮：表情包 + 看图（2026-10-26）

用 agenttree 拆 3 个节点跑（#11 表情包 / #12 看图 / #13 登记回归）。

### 找到并修掉的缺陷

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `src/emoji/store.ts` | 只按 store 实例排队不够：chat 和通道可能各建一个指向同一目录的 store，两个实例同时 read-modify-write 会互相覆盖索引 | 改成按**目录绝对路径**串行化（`dirLocks`），队列空了自动清 key |
| 2 | `src/emoji/detect.ts` | `isEmojiCandidate` 没先判断 `seg.type === 'image'`，非图片段也可能被当成候选 | 加前置判断 |
| 3 | `src/emoji/detect.ts` | `size` / `width` / `height` 为 0 或负数时会被当成"合法的小图" | 加 `> 0` 校验，按"不可判断"处理 |

### 验证方式

新增两个体检脚本，各 19 项：

- `scripts/test-emoji-bugs.ts`：并发 add 去重、容量淘汰、坏 JSON 恢复、索引引用不存在文件、pickEmoji 空库 / mood 未命中 / tag 兜底、isEmojiCandidate 大图 / 非图片
- `scripts/test-vision-bugs.ts`：立刻拒绝的地址返回 null 不抛错、text/html 被拒、超 5MB 被拒、模型返回空字符串那条不进结果、一张失败不影响下一张、renderImages 的 0 条和 3 条

两个都纳入了 `npm run check-all`（现在 21 项）。

### 遗留

无。

### 过程中的坑

1. **brain 拆解两次跑偏**：第一次把"表情包 + 看图"猜成"压缩 + 控制台"，第二次变成"只出报告不修"。最后改成自己写任务树 `plan --import`。
2. **import 格式要试**：顶层不能包 `tree`，要平铺；根节点也要 `acceptance`；有子节点的要 `coverage`。
3. **worktree 里没有 `node_modules`**：判据里写 `node node_modules/typescript/bin/tsc` 一定失败。要么去掉，要么用 `node xxx.ts` 直接跑。
4. **opencode 会顺手改 scope 外的文件**：两个节点都改了 `scripts/check-all.ts`（其实是对的，但 `diff-scope` 拦了）。要么把该文件加进 allow，要么在 spec 里明确禁止。

## 第 2 轮：存储层 + 记忆层（2026-10-26）

用 agenttree 拆 3 个节点跑（#15 存储层 / #16 记忆层 / #17 登记回归）。

### 找到并修掉的缺陷

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `src/store/serialize.ts` | `serialized` 只处理同步 `fn`：异步的读改写返回 Promise 后没被跟踪，后来者以为队列空了，直接和它交错 | `fn` 允许返回 Promise；返回 thenable 才占队列，同步 `fn` 仍当场执行完 |
| 2 | `src/store/serialize.ts` | `drainWrites` 只等一份快照就 `chains.clear()`：等待期间新挂上来的任务会被从 map 抹掉却没等 | 循环等到 map 真空，只清这一轮等过的队尾 |
| 3 | `src/store/serialize.ts` | 前一个任务失败可能让后续任务被跳过，或把 rejected 链传下去 | 用 `runSafely` 吞掉单个任务的同步抛错 / Promise reject，两个分支都接 |
| 4 | `src/store/fs.ts` | `writeAtomic` 写一半失败或 rename 失败时，`.tmp` 会留在数据目录里越积越多 | catch 里 `unlinkSync(tmp)` 再抛 |
| 5 | `src/store/fs.ts` | 上次崩在写一半会留下没有换行的半行，`appendJsonl` 直接往后接会把新行粘在坏行上，两条一起废 | 追加前检查文件末尾是不是 `\n`，不是就先补一个 |
| 6 | `src/memory/facts.ts` | 单行坏数据（缺日期、置信不是数字、可见性写错）会被整行丢掉；文件读失败（被占用 / 变成目录）会炸掉整条链路 | 拆出 `parseFactLine`；坏行跳过，可见性未知按「私密」收下，置信 clamp 到 0-1，读失败返回空列表，顺手去 BOM |
| 7 | `src/memory/facts.ts` | `effectiveConfidence` 遇到坏日期 / 坏置信会把 `NaN` 一路传下去 | `dayStart` 校验日期，坏日期退回首次记录日期，置信 clamp |
| 8 | `src/memory/facts.ts` | `loadDeleted` 读失败会抛；只认 `text` 字段，不校验类型 | 读失败返回空列表；坏行跳过，非字符串 `text` 忽略 |
| 9 | `src/memory/recall.ts` | `lambdaOf` / `scoreOf` 对 `NaN`、越界重要度和坏衰减配置没兜底，排序会乱 | `finiteOr` + clamp，坏值按普通重要度 5 处理 |
| 10 | `src/memory/recall.ts` | 召回记账和去重只按 `e.id`：同一天不同会话都叫 `2026-10-26-01`，会把别人的经历标成「刚想起」、合并时误去重 | 记账 key 改成 `scope + id` |
| 11 | `src/memory/recall.ts` | 空召回也会排一个 `flushTimer` | 没有要记的直接返回 |

### 验证方式

新增两个体检脚本：

- `scripts/test-store-bugs.ts`：`serialized` 空队列同步 / 有队列按序 / 异步任务、`drainWrites` 等待期间新任务、单个任务失败不污染链、`writeAtomic` 失败不留 `.tmp`、`appendJsonl` 半行修复，共 **23 项**
- `scripts/test-memory-bugs.ts`：手工改坏的 facts、无效日期、并发追加、可见性矩阵、删除黑名单坏行、空库召回、同 id 不同 scope 的记账，共 **47 项**

两个都纳入了 `npm run check-all`（现在 **23 项**），跑完 23/23 全绿。

### 遗留

- `src/persona/` 还没进版本控制（见下面坑 2），需要单独修。
- `scripts/test-deep.ts` 的 `saveWill` 断言依赖现场数据（见下面坑 3），建议改成断言结构完整。

### 过程中的坑

1. **worktree 里还是没有 `node_modules`**：第 1 轮就踩过，这轮 `check-all` 的类型检查步骤又直接 `MODULE_NOT_FOUND`。这次用目录 junction 指到主仓库的 `node_modules` 才跑起来。
2. **`.gitignore` 的 `persona/` 把 `src/persona/` 也忽略了**：`src/persona/{mood,profile,version}.ts` 从来没进过 git，主仓库里是未跟踪文件，worktree 里直接没有 → 冒烟 / 数据体检报 `ERR_MODULE_NOT_FOUND`。建议改成 `/persona/`，并把 `src/persona/` 提交。
3. **`test-deep` 依赖 `persona/will.json` 里已有 `at`**：新 worktree 的默认 `will.json` 是 `at: 0`，`Boolean(w.at)` 直接判失败。测试该断言 `typeof w.at === 'number'`，而不是依赖已有数据。
4. **live 检查连的是主仓库的服务**：控制台在 7788 跑着，worktree 里的「API 边界 / 并发」实际打的是主仓库代码，结果只能参考，不能当作本 worktree 的验证。
## 第 2-9 轮汇总（2026-10-26）

| 轮 | 范围 | 找到的 bug | 体检脚本 | 项数 |
|---|---|---|---|---|
| 1 | 表情包 + 看图 | store 按实例排队不够（要按目录）、detect 没先判 image、size=0 被当合法 | test-emoji-bugs / test-vision-bugs | 19 + 19 |
| 2 | store + memory | writeAtomic 失败残留 .tmp、appendJsonl 半行、serialize 只支持同步、facts 解析太脆 | test-store-bugs / test-memory-bugs | 23 + 47 |
| 3 | loop + self | 摘要截断切半个 emoji、坏 JSONL 的 null/数组/裸字符串能 parse 成功但读字段炸 | test-loop-bugs / test-self-bugs | 43 + 34 |
| 4 | scheduler + channel | rand 配置写反会越界、纯标点片段单独成条、硬切切半个 emoji | test-sched-bugs / test-chan-bugs | 58 + 115 |
| 5 | core + people | 限流 max<=0 语义改了要同步测试、config 深合并、access 优先级 | test-core-bugs / test-people-bugs | 98 + 96 |
| 6 | relation + learn + persona | **.gitignore 的 persona/ 把 src/persona/ 源码也忽略了**、关系值 NaN/Infinity 兜底、锚点上限 | test-relation-bugs | 25 |
| 7 | llm + outward + diagnose | humanDuration(3599) 显示「1 小时 0 分」、readSlice 把负行号静默夹成 1 | test-llm-bugs / test-outward-bugs / test-diagnose-bugs | 12 + 19 + 29 |
| 8 | console + 主流程 | **无新 bug**（36 项全过） | test-console-bugs | 36 |
| 9 | 端到端 + 配置组合 + 真实数据 | **无新 bug**（41 项全过） | test-integration-bugs | 41 |

### 最严重的发现

**第 6 轮：`.gitignore` 的 `persona/` 规则把 `src/persona/` 源码目录也忽略了。**

```
git check-ignore -v src/persona/mood.ts
.gitignore:5:persona/    src/persona/mood.ts
```

后果：`src/persona/{mood,profile,version}.ts` 三个源文件从来没进过 git。
clone 这个仓库会缺三个文件，代码直接跑不起来。

修法：规则改成 `/persona/` 和 `/data/`（只忽略根目录）。

### 过程中的坑

1. **agenttree 的 brain 拆解两次跑偏**（"表情包+看图"猜成"压缩+控制台"，第二次变成"只出报告不修"）。最后改成自己写任务树 `plan --import`。
2. **import 格式要试**：顶层不能包 `tree`，要平铺；根节点也要 `acceptance`；有子节点的要 `coverage`。
3. **worktree 里没有 `node_modules`**：判据里写 `node node_modules/typescript/bin/tsc` 一定失败。
4. **opencode 免费额度在第 7 轮用完**（Free usage limit reached），之后 act 全 blocked，只能手写。
5. **判据带中文路径会失败**：git 输出的是八进制转义（`\346\234\272...`），字符串比对不上。
6. **opencode 会顺手改 scope 外的文件**（`check-all.ts`、`.gitignore`、`test/units.test.ts`）——有好有坏，要逐个判断。

### 现在的检查规模

`npm run check-all` 35 项，其中 15 个是这轮新增的模块体检脚本（合计约 600 个断言）。