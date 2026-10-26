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