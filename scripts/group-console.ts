import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')

/* ---------- 1. 导航换成 6 组 ---------- */
const navNew = `  <nav id="nav">
    <button class="on" data-v="state"><span class="ico">◎</span>状态</button>
    <button data-v="memory"><span class="ico">◈</span>记忆</button>
    <button data-v="comm"><span class="ico">≡</span>对话</button>
    <button data-v="self"><span class="ico">✦</span>自我</button>
    <button data-v="settings"><span class="ico">⚙</span>设置</button>
    <button data-v="tools"><span class="ico">⌘</span>工具</button>
  </nav>`
const navStart = html.indexOf('<nav id="nav">')
const navEnd = html.indexOf('</nav>', navStart) + '</nav>'.length
html = html.slice(0, navStart) + navNew + html.slice(navEnd)

/* ---------- 2. 在 views 容器顶部插一个 tab 条 ---------- */
html = html.replace('<div class="views">', '<div class="views">\n      <div class="group-tabs" id="group-tabs"></div>')

/* ---------- 3. 导航逻辑换成分组 ---------- */
const oldNav = html.match(/\/\/ ---------- 导航 ----------[\s\S]*?\n\}\)\n/)
if (!oldNav) {
  console.log('找不到导航逻辑')
  process.exit(1)
}

const newNav = `// ---------- 导航：6 组，组内用 tab 切 ----------
const GROUPS = {
  state: [['v-state', '状态'], ['v-overview', '概览'], ['v-relation', '关系']],
  memory: [['v-memory', '记忆'], ['v-search', '搜索']],
  comm: [['v-logs', '日志'], ['v-chat', '对话']],
  self: [['v-self', '自我']],
  settings: [['v-rules', '规则'], ['v-access', '权限'], ['v-history', '历史']],
  tools: [['v-try', '试聊'], ['v-ops', '操作']],
}
const TITLES = { state: '状态', memory: '记忆', comm: '对话', self: '自我', settings: '设置', tools: '工具' }

let currentGroup = 'state'

function showGroup(g, subIndex = 0) {
  currentGroup = g
  const list = GROUPS[g]
  if (!list) return
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('on'))
  const target = document.getElementById(list[subIndex] ? list[subIndex][0] : list[0][0])
  if (target) target.classList.add('on')

  const bar = $('group-tabs')
  if (bar) {
    bar.innerHTML = ''
    if (list.length > 1) {
      list.forEach(([id, label], i) => {
        const b = el('button', 'gtab' + (i === subIndex ? ' on' : ''), label)
        b.onclick = () => showGroup(g, i)
        bar.appendChild(b)
      })
    }
  }
  $('title').textContent = TITLES[g] || g
  runLoaders(list[subIndex] ? list[subIndex][0] : list[0][0])
}

function runLoaders(viewId) {
  if (viewId === 'v-state') { loadStatus(); loadState() }
  if (viewId === 'v-overview') { loadStatus(); loadTrend() }
  if (viewId === 'v-relation') loadRelation()
  if (viewId === 'v-memory') loadMemory()
  if (viewId === 'v-search') $('search-input')?.focus()
  if (viewId === 'v-logs') loadStatus()
  if (viewId === 'v-chat') loadChat()
  if (viewId === 'v-self') loadSelf()
  if (viewId === 'v-rules') loadRules()
  if (viewId === 'v-access') loadAccessPolicy()
  if (viewId === 'v-history') loadHistory()
}

$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  $('nav').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
  showGroup(b.dataset.v)
})
`

html = html.replace(oldNav[0], newNav)

/* ---------- 4. tab 条样式 ---------- */
const css = `  /* ---- 组内 tab ---- */
  .group-tabs{display:flex;gap:2px;margin-bottom:14px}
  .gtab{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim2);font-size:13px;padding:7px 16px;cursor:pointer;font-family:inherit;transition:color .15s}
  .gtab:hover{color:var(--text)}
  .gtab.on{color:var(--blue);border-bottom-color:var(--blue)}
`
html = html.replace('  /* ---- 状态页 ---- */', css + '\n  /* ---- 状态页 ---- */')

/* ---------- 5. 初始显示状态组 ---------- */
html = html.replace("loadStatus()\nloadState()\nconnectEvents()", "connectEvents()\nshowGroup('state')")

writeFileSync(FILE, html, 'utf8')
console.log('导航已改为 6 组，DOM 全部保留')
