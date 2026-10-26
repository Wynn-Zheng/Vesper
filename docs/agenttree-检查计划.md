# agenttree 检查计划：全面查 bug

> 按 agenttree 的规矩，跑 `plan --accept` / `run` 前要你确认。
> 这份是 Gate A + Gate B 的草稿，**还没跑**。

---

## Gate A：我理解的目标

**一句话**：找出 QQbot 里**确定的** bug 并修掉，不确定的列出来给你看。

**范围**：
- **会改**：`src/console/people-api.ts`、`src/people/*`、`src/memory/recall.ts`、`src/loop/prompt.ts`、`console/index.html`
- **不碰**：`persona/` 和 `data/` 下的任何数据（都在 .gitignore 里）

**形态**：存量项目，Node 24 + TypeScript，测试命令 `npm run check-all`（56 项）

**假设**（要你拍板）：
1. **要不要修"没验证的猜测"**？比如"这里可能会空指针" —— 我倾向只修**能复现的**
2. **要不要动数据结构**？我倾向**不动**（改结构风险大，收益小）
3. **agenttree 的 act 用 opencode**，它**看不到既有代码**（盲写）。所以每个节点要**独立、目标明确**，不能是"重构某某模块"

---

## 我已经查出来的

### ✅ 已修：`stageOf(NaN)` 返回「离不开」

```ts
// 改之前
export function stageOf(rules: Rules, value: number): StageRule {
  for (const s of rules.关系.阶段) {
    if (value <= s.至) return s   // NaN <= 10 是 false
  }
  return 最后一个                     // → 「离不开」
}
```

**关系值算坏的时候，它会被当成最亲近的人。**

**已修**（`Number.isFinite` 兜底 → 「陌生」）。

### ⚠️ 待定：`people-api.ts` 没有 try/catch

**26 个动态 import**，任何一个失败都会抛到 `server.ts` 外层，返回 500。

**前端会显示"加载失败：..."**，不算致命，但**错误信息是原始异常**（可能很长）。

### ⚠️ 待定：前端切人时 TAB 状态残留

`openPerson()` 之后 `PD_TAB` 重置成 `'overview'`，**但如果从详情页点「返回」再点另一个人，可能停在旧 TAB**。

---

## 任务树（草稿）

```
#1 控制台人物接口的健壮性
   └ 给 people-api.ts 的 7 个分支加 try/catch，统一返回 {error} 而不是 500
   └ 判据：tsc 通过 + 手动构造坏请求返回 400/500 且带 error 字段
   └ diff-scope: src/console/people-api.ts

#2 名字体系的边界检查
   └ 空名字（''）、超长（>40）、纯空格、emoji 名字 —— 建/改/显示 三条路径都要对
   └ 判据：新增 test-name-edge.ts 全绿
   └ diff-scope: src/people/store.ts, scripts/test-name-edge.ts

#3 记忆检索的边界
   └ query 为空/超长、limit=0、limit 很大、scope 不存在、fact 置信度 NaN
   └ 判据：新增 test-recall-edge.ts 全绿
   └ diff-scope: src/memory/recall.ts, scripts/test-recall-edge.ts

#4 群名单并发
   └ refreshGroupMembers 同时调两次、refresh + restore 同时调、pull 失败时的状态
   └ 判据：新增 test-group-concurrent.ts 全绿
   └ diff-scope: src/people/groupcache.ts, scripts/test-group-concurrent.ts

#5 前端状态机
   └ 切人时旧数据不残留、TAB 重置、"返回"后能回到列表、搜索框清空
   └ 判据：手动 + 截图（前端没法自动测）
   └ diff-scope: console/index.html
```

---

## 问题：agenttree 适不适合这个任务

**老实说，不太适合**，原因：

1. **"找 bug" 不是它的强项** —— 它是"改造引擎"，节点要求**明确的产物**（代码 + 判据）。"检查 bug"的产物是**一份报告**，判据不好写。

2. **它的 act（opencode）看不到既有代码** —— skill 里明说「llm worker 是单文件盲写，看不到既有代码，不适合改存量复杂文件」。而 bug 修复**恰恰需要看上下文**。

3. **成本**：跑一轮 opencode 十几分钟，5 个节点可能一两小时。

**更适合的做法**（我的建议）：

| 做法 | 适合 |
|---|---|
| **我自己扫 + 写测试** | 找 bug、修 bug —— **快、准、有上下文** |
| **`workflow` 并行审查** | 多个文件同时审（每个 subagent 看一个文件） |
| **agenttree** | **有明确改造目标**时（比如"把控制台拆成组件"、"加一个群设置页"） |

---

## 所以两个选择

**A. 我自己做完（推荐）**

按上面的任务树 **5 个方向**，我自己写测试 + 修，**每修一个提交一次**。预计 1-2 小时。

**B. 走 agenttree 流程**

拆树 → 你确认 → `plan --accept` → `run`。**适合你想看它自己干活**，但慢、且改存量代码容易出岔子。

**C. 混合**

**我自己找 + 修**，**最后用 agenttree 跑一遍"验证"节点**（比如"给新代码补测试"这种明确产物）。

---

**你选哪个？** 选 A 我现在就开始，选 B 我把任务树正式提交给 agenttree。
