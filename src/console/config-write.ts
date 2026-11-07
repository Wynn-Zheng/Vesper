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

  // Windows 上的 rules.yaml 是 CRLF：行尾的 \r 会让 /(.*)$/ 匹配失败，
  // 所有带 \r 的键都改不了（表现为「找不到键 xxx」）。先规范化成 LF。
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = normalized.split('\n')

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

// 子键缩进按父键下面「已有子键」的实际缩进来定，不硬编码 +2：
  // 用户把 rules.yaml 排成 4 空格或 Tab 后，写死 +2 会让所有改配置接口报"找不到键"。
  let targetIndent = parentLine >= 0 ? parentIndent + 2 : 0
  if (parentLine >= 0) {
    for (let i = parentLine + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (!l.trim()) continue
      const ind = /^(\s*)/.exec(l)![1]!.length
      if (ind <= parentIndent) break
      targetIndent = ind
      break
    }
  }
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

  // 键不存在：往父级段落里补一行。
  //
  // 为什么必须补而不是报错：老用户升级后，rules.yaml 里没有新版本加的键
  // （默认值来自代码里的 DEFAULTS，文件里根本没有那一行）。
  // 只支持"改已有的键"的话，凡是我们新加的设置项，在老安装上
  // 都会变成"界面上有、点保存报找不到键" —— 实测部署实例就是这样。
  if (parentLine >= 0) {
    // 插到父级段落已有子键的最后一个后面，保持同级缩进。
    // 同时判断这个父级是不是**列表**：段落下面全是 `- xxx` 的话，
    // 往里插 `key: value` 会写出非法 YAML（实测 `关系.阶段.新键` → 解析失败），
    // 那比"找不到键"更糟 —— 下次启动整份配置都读不出来。
    let insertAt = parentLine + 1
    let parentIsList = false
    for (let i = parentLine + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (!l.trim()) continue
      const ind = /^(\s*)/.exec(l)![1]!.length
      if (ind <= parentIndent) break
      if (/^\s*-\s/.test(l)) parentIsList = true
      insertAt = i + 1
    }
    if (parentIsList) {
      return { text: raw, ok: false, error: `${parents[parents.length - 1]} 是个列表，不能往里加键` }
    }

    const pad = ' '.repeat(targetIndent)
    lines.splice(insertAt, 0, `${pad}${leaf}: ${formatValue(value)}`)
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

/** 把一个值写成一行 YAML 标量（只处理标量和小数组，够对象数组用） */
function scalarToYaml(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    // 元素一律加双引号：和 rules.yaml 里手写的风格一致，重写整块时 diff 噪声最小
    return '[' + v.map((x) => JSON.stringify(String(x))).join(', ') + ']'
  }
  const s = String(v)
  // 需要引号的情况：空串、含 # 或 : 空格、首尾空白、以特殊字符开头、像数字/bool
  const needQuote =
    s === '' ||
    /^\s|\s$/.test(s) ||
    /[:#]/.test(s) ||
    /^[-?*&!|>%@`"'[\]{},]/.test(s) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s)
  if (!needQuote) return s
  return "'" + s.replace(/'/g, "''") + "'"
}

/**
 * 整块替换一个对象数组（B-15）。
 *
 * `setConfigPath` 是逐行改标量的，写不了多行数组；这里按「键名行 → 下一个同级行」
 * 定位整块，用序列化结果替换。只动这一块，其余行（含注释、空行）原样保留。
 */
export function setConfigBlock(
  raw: string,
  key: string,
  value: unknown,
): { text: string; ok: boolean; error?: string } {
  const parts = key.split('.')
  const leaf = parts[parts.length - 1]!
  const parents = parts.slice(0, -1)
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = normalized.split('\n')

  let from = 0
  let baseIndent = 0
  if (parents.length) {
    const want = parents[parents.length - 1]!
    let pLine = -1
    let pIndent = -1
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)([^:#\s][^:#]*):\s*(#.*)?$/.exec(lines[i]!)
      if (m && m[2]!.trim() === want) {
        pIndent = m[1]!.length
        pLine = i
        break
      }
    }
    if (pLine < 0) return { text: raw, ok: false, error: `找不到父级 ${want}` }
    from = pLine + 1
    baseIndent = pIndent + 2
  }

  const leafRe = new RegExp('^(\\s*)' + leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:')
  let leafLine = -1
  let leafIndent = baseIndent
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    const ind = /^(\s*)/.exec(l)![1]!.length
    if (ind < baseIndent) break
    const m = leafRe.exec(l)
    if (m) {
      leafLine = i
      leafIndent = m[1]!.length
      break
    }
  }

  const pad = ' '.repeat(leafIndent)
  const block: string[] = [`${pad}${leaf}:`]
  if (Array.isArray(value)) {
    for (const row of value) {
      const obj = (row ?? {}) as Record<string, unknown>
      const keys = Object.keys(obj)
      if (!keys.length) continue
      const first = keys[0]!
      block.push(`${pad}  - ${first}: ${scalarToYaml(obj[first])}`)
      for (const k of keys.slice(1)) {
        block.push(`${pad}    ${k}: ${scalarToYaml(obj[k])}`)
      }
    }
    if (value.length === 0) block[0] = `${pad}${leaf}: []`
  } else {
    block[0] = `${pad}${leaf}: ${scalarToYaml(value)}`
  }

  if (leafLine < 0) {
    // 没有这个键：追加到父级段落末尾（顶层就追加到文件末尾）
    let insertAt = lines.length
    if (parents.length) {
      for (let i = from; i < lines.length; i++) {
        const l = lines[i]!
        if (l.trim() && /^(\s*)/.exec(l)![1]!.length < baseIndent) {
          insertAt = i
          break
        }
      }
    }
    lines.splice(insertAt, 0, ...block)
    return { text: lines.join('\n'), ok: true }
  }

  // 块结束：下一个缩进 <= leafIndent 的非空行
  let end = leafLine + 1
  for (let i = leafLine + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    if (/^(\s*)/.exec(l)![1]!.length <= leafIndent) break
    end = i + 1
  }

  lines.splice(leafLine, end - leafLine, ...block)
  return { text: lines.join('\n'), ok: true }
}