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

    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  /* ============================================================
   * 模型
   * ============================================================ */
    /**
 * 设置页 → NapCat：看现在解析到哪个目录，也能手动改。
 *
 * 之前只有「日志 → NapCat」那行有个小「改」，而且是 prompt() 弹窗 ——
 * 换过 NapCat 位置的人根本找不到地方改。
 */
async function loadNapcatSettings() {
  const box = document.getElementById('napcat-body')
  if (!box) return
  box.innerHTML = '<div class="hint" style="padding:10px 0">读取中…</div>'

  let d
  try {
    d = await api('/api/napcat/shelldir')
  } catch (e) {
    box.innerHTML = ''
    const err = el('div', 'hint')
    err.style.cssText = 'padding:10px 0;color:#f85149'
    err.textContent = '读不到：' + e.message
    box.appendChild(err)
    return
  }

  box.innerHTML = ''
  const card = el('div', 'card')

  const title = el('div', 'op-t', 'NapCat 安装目录')
  card.appendChild(title)

  const state = el('div', 'hint')
  state.style.cssText = 'font-size:12px;line-height:1.7;margin-top:8px'
  if (d.ok) {
    state.innerHTML =
      '<span style="color:#3fb950">✓ 找到了</span><br>' +
      '<code style="color:#79c0ff;word-break:break-all">' + escHtml(d.shellDir) + '</code>' +
      (d.configured ? '' : ' <span style="color:#8b949e">（自动探测到的，没手动指定）</span>')
  } else {
    state.innerHTML =
      '<span style="color:#d29922">✗ 没找到 NapCat</span><br>' +
      '<span style="color:#8b949e">' + escHtml(d.error || '') + '</span>'
  }
  card.appendChild(state)

  // 输入框
  const row = el('div')
  row.style.cssText = 'display:flex;gap:8px;margin-top:12px;align-items:center'
  const input = el('input')
  input.type = 'text'
  input.placeholder = d.ok ? '' : '例如 D:/NapCat/NapCat.52230.Shell'
  input.value = d.configured && d.ok ? d.shellDir : ''
  input.style.cssText =
    'flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;' +
    'padding:6px 10px;font-size:12.5px;color:inherit;font-family:ui-monospace,Consolas,monospace'
  row.appendChild(input)

  const save = el('button', 'mini-btn', '保存路径')
  save.onclick = async () => {
    const v = input.value.trim()
    save.disabled = true
    save.textContent = '保存中…'
    try {
      const r = await sendJson('/api/napcat/shelldir', { shellDir: v }, 'PUT')
      if (v && !r.resolved) {
        toast('保存了，但这个路径下没找到 NapCat（检查一下是不是 <版本>.Shell 那一层）')
      } else {
        toast(v ? '已保存，解析到 ' + r.resolved.shellDir : '已清空，改用自动探测')
      }
      loadNapcatSettings()
    } catch (e) {
      toast('✗ ' + e.message)
    }
    save.disabled = false
    save.textContent = '保存路径'
  }
  row.appendChild(save)

  const auto = el('button', 'mini-btn', '自动探测')
  auto.onclick = async () => {
    try {
      await sendJson('/api/napcat/shelldir', { shellDir: '' }, 'PUT')
      toast('已清空手动指定，改用自动探测')
      loadNapcatSettings()
    } catch (e) {
      toast('✗ ' + e.message)
    }
  }
  row.appendChild(auto)
  card.appendChild(row)

  const hint = el('div', 'hint')
  hint.style.cssText = 'font-size:11.5px;line-height:1.8;margin-top:10px;color:#8b949e'
  hint.innerHTML =
    '填的是 <code style="color:#79c0ff">&lt;版本&gt;.Shell</code> 那一层，例如 <code>D:/NapCat/NapCat.52230.Shell</code>。<br>' +
    '留空 = 自动探测常见位置（数据目录下的 napcat、C/D/E/F 盘的 NapCat 等）。<br>' +
    '还没装？去 <b>日志 → NapCat</b> 点「一键安装 NapCat」。'
  card.appendChild(hint)

  box.appendChild(card)
}

/** 简单的 HTML 转义（settings.js 里没有全局的） */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function loadModel() {
      const box = document.getElementById('model-body')
      if (!box) return
      box.innerHTML = '<div class="hint">读取中…</div>'

      try {
        const [d, bal, st] = await Promise.all([
          api('/api/settings/model'),
          api('/api/balance').catch(() => null),
          api('/api/status').catch(() => null),
        ])
        box.innerHTML = ''

        // ---------- 接入 ----------
        const c1 = el('div', 'card')
        c1.appendChild(el('div', 'op-t', '接入'))

        const keyLabel = el('div', 'hint', 'API Key')
        keyLabel.style.cssText = 'font-size:11.5px;margin-top:12px'
        c1.appendChild(keyLabel)

        const keyRow = el('div')
        keyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:5px'

        const keyInput = el('input')
        keyInput.type = 'password'
        keyInput.autocomplete = 'off'
        keyInput.placeholder = d.hasKey ? '已保存 ' + d.apiKey + '，要换就填新的' : 'sk-...'
        keyInput.style.cssText =
          "flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12.5px;color:inherit;font-family:ui-monospace,Consolas,monospace"
        keyRow.appendChild(keyInput)

        // 显示/隐藏（password ↔ text）
        const eye = el('button', 'mini-btn', '显示')
        eye.onclick = () => {
          const show = keyInput.type === 'password'
          keyInput.type = show ? 'text' : 'password'
          eye.textContent = show ? '隐藏' : '显示'
        }
        keyRow.appendChild(eye)

        const saveKey = el('button', 'mini-btn', '保存 Key')
        saveKey.onclick = async () => {
          const v = keyInput.value.trim()
          if (!v) return toast('先填一个 key')
          if (!/^sk-[A-Za-z0-9]{10,}$/.test(v)) return toast('看着不像 key（应该 sk- 开头）')
          saveKey.disabled = true
          saveKey.textContent = '保存中…'
          try {
            await sendJson('/api/settings/model', { apiKey: v }, 'PUT')
            // 说清楚"没生效"这件事 —— 只打"已写入 .env"会让人以为马上就能用，
            // 结果模型还是回显模式，看起来就像保存失败。
            toast('已保存。要重启程序才会用上新 Key（现在还在回显模式）')
            keyInput.value = ''
            loadModel()
          } catch (e) {
            toast('✗ ' + e.message)
          }
          saveKey.disabled = false
          saveKey.textContent = '保存 Key'
        }
        keyRow.appendChild(saveKey)
        c1.appendChild(keyRow)

        const keyHint = el('div', 'hint')
        keyHint.style.cssText = 'font-size:11px;margin-top:6px;line-height:1.6'
        keyHint.textContent = d.hasKey
          ? '当前 ' + d.apiKey + '。改完写入 .env，重启服务才生效。'
          : '还没配。去 platform.deepseek.com 拿一个，填进来就能用。'
        c1.appendChild(keyHint)

        // 配了但没生效 —— 最容易被误解成"保存没用"。
        // apiKey 是启动时读成常量传给模型的，所以写完文件必须重启才真的切过去。
        if (d.restartNeeded) {
          const warn = el('div')
          warn.style.cssText =
            'margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.7;' +
            'background:rgba(210,153,34,.12);border:1px solid rgba(210,153,34,.4)'
          warn.innerHTML =
            '<b>Key 已保存，但还没生效</b><br>' +
            '<span style="color:#8b949e">现在仍跑在回显模式。重启之后才会真正用它。</span>'
          c1.appendChild(warn)

          const rb = el('button', 'mini-btn', '立即重启')
          rb.style.marginTop = '8px'
          rb.onclick = async () => {
            rb.disabled = true
            rb.textContent = '重启中…'
            try {
              const rr = await sendJson('/api/settings/restart', {}, 'POST')
              if (rr.restarting) {
                toast('正在重启，几秒后自动刷新…')
                setTimeout(() => location.reload(), 5000)
              } else {
                // 浏览器模式没法自重起
                alert(rr.detail || '请手动重启')
                rb.disabled = false
                rb.textContent = '立即重启'
              }
            } catch (e) {
              alert('重启失败：' + e.message)
              rb.disabled = false
              rb.textContent = '立即重启'
            }
          }
          warn.appendChild(rb)
        }

        // 服务地址（只读，说明了为什么不能改）
        const urlRow = el('div')
        urlRow.style.cssText = 'display:flex;gap:10px;align-items:baseline;padding:10px 0 0;font-size:12.5px;border-top:1px solid var(--line);margin-top:12px'
        const urlK = el('span', '', '服务地址')
        urlK.style.cssText = 'color:var(--dim);min-width:70px;flex:none'
        urlRow.appendChild(urlK)
        urlRow.appendChild(el('span', '', d.baseUrl))
        c1.appendChild(urlRow)

        const urlHint = el('div', 'hint', '这个写死在代码里（.env 里改它不生效），换了服务商才需要动。')
        urlHint.style.cssText = 'font-size:11px;margin-top:4px;margin-left:80px'
        c1.appendChild(urlHint)
        box.appendChild(c1)

        // ---------- 模型 ----------
        const c2 = el('div', 'card')
        c2.style.marginTop = '12px'
        c2.appendChild(el('div', 'op-t', '模型'))

        const mkSelect = (label, cur, options, hint) => {
          const row = el('div')
          row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 0'
          const k = el('span', '', label)
          k.style.cssText = 'color:var(--dim);min-width:70px;flex:none;font-size:12.5px'
          row.appendChild(k)
          const sel = el('select')
          sel.style.cssText =
            'flex:1;max-width:280px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-size:12.5px;color:inherit'
          for (const o of options) {
            const op = el('option', '', o[1])
            op.value = o[0]
            if (o[0] === cur) op.selected = true
            sel.appendChild(op)
          }
          row.appendChild(sel)
          c2.appendChild(row)
          if (hint) {
            const h = el('div', 'hint', hint)
            h.style.cssText = 'font-size:11px;margin-left:80px;margin-top:-4px;margin-bottom:4px'
            c2.appendChild(h)
          }
          return sel
        }

        const curModel = (d.model || '').replace('（默认）', '')
        const selModel = mkSelect('对话模型', curModel, [
          ['deepseek-chat', 'deepseek-chat（通用，便宜）'],
          ['deepseek-reasoner', 'deepseek-reasoner（会思考，慢且贵）'],
        ])

        const curVision = (d.visionModel || '').trim()
        const selVision = mkSelect(
          '视觉模型',
          curVision,
          [
            ['', '（不启用，看图功能关着）'],
            ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp'],
          ],
          '只有主模型是纯文本时才需要它：先用它把图看成一句话，再混进对话。',
        )

        const saveModel = el('button', 'btn pri', '保存模型设置')
        saveModel.style.marginTop = '10px'
        saveModel.onclick = async () => {
          saveModel.disabled = true
          try {
            const r = await sendJson(
              '/api/settings/model',
              { model: selModel.value, visionModel: selVision.value },
              'PUT',
            )
            toast('已保存' + (r.note ? '，' + r.note : ''))
          } catch (e) {
            toast('✗ ' + e.message)
          }
          saveModel.disabled = false
        }
        c2.appendChild(saveModel)
        box.appendChild(c2)

        // ---------- 状态 ----------
        const c3 = el('div', 'card')
        c3.style.marginTop = '12px'
        const head = el('div')
        head.style.cssText = 'display:flex;align-items:center;gap:10px'
        head.appendChild(el('div', 'op-t', '状态'))
        const retest = el('button', 'mini-btn', '重新测试')
        retest.style.marginLeft = 'auto'
        head.appendChild(retest)
        c3.appendChild(head)

        const stBox = el('div')
        stBox.style.cssText = 'margin-top:10px;font-size:12.5px;line-height:1.9'
        c3.appendChild(stBox)

        const renderStatus = (health) => {
          stBox.innerHTML = ''
          const item = (health && health.items ? health.items : []).find(
            (x) => x.name && String(x.name).includes('DeepSeek'),
          )
          const ok = item && item.level === 'ok'
          const dot = el('span')
          dot.style.cssText =
            'display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle;background:' +
            (item ? (ok ? 'var(--green)' : 'var(--red)') : 'var(--dim2)')

          const line1 = el('div')
          line1.appendChild(dot)
          // 有 detail 就直接用它（"能调通（168ms）"本身已经说了状态），
          // 没 detail 才退回自己的一句话，免得"能连通 能调通"重复
          const hasDetail = item && item.detail
          line1.appendChild(
            el('span', '', hasDetail ? '' : !item ? '还没测' : ok ? '能连通' : '连不上'),
          )
          if (hasDetail) {
            const de = el('span', 'hint', item.detail)
            de.style.cssText = 'font-size:11.5px'
            line1.appendChild(de)
          }
          stBox.appendChild(line1)

          // 余额 / 今日用量
          const parts = []
          if (bal && bal.total != null) parts.push('余额 ¥' + Number(bal.total).toFixed(2))
          if (st && st.cost) {
            parts.push('今日 ' + (st.cost.calls ?? 0) + ' 次调用')
            parts.push('¥' + Number(st.cost.cny ?? 0).toFixed(4))
          }
          if (parts.length) {
            const line2 = el('div', 'hint', parts.join(' · '))
            line2.style.cssText = 'font-size:11.5px'
            stBox.appendChild(line2)
          }
        }

        renderStatus(null)
        retest.onclick = async () => {
          retest.disabled = true
          retest.textContent = '测试中…'
          try {
            renderStatus(await api('/api/health'))
          } catch (e) {
            toast('✗ ' + e.message)
          }
          retest.disabled = false
          retest.textContent = '重新测试'
        }
        // 进来先自动测一次（反正 health 接口本来就会调）
        api('/api/health')
          .then(renderStatus)
          .catch(() => {})

        box.appendChild(c3)
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

      // ---- 更新 ----
      const c2 = el('div', 'card')
      c2.style.marginTop = '12px'
      c2.appendChild(el('div', 'op-t', '更新'))

      const info = el('div', 'hint')
      info.style.marginTop = '6px'
      info.textContent = '当前 ' + (d.version || '?') + (d.buildTime ? '（' + String(d.buildTime).replace('T', ' ').slice(0, 16) + '）' : '')
      c2.appendChild(info)

      const line = el('div', 'hint')
      line.style.marginTop = '6px'
      c2.appendChild(line)

      const btns = el('div', 'row')
      btns.style.marginTop = '8px'
      const checkBtn = el('button', 'mini-btn', '检查更新')
      const applyBtn = el('button', 'btn pri', '立即更新')
      applyBtn.style.display = 'none'
      btns.appendChild(checkBtn)
      btns.appendChild(applyBtn)
      c2.appendChild(btns)
      box.appendChild(c2)

      let latest = null

      checkBtn.onclick = async () => {
        checkBtn.disabled = true
        line.textContent = '检查中…'
        try {
          const r = await api('/api/settings/check-update')
          if (!r.ok) {
            line.textContent = r.error || '检查失败'
            return
          }
          latest = r.latest
          if (!r.hasNew) {
            line.textContent = '已是最新版本（' + r.latest.version + '）'
            applyBtn.style.display = 'none'
            return
          }
          line.textContent =
            '发现新版本 ' + r.latest.version + (r.latest.git ? '（' + r.latest.git + '）' : '') + '，可以更新'
          applyBtn.style.display = ''
        } catch (e) {
          line.textContent = '检查失败：' + e.message
        } finally {
          checkBtn.disabled = false
        }
      }

      applyBtn.onclick = async () => {
        if (!latest) return
        applyBtn.disabled = true
        const old = applyBtn.textContent
        applyBtn.textContent = '下载中…'
        line.textContent = '下载并校验更新包…'
        try {
          const r = await sendJson('/api/settings/download-update', { latest }, 'POST')
          if (!r.ok) {
            line.textContent = r.error || '更新失败'
            return
          }
          line.textContent = '已下载完成，重启后生效'
          applyBtn.textContent = '重启生效'
          applyBtn.onclick = async () => {
            try {
              const rr = await sendJson('/api/settings/restart', {}, 'POST')
              alert(rr.detail || '请手动重启')
            } catch (e) {
              alert('重启失败：' + e.message)
            }
          }
        } catch (e) {
          line.textContent = '更新失败：' + e.message
        } finally {
          applyBtn.disabled = false
          if (applyBtn.textContent === '下载中…') applyBtn.textContent = old
        }
      }

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
  // 这个文件整体包在 IIFE 里，不挂到 window 的话
  // onclick="loadNapcatSettings()" 会报 is not defined —— 刚踩过。
  window.loadNapcatSettings = loadNapcatSettings
})()
