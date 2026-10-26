import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')
const before = html.length

// 这些元素所在的页面在合并时被并掉了，对应的更新逻辑要删掉——
// 状态页由 loadState 负责，不需要老的 c-* / r-* / sched-info
const deadIds = ['c-link', 'c-link-s', 'c-rel', 'c-rel-s', 'c-today', 'c-today-s', 'c-mem', 'c-mem-s', 'c-cost', 'c-cost-s', 'rel-next', 'rel-block', 'mini-log', 'sched-info', 'r-num', 'r-stages', 'r-ring', 'r-hint', 'r-mood', 'r-anchors']

const lines = html.split('\n')
const kept = []
let removed = 0
for (const line of lines) {
  const hit = deadIds.some((id) => line.includes(`$('${id}')`))
  if (hit) {
    removed++
    continue
  }
  kept.push(line)
}
html = kept.join('\n')

// loadRelation 已无页面承载，整段删掉
const relStart = html.indexOf('async function loadRelation() {')
if (relStart >= 0) {
  // 找到函数结尾：从 relStart 开始数大括号
  let depth = 0
  let i = relStart
  let started = false
  for (; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true }
    else if (html[i] === '}') { depth--; if (started && depth === 0) { i++; break } }
  }
  html = html.slice(0, relStart) + html.slice(i)
}

writeFileSync(FILE, html, 'utf8')
console.log(`删掉 ${removed} 行引用已删除 DOM 的代码`)
console.log(`体积 ${before} → ${html.length}`)
