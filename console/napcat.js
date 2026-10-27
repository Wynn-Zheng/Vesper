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

      // 具体原因（fetch failed 之类）用更小的字附在下面
      if (reason) {
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

  /** 把 iframe 指到 WebUI。地址必须带 /webui/（根路径是空壳） */
  function loadWebuiFrame(webuiUrl) {
    const frame = document.getElementById('nc-frame')
    if (!frame) return
    const want = webuiUrl || 'http://127.0.0.1:6099/webui/'
    if (frame.getAttribute('data-src') === want) return
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
