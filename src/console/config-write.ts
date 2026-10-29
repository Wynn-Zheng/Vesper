/**
 * 改 rules.yaml 里的一个键（支持 '视觉.开启' 这种路径）。
 *
 * 为什么直接改 yaml 文本而不是"读对象 → 改 → 序列化回去"：
 *   rules.yaml 里全是中文键和注释，序列化回去会把注释和顺序全丢掉。
 *   这里只在文本里定位那一行改值，其余原样保留。
 */
export function setConfigPath(raw: string, key: string, value: unknown): { text: string; ok: boolean; error?: string } {
  const parts = key.split('.')
  const leaf = parts[parts.length - 1]!
  const parents = parts.slice(0, -1)

  const lines = raw.split('\n')

  // 找父级的行（可能有多层，只取最内层）
  let parentLine = -1
  let parentIndent = -1
  if (parents.length) {
    const want = parents[parents.length - 1]!
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)([^:#\s][^:#]*):\s*(#.*)?$/.exec(lines[i]!)
      if (m && m[2]!.trim() === want) {
        parentIndent = m[1]!.length
        parentLine = i
        break
      }
    }
    if (parentLine < 0) return { text: raw, ok: false, error: `找不到父级 ${want}` }
  }

  const targetIndent = parentLine >= 0 ? parentIndent + 2 : 0
  const leafRe = new RegExp('^(\\s*)' + leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.*)$')

  for (let i = parentLine + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    const indent = /^(\s*)/.exec(l)![1]!.length
    if (indent < targetIndent) break
    if (indent > targetIndent) continue

    const m = leafRe.exec(l)
    if (!m) continue

    // 保留行尾注释
    const rest = m[2] ?? ''
    const commentIdx = rest.search(/\s+#/)
    const comment = commentIdx >= 0 ? rest.slice(commentIdx) : ''

    lines[i] = `${m[1]}${leaf}: ${formatValue(value)}${comment}`
    return { text: lines.join('\n'), ok: true }
  }

  return { text: raw, ok: false, error: `找不到键 ${key}` }
}

/** 把值写成 yaml 字面量 */
/** 把值写成 yaml 字面量 */
function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    const items = value.map((x) => (typeof x === 'number' ? String(x) : JSON.stringify(String(x))))
    return `[${items.join(', ')}]`
  }
  // 对象不能 stringify 成 "[object Object]"：那是坏值，直接拒掉
  if (value && typeof value === 'object') throw new Error('配置值不能是对象')
  const s = String(value)
  // 一律用 JSON.stringify 包：普通字符串也包（YAML 兼容），
  // 这样换行/引号/冒号/#/花括号全都不会破坏结构。
  // 之前只对部分字符加引号，\\n 原样拼进去会把 rules.yaml 写坏，
  // 甚至能插一个顶层键（越权改 电脑操作.允许操作）。
  return JSON.stringify(s)
}
