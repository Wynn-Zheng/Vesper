/**
 * 测试要动真实 plugins/ 时的安全护栏。
 *
 * 为什么要这个：`test-plugins-e2e.ts` / `test-plugins-edge.ts` 是通过 HTTP
 * 打真实服务、在真实 `plugins/` 里装/卸插件的（不是临时目录）。
 * 这就意味着一个手滑的 id 能把 `plugins/demo` 删掉 —— 之前真发生过，
 * 之后 check-all 里的插件测试全挂。
 *
 * 护栏有两条：
 *   1. id 必须以指定的前缀开头（e2e- / edge-），别的直接拒绝
 *   2. 装卸前后可以对比目录快照，确认只动了自己那份
 */

/** 允许测试操作的插件 id 前缀 */
export const TEST_ID_PREFIXES = ['e2e-', 'edge-']

/** 拒绝操作任何 prep 之外的东西 —— 抛错，不是静默跳过 */
export function assertTestPluginId(id: string, prefixes: string[] = TEST_ID_PREFIXES): string {
  const name = String(id ?? '').trim()
  if (!name) throw new Error('测试想操作一个空 id 的插件，拒绝')
  if (!prefixes.some((p) => name.startsWith(p))) {
    throw new Error(`测试只能操作 ${prefixes.join(' / ')} 开头的插件，拒绝操作：${name}`)
  }
  // 再挡一层：不能带路径分隔符（防 ../ 逃逸）
  if (/[\\/]/.test(name) || name.includes('..')) {
    throw new Error(`插件 id 里不能有路径字符：${name}`)
  }
  return name
}

/** 生成一个带前缀的临时 id（时间戳比随机数好排查） */
export function testPluginId(prefix: 'e2e' | 'edge', tag: string): string {
  return `${prefix}-${tag}-${Date.now().toString(36)}`
}
