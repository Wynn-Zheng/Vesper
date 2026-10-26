/**
 * 一次性：把 13 个页签合并成 6 个。
 * 状态（含总览/关系）· 记忆（含搜索）· 对话（含日志）· 自我 · 设置（规则/权限/历史）· 工具（试聊/操作）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'console/index.html'
let html = readFileSync(FILE, 'utf8')

/** 抠出某个 section 的内部内容 */
function inner(id: string): string {
  const start = html.indexOf(`<section class="view${html.includes(`<section class="view on" id="${id}">`) ? ' on' : ''}" id="${id}">`)
  if (start < 0) throw new Error(`找不到 ${id}`)
  const openEnd = html.indexOf('>', start) + 1
  const end = html.indexOf('</section>', openEnd)
  return html.slice(openEnd, end)
}

const ids = ['v-overview', 'v-state', 'v-logs', 'v-chat', 'v-memory', 'v-relation', 'v-self', 'v-rules', 'v-history', 'v-access', 'v-search', 'v-try', 'v-ops']
const parts: Record<string, string> = {}
for (const id of ids) parts[id] = inner(id)

// 总览里去掉删过的部分：只要趋势图、日志、关系块（状态页已经有环形和今日）
const overview = parts['v-overview']!

/** 组装合并后的 6 个 section */
const merged = `
    <section class="view on" id="v-state">
      ${parts['v-state']!}
      <div class="panel" style="margin-top:12px">
        <h3>最近 7 天 <span class="r" id="trend-hint"></span></h3>
        <div class="body">
          <div class="trend-wrap"><svg class="trend" id="trend-chart" viewBox="0 0 420 120" preserveAspectRatio="none"></svg></div>
          <div class="trend-axis" id="trend-axis"></div>
        </div>
      </div>
      <div class="panel" style="margin-top:12px">
        <h3>关系 <span class="r" id="rel-next"></span></h3>
        <div class="body">
          <div class="rel-mini" id="rel-mini"></div>
          <div class="timeline" id="r-anchors" style="margin-top:14px;max-height:300px;overflow:auto"></div>
        </div>
      </div>
    </section>

    <section class="view" id="v-memory">
      <div class="panel" style="margin-bottom:12px">
        <h3>搜索 <span class="r">记忆和日志一起搜</span></h3>
        <div class="body">
          <div class="row" style="margin-top:0">
            <input id="search-input" class="try-input" placeholder="搜什么？比如「四级」或「住院」" style="flex:1">
            <button class="btn pri" onclick="doSearch()">搜</button>
          </div>
          <div class="log-filter" style="margin-top:10px">
            <button class="fbtn on" data-st="all">全部</button>
            <button class="fbtn" data-st="fact">事实</button>
            <button class="fbtn" data-st="open">待办</button>
            <button class="fbtn" data-st="episode">经历</button>
            <button class="fbtn" data-st="raw">对话</button>
            <button class="fbtn" data-st="log">日志</button>
            <span class="hint" id="search-count" style="margin-left:auto"></span>
          </div>
          <div id="search-hits" style="margin-top:12px;max-height:260px;overflow:auto"></div>
        </div>
      </div>
      ${parts['v-memory']!}
    </section>

    <section class="view" id="v-comm">
      <div class="tabs" id="comm-tabs">
        <button class="tab on" data-tab="logs">实时日志</button>
        <button class="tab" data-tab="chat">对话</button>
      </div>
      <div class="tab-pane on" id="tab-logs">
        ${parts['v-logs']!}
      </div>
      <div class="tab-pane" id="tab-chat">
        ${parts['v-chat']!}
      </div>
    </section>

    <section class="view" id="v-self">
      ${parts['v-self']!}
    </section>

    <section class="view" id="v-settings">
      <div class="tabs" id="settings-tabs">
        <button class="tab" data-tab="rules">规则</button>
        <button class="tab" data-tab="access">权限</button>
        <button class="tab" data-tab="history">人格快照</button>
      </div>
      <div class="tab-pane" id="tab-rules">
        ${parts['v-rules']!}
      </div>
      <div class="tab-pane" id="tab-access">
        ${parts['v-access']!}
      </div>
      <div class="tab-pane" id="tab-history">
        ${parts['v-history']!}
      </div>
    </section>

    <section class="view" id="v-tools">
      <div class="tabs" id="tools-tabs">
        <button class="tab on" data-tab="try">试聊</button>
        <button class="tab" data-tab="ops">操作</button>
      </div>
      <div class="tab-pane on" id="tab-try">
        ${parts['v-try']!}
      </div>
      <div class="tab-pane" id="tab-ops">
        ${parts['v-ops']!}
      </div>
    </section>
`

// 把原来 13 个 section 整段替换掉
const firstStart = html.indexOf('<section class="view on" id="v-overview">')
const lastEnd = html.indexOf('</section>', html.lastIndexOf('id="v-ops"')) + '</section>'.length
html = html.slice(0, firstStart) + merged.trim() + html.slice(lastEnd)

// nav 换成 6 项
const navOld = html.match(/<nav>[\s\S]*?<\/nav>/)
if (navOld) {
  const navNew = `<nav>
    <button data-v="state"><span class="ico">◎</span>状态</button>
    <button data-v="memory"><span class="ico">◆</span>记忆</button>
    <button data-v="comm"><span class="ico">≡</span>对话</button>
    <button data-v="self"><span class="ico">✧</span>自我</button>
    <button data-v="settings"><span class="ico">⚙</span>设置</button>
    <button data-v="tools"><span class="ico">⌘</span>工具</button>
  </nav>`
  html = html.replace(navOld[0], navNew)
}

writeFileSync(FILE, html, 'utf8')
console.log('合并完成：13 页 → 6 页')
console.log('原 total:', firstStart, '→', lastEnd)
