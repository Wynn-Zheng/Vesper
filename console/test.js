/**
 * 测试页的两个新 tab：工具连通性 / 记忆检索。
 * （试聊那个还在原来的 v-try 里）
 */
;(function () {
  'use strict'

  /* ============================================================
   * 工具连通性
   * ============================================================ */
  async function loadToolTests() {
    const box = document.getElementById('tt-list')
    if (!box) return
    box.innerHTML = '<div class="hint">读取工具清单…</div>'

    try {
      const d = await api('/api/test/tools')
      box.innerHTML = ''

      const byGroup = {}
      for (const t of d.tools || []) {
        byGroup[t.group] = byGroup[t.group] || []
        byGroup[t.group].push(t)
      }

      for (const [g, list] of Object.entries(byGroup)) {
        const head = el('div')
        head.style.cssText = 'margin:10px 0 6px;font-size:13px;font-weight:600'
        head.textContent = g
        box.appendChild(head)

        const grid = el('div')
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px'

        for (const t of list) {
          const card = el('div')
          card.style.cssText =
            'background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:8px'

          const nm = el('div', '', t.name)
          nm.style.cssText = 'flex:1;font-size:12.5px'
          card.appendChild(nm)

          const st = el('span', 'hint', '—')
          st.style.cssText = 'font-size:11px;min-width:50px;text-align:right'
          card.appendChild(st)

          const btn = el('button', 'mini-btn', '测')
          btn.style.cssText += ';font-size:11px;padding:1px 8px'
          btn.onclick = async () => {
            btn.disabled = true
            st.textContent = '…'
            st.style.color = ''
            try {
              const r = await sendJson('/api/test/tool', { id: t.id })
              st.textContent = r.ms + 'ms'
              st.style.color = r.ok ? '#3fb950' : '#f85149'
              st.title = r.detail + (r.preview ? '\n' + r.preview : '')
              st.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail.slice(0, 20)
            } catch (e) {
              st.textContent = '✗ 失败'
              st.style.color = '#f85149'
            }
            btn.disabled = false
          }
          card.appendChild(btn)
          grid.appendChild(card)
        }
        box.appendChild(grid)
      }
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  /**
 * 装 ai-desktop（截图/看窗口/操作电脑的后端）。
 *
 * 它是 Python 包，后端用 pip 装，这里轮询进度 —— pip 要几十秒，
 * 不能让用户对着一个不动的按钮干等。
 */
async function installAiDesktop() {
  const hint = document.getElementById('tt-install-hint')
  const say = (msg, color) => {
    if (!hint) return
    hint.style.display = ''
    hint.textContent = msg
    hint.style.color = color || '#8b949e'
  }

  say('正在找 Python…')
  try {
    const r = await sendJson('/api/test/install-ai-desktop', {})
    if (!r.ok) return say('启动失败：' + (r.error || '?'), '#f85149')
  } catch (e) {
    return say('启动失败：' + e.message, '#f85149')
  }

  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    let s
    try {
      s = await api('/api/test/install-ai-desktop/status')
    } catch {
      continue
    }
    if (!s) continue
    if (s.state === 'running') {
      say(s.message || '装中…')
      continue
    }
    if (s.state === 'done') {
      say(s.message + '（重启程序后生效）', '#3fb950')
      if (typeof loadToolTests === 'function') loadToolTests()
      return
    }
    if (s.state === 'error') {
      say(s.error || s.message || '装失败', '#f85149')
      return
    }
  }
}

async function testAllTools() {
    const btns = [...document.querySelectorAll('#tt-list button')]
    for (const b of btns) {
      if (!b.disabled) {
        b.click()
        await new Promise((r) => setTimeout(r, 150))
      }
    }
  }

  /* ============================================================
   * 记忆检索
   * ============================================================ */
  async function loadRecallTest() {
    const box = document.getElementById('rt-body')
    if (!box) return
    if (box.dataset.ready) return

    box.dataset.ready = '1'
    box.innerHTML = ''

    const card = el('div', 'card')
    card.appendChild(el('div', 'op-t', '输入一句话，看会回忆起什么'))
    card.appendChild(
      el('div', 'hint', '不生成回复，只看检索结果。用来验证"它到底记不记得这件事"'),
    ).style.marginTop = '4px'

    // 选人
    const pickRow = el('div')
    pickRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap'

    const sel = el('select')
    sel.id = 'rt-person'
    sel.style.cssText =
      'background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12.5px'
    sel.innerHTML = '<option value="">（默认主人）</option>'
    try {
      const p = await api('/api/people')
      for (const x of p.people || []) {
        const o = document.createElement('option')
        o.value = x.id
        o.textContent = x.名字
        sel.appendChild(o)
      }
    } catch {
      /* 拿不到人也不影响 */
    }
    pickRow.appendChild(sel)

    const inp = el('input')
    inp.id = 'rt-q'
    inp.placeholder = '比如：他四级考得怎么样'
    inp.style.cssText =
      'flex:1;min-width:200px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12.5px'
    pickRow.appendChild(inp)

    const go = el('button', 'mini-btn', '检索')
    go.onclick = doRecall
    pickRow.appendChild(go)
    card.appendChild(pickRow)

    // 结果区
    const out = el('div')
    out.id = 'rt-out'
    out.style.marginTop = '12px'
    card.appendChild(out)
    box.appendChild(card)

    inp.onkeydown = (e) => {
      if (e.key === 'Enter') doRecall()
    }
  }

  async function doRecall() {
    const q = (document.getElementById('rt-q')?.value || '').trim()
    const personId = document.getElementById('rt-person')?.value || ''
    const out = document.getElementById('rt-out')
    if (!out) return
    if (!q) {
      out.innerHTML = '<div class="hint">先输入一句话</div>'
      return
    }

    out.innerHTML = '<div class="hint">检索中…</div>'
    try {
      const r = await sendJson('/api/test/recall', { query: q, personId, limit: 8 })
      if (!r.ok) {
        out.innerHTML = '<div class="empty">失败：' + esc(r.error || '') + '</div>'
        return
      }

      out.innerHTML = ''
      const cnt = r.counts || {}

      // 统计条
      const bar = el('div')
      bar.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;margin-bottom:10px'
      for (const [k, label] of [
        ['facts', '事实'],
        ['episodes', '经历'],
        ['insights', '洞察'],
        ['open', '待问'],
        ['recent', '原话'],
      ]) {
        const s = el('span', '', label + ' ' + (cnt[k] ?? 0))
        s.style.color = (cnt[k] ?? 0) > 0 ? '#3fb950' : '#8b949e'
        bar.appendChild(s)
      }
      bar.appendChild(el('span', 'hint', r.ms + 'ms'))
      out.appendChild(bar)

      // 渲染给模型的原文（最直观）
      const card = el('div', 'card')
      card.appendChild(el('div', 'op-t', '模型实际会看到的'))
      const pre = el('pre', '', r.rendered || '（空）')
      pre.style.cssText =
        'white-space:pre-wrap;font-size:11.5px;line-height:1.6;color:#8b949e;margin-top:8px;max-height:420px;overflow:auto'
      card.appendChild(pre)
      out.appendChild(card)
    } catch (e) {
      out.innerHTML = '<div class="empty">失败：' + esc(e.message) + '</div>'
    }
  }

  window.loadToolTests = loadToolTests
  window.testAllTools = testAllTools
  window.loadRecallTest = loadRecallTest
  // 这个文件整体在 IIFE 里，不挂 window 的话 onclick="installAiDesktop()"
  // 会报 is not defined —— settings.js 那次也是这个坑，又踩了一遍。
  window.installAiDesktop = installAiDesktop
})()
