# episode 加 related 链接

## 问题

`src/self/store.ts:239` 的 `appendLife`、`src/memory/distill.ts` 的去重，**都在拼命合并相似的东西**：

```ts
// appendLife 里
if (similar) return false    // 太像就不存
```

## 依据

Hintzman (1986, Psychological Review) 的**多痕迹模型**：

> 每经历一次，就存**一条独立的痕迹**。不合并成抽象图式。
> 只有在需要抽象时，才从多条痕迹里**临时**算出来。

**A-MEM**（arXiv:2502.12110, NeurIPS 2025）的对应做法（摘要原文）：

> analyze historical memories to identify relevant connections, establishing **links** where meaningful similarities exist

**相似的不合并，而是建链接。**

## 改法

**只给 Episode 加 `related` 字段**，不做全图：

```yaml
---
date: 2026-10-25
scope: private:1234567890
importance: 5
emotion: 认同
related: [2026-10-20-02, 2026-10-18-01]
---
```

**生成时机**：distill 时，让模型看已有 episode 的标题列表，挑 1-3 个相关的。

```ts
// distill 的 prompt 里加
"related": [{"id": "2026-10-20-02", "why": "同一件事的延续"}]
```

**召回时**：被召回 episode 的 related **也带出来**（标注"相关的"）。

```ts
// recall 里
const hitIds = new Set(hits.map(e => e.id))
const linked = all.filter(e => hits.some(h => h.related?.includes(e.id)))
```

## 影响

- 召回能从"一条"变成"一串"
- 相似经历不再互相覆盖

## 风险

1. **成本**：distill 每次多一次模型调用（看已有 episode 列表挑链接）。
   现在 9 条 episode 便宜，50 条就贵了。
2. **related 可能不准**：模型挑的相关可能只是"话题像"，不是"真的有关系"。
3. **可能形成环**：A 链接 B，B 链接 A，召回时重复带出。
   缓解：带去重。
4. **现在数据量太小**：9 条 episode，建链接没意义（每条都能直接找到）。
   **50 条以上才有价值。**

## 优先级

**最低**。等 episode 攒到 50 条以上再做。
