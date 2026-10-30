/**
 * 插件页的安装流程 + 权限预览。
 *
 * 用法（从前端别处调用）：
 *   window.openInstallDialog()   —— 装本地插件：先 inspect 再让你确认
 *   window.confirmInstall(info)  —— 只弹确认框（测试用）
 *
 * 设计取向：这不是沙箱。它做的是"复制文件之前，先把插件要什么摆出来"。
 * 插件跑在同一进程里，技术上挡不住它直接联网/读文件 —— 只装信得过的。
 */

;(function () {
  'use strict'

  /** 权限的中文说明（和后端 src/plugins/manifest.ts 的 PERMISSIONS 对应） */
  const PERM_LABEL = {
    net: ['联网', '访问外部网络（调第三方 API）'],
    memory: ['读记忆', '读 persona/ 下的记忆、档案、聊天记录'],
    message: ['发消息', '主动给你或群里发消息'],
    files: ['读写文件', '读写自己数据目录以外的本机文件'],
    shell: ['执行命令', '在本机运行命令'],
  }

  const TYPE_LABEL = {
    tool: '工具插件（注册成模型能调用的工具）',
    panel: '面板插件（提供前端面板）',
    transport: '接入平台（替换消息通道）',
    event: '事件插件（只订阅事件）',
  }

  /** 发一个 JSON POST（plugins.js 的 postData 在闭包里，这里自己来） */
  async function postJson(path, body) {
    const token = window.__token || new URLSearchParams(location.search).get('token') || ''
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'x-console-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.ok === false) {
      throw new Error((j && j.error) || 'HTTP ' + r.status)
    }
    return j.data === undefined ? j : j.data
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  /**
   * 弹一个"装这个插件？"的确认框。
   * 返回 Promise<boolean>：true = 装，false = 取消。
   */
  function confirmInstall(info) {
    return new Promise((resolve) => {
      const mask = el('div')
      mask.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px'

      const box = el('div', 'card')
      box.style.cssText = 'width:min(520px,94vw);max-height:82vh;overflow:auto;padding:18px'

      const title = el('b', '', '装这个插件？')
      title.style.cssText = 'font-size:15px;display:block;margin-bottom:10px'
      box.appendChild(title)

      const kv = el('div', 'params')
      const rows = [
        ['名字', info.name || '（未命名）'],
        ['版本', info.version ? 'v' + info.version : '?'],
        ['id', info.id || '?'],
        ['作者', info.author || '（没写）'],
        ['类型', TYPE_LABEL[info.type] || info.type || 'event'],
      ]
      for (const [k, v] of rows) {
        const row = el('div', 'prow')
        row.appendChild(el('span', 'k', k))
        row.appendChild(el('span', 'v', v))
        kv.appendChild(row)
      }
      box.appendChild(kv)

      if (info.description) box.appendChild(el('div', 'desc', info.description))

      // 权限清单：这是这个弹窗存在的理由
      const ph = el('div', 'hint', '这个插件声明的权限：')
      ph.style.cssText = 'margin-top:4px;font-size:12px'
      box.appendChild(ph)

      const pl = el('div')
      pl.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-top:6px'
      const perms = Array.isArray(info.permissions) ? info.permissions : []
      if (!perms.length) {
        pl.appendChild(el('div', 'hint', '（没声明任何权限 —— 只能用最基础的能力）'))
      } else {
        for (const p of perms) {
          const meta = PERM_LABEL[p] || [p, '']
          const row = el('div')
          row.style.cssText = 'font-size:12.5px;line-height:1.6'
          const nm = el('b', '', '· ' + meta[0])
          nm.style.color = 'var(--yellow)'
          row.appendChild(nm)
          if (meta[1]) row.appendChild(el('span', 'hint', '：' + meta[1]))
          pl.appendChild(row)
        }
      }
      box.appendChild(pl)

      if (info.alreadyExists) {
        const warn = el('div', 'hint', '注意：已经有一个同 id 的插件，装着会覆盖它。')
        warn.style.cssText = 'color:var(--red);margin-top:8px;font-size:12px'
        box.appendChild(warn)
      }

      // 诚实交代边界：这是提示，不是沙箱
      const note = el(
        'div',
        'hint',
        '提醒：这是「装之前告诉你要什么」，不是沙箱。插件跑在同一个进程里，' +
          '技术上挡不住它直接联网或读文件 —— 只装你信得过的。',
      )
      note.style.cssText = 'margin-top:12px;font-size:11.5px;line-height:1.6;color:var(--dim2)'
      box.appendChild(note)

      const foot = el('div')
      foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px'
      const cancel = el('button', 'btn', '取消')
      cancel.onclick = () => {
        mask.remove()
        resolve(false)
      }
      const go = el('button', 'btn pri', '仍然安装')
      go.onclick = () => {
        mask.remove()
        resolve(true)
      }
      foot.appendChild(cancel)
      foot.appendChild(go)
      box.appendChild(foot)

      mask.appendChild(box)
      document.body.appendChild(mask)
    })
  }

  /**
   * 走完整个安装流程：填路径 → 读清单 → 展示权限 → 确认 → 复制文件。
   *
   * 为什么先 inspect：插件一装上就能读记忆、能联网，
   * 事后再提示等于"已经发生了才告诉你"。
   */
  async function openInstallDialog() {
    const input = await window.askText('本地插件目录路径（目录里要有 plugin.json）', '')
    if (input === null) return

    const source = String(input).trim()
    if (!source) {
      window.alert('请填写插件目录路径')
      return
    }

    let info = null
    try {
      info = await postJson('/api/plugins/inspect', { source })
    } catch (e) {
      window.alert('读不到这个插件：' + (e && e.message ? e.message : String(e)))
      return
    }

    const ok = await confirmInstall(info || {})
    if (!ok) return

    try {
      await postJson('/api/plugins/install', { source })
      if (typeof window.renderPlugins === 'function') window.renderPlugins()
      if (typeof window.toast === 'function') window.toast('装好了')
    } catch (e) {
      window.alert('安装失败：' + (e && e.message ? e.message : String(e)))
    }
  }

  window.confirmInstall = confirmInstall
  window.openInstallDialog = openInstallDialog
})()
