/**
 * NapCat 登录面板。
 *
 * 需求：右边拉一块出来放二维码，确认登录成功后关掉，变成正常的样子。
 *
 * 判断"登录成功"用 NapCat 自己的 CheckLoginStatus.isLogin，
 * 不是我们后端的 connected —— 后者要等 OneBot 重连，会慢一拍。
 */
;(function () {
  'use strict'

  let POLL = null
  let SHOWN = false

  /* ============================================================
   * 查询 + 渲染
   * ============================================================ */
  async function loadNapcatLogin() {
    const panel = document.getElementById('nc-login-panel')
    if (!panel) return

    try {
      // 顺手把日志开关和安装目录同步一下
      loadLogSetting().catch(() => {})
      loadShelldir().catch(() => {})

      const d = await api('/api/napcat/login')

      // 拿不到 —— 通常是 NapCat 没跑（fetch failed），也可能是 token 变了。
      // 这种情况也要走 renderInfo：
      //   否则「启动」按钮永远不显示，用户只能自己去命令行开 NapCat。
      if (!d.available) {
        hidePanel()
        const tag = document.getElementById('nc-state')
        if (tag) {
          tag.textContent = '没在跑'
          tag.style.background = '#f85149'
          tag.style.color = '#fff'
        }
        renderInfo(d, false, d.reason)
        loadWebuiFrame()
        loadNapcatConsole()
        return
      }

      if (d.isLogin) {
        // 登录成功 → 收起面板，恢复成正常样子
        hidePanel()
        const tag = document.getElementById('nc-state')
        if (tag) {
          tag.textContent = '已登录'
          tag.style.background = '#238636'
          tag.style.color = '#fff'
        }
        renderInfo(d, true)
        loadWebuiFrame(d.webuiAuto || d.webui)
        loadNapcatConsole()
        stopPoll()

        // 后端刚把 OneBot 连接配好（扫码登录后才有的 onebot11_<QQ号>.json）。
        // NapCat 只在启动/登录时读一次配置，所以要重启它才生效。
        if (d.wired) {
          toast('已自动把连接配好，正在重启 NapCat…')
          setTimeout(() => {
            napcatAction('restart').catch(() => {})
          }, 1000)
        }
      } else {
        // 未登录 → 显示面板 + 二维码
        renderInfo(d, false, d.reason)
        loadWebuiFrame(d.webuiAuto || d.webui)
        showPanel()
        loadNapcatConsole()
        renderQrcode()
        const tag = document.getElementById('nc-state')
        if (tag) {
          tag.textContent = '待扫码'
          tag.style.background = '#d29922'
          tag.style.color = '#fff'
        }
        startPoll()
      }
    } catch (e) {
      hidePanel()
    }
  }

  /**
   * 渲染主区的状态卡。
   *
   * 为什么不再嵌 WebUI：那个页面还要再输一次 token，而我们要的信息
   * （登录状态/账号/昵称/二维码）后端已经直接能给了 —— 嵌进去纯多余。
   */
  function renderInfo(d, isLogin, reason) {
    const box = document.getElementById('nc-info')
    if (!box) return

    // 按钮显示规则：
    //   压根连不上（NapCat 没跑）→ 只显示「启动」
    //   连上了（在跑）→ 显示「重启」「停止」
    const btnStart = document.getElementById('nc-btn-start')
    const btnRestart = document.getElementById('nc-btn-restart')
    const btnStop = document.getElementById('nc-btn-stop')
    const running = d.available === true
    if (btnStart) btnStart.style.display = running ? 'none' : ''
    if (btnRestart) btnRestart.style.display = running ? '' : 'none'
    if (btnStop) btnStop.style.display = running ? '' : 'none'

    if (!isLogin) {
      box.innerHTML = ''
      const wrap = el('div')
      wrap.style.cssText = 'padding:20px 0;text-align:center'

      // 压根连不上（NapCat 没跑）和"连上了但没登录"是两种情况，文案要分开
      const notRunning = d.available === false
      const t1 = el('div', '', notRunning ? 'NapCat 没在跑' : '还没登录')
      t1.style.cssText = 'font-size:14px;margin-bottom:6px'
      wrap.appendChild(t1)

      const t2 = el(
        'div',
        'hint',
        notRunning
          ? '点上面的「启动」。会弹 UAC 确认框，点「是」就行。'
          : '右边扫码，或者点上面的「在浏览器打开 WebUI」',
      )
      t2.style.cssText = 'font-size:12px'
      wrap.appendChild(t2)

      // 具体原因用更小的字附在下面。
      // fetch failed / ECONNREFUSED 这类是内部错误，用户看了也没用，过滤掉。
      if (reason && !/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(reason)) {
        const t3 = el('div', 'hint', reason)
        t3.style.cssText = 'font-size:10.5px;opacity:.6;margin-top:8px'
        wrap.appendChild(t3)
      }

      box.appendChild(wrap)
      return
    }

    box.innerHTML = ''
    const row = el('div')
    row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:8px 0'

    // 头像占位（拿不到真头像，用首字 + 色块）
    const av = el('span', '', (d.nick || '?').slice(0, 1))
    av.style.cssText =
      'width:48px;height:48px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:19px;color:#fff;background:' +
      avatarColor(d.account || 'x')
    row.appendChild(av)

    const info = el('div')
    info.style.cssText = 'min-width:0'
    const nm = el('div', '', d.nick || '（没昵称）')
    nm.style.cssText = 'font-size:15px;font-weight:600'
    info.appendChild(nm)
    const acc = el('div', 'hint', d.account || '（没账号）')
    acc.style.cssText = 'font-size:12.5px;margin-top:1px'
    info.appendChild(acc)
    row.appendChild(info)
    box.appendChild(row)

    // 明细
    const lines = [
      ['连接', d.phase === 'ready' ? '就绪' : d.phase || '—'],
      ['WebUI', d.webui || 'http://127.0.0.1:6099/webui/'],
    ]
    const list = el('div')
    list.style.cssText = 'margin-top:12px;border-top:1px solid var(--line);padding-top:10px'
    for (const [k, v] of lines) {
      const r = el('div')
      r.style.cssText = 'display:flex;gap:10px;padding:4px 0;font-size:12.5px'
      const a = el('span', '', k)
      a.style.cssText = 'color:#8b949e;min-width:50px;flex:none'
      r.appendChild(a)
      const b = el('span', '', v)
      b.style.cssText = 'word-break:break-all'
      r.appendChild(b)
      list.appendChild(r)
    }
    box.appendChild(list)
  }

  /* ============================================================
   * 面板
   * ============================================================ */
  function showPanel() {
    const panel = document.getElementById('nc-login-panel')
    const main = document.getElementById('nc-main')
    if (!panel) return
    SHOWN = true
    panel.style.display = 'flex'
    panel.style.transform = 'translateX(0)'
    // 主内容让出 300px，不然被盖住
    if (main) main.style.marginRight = '300px'
  }

  function hidePanel() {
    const panel = document.getElementById('nc-login-panel')
    const main = document.getElementById('nc-main')
    if (!panel) return
    SHOWN = false
    panel.style.transform = 'translateX(100%)'
    setTimeout(() => {
      if (!SHOWN) panel.style.display = 'none'
    }, 200)
    if (main) main.style.marginRight = ''
  }

  /* ============================================================
   * 二维码
   * ============================================================ */
  /**
   * 显示二维码。
   *
   * 用 NapCat 自己存的 cache/qrcode.png，不自己画。
   * 加时间戳防止浏览器缓存旧图（二维码变了扫不出来）。
   */
  function renderQrcode() {
    const box = document.getElementById('nc-qr')
    if (!box) return

    box.innerHTML =
      '<img src="/api/napcat/qrcode.png?_=' +
      Date.now() +
      '" alt="二维码" style="width:200px;height:200px;border-radius:8px;background:#fff;padding:6px;object-fit:contain" onerror="this.parentNode.innerHTML=\'<div class=&quot;hint&quot; style=&quot;padding:20px;text-align:center;font-size:12px&quot;>还没有二维码<br>NapCat 生成后会自动出现</div>\'">'
  }

  /* ============================================================
   * 轮询（每 3 秒查一次，登录了自动收）
   * ============================================================ */
  function startPoll() {
    if (POLL) return
    POLL = setInterval(async () => {
      try {
        const d = await api('/api/napcat/login')
        if (d.available && d.isLogin) {
          stopPoll()
          hidePanel()
          const tag = document.getElementById('nc-state')
          if (tag) {
            tag.textContent = '已登录'
            tag.style.background = '#238636'
            tag.style.color = '#fff'
          }
          toast('登录成功')
        }
      } catch {
        /* 查失败就下次再试 */
      }
    }, 3000)
  }

  function stopPoll() {
    if (POLL) {
      clearInterval(POLL)
      POLL = null
    }
  }

  /**
   * 拉 NapCat 的控制台输出。
   *
   * NapCat 本身不写日志文件，这个文件是我们改启动脚本加出来的
   * （Tee-Object 把 cmd 窗口的输出同时写一份）。
   */
  async function loadNapcatConsole() {
    const box = document.getElementById('nc-console')
    const hint = document.getElementById('nc-console-hint')
    const meta = document.getElementById('nc-console-meta')
    if (!box) return

    try {
      const d = await api('/api/napcat/console?lines=200')

      if (!d.available) {
        box.textContent = ''
        if (hint) hint.textContent = d.reason || '没有日志'
        if (meta) meta.textContent = ''
        return
      }

      if (hint) hint.textContent = ''
      box.textContent = (d.lines || []).join('\n')
      // 滚到底，看最新的
      box.scrollTop = box.scrollHeight

      if (meta) {
        const kb = (d.bytes / 1024).toFixed(1)
        meta.textContent = `${d.total} 行 · ${kb} KB`
      }
    } catch (e) {
      if (hint) hint.textContent = '读取失败：' + e.message
    }
  }

  /**
   * 启动 / 停止 / 重启 NapCat。
   *
   * 启动会弹 UAC（脚本自己要提权）—— 这是 Windows 的限制，绕不过去。
   * 停止只杀 NapCatWinBootMain，不动你自己日常用的 QQ.exe。
   */
  async function napcatAction(action) {
    const labels = { start: '启动', stop: '停止', restart: '重启' }
    const label = labels[action] || action

    if (action === 'stop') {
      if (!confirm('停止 NapCat？QQ 那边会掉线。')) return
    }

    // 按钮全禁用，防止连点
    for (const id of ['nc-btn-start', 'nc-btn-restart', 'nc-btn-stop']) {
      const b = document.getElementById(id)
      if (b) b.disabled = true
    }

    try {
      const r = await sendJson('/api/napcat/' + action, {}, 'POST')
      if (r.ok) {
        toast(label + '已发起，等几秒…')
        // 启动/重启要多等一会（脚本要弹 UAC、QQ 要起）
        const wait = action === 'stop' ? 1500 : 6000
        setTimeout(() => {
          loadNapcatLogin()
          loadNapcatConsole()
        }, wait)
        setTimeout(() => {
          loadNapcatLogin()
          loadNapcatConsole()
        }, wait + 6000)
      } else {
        alert(label + '失败：' + (r.detail || '未知原因'))
      }
    } catch (e) {
      alert(label + '失败：' + e.message)
    } finally {
      for (const id of ['nc-btn-start', 'nc-btn-restart', 'nc-btn-stop']) {
        const b = document.getElementById(id)
        if (b) b.disabled = false
      }
    }
  }

  /**
   * 日志开关。
   *
   * 关（默认）：启动完全无窗口，状态和二维码都在界面里。
   * 开：走 .cmd 启动，多一个最小化窗口，但能拿到 NapCat 的原始日志。
   *
   * 改完要重启 NapCat 才生效（模式是启动时决定的）。
   */
  async function toggleNapcatLog(on) {
    try {
      await sendJson('/api/napcat/logsetting', { 记录日志: on }, 'PUT')
      toast(on ? '已开启日志记录，重启 NapCat 后生效' : '已关闭日志记录，重启 NapCat 后生效')
      updateLogHint(on)
      // 开关打开 → 出现 WebUI/日志 两个 tab；关掉 → 藏起来并强制切回 WebUI
      const tabs = document.getElementById('nc-view-tabs')
      if (tabs) tabs.style.display = on ? '' : 'none'
      if (!on) switchNapcatView('webui')
      else loadNapcatConsole()
    } catch (e) {
      alert('改不了：' + e.message)
      // 失败就把勾选还原
      const cb = document.getElementById('nc-log-toggle')
      if (cb) cb.checked = !on
    }
  }

  function updateLogHint(on) {
    const hint = document.getElementById('nc-log-hint')
    if (!hint) return
    hint.textContent = on
      ? '启动时会把输出写到日志文件（仍然是零窗口）。重启 NapCat 后生效。'
      : '启动完全无窗口，也不写日志。重启 NapCat 后生效。'
  }

  /** 读配置，把开关和卡片的初始状态摆好 */
  async function loadLogSetting() {
    try {
      const d = await api('/api/napcat/logsetting')
      const on = d.记录日志 === true
      const cb = document.getElementById('nc-log-toggle')
      if (cb) cb.checked = on
      updateLogHint(on)
      const tabs = document.getElementById('nc-view-tabs')
      if (tabs) tabs.style.display = on ? '' : 'none'
      // 没开日志就一定是 WebUI
      if (!on) switchNapcatView('webui')
      return on
    } catch {
      return false
    }
  }

  /* ============================================================
   * WebUI / 日志 切换
   *
   * 默认显示 WebUI —— 它就是普通网页，iframe 嵌进来就行。
   * 勾了"记录日志"之后，多出这两个 tab，可以切到日志看原始输出。
   * ============================================================ */

  let NC_VIEW = 'webui'

  function switchNapcatView(view) {
    NC_VIEW = view

    const webuiCard = document.getElementById('nc-webui-card')
    const logCard = document.getElementById('nc-console-card')
    const tabs = document.querySelectorAll('#nc-view-tabs .gtab')

    // 高亮
    tabs.forEach((b) => {
      const isWebui = b.textContent.trim() === 'WebUI'
      b.classList.toggle('on', (view === 'webui' && isWebui) || (view === 'log' && !isWebui))
    })

    if (webuiCard) webuiCard.style.display = view === 'webui' ? '' : 'none'
    if (logCard) logCard.style.display = view === 'log' ? '' : 'none'

    if (view === 'log') loadNapcatConsole()
  }

  /** 一个地址能不能连上（不管 CORS：连上是 opaque 响应，连不上才抛） */
  async function probeReachable(url) {
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(1500) })
      return true
    } catch {
      return false
    }
  }

  /**
   * NapCat 没跑时，用一块人话提示盖住 iframe。
   *
   * 不这么做的话 iframe 会显示 Chromium 的 ERR_CONNECTION_REFUSED 白页 ——
   * 用户看到的就是"打不开"，也不知道该装 NapCat 还是该点启动。
   */
  function showWebuiDown(url) {
    const frame = document.getElementById('nc-frame')
    if (!frame) return

    let box = document.getElementById('nc-webui-down')
    if (!box) {
      box = document.createElement('div')
      box.id = 'nc-webui-down'
      box.style.cssText =
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
        'min-height:420px;padding:40px;background:#0d1117;border:1px solid #30363d;' +
        'border-radius:10px;text-align:center;line-height:1.8'
      frame.parentNode.insertBefore(box, frame)
    }
    box.style.display = ''
    frame.style.display = 'none'
    frame.removeAttribute('data-src')
    box.innerHTML = ''

    const title = document.createElement('div')
    // 标题用「WebUI 打不开」而不是「NapCat 没在运行」：
    // 上面卡片里已经说了"没在跑"，这里说的是"这个嵌进来的页面连不上"，两件事
    title.textContent = 'WebUI 打不开'
    title.style.cssText = 'font-size:16px;font-weight:600'
    box.appendChild(title)

    const addr = document.createElement('div')
    addr.textContent = '连不上 ' + url
    addr.style.cssText = 'font-size:12px;color:#8b949e;word-break:break-all'
    box.appendChild(addr)

    const tips = document.createElement('div')
    tips.style.cssText = 'font-size:13px;color:#8b949e;max-width:460px;text-align:left;margin-top:6px'
    tips.innerHTML =
      '<div>· <b>还没装</b>：看项目里的 <code>docs/NapCat安装.md</code></div>' +
      '<div>· <b>装了没开</b>：点上面那张卡片的「启动」</div>' +
      '<div>· <b>端口不对</b>：WebUI 不是 6099 的话，改 NapCat 的 webui 配置</div>'
    box.appendChild(tips)

    // ---- 一键安装（包里带了 NapCat 才显示） ----
    //
    // 装的是包里那份完整目录（含 QQ 本体），复制到数据目录再写好配置，
    // 全程离线 —— 从 GitHub 下 34MB 实测都拉不动，所以改用内置复制。
    const installBtn = document.createElement('button')
    installBtn.className = 'mini-btn'
    installBtn.textContent = '一键安装 NapCat'
    installBtn.style.display = 'none'
    box.appendChild(installBtn)

    const prog = document.createElement('div')
    prog.style.cssText = 'font-size:12px;color:#8b949e;min-height:18px;max-width:460px;line-height:1.6'
    box.appendChild(prog)

    // 进度条（只有真的在复制时才显示）
    const barWrap = document.createElement('div')
    barWrap.style.cssText = 'display:none;width:100%;max-width:460px;margin-top:2px'
    barWrap.innerHTML =
      '<div style="height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden">' +
      '<div id="nc-inst-bar" style="height:100%;width:0;background:linear-gradient(90deg,#2dd4bf,#38bdf8);border-radius:3px;transition:width .25s ease-out"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:#8b949e;margin-top:5px">' +
      '<span id="nc-inst-text">0%</span>' +
      '<span id="nc-inst-size"></span>' +
      '</div>'
    box.appendChild(barWrap)

    /** 更新进度条 */
    function setProgress(percent, sizeText) {
      barWrap.style.display = ''
      const bar = document.getElementById('nc-inst-bar')
      const txt = document.getElementById('nc-inst-text')
      const size = document.getElementById('nc-inst-size')
      const pct = Math.max(0, Math.min(100, Math.round((percent || 0) * 100)))
      if (bar) bar.style.width = pct + '%'
      if (txt) txt.textContent = pct + '%'
      if (size && sizeText !== undefined) size.textContent = sizeText
    }

    api('/api/napcat/install/status')
      .then((s) => {
        if (s && s.bundleAvailable) installBtn.style.display = ''
        else prog.textContent = '包里没带 NapCat，只能手动装（见 docs/NapCat安装.md）'
      })
      .catch(() => {})

    installBtn.onclick = async () => {
      installBtn.disabled = true
      installBtn.textContent = '安装中…'
      prog.textContent = '正在准备…'

      try {
        await api('/api/napcat/install', { method: 'POST' })
      } catch (e) {
        installBtn.disabled = false
        installBtn.textContent = '一键安装 NapCat'
        prog.textContent = '启动安装失败：' + (e && e.message ? e.message : String(e))
        return
      }

      // 复制 1.2GB 要一两分钟（机械盘更久），轮询进度。
      // 间隔 400ms：太慢的话条子一顿一顿地跳，太快又白刷接口。
      for (;;) {
        await new Promise((r) => setTimeout(r, 400))
        let s
        try {
          s = await api('/api/napcat/install/status')
        } catch {
          continue
        }
        if (!s) continue

        if (s.state === 'copying') {
          prog.textContent = '' // 细节交给进度条
          setProgress(s.percent, s.message || '')
          continue
        }
        if (s.state === 'configuring') {
          setProgress(0.97, '')
          prog.textContent = s.message || '正在写配置…'
          continue
        }
        if (s.state === 'done') {
          setProgress(1, '')
          prog.textContent = '装好了：' + (s.shellDir || '') + '（可以点上面的「启动」了）'
          installBtn.textContent = '重新检查'
          installBtn.disabled = false
          installBtn.onclick = () => loadWebuiFrame(url).catch(() => {})
          return
        }
        if (s.state === 'error') {
          prog.textContent = '装失败：' + (s.error || s.message || '?')
          installBtn.textContent = '重试安装'
          installBtn.disabled = false
          return
        }
      }
    }

    const btn = document.createElement('button')
    btn.className = 'mini-btn'
    btn.textContent = '重试'
    btn.onclick = () => {
      btn.disabled = true
      btn.textContent = '检查中…'
      loadWebuiFrame(url).catch(() => {})
    }
    box.appendChild(btn)
  }

  function hideWebuiDown() {
    const box = document.getElementById('nc-webui-down')
    if (box) box.style.display = 'none'
    const frame = document.getElementById('nc-frame')
    if (frame) frame.style.display = ''
  }

  /** 把 iframe 指到 WebUI。地址必须带 /webui/（根路径是空壳） */
  async function loadWebuiFrame(webuiUrl) {
    const frame = document.getElementById('nc-frame')
    if (!frame) return
    const want = webuiUrl || 'http://127.0.0.1:6099/webui/'
    if (frame.getAttribute('data-src') === want) return

    // 先探一下再设 src：直接设的话 NapCat 没跑时就是一个白页 + Chromium 报错，
    // 用户根本判断不出是"程序坏了"还是"NapCat 没开"。
    if (!(await probeReachable(want))) {
      showWebuiDown(want)
      return
    }

    hideWebuiDown()
    frame.src = want
    frame.setAttribute('data-src', want)
  }

  /**
   * 读安装目录。
   *
   * 配置里留空 = 自动探测。这里显示的是"最终解析到哪"，
   * 没配置的话会带上「（自动）」的标记。
   */
  async function loadShelldir() {
    const el0 = document.getElementById('nc-shelldir')
    if (!el0) return

    try {
      const d = await api('/api/napcat/shelldir')
      if (d.ok) {
        el0.textContent = d.shellDir + (d.configured ? '' : '（自动探测）')
        el0.style.color = ''
      } else {
        el0.textContent = d.error || '没找到'
        el0.style.color = '#d29922'
      }
    } catch (e) {
      el0.textContent = '读不到：' + e.message
      el0.style.color = '#f85149'
    }
  }

  /**
   * 改安装目录。
   *
   * 留空 = 恢复自动探测。填的应该是 <版本>.Shell 那一层。
   */
  async function editNapcatShelldir() {
    const cur = (document.getElementById('nc-shelldir')?.textContent ?? '').replace(/（自动探测）$/, '').trim()

    const input = prompt(
      'NapCat 安装目录（那个 <版本>.Shell 目录）\n\n留空 = 自动探测常见位置\n例如：E:/NapCat/NapCat.52230.Shell',
      cur === '检查中…' || cur === '没找到' ? '' : cur,
    )
    if (input === null) return

    try {
      const r = await sendJson('/api/napcat/shelldir', { shellDir: input.trim() }, 'PUT')
      toast(r.resolved ? '已保存，解析到 ' + r.resolved.shellDir : '已保存')
      loadShelldir()
      loadNapcatLogin()
    } catch (e) {
      alert('改不了：' + e.message)
    }
  }

  window.loadNapcatLogin = loadNapcatLogin
  window.loadShelldir = loadShelldir
  window.editNapcatShelldir = editNapcatShelldir
  window.switchNapcatView = switchNapcatView
  window.toggleNapcatLog = toggleNapcatLog
  window.loadLogSetting = loadLogSetting
  window.napcatAction = napcatAction
  window.loadNapcatConsole = loadNapcatConsole
  window.refreshNapcatQrcode = () => {
    loadNapcatLogin()
  }
})()
