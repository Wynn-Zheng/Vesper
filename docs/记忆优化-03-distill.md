# distill 按"意外度"筛选

## 问题

`src/memory/distill.ts` 的 `shouldDistill`：

```ts
if (turns.length >= 20) return true         // 攒够 20 条就全量提炼
return hours >= 24 && turns.length >= 4     // 或者隔一天
```

**攒够 20 条就把这 20 条全喂给模型**，不管里面多少是"嗯""好""哈哈"。

## 依据

Kumaran, Hassabis & McClelland (2016, Trends in Cognitive Sciences)：

> 重播是**有选择的**：优先重播**意外的**、**有奖励的**、**还没学会的**

海马不是把一天的流水账原样重播给皮层，是挑。

## 改法

**加一个打分函数，只提炼分数最高的部分**：

```ts
function worthDistilling(turn: RawTurn, existing: Episode[]): number {
  let score = 0

  // 1. 和已有记忆不相似 = 意外的（Kumaran 说的"意外"）
  const maxSim = existing.length
    ? Math.max(...existing.map(e => similarity(turn.text, `${e.title} ${e.body}`)))
    : 0
  score += (1 - maxSim) * 2

  // 2. 提到约定/承诺 = 有奖励的（Kumaran 说的"有奖励的"）
  if (/答应|说好|一定|别忘|记得|约/.test(turn.text)) score += 2

  // 3. 长消息 = 信息量大（粗代理）
  score += Math.min(1, turn.text.length / 200)

  return score
}
```

**然后**（原来是全量，现在是取前 70%）：

```ts
const scored = turns.map(t => ({ t, s: worthDistilling(t, existing) }))
const keep = Math.max(8, Math.ceil(turns.length * 0.7))
const picked = scored.sort((a, b) => b.s - a.s).slice(0, keep).map(x => x.t)
```

**剩下 30% 留在 raw 里**，下次一起再评。

## 影响

- 一次提炼的 token 减少约 30%
- 废话不会被提炼成 episode
- 重要的话（"我答应你..."）权重会被拉高

## 风险

1. **权重是我拍的**：2 / 2 / 1 这三个数没有数据支撑。
   **建议先只保留前两个维度**（意外度 + 约定词），去掉"长消息"——长不等于重要。
2. **可能筛掉真正重要的**：一句很短但信息量大的话（"我不喜欢被追问"）。
   缓解：约定词那条能捞回来，但"不喜欢被追问"不含约定词。
   **更好的做法**：加一个"边界词"维度（不喜欢/讨厌/别/不许）。
3. **实现位置**：注意不是 `scripts/distill.ts`（那个是测试脚本），是 `src/memory/distill.ts` 的 `tick` → `distill` 之间。
4. **existing 从哪来**：要 loadEpisodes()，但那是全量读盘，20 条一评可能要读 9 次盘。要缓存。

## 优先级

**低**。原因：
- 现在 raw 一天 60 条，攒够 20 条就提炼，成本不紧张
- 权重没数据支撑，调不好反而有害
- **等积累更多对话、能观察到"提炼出什么废话"之后再调**
