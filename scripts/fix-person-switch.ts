import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')

/* ---------- 1. 记住当前显示的 view ---------- */
html = html.replace(
  "let currentGroup = 'state'",
  "let currentGroup = 'state'\nlet currentViewId = 'v-state'\n\n/** 当前显示的是哪个 view（切人后要重新拉它的数据） */\nfunction activeView() {\n  return currentViewId\n}",
)

html = html.replace(
  "  const target = document.getElementById(list[subIndex] ? list[subIndex][0] : list[0][0])\n  if (target) target.classList.add('on')",
  "  const viewId = list[subIndex] ? list[subIndex][0] : list[0][0]\n  currentViewId = viewId\n  const target = document.getElementById(viewId)\n  if (target) target.classList.add('on')",
)

/* ---------- 2. 切人后重新跑当前 view 的 loader ---------- */
const oldSwitch = `    item.onclick = () => {
      if (p.id !== currentPerson) {
        currentPerson = p.id
        localStorage.setItem('qqbot-person', currentPerson)
        menu.classList.remove('on')
        loadStatus()
        const active = document.querySelector('nav button.on')?.dataset.v
        if (active === 'memory') loadMemory()
        if (active === 'relation') loadRelation()
        if (active === 'self') loadSelf()
      } else {
        menu.classList.remove('on')
      }
    }`

const newSwitch = `    item.onclick = () => {
      menu.classList.remove('on')
      if (p.id === currentPerson) return
      currentPerson = p.id
      localStorage.setItem('qqbot-person', currentPerson)
      // 换了个人，当前页面上的东西基本都变了：整组重新拉一遍
      loadStatus()
      runLoaders(activeView())
      toast('已切换到 ' + (p.name || p.id))
    }`

if (!html.includes(oldSwitch)) {
  console.log('找不到切换逻辑')
  process.exit(1)
}
html = html.replace(oldSwitch, newSwitch)

/* ---------- 3. 对话页切人也要重载 ---------- */
html = html.replace(
  "  if (viewId === 'v-chat') loadChat()",
  "  if (viewId === 'v-chat') loadChat()\n  if (viewId === 'v-trend') loadTrend()",
)

writeFileSync(FILE, html, 'utf8')
console.log('切换逻辑已改：切人后重新跑当前页的 loader')
