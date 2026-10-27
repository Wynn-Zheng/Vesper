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
      const d = await api('/api/napcat/login')

      // 拿不到（token 变了 / 配置找不到）→ 面板不显示，主页面照常
      if (!d.available) {
        hidePanel()
        const hint = document.getElementById('nc-hint')
        if (hint) hint.textContent = '查不到登录状态：' + (d.reason || '未知原因')
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
        stopPoll()
      } else {
        // 未登录 → 显示面板 + 二维码
        renderInfo(d, false)
        showPanel()
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
  function renderInfo(d, isLogin) {
    const box = document.getElementById('nc-info')
    if (!box) return

    if (!isLogin) {
      box.innerHTML = ''
      const wrap = el('div')
      wrap.style.cssText = 'padding:20px 0;text-align:center'
      const t1 = el('div', '', '还没登录')
      t1.style.cssText = 'font-size:14px;margin-bottom:6px'
      wrap.appendChild(t1)
      const t2 = el('div', 'hint', '右边扫码，或者点上面的「在浏览器打开 WebUI」')
      t2.style.cssText = 'font-size:12px'
      wrap.appendChild(t2)
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

  window.loadNapcatLogin = loadNapcatLogin
  window.refreshNapcatQrcode = () => {
    loadNapcatLogin()
  }
})()
