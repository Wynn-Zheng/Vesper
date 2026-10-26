# act 通道降级说明（opencode → dsh headless）

## 执行顺序

1. 先尝试 opencode 通道，执行 `opencode run --standalone --auto --format json -m opencode/deepseek-v4.1-flash-free <spec>`。
2. 若退出码为 0 且输出中没有额度错误，直接采用 opencode 的结果，流程结束。
3. 若 opencode 额度用尽（输出命中 `Free usage limit reached`、`provider.quota`、`FreeUsageLimitError`）或调用失败（退出码非 0），打印降级提示，自动切换到 dsh headless。
4. 用 dsh headless 执行同一份 spec：`node <dsh-bin> --profile headless <spec>`，并将其退出码作为最终结果；全程无需人工干预。

## 兜底链路

该链路为兜底设计：opencode 优先、dsh headless 兜底。opencode 只是免费额度暂时不可用（额度恢复后仍可使用），所以保留该通道，仅在其不可用时降级，避免整个节点失败。

## 实现位置

对应实现位于 `scripts/act-fallback.mjs`（本文仅作引用，不修改该文件）。调试时可用环境变量 `ACT_FORCE` 强制指定 `opencode` 或 `dsh` 通道。
