/**
 * 把"同一时间只跑一轮"包成一个函数。
 *
 * 为什么需要：定时整理 / 主动消息这类任务是 setInterval 驱动的，而它们的
 * 单次执行要调模型，慢的时候完全可能超过间隔。不设保护的话，下一拍会在
 * 上一次还没结束时又起一轮：
 *   - 整理：重复花钱，同一条事实可能被提炼两遍
 *   - 主动消息：同一个人连着收到两条"想你了"，看着像抽风
 *
 * 语义：正在跑的时候再调，直接忽略（不是排队 —— 排队会越积越多）。
 * 返回的函数可以用来手动触发一次，行为和定时那一拍完全一致。
 */
export function onceAtATime(fn: () => Promise<unknown> | unknown): () => Promise<void> {
  let running = false
  return async () => {
    if (running) return
    running = true
    try {
      await fn()
    } finally {
      running = false
    }
  }
}
