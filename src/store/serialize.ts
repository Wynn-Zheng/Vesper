/**
 * 让"读 → 改 → 写"这类操作排队执行。
 *
 * 这些函数都是 load() → push() → save() 的模式，
 * 两个并发调用会互相覆盖（后写的把先写的吃掉）。
 *
 * 关键取舍：队列空的时候**同步执行**，只有真的撞上并发才排队。
 * 这样绝大多数调用（包括测试里的连续调用）行为和以前完全一样，
 * 只有并发场景才让后来者等前面那个写完。
 */
const chains = new Map<string, Promise<void>>()

/** 同步返回；队列空时当场执行完，否则排队 */
export function serialized(key: string, fn: () => void): void {
  const prev = chains.get(key)
  if (!prev) {
    // 没有排队中的任务：立刻做，行为和以前一致
    try {
      fn()
    } catch {
      /* 写失败不该炸调用方 */
    }
    return
  }

  const next = prev
    .then(() => {
      try {
        fn()
      } catch {
        /* 同上 */
      }
    })
    .catch(() => {
      /* 前一个失败不该卡住后面的 */
    })
  chains.set(key, next)
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key)
  })
}

/** 等所有排队中的写入完成（测试和优雅退出用） */
export async function drainWrites(): Promise<void> {
  await Promise.all([...chains.values()])
  chains.clear()
}
