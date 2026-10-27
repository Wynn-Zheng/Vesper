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

    // 表格
    const wrap = el('div')
    wrap.style.cssText = 'margin-top:12px;overflow-x:auto'

    const table = el('table')
    table.style.cssText = 'width:100%;border-collapse:collapse;min-width:780px'

    const thead = el('thead')
    const headRow = el('tr')
    headRow.style.cssText = 'background:rgba(255,255,255,.03);text-align:left'
    for (const h of ['名称', 'id', '版本', '描述', '启用状态', '已加载状态', '操作']) {
      const th = el('th', '', h)
      th.style.cssText =
        'padding:8px;font-size:11.5px;font-weight:600;color:#8b949e;white-space:nowrap'
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = el('tbody')
    tbody.id = 'plugins-rows'
    table.appendChild(tbody)

    wrap.appendChild(table)
    card.appendChild(wrap)
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

  function drawRows() {
    const tbody = document.getElementById('plugins-rows')
    if (!tbody) return
    tbody.innerHTML = ''

    if (ROWS.length === 0) {
      const tr = el('tr')
      const td = el('td', 'hint', '还没有装插件。点上面的「安装」填一个本地插件目录。')
      td.colSpan = 7
      td.style.cssText = 'padding:16px 8px;font-size:12px'
      tr.appendChild(td)
      tbody.appendChild(tr)
      return
    }

    for (const p of ROWS) drawRow(tbody, p)
  }

  function drawRow(tbody, p) {
    const id = String(p.id || '')
    const up = UPDATES[id]

    const tr = el('tr')
    tr.style.cssText = 'border-top:1px solid var(--line)'
    // 有更新的行加一层很淡的底色，扫一眼就能看到
    if (up && up.hasUpdate) tr.style.background = 'rgba(210,153,34,.06)'

    const name = el('td', '', p.name || id || '（未命名）')
    name.style.cssText = 'padding:8px;font-size:12.5px;word-break:break-all'

    const idCell = el('td', '', id || '—')
    idCell.style.cssText =
      'padding:8px;font-size:11.5px;color:#8b949e;font-family:ui-monospace,Consolas,monospace;word-break:break-all'

    const verCell = el('td')
    verCell.style.cssText = 'padding:8px;font-size:12px;white-space:nowrap'
    if (up && up.hasUpdate) {
      const verText = el('span', '', (p.version || up.current || '?') + ' → ' + (up.latest || '?'))
      verText.style.color = '#d29922'
      verCell.appendChild(verText)
      const tag = el('span', '', '有更新')
      tag.style.cssText = 'margin-left:6px;font-size:10.5px;color:#d29922'
      verCell.appendChild(tag)
    } else {
      verCell.textContent = p.version || '—'
    }

    const desc = el('td', '', p.description || '—')
    desc.style.cssText =
      'padding:8px;font-size:12px;color:#8b949e;max-width:280px;word-break:break-word'

    const enabled = el('td', '', p.enabled ? '已启用' : '已停用')
    enabled.style.cssText = 'padding:8px;font-size:12px;white-space:nowrap;color:' + (p.enabled ? '#3fb950' : '#8b949e')

    const loaded = el('td', '', p.loaded ? '已加载' : '未加载')
    loaded.style.cssText = 'padding:8px;font-size:12px;white-space:nowrap;color:' + (p.loaded ? '#3fb950' : '#8b949e')

    const ops = el('td')
    ops.style.cssText = 'padding:8px;white-space:nowrap'

    const btnConfig = el('button', 'mini-btn', '配置')
    btnConfig.onclick = () => openConfigEditor(p)

    const btnUninstall = el('button', 'mini-btn danger', '卸载')
    btnUninstall.onclick = () => window.pluginUninstall(id)

    const btnToggle = el('button', 'mini-btn', p.enabled ? '停用' : '启用')
    btnToggle.onclick = () => window.pluginToggle(id, p.enabled === true)

    const btnReload = el('button', 'mini-btn', '重载')
    btnReload.onclick = () => window.pluginReload(id)

    for (const b of [btnConfig, btnUninstall, btnToggle, btnReload]) {
      b.style.marginRight = '4px'
      ops.appendChild(b)
    }

    tr.appendChild(name)
    tr.appendChild(idCell)
    tr.appendChild(verCell)
    tr.appendChild(desc)
    tr.appendChild(enabled)
    tr.appendChild(loaded)
    tr.appendChild(ops)
    tbody.appendChild(tr)
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
      if (d && d.error) showError(d.error)
      else toast(count > 0 ? count + ' 个插件有更新' : '插件都是最新的')
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
