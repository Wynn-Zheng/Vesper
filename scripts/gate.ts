/**
 * 门禁的判定逻辑。
 *
 * 单独抽出来是为了能测：这里判错的话，整轮"全部通过"就是假的。
 * 之前踩过的坑（见 buglog BUG-23/24）都出在判定层，不是被测功能。
 */

export interface Verdict {
  ok: boolean
  why?: string
}

/**
 * 从输出里读出「跑了多少项 / 失败多少项」。
 *
 * 兼容两种格式（项目里两种都有，历史原因）：
 *   `通过 18 / 失败 0`
 *   `19 / 19 通过`
 */
export function readCounts(out: string): { pass: number; fail: number } | null {
  // 只看结尾那段。
  // 踩过的坑：把整个输出拿去匹配时，**测试标题里**出现的「通过 0 / 失败 0」
  // 也会被当成结果 —— 门禁曾因此判"单元测试只跑了 0 项"。
  // 摘要永远在最后几行，所以只看尾巴既够用又不会误伤。
  const tail = out.trimEnd().split('\n').slice(-20).join('\n')

  // node --test 的格式
  const native = /ℹ\s*pass\s+(\d+)[\s\S]*?ℹ\s*fail\s+(\d+)/.exec(tail)
  if (native) return { pass: Number(native[1]), fail: Number(native[2]) }

  const a = /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/.exec(tail)
  if (a) return { pass: Number(a[1]), fail: Number(a[2]) }
  // 注意：这个格式是「通过数 / 总数」，失败数得算差值。
  // 直接拿第二个数当失败数的话，"19 / 19 通过"会被判成 19 项失败。
  const b = /(\d+)\s*\/\s*(\d+)\s*通过/.exec(tail)
  if (b) {
    const pass = Number(b[1])
    const total = Number(b[2])
    return { pass, fail: Math.max(0, total - pass) }
  }
  return null
}

/**
 * 判定一条检查是否真的通过。
 *
 * 三个条件缺一不可：
 *   1. 退出码 0
 *   2. 输出里有预期内容（防止"跑了但什么都没发生"）
 *   3. 如果输出能读出计数，**至少跑了 1 项、且没有失败**
 *
 * 第 3 条专门治一种假绿：脚本里一个用例都没跑，
 * 打印「通过 0 / 失败 0」，前两条都能满足。
 */
export function judge(
  out: string,
  code: number,
  expect: RegExp,
  minChecks = 1,
): Verdict {
  if (code !== 0) return { ok: false, why: `退出码 ${code}` }
  if (!expect.test(out)) return { ok: false, why: `输出里没有预期内容（${expect}）——可能静默失败` }
  const counts = readCounts(out)
  if (counts) {
    if (counts.fail > 0) return { ok: false, why: `有 ${counts.fail} 项失败` }
    if (counts.pass < minChecks) {
      return { ok: false, why: `只跑了 ${counts.pass} 项检查（至少应有 ${minChecks} 项）——可能空转` }
    }
  }
  return { ok: true }
}
