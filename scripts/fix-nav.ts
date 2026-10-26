import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')

const navNew = `  <nav id="nav">
    <button class="on" data-v="state"><span class="ico">◎</span>状态</button>
    <button data-v="memory"><span class="ico">◈</span>记忆</button>
    <button data-v="comm"><span class="ico">≡</span>对话</button>
    <button data-v="self"><span class="ico">✦</span>自我</button>
    <button data-v="settings"><span class="ico">⚙</span>设置</button>
    <button data-v="tools"><span class="ico">⌘</span>工具</button>
  </nav>`

const start = html.indexOf('<nav id="nav">')
const end = html.indexOf('</nav>', start) + '</nav>'.length
if (start < 0) {
  console.log('找不到 nav')
  process.exit(1)
}
html = html.slice(0, start) + navNew + html.slice(end)

// 标题
html = html.replace('<span class="t" id="title">总览</span>', '<span class="t" id="title">状态</span>')

writeFileSync(FILE, html, 'utf8')
console.log('nav 已替换为 6 项')
