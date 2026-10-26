/**
 * 让"读 → 改 → 写"这类操作排队执行。
 *
 * 这些函数都是 load() → push() → save() 的模式，
 * 两个并发调用会互相覆盖（后写的把先写的吃掉）。
 *
 * 关键取舍：队列空的时候**同步执行**，只有真的撞上并发才排队。
 * 这样绝大多数调用（包括测试里的连续调用）行为和以前完全一样，
 * 只有并发场景才让后来者等前面那个写完。
 *
 * fn 还可以返回 Promise（异步的读改写）。返回 Promise 时才算"还在写"，
 * 后续任务会等它 resolve/reject；纯同步的 fn 依然当场执行完，不留尾巴。
 */
type Task = () => void | Promise<void>

const chains = new Map<string, Promise<void>>()

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

/** 单个任务失败（同步抛错或 Promise reject）只吞掉自己，不污染整条链 */
async function runSafely(fn: Task): Promise<void> {
  try {
    await fn()
  } catch {
    /* 写失败不该炸调用方，也不该卡住后面的任务 */
  }
}

function track(key: string, p: Promise<void>): void {
  chains.set(key, p)
  void p.then(() => {
    // 只有队尾还是自己时才删；后面可能已经又排了新任务
    if (chains.get(key) === p) chains.delete(key)
  })
}

/** 同步返回；队列空时当场执行完，否则排队 */
export function serialized(key: string, fn: Task): void {
  const prev = chains.get(key)
  if (!prev) {
    // 没有排队中的任务：立刻做，行为和以前一致
    let result: unknown
    try {
      result = fn()
    } catch {
      /* 写失败不该炸调用方 */
      return
    }
    // 同步 fn 不占队列；异步 fn 要让后来者等它写完
    if (isThenable(result)) {
      track(key, Promise.resolve(result).then(() => undefined, () => undefined))
    }
    return
  }

  // prev 正常不会 reject（track 的链都吞了错），仍然两个分支都接上，
  // 避免某天出现 rejected 的 prev 时后面的任务被直接跳过。
  track(key, prev.then(() => runSafely(fn), () => runSafely(fn)))
}

/** 等所有排队中的写入完成（测试和优雅退出用） */
export async function drainWrites(): Promise<void> {
  // 等待期间可能又有任务挂到链上，循环到真的没有为止。
  // 不能只等一份快照再 chains.clear()——那会把新任务从 map 里抹掉却不等它。
  while (chains.size > 0) {
    const pending = [...chains.values()]
    await Promise.allSettled(pending)
    for (const [key, p] of [...chains]) {
      // 只清掉这一轮等过的；被新任务替换掉的队尾留到下一轮
      if (pending.includes(p)) chains.delete(key)
    }
  }
}
