import { readFileSync, writeFileSync } from 'node:fs'

const p = 'console/index.html'
let t = readFileSync(p, 'utf8')

// 找所有 "?.xxx =" 这种非法赋值
const bad = /(\$\('[^']+'\))\?\.(\w+)\s*=/g
let n = 0
const hits: string[] = []
let m: RegExpExecArray | null
while ((m = bad.exec(t))) {
  hits.push(`${m[1]}?.${m[2]} =`)
  n++
}

console.log(`找到 ${n} 处非法赋值：`)
for (const h of hits) console.log('  ' + h)

// 修法：改成  if ($('x')) $('x').prop = ...   太啰嗦
// 更好：改成  ($('x') || {}).prop = ...  —— 也不行（赋给临时对象，但语法合法且安全）
//
// 最干净：用 setText 辅助。这里没有，那就改成：
//   const el = $('x'); if (el) el.prop = ...
// 用脚本做行级替换
const lines = t.split('\n')
let fixed = 0
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]!
  const mm = /^(\s*)(\$\('[^']+'\))\?\.(\w+)\s*=\s*(.+)$/.exec(l)
  if (!mm) continue
  const [, indent, sel, prop, rhs] = mm
  // 单行改成 if 保护
  lines[i] = `${indent}if (${sel}) ${sel}.${prop} = ${rhs}`
  fixed++
}

t = lines.join('\n')
writeFileSync(p, t, 'utf8')
console.log('')
console.log(`✓ 修了 ${fixed} 处`)
