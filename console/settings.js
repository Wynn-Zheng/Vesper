/**
 * 设置页的三个新子栏：数据 / 模型 / 关于。
 *
 * 单独一个文件（和 members.js 一样），因为 index.html 已经太大。
 */
;(function () {
  'use strict'

  /* ============================================================
   * 数据
   * ============================================================ */
  async function loadData() {
    const box = document.getElementById('data-body')
    if (!box) return
    box.innerHTML = '<div class="hint">读取中…</div>'

    try {
      const d = await api('/api/settings/data')

      box.innerHTML = ''

      // 目录位置
      const c1 = el('div', 'card')
      c1.appendChild(el('div', 'op-t', '数据在哪'))
      const pathRow = el('div')
      pathRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px'
      const code = el('code', '', d.cwd)
      code.style.cssText =
        'flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:5px 8px;font-size:11.5px;overflow:auto;white-space:nowrap'
      pathRow.appendChild(code)
      c1.appendChild(pathRow)
      c1.appendChild(
        el('div', 'hint', '整个文件夹可以整体搬走（换电脑直接复制这个目录）'),
      ).style.marginTop = '6px'
      box.appendChild(c1)

      // 日志保留天数
      const cLog = el('div', 'card')
      cLog.style.marginTop = '12px'
      cLog.appendChild(el('div', 'op-t', '日志保留'))
      cLog.appendChild(
        el('div', 'hint', '运行日志（它自己在干什么的记录）留多少天。每天约 500KB。'),
      ).style.marginTop = '6px'

      const logRow = el('div')
      logRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px'
      const logInput = el('input')
      logInput.type = 'number'
      logInput.min = '1'
      logInput.max = '3650'
      logInput.style.cssText =
        'width:90px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:4px 8px;font-size:12.5px;color:inherit'
      const cur = await api('/api/settings/log-retention').catch(() => ({ 保留天数: 30 }))
      logInput.value = String(cur.保留天数 ?? 30)
      const logSave = el('button', 'mini-btn', '保存')
      logSave.onclick = async () => {
        try {
          const r = await sendJson(
            '/api/settings/log-retention',
            { 保留天数: Number(logInput.value) },
            'PUT',
          )
          toast('已保存' + (r.note ? '，' + r.note : ''))
        } catch (e) {
          alert('改不了：' + e.message)
        }
      }
      logRow.appendChild(logInput)
      logRow.appendChild(el('span', 'hint', '天'))
      logRow.appendChild(logSave)
      cLog.appendChild(logRow)
      box.appendChild(cLog)

      // 磁盘占用
      const c2 = el('div', 'card')
      c2.style.marginTop = '12px'
      c2.appendChild(el('div', 'op-t', '磁盘占用'))
      for (const p of d.parts || []) {
        const row = el('div', 'item')
        row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px'
        row.appendChild(el('span', '', p.name))
        row.appendChild(el('span', 'hint', p.human))
        c2.appendChild(row)
      }
      const totalRow = el('div')
      totalRow.style.cssText = 'display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px;font-weight:600;border-top:1px solid var(--line);margin-top:4px'
      totalRow.appendChild(el('span', '', '合计'))
      totalRow.appendChild(el('span', '', d.total))
      c2.appendChild(totalRow)
      c2.appendChild(
        el('div', 'hint', `快照 ${d.snapshots} 个（${d.snapshotsSize}）· 日志 ${d.logFiles} 个`),
      ).style.marginTop = '6px'
      box.appendChild(c2)

      // 备份
      const c3 = el('div', 'card')
      c3.style.marginTop = '12px'
      c3.appendChild(el('div', 'op-t', '备份 / 还原'))
      c3.appendChild(el('div', 'hint', '「立刻快照」把整个 persona/ 拍一张，出问题能回滚')).style.marginTop =
        '4px'

      const btnRow = el('div')
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap'

      const snap = el('button', 'mini-btn', '立刻快照')
      snap.onclick = async () => {
        snap.disabled = true
        snap.textContent = '拍…'
        try {
          await sendJson('/api/action', { action: 'snapshot', payload: {} })
          toast('快照完成')
          loadData()
        } catch (e) {
          alert('失败：' + e.message)
        }
        snap.disabled = false
        snap.textContent = '立刻快照'
      }
      btnRow.appendChild(snap)

      const exp = el('button', 'mini-btn', '导出全部（JSON）')
      exp.onclick = () => window.open('/api/export?token=' + encodeURIComponent(window.__token || ''), '_blank')
      btnRow.appendChild(exp)

      c3.appendChild(btnRow)
      box.appendChild(c3)
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  /* ============================================================
   * 模型
   * ============================================================ */
  async function loadModel() {
    const box = document.getElementById('model-body')
    if (!box) return
    box.innerHTML = '<div class="hint">读取中…</div>'

    try {
      const d = await api('/api/settings/model')
      box.innerHTML = ''

      const c = el('div', 'card')
      c.appendChild(el('div', 'op-t', 'DeepSeek 配置'))

      const row = (label, value, hint) => {
        const r = el('div')
        r.style.cssText = 'display:flex;gap:10px;align-items:baseline;padding:6px 0;font-size:12.5px'
        const k = el('span', '', label)
        k.style.cssText = 'color:#8b949e;min-width:80px;flex:none'
        r.appendChild(k)
        const v = el('span', '', value)
        v.style.cssText = 'flex:1;word-break:break-all'
        r.appendChild(v)
        c.appendChild(r)
        if (hint) {
          const h = el('div', 'hint', hint)
          h.style.cssText = 'font-size:11px;margin-left:90px;margin-top:-2px'
          c.appendChild(h)
        }
      }

      row('API Key', d.apiKey || '（没配）', d.hasKey ? '' : '在项目根目录的 .env 里填 DEEPSEEK_API_KEY=sk-...')
      row('Base URL', d.baseUrl)
      row('模型', d.model)
      row('视觉模型', d.visionModel || '（没设，用默认）')

      const hint = el('div', 'hint', '改这些要编辑 .env 然后重启服务。控制台不能直接改（key 太敏感）')
      hint.style.cssText = 'margin-top:12px;font-size:11.5px'
      c.appendChild(hint)
      box.appendChild(c)

      // 连通性测试
      const c2 = el('div', 'card')
      c2.style.marginTop = '12px'
      c2.appendChild(el('div', 'op-t', '连通性'))
      const btn = el('button', 'mini-btn', '测一下')
      btn.style.marginTop = '8px'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '测…'
        try {
          const r = await api('/api/health')
          const item = (r.items || []).find((x) => x.name && x.name.includes('DeepSeek'))
          toast(item ? item.level === 'ok' ? '✓ ' + item.detail : '✗ ' + item.detail : '测不到')
        } catch (e) {
          toast('✗ ' + e.message)
        }
        btn.disabled = false
        btn.textContent = '测一下'
      }
      c2.appendChild(btn)
      box.appendChild(c2)
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  /* ============================================================
   * 关于
   * ============================================================ */
  async function loadAbout() {
    const box = document.getElementById('about-body')
    if (!box) return
    box.innerHTML = '<div class="hint">读取中…</div>'

    try {
      const d = await api('/api/settings/about')
      box.innerHTML = ''

      const c = el('div', 'card')
      c.appendChild(el('div', 'op-t', '版本'))

      const row = (k, v) => {
        const r = el('div')
        r.style.cssText = 'display:flex;gap:10px;padding:5px 0;font-size:12.5px'
        const a = el('span', '', k)
        a.style.cssText = 'color:#8b949e;min-width:80px'
        r.appendChild(a)
        r.appendChild(el('span', '', v))
        c.appendChild(r)
      }

      row('版本', d.version)
      row('Git', d.git ? d.git + (d.dirty ? '（有未提交改动）' : '') : '（不是 git 仓库）')
      row('Node', d.node)
      row('平台', d.platform + ' / ' + d.arch)
      row('已运行', fmtDurText(d.uptime))
      box.appendChild(c)

      const c2 = el('div', 'card')
      c2.style.marginTop = '12px'
      c2.appendChild(el('div', 'op-t', '更新'))
      c2.appendChild(
        el('div', 'hint', '自动更新还没做（这个项目没有发布渠道）。现在只显示版本号。'),
      ).style.marginTop = '6px'
      const b = el('button', 'mini-btn', '检查更新')
      b.style.marginTop = '8px'
      b.disabled = true
      b.title = '还没做'
      c2.appendChild(b)
      box.appendChild(c2)

      // 重启
      const c3 = el('div', 'card')
      c3.style.marginTop = '12px'
      c3.appendChild(el('div', 'op-t', '重启服务'))
      c3.appendChild(
        el(
          'div',
          'hint',
          '服务不能自己重启（会掐断正在返回的响应）。打包成桌面应用后这里会有真按钮。',
        ),
      ).style.marginTop = '6px'
      const rb = el('button', 'mini-btn', '重启')
      rb.style.marginTop = '8px'
      rb.onclick = async () => {
        try {
          const r = await sendJson('/api/settings/restart', {}, 'POST')
          alert(r.detail || '请手动重启')
        } catch (e) {
          alert('失败：' + e.message)
        }
      }
      c3.appendChild(rb)
      box.appendChild(c3)
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  function fmtDurText(sec) {
    if (sec < 60) return sec + ' 秒'
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟'
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时'
    return Math.floor(sec / 86400) + ' 天'
  }

  window.loadData = loadData
  window.loadModel = loadModel
  window.loadAbout = loadAbout
})()
