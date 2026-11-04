/**
 * 本地时间格式化。
 *
 * 为什么需要：`new Date().toISOString()` 是 **UTC**。用它写"日期/时间"再按本地解析
 * （`Date.parse('2026-11-04T20:00')`），往返一次就差 8 小时（东八区）；
 * 凌晨 0–8 点写的日记会记成前一天。这几个文件都踩过：
 *   - outward/qzone.ts 的草稿时间戳
 *   - memory/core.ts 的申请/核心记忆日期
 *   - self/reflect.ts 的"今天"
 */

/** 本地日期 YYYY-MM-DD */
export function localDate(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地「YYYY-MM-DD HH:mm」，与 `Date.parse('YYYY-MM-DDTHH:mm')` 对称 */
export function localMinute(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${localDate(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
