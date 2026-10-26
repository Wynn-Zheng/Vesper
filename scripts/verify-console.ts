import { readFileSync } from 'node:fs'

const html = readFileSync('console/index.html', 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/)
try {
  new Function(m[1])
  console.log('语法 OK')
} catch (e) {
  console.log('语法错误:', e.message)
}
const views = Array.from(html.matchAll(/<section class="view[^"]*" id="([^"]+)"/g)).map((x) => x[1])
console.log('页面:', views.join(', '))
const navs = Array.from(html.matchAll(/data-v="([^"]+)"/g)).map((x) => x[1])
console.log('导航:', navs.join(', '))
