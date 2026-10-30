/**
 * 插件管理面板。
 *
 * 只做前端展示和请求：插件的扫描、安装、卸载、启停、重载都由后端
 * /api/plugins/* 处理，这里不碰任何文件。
 *
 * 挂载风格和 napcat.js 一致：IIFE + 把入口挂到 window。
 */
;(function () {
  'use strict'

  let HOST = null // 当前面板容器
  let ROWS = [] // 最近一次拉到的插件列表
  let UPDATES = {} // 插件 id -> 更新信息
  let SHELL = false // 骨架是否已经画过

  /* ============================================================
   * 请求 + 错误提示
   * ============================================================ */

  /** 取容器：支持传元素、传元素 id，都不传就用 plugins-panel */
  function resolveHost(container) {
    if (container && typeof container === 'object' && container.nodeType === 1) return container
    if (typeof container === 'string' && container) return document.getElementById(container)
    return document.getElementById('plugins-panel')
  }

  /** 后端统一返回 { ok, data }；ok 为 false 时把 error 抛成异常 */
  function unwrap(r) {
    if (r && r.ok === false) throw new Error(r.error || '请求失败')
    return r && r.data !== undefined ? r.data : r
  }

  /** GET 请求（路径只写相对地址） */
  async function getData(path) {
    return unwrap(await api(path))
  }

  /** POST JSON 请求 */
  async function postData(path, body) {
    return unwrap(await sendJson(path, body || {}, 'POST'))
  }

  /** 把任意异常转成一行可读文本 */
  function errText(e) {
    if (typeof e === 'string' && e) return e
    if (e && e.message) return String(e.message)
    return String(e || '请求失败')
  }

  /** 清空面板里的错误行 */
  function clearError() {
    const box = document.getElementById('plugins-error')
    if (!box) return
    box.textContent = ''
    box.style.display = 'none'
  }

  /** 在面板内显示一行红字，不弹 alert */
  function showError(message) {
    let box = document.getElementById('plugins-error')
    if (!box && HOST) {
      ensureShell(HOST)
      box = document.getElementById('plugins-error')
    }
    if (!box) return
    box.textContent = errText(message)
    box.style.display = ''
  }

  /* ============================================================
   * 面板骨架
   * ============================================================ */

  function ensureShell(host) {
    if (host === HOST && SHELL && document.getElementById('plugins-error')) return

    HOST = host
    SHELL = true
    host.innerHTML = ''

    const card = el('div', 'card')

    const row = el('div')
    row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap'

    const title = el('b', '', '插件管理')
    title.style.cssText = 'font-size:15px'
    row.appendChild(title)
    row.appendChild(
      el('span', 'hint', '安装、卸载、启停、重载都在这里；真正的文件操作由后端完成。'),
    )

    const btnInstall = el('button', 'mini-btn', '安装')
    btnInstall.onclick = () => window.pluginsInstall()
    row.appendChild(btnInstall)

    const btnCheck = el('button', 'mini-btn', '检查更新')
    btnCheck.onclick = () => window.checkPluginUpdates()
    row.appendChild(btnCheck)

    const btnRefresh = el('button', 'mini-btn', '刷新')
    btnRefresh.onclick = () => window.renderPlugins(HOST)
    row.appendChild(btnRefresh)

    card.appendChild(row)

    // 错误行：所有请求失败都落在这里
    const err = el('div', 'hint', '')
    err.id = 'plugins-error'
    err.style.cssText =
      'display:none;margin-top:8px;color:#f85149;font-size:12px;line-height:1.5;word-break:break-all'
    card.appendChild(err)

  // 两组：工具插件（type=tool）/ 已安装（其余）
  // 之前是一张表把所有插件平铺，现在按 v2 设计分组
  const g1 = el('div', 'grp')
  g1.style.marginTop = 'var(--gap-group)'
  const g1h = el('div', 'grp-h')
  g1h.appendChild(el('b', '', '工具插件'))
  g1h.appendChild(el('span', '', '注册成模型能调用的工具'))
  g1.appendChild(g1h)
  const g1grid = el('div', 'grid')
  g1grid.id = 'plugins-tool-grid'
  g1.appendChild(g1grid)
  card.appendChild(g1)
  
  const g2 = el('div', 'grp')
  g2.style.marginTop = 'var(--gap-group)'
  const g2h = el('div', 'grp-h')
  g2h.appendChild(el('b', '', '已安装'))
  g2h.appendChild(el('span', '', '从本地装的，能卸'))
  g2.appendChild(g2h)
  const g2grid = el('div', 'grid')
  g2grid.id = 'plugins-installed-grid'
  g2.appendChild(g2grid)
  card.appendChild(g2)
  
  host.appendChild(card)
  }

  /* ============================================================
   * 列表 + 渲染
   * ============================================================ */

  /** 从 /api/plugins/list 取列表，兼容 data.plugins / plugins / 裸数组 */
  async function fetchPlugins() {
    const d = await getData('/api/plugins/list')
    const list = Array.isArray(d)
      ? d
      : (d && (d.plugins || (d.data && d.data.plugins))) || []
    return Array.isArray(list) ? list : []
  }

  /** 重新拉列表并重画表格（不动错误行） */
  async function reloadList() {
    ROWS = await fetchPlugins()
    drawRows()
  }

/** 一张插件卡（工具插件 / 已安装共用） */
  function pluginCard(p, isTool) {
    const card = el('div', 'card' + (p.enabled ? '' : ' off'))
    const head = el('div', 'card-h')
    const ico = el('div', 'ico2' + (p.enabled ? '' : ' gray'))
    ico.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (isTool
        ? '<path d="M4 7h16M4 12h16M4 17h10"/>'
        : '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6M9 13h4"/>') +
      '</svg>'
    head.appendChild(ico)
    head.appendChild(el('b', '', p.name || p.id || '（未命名）'))
    head.appendChild(el('span', 'ver', 'v' + (p.version || '?')))
    if (isTool) head.appendChild(el('span', 'tag blue', '工具'))
    const sp = el('span', 'spacer')
    head.appendChild(sp)

    // 启停：恒成功的用开关；demo 这种也能关
    const sw = el('button', 'sw' + (p.enabled ? '' : ' off'), p.enabled ? '开' : '关')
    sw.onclick = () => window.pluginToggle?.(p.id, p.enabled)
    head.appendChild(sw)
    card.appendChild(head)

    card.appendChild(el('div', 'desc', p.description || '（没有说明）'))

    // 有更新就把版本号显示成「当前 → 最新」
    const up = UPDATES[String(p.id)]
    if (up) {
      const row = el('div', 'prow')
      row.appendChild(el('span', 'k', '版本'))
      const v = el('span', 'v', (up.current || p.version || '?') + ' → ' + (up.latest || '?'))
      v.style.color = 'var(--yellow)'
      row.appendChild(v)
      const badge = el('span', 'tag', '有更新')
      badge.style.color = 'var(--yellow)'
      badge.style.borderColor = 'rgba(210,153,34,.35)'
      row.appendChild(badge)
      card.appendChild(row)
    }

    // 工具插件：把它注册了哪些工具列出来 —— 这是它和普通插件最大的区别
    if (isTool && Array.isArray(p.tools) && p.tools.length) {
      const params = el('div', 'params')
      for (const t of p.tools) {
        const row = el('div', 'prow')
        row.appendChild(el('span', 'k', '工具'))
        const v = el('span', 'v', t)
        v.style.fontFamily = 'ui-monospace,Consolas,monospace'
        v.style.fontSize = '11.5px'
        row.appendChild(v)
        params.appendChild(row)
      }
      card.appendChild(params)
    }

    // 配置项（manifest 声明的）
    if (p.configSchema && typeof p.configSchema === 'object') {
      const keys = Object.keys(p.configSchema)
      if (keys.length) {
        const params = el('div', 'params')
        for (const k of keys.slice(0, 3)) {
          const f = p.configSchema[k] || {}
          const row = el('div', 'prow')
          row.appendChild(el('span', 'k', f.label || k))
          const cur = p.config && p.config[k] !== undefined ? p.config[k] : f.default
          row.appendChild(el('span', 'v', String(cur ?? '—')))
          const ed = el('button', 'ed', '改')
          ed.onclick = () => openConfigEditor(p)
          row.appendChild(ed)
          params.appendChild(row)
        }
        card.appendChild(params)
      }
    }

    const foot = el('div', 'foot2')
    foot.appendChild(el('span', '', p.loaded ? '已加载' : '未加载'))
    const sp2 = el('span', 'spacer')
    foot.appendChild(sp2)
    const cfg = el('button', 't', '配置')
    cfg.onclick = () => openConfigEditor(p)
    foot.appendChild(cfg)
    // 工具插件：手动跑一次，看它到底行不行（不用等模型去调）
    if (isTool && Array.isArray(p.tools) && p.tools.length) {
      const test = el('button', 't', '测试')
      test.onclick = () => testPluginTool(p.tools[0])
      foot.appendChild(test)
    }
    const reload = el('button', 't', '重载')
    reload.onclick = () => window.pluginReload?.(p.id)
    foot.appendChild(reload)
    const del = el('button', 't', '卸载')
    del.onclick = () => window.pluginUninstall?.(p.id)
    foot.appendChild(del)
    card.appendChild(foot)

    return card
  }

  /** 手动跑一次插件工具，把返回内容显示出来 */
  async function testPluginTool(toolName) {
    try {
      const r = await postData('/api/plugins/test', { tool: toolName })
      const d = r && typeof r === 'object' ? r : {}
      window.alert(`[${toolName}] ${d.ms ?? 0}ms\n\n${d.result || '（没有返回内容）'}`)
    } catch (e) {
      window.alert('测试失败：' + errText(e))
    }
  }

  function drawRows() {
    const gridTool = document.getElementById('plugins-tool-grid')
    const gridOther = document.getElementById('plugins-installed-grid')
    if (!gridTool || !gridOther) return
    gridTool.innerHTML = ''
    gridOther.innerHTML = ''

    const tools = ROWS.filter((p) => p.type === 'tool')
    const others = ROWS.filter((p) => p.type !== 'tool')

    if (!tools.length) {
      gridTool.appendChild(
        el('div', 'empty', '还没有工具插件。装一个 plugin.json 里写 "type": "tool" 的插件，它注册的工具就会出现在这里。'),
      )
    } else {
      for (const p of tools) gridTool.appendChild(pluginCard(p, true))
    }

    if (!others.length) {
      gridOther.appendChild(el('div', 'empty', '还没有装外部插件。'))
    } else {
      for (const p of others) gridOther.appendChild(pluginCard(p, false))
    }
  }

  /**
   * 面板入口。
   *
   * 不传参数时用 id 为 plugins-panel 的容器；
   * 也可以直接传元素或元素 id，方便以后放到别的位置。
   */
  async function renderPlugins(container) {
    const host = resolveHost(container)
    if (!host) return

    ensureShell(host)
    clearError()

    try {
      await reloadList()
    } catch (e) {
      showError(errText(e))
    }
  }

  /* ============================================================
   * 操作
   * ============================================================ */

  function findPlugin(id) {
    return ROWS.find((p) => String(p.id) === String(id)) || null
  }

  /** 操作成功后统一刷新列表；失败只写错误行 */
  async function runAction(label, fn) {
    clearError()
    try {
      await fn()
      await reloadList()
      toast(label + '完成')
    } catch (e) {
      showError(errText(e))
    }
  }

  /** 安装：让用户填本地插件目录，再交给后端复制 */
  async function pluginsInstall() {
    const input = window.prompt('本地插件目录路径（目录里要有 plugin.json）')
    if (input === null) return

    const source = input.trim()
    if (!source) {
      clearError()
      showError('请填写插件目录路径')
      return
    }

    await runAction('安装', () => postData('/api/plugins/install', { source }))
  }

  /** 卸载：二次确认 */
  async function pluginUninstall(id) {
    const p = findPlugin(id)
    const name = p && p.name ? p.name : id
    if (!window.confirm('卸载插件「' + name + '」？\n插件目录会被删除，不可恢复。')) return

    await runAction('卸载', () => postData('/api/plugins/uninstall', { id }))
  }

  /** 启用 / 停用：按当前状态取反 */
  async function pluginToggle(id, enabled) {
    const next = !enabled
    await runAction(next ? '启用' : '停用', () =>
      postData('/api/plugins/toggle', { id, enabled: next }),
    )
  }

  /** 重载：只在已加载的插件上有实际效果，失败原因由后端给 */
  async function pluginReload(id) {
    await runAction('重载', () => postData('/api/plugins/reload', { id }))
  }

  /* ============================================================
   * 配置弹窗
   *
   * 两种形态：
   *   - 插件声明了 configSchema → 按 type 渲染 input / checkbox / select
   *   - 没声明 → 通用键值编辑器（值按字面量试着还原成数字/布尔）
   * 保存走 POST /api/plugins/config，写进 persona/plugins.yaml
   * ============================================================ */

  let CONFIG_MASK = null
  let CONFIG_ONKEY = null

  const INPUT_STYLE =
    'width:100%;box-sizing:border-box;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:6px 8px;color:inherit;font-size:13px;font-family:inherit'

  function closeConfigEditor() {
    if (CONFIG_ONKEY) {
      document.removeEventListener('keydown', CONFIG_ONKEY)
      CONFIG_ONKEY = null
    }
    if (CONFIG_MASK && CONFIG_MASK.parentNode) CONFIG_MASK.parentNode.removeChild(CONFIG_MASK)
    CONFIG_MASK = null
  }

  /** 键值模式：把文本尽量还原成数字/布尔/null，其余保持字符串 */
  function parseKV(raw) {
    const t = String(raw).trim()
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === 'null') return null
    if (t !== '' && /^-?\d+(?:\.\d+)?$/.test(t)) {
      const n = Number(t)
      if (Number.isFinite(n)) return n
    }
    return String(raw)
  }

  /** 按字段声明造一个控件，返回元素和读值函数 */
  function makeField(key, field, current, hasValue) {
    const type = typeof field.type === 'string' ? field.type : 'string'
    const value = hasValue ? current[key] : field.default
    let input

    if (type === 'boolean') {
      input = el('input')
      input.type = 'checkbox'
      input.checked = value === true
      input.style.cssText = 'width:16px;height:16px;cursor:pointer'
    } else if (type === 'select') {
      input = el('select')
      input.style.cssText = INPUT_STYLE + ';cursor:pointer'
      const opts = Array.isArray(field.options) ? field.options.slice() : []
      // 当前值不在 options 里也保留一项，别让用户已有的配置被悄悄丢掉
      if (
        hasValue &&
        value !== undefined &&
        value !== null &&
        !opts.some((o) => String(o) === String(value))
      ) {
        opts.push(String(value))
      }
      for (const o of opts) {
        const opt = el('option', '', String(o))
        opt.value = String(o)
        if (String(value) === String(o)) opt.selected = true
        input.appendChild(opt)
      }
    } else if (type === 'number') {
      input = el('input')
      input.type = 'number'
      if (typeof field.min === 'number') input.min = String(field.min)
      if (typeof field.max === 'number') input.max = String(field.max)
      input.value = value === undefined || value === null ? '' : String(value)
      input.style.cssText = INPUT_STYLE
    } else {
      input = el('input')
      input.type = 'text'
      input.value = value === undefined || value === null ? '' : String(value)
      input.style.cssText = INPUT_STYLE
    }

    return {
      input,
      type,
      /** 数字留空返回 undefined（表示这一项不写入） */
      read() {
        if (type === 'boolean') return input.checked
        if (type === 'number') {
          const raw = String(input.value).trim()
          if (raw === '') return undefined
          const n = Number(raw)
          return Number.isFinite(n) ? n : undefined
        }
        return input.value
      },
    }
  }

  function openConfigEditor(p) {
    closeConfigEditor()

    const schema = p && p.configSchema && typeof p.configSchema === 'object' ? p.configSchema : null
    const current = p && p.config && typeof p.config === 'object' ? p.config : {}
    const id = p && p.id ? String(p.id) : ''
    const name = p && p.name ? String(p.name) : id
    if (!id) return

    const mask = el('div')
    mask.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px'
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closeConfigEditor()
    })

    const box = el('div', 'card')
    box.style.cssText = 'width:min(560px,94vw);max-height:84vh;overflow:auto;padding:18px'

    const head = el('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:2px'
    const title = el('b', '', name + ' 的配置')
    title.style.fontSize = '15px'
    head.appendChild(title)
    box.appendChild(head)

    const sub = el(
      'div',
      'hint',
      schema
        ? '按插件声明的字段填。改完点「保存」，再重载这个插件才生效。'
        : '这个插件没声明配置项，可以自己加键值（能识别数字和 true/false）。',
    )
    sub.style.cssText = 'font-size:12px;margin-bottom:14px;line-height:1.5'
    box.appendChild(sub)

    const form = el('div')
    form.style.cssText = 'display:flex;flex-direction:column;gap:12px'
    box.appendChild(form)

    /** 每项返回 {key, value} 或 {key, raw} */
    const readers = []

    if (schema) {
      for (const key of Object.keys(schema)) {
        const field = schema[key] && typeof schema[key] === 'object' ? schema[key] : { type: 'string' }
        const hasValue = Object.prototype.hasOwnProperty.call(current, key)
        const label = typeof field.label === 'string' && field.label ? field.label : key

        const row = el('div')
        row.style.cssText = 'display:flex;flex-direction:column;gap:4px'

        const lab = el('label', '', label)
        lab.style.cssText = 'font-size:12px;opacity:.75'
        row.appendChild(lab)

        const made = makeField(key, field, current, hasValue)
        row.appendChild(made.input)

        if (typeof field.hint === 'string' && field.hint) {
          const hint = el('div', '', field.hint)
          hint.style.cssText = 'font-size:11px;opacity:.5;line-height:1.4'
          row.appendChild(hint)
        }

        form.appendChild(row)
        readers.push(() => ({ key, value: made.read() }))
      }
    } else {
      const rowsBox = el('div')
      rowsBox.style.cssText = 'display:flex;flex-direction:column;gap:8px'
      form.appendChild(rowsBox)

      function addKVRow(k, v) {
        const row = el('div')
        row.style.cssText = 'display:flex;gap:6px;align-items:center'

        const keyIn = el('input')
        keyIn.type = 'text'
        keyIn.placeholder = '键'
        keyIn.value = k === undefined ? '' : String(k)
        keyIn.style.cssText = INPUT_STYLE + ';flex:0 0 38%'

        const valIn = el('input')
        valIn.type = 'text'
        valIn.placeholder = '值'
        valIn.value = v === undefined ? '' : String(v)
        valIn.style.cssText = INPUT_STYLE + ';flex:1 1 auto'

        const del = el('button', 'mini-btn', '删')
        del.onclick = () => {
          if (row.parentNode) row.parentNode.removeChild(row)
        }

        row.appendChild(keyIn)
        row.appendChild(valIn)
        row.appendChild(del)
        rowsBox.appendChild(row)
        readers.push(() => ({ key: keyIn.value.trim(), raw: valIn.value }))
      }

      const existing = Object.keys(current)
      for (const k of existing) {
        const v = current[k]
        addKVRow(k, v === null || typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      if (existing.length === 0) addKVRow('', '')

      const addBtn = el('button', 'mini-btn', '+ 加一项')
      addBtn.onclick = () => addKVRow('', '')
      form.appendChild(addBtn)
    }

    function collect() {
      const out = {}
      for (const r of readers) {
        const item = r()
        if (item.raw !== undefined) {
          if (!item.key) continue
          out[item.key] = parseKV(item.raw)
        } else if (item.value !== undefined) {
          out[item.key] = item.value
        }
      }
      return out
    }

    const foot = el('div')
    foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px'

    const cancel = el('button', 'mini-btn', '取消')
    cancel.onclick = () => closeConfigEditor()

    const save = el('button', 'mini-btn', '保存')
    const saveReload = el('button', 'mini-btn', '保存并重载')

    async function doSave(thenReload) {
      save.disabled = true
      saveReload.disabled = true
      clearError()
      try {
        await postData('/api/plugins/config', { id, config: collect() })
        closeConfigEditor()
        if (thenReload) {
          await postData('/api/plugins/reload', { id })
          await reloadList()
          toast('已保存并重载')
        } else {
          await reloadList()
          toast('已保存，重载后生效')
        }
      } catch (e) {
        save.disabled = false
        saveReload.disabled = false
        showError(errText(e))
      }
    }

    save.onclick = () => doSave(false)
    saveReload.onclick = () => doSave(true)

    foot.appendChild(cancel)
    foot.appendChild(save)
    foot.appendChild(saveReload)
    box.appendChild(foot)

    mask.appendChild(box)
    document.body.appendChild(mask)
    CONFIG_MASK = mask

    CONFIG_ONKEY = (e) => {
      if (e.key === 'Escape') closeConfigEditor()
    }
    document.addEventListener('keydown', CONFIG_ONKEY)
  }

  /** 检查更新：把 current → latest 标在版本列 */
  async function checkPluginUpdates() {
    clearError()
    try {
      const d = await getData('/api/plugins/updates')
      const items = Array.isArray(d) ? d : (d && d.items) || []

      UPDATES = {}
      let count = 0
      for (const it of items) {
        if (!it || !it.id) continue
        UPDATES[String(it.id)] = it
        if (it.hasUpdate) count++
      }

      await reloadList()

      // 后端可能只拿到部分索引：列表照常显示，错误单独提示
      // 没有 plugins/index.json 是「正常但检查不了」，不是错误。
      // 之前写进红色错误行，用户看到的是"报错了"，其实插件好好的。
      if (d && d.error) {
        const friendly = /index\.json/.test(String(d.error))
          ? '还没配更新源（plugins/index.json），检查不了更新；不影响插件使用'
          : String(d.error)
        toast(friendly)
      } else {
        toast(count > 0 ? count + ' 个插件有更新' : '插件都是最新的')
      }
    } catch (e) {
      showError(errText(e))
    }
  }

  /* ============================================================
   * 挂到 window
   * ============================================================ */

  window.renderPlugins = renderPlugins
  window.pluginsInstall = pluginsInstall
  window.pluginUninstall = pluginUninstall
  window.pluginToggle = pluginToggle
  window.pluginReload = pluginReload
  window.checkPluginUpdates = checkPluginUpdates

  // 页面加载时如果面板已经存在，就先拉一次；切换标签时 runLoaders 还会再调。
  function autoLoad() {
    const host = document.getElementById('plugins-panel')
    if (host) renderPlugins(host)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoLoad)
  } else {
    autoLoad()
  }
})()
