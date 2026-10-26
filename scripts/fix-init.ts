import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')

const old = `// ---------- 启动 ----------
loadStatus()
connectEvents()`

const neu = `// ---------- 启动 ----------
connectEvents()
showGroup('state')`

if (!html.includes(old)) {
  console.log('没匹配启动段')
  process.exit(1)
}
html = html.replace(old, neu)

// 初始 view 不要带 on，交给 showGroup 决定
html = html.replace('<section class="view on" id="v-overview">', '<section class="view" id="v-overview">')

writeFileSync(FILE, html, 'utf8')
console.log('启动改为 showGroup("state")')
