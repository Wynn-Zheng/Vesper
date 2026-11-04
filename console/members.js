/**
 * 成员页：表格 + 侧边抽屉。
 *
 * 为什么单独一个 js 文件而不是塞进 index.html：
 *   index.html 已经 3000 多行，往里加东西改坏过好几次（可选链赋值、正则转义）。
 *   单独一个文件可以用 node --check 单独验语法。
 */

(function () {
  'use strict'

  /* ============================================================
   * 状态
   * ============================================================ */
  let DATA = { rows: [], nameless: [], stats: {} }
  // 两个筛选是独立的，可以任意组合：
  //   onlyChat —— 只看"聊过天"的（对话 > 0）
  //   onlyReal —— 只看"有记忆"的（事实/经历/洞察/核心 至少一个）
  //
  // 默认开 onlyChat：聊过就算有记录，比"有记忆"宽一点 ——
  // 不然只聊过几句还没沉淀成事实的人就看不到了（实测只剩 1 个）。
  let IF = { q: '', src: 'all', sort: 'relation', onlyChat: true, onlyReal: false }
  let DRAW = { open: false, person: null, tab: 'memory', chat: [], detail: null }

  /* ============================================================
   * 加载
   * ============================================================ */
  async function loadMembers() {
    const box = document.getElementById('mt-body')
    if (!box) return
    box.innerHTML = '<tr><td colspan="7" class="hint" style="padding:20px">加载中…</td></tr>'

    try {
      DATA = await api('/api/member/table')
      renderTable()
    } catch (e) {
      box.innerHTML =
        '<tr><td colspan="7" class="empty" style="padding:20px">加载失败：' + esc(e.message) + '</td></tr>'
    }
  }

  /* ============================================================
   * 表格
   * ============================================================ */
  function renderTable() {
    const all = [...DATA.rows, ...(DATA.nameless || [])]

    let list = all
    if (IF.q) {
      const q = IF.q.toLowerCase()
      list = list.filter(
        (r) => (r.名字 || '').toLowerCase().includes(q) || String(r.账号 || '').includes(q),
      )
    }
    if (IF.src === 'private') list = list.filter((r) => (r.来源 || []).some((s) => s.kind === 'private'))
    else if (IF.src === 'group') list = list.filter((r) => (r.来源 || []).some((s) => s.kind === 'group'))
    else if (IF.src === 'none') list = list.filter((r) => r.未建档)
    if (IF.onlyChat) list = list.filter((r) => (r.对话 || {}).turns > 0)
    // 只留"有记忆"的：事实 / 经历 / 洞察 / 核心 任一 > 0
    if (IF.onlyReal) {
      list = list.filter((r) => {
        const m = r.记忆 || {}
        const hasMemory = (m.facts || 0) + (m.episodes || 0) + (m.insights || 0) > 0
        const hasCore = (r.核心 || {}).count > 0
        return hasMemory || hasCore
      })
    }

    if (IF.sort === 'relation') list.sort((a, b) => (b.关系?.值 || 0) - (a.关系?.值 || 0))
    else if (IF.sort === 'recent') list.sort((a, b) => (b.对话?.lastAt || 0) - (a.对话?.lastAt || 0))
    else if (IF.sort === 'memory')
      list.sort((a, b) => (b.记忆?.facts || 0) + (b.记忆?.episodes || 0) - ((a.记忆?.facts || 0) + (a.记忆?.episodes || 0)))
    else if (IF.sort === 'name') list.sort((a, b) => String(a.名字).localeCompare(String(b.名字), 'zh'))

    const head = document.getElementById('mt-head')
    if (head) {
      const totalAll = all.length
      const filtered = IF.q || IF.src !== 'all' || IF.onlyChat || IF.onlyReal
      head.textContent =
        list.length +
        ' 个成员' +
        (filtered ? `（共 ${totalAll} 个，已筛选）` : '')
    }

    const box = document.getElementById('mt-body')
    if (!box) return
    box.innerHTML = ''

    if (!list.length) {
      const hint = IF.onlyReal
        ? '没有"有记忆"的成员。勾掉「只看有记忆的」能看到全部 ' + all.length + ' 个。'
        : '没有符合的成员'
      box.innerHTML = '<tr><td colspan="7" class="empty" style="padding:20px">' + hint + '</td></tr>'
      return
    }

    for (const r of list) {
      const tr = document.createElement('tr')
      tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer'
      if (r.未建档) tr.style.opacity = '0.55'
      tr.onmouseenter = () => (tr.style.background = 'rgba(255,255,255,.03)')
      tr.onmouseleave = () => (tr.style.background = '')
      tr.onclick = () => openDrawer(r)

      const td = (content, opts) => {
        const c = document.createElement('td')
        c.style.cssText = 'padding:9px 10px;font-size:12.5px;vertical-align:middle' + (opts?.css || '')
        if (typeof content === 'string') c.innerHTML = content
        else c.appendChild(content)
        tr.appendChild(c)
        return c
      }

      // 1. 人
      const who = document.createElement('div')
      who.style.cssText = 'display:flex;align-items:center;gap:8px'
      const av = document.createElement('span')
      av.textContent = (r.名字 || '?').slice(0, 1)
      av.style.cssText =
        'width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;background:' +
        avatarColor(r.id)
      who.appendChild(av)
      const nmBox = document.createElement('div')
      // 名字和账号同一行：手机上这一列要压成一行（mt-nm 是给 CSS 用的）
      nmBox.style.cssText = 'min-width:0;display:flex;align-items:baseline;gap:6px'
      nmBox.className = 'mt-nm'
      const nameEl = document.createElement('span')
      nameEl.className = 'mt-name'
      nameEl.textContent = r.名字
      nmBox.appendChild(nameEl)
      const sub = document.createElement('div')
      sub.className = 'hint mt-acc'
      sub.style.fontSize = '10.5px'
      sub.textContent = r.账号
      nmBox.appendChild(sub)
      who.appendChild(nmBox)
      td(who)

      // 2. 来源
      const src = (r.来源 || []).map((s) => s.kind === 'private' ? '私聊' : s.label)
      td(
        src.length
          ? src.slice(0, 2).map((x) => '<span class="tag" style="font-size:10px;padding:0 4px">' + esc(x) + '</span>').join(' ')
          : '<span class="hint">—</span>',
      )

      // 3. 关系
      td(
        r.关系?.值 > 0
          ? esc(r.关系.阶段) + ' <span class="hint">' + r.关系.值 + '</span>'
          : '<span class="hint">' + esc(r.关系?.阶段 || '陌生') + '</span>',
      )

      // 4. 记忆
      const mem = r.记忆 || {}
      td(
        mem.facts || mem.episodes
          ? mem.facts + ' 事实 · ' + mem.episodes + ' 经历'
          : '<span class="hint">—</span>',
      )

      // 5. 对话
      td(
        r.对话?.turns
          ? r.对话.turns + ' 条 <span class="hint">' + fmtAgo(r.对话.lastAt) + '</span>'
          : '<span class="hint">没说过</span>',
      )

      // 6. 核心
      td(r.核心?.count ? r.核心.count + ' 条' : '<span class="hint">—</span>')

      // 7. 日期
      td(
        '<span class="hint">' +
          (r.日期?.firstSeen ? new Date(r.日期.firstSeen).toLocaleDateString() : '—') +
          '</span>',
      )

      box.appendChild(tr)
    }
  }

  /* ============================================================
   * 抽屉
   * ============================================================ */
  async function openDrawer(row) {
    DRAW = { open: true, person: row, tab: 'memory', chat: [], detail: null }

    const d = document.getElementById('member-drawer')
    const mask = document.getElementById('member-mask')
    if (!d) return
    // 必须用 flex：抽屉内部靠 flex:1 + overflow:auto 滚动，设成 block 就撑出屏幕了
  d.style.display = 'flex'
    if (mask) mask.style.display = 'block'
    // 让它滑进来
    requestAnimationFrame(() => {
      d.style.transform = 'translateX(0)'
    })

    renderDrawerHead()
    await loadDrawerData()
    renderDrawerBody()
  }

  function closeDrawer() {
    const d = document.getElementById('member-drawer')
    const mask = document.getElementById('member-mask')
    if (d) {
      d.style.transform = 'translateX(100%)'
      setTimeout(() => (d.style.display = 'none'), 180)
    }
    if (mask) mask.style.display = 'none'
    DRAW.open = false
  }

  function renderDrawerHead() {
    const p = DRAW.person
    if (!p) return
    const n = document.getElementById('md-name')
    const s = document.getElementById('md-sub')
    if (n) n.textContent = p.名字
    if (s) {
      const src = (p.来源 || []).map((x) => (x.kind === 'private' ? '私聊' : x.label)).join(' · ')
      s.textContent = p.账号 + (src ? ' · ' + src : '') + (p.未建档 ? ' · 未建档' : '')
    }

    // 屏蔽开关
    const bt = document.getElementById('md-block')
    if (bt) {
      api('/api/access')
        .then((a) => {
          // memberDeny 里存的是 QQ 号（后端 /api/member/block 写的就是它），
          // 不是内部档案 id（qq-123）。以前拿 p.id 比对，永远不命中 →
          // 已经屏蔽的人，按钮还显示"屏蔽"，再点一次又"屏蔽"一遍。
          const qq = String(p.账号 || '')
          const denied = qq !== '' && (a.memberDeny || []).includes(qq)
          bt.textContent = denied ? '已屏蔽' : '屏蔽'
          bt.style.background = denied ? '#f85149' : ''
          bt.style.color = denied ? '#fff' : ''
          bt.onclick = async () => {
            try {
              await sendJson('/api/member/block', { id: p.id, blocked: !denied }, 'PUT')
              openDrawer(p)
              toast(denied ? '取消屏蔽' : '已屏蔽')
            } catch (e) {
              alert('失败：' + e.message)
            }
          }
        })
        .catch(() => {})
    }
  }

  async function loadDrawerData() {
    const p = DRAW.person
    if (!p) return
    try {
      const tasks = []
      tasks.push(
        api('/api/member/chat?id=' + encodeURIComponent(p.id) + '&limit=60')
          .then((r) => (DRAW.chat = r.rows || []))
          .catch(() => (DRAW.chat = [])),
      )
      if (!p.未建档) {
        tasks.push(
          api('/api/person/detail?id=' + encodeURIComponent(p.id))
            .then((r) => (DRAW.detail = r))
            .catch(() => (DRAW.detail = null)),
        )
      }
      await Promise.all(tasks)
    } catch {
      /* 忽略 */
    }
  }

  function renderDrawerBody() {
    const box = document.getElementById('md-body')
    if (!box) return

    // TAB
    const tabs = [
      ['memory', '全部记忆'],
      ['chat', '历史对话'],
      ['timeline', '时间线'],
      ['impression', '印象'],
    ]
    const bar = document.getElementById('md-tabs')
    if (bar) {
      bar.innerHTML = ''
      for (const [k, label] of tabs) {
        const b = document.createElement('button')
        b.className = 'gtab' + (k === DRAW.tab ? ' on' : '')
        b.textContent = label
        b.onclick = () => {
          DRAW.tab = k
          renderDrawerBody()
        }
        bar.appendChild(b)
      }
    }

    box.innerHTML = ''

    if (DRAW.tab === 'memory') {
      const d = DRAW.detail
      if (!d) {
        box.innerHTML = '<div class="empty">这个人还没建档，没有记忆</div>'
        return
      }

    /** 各分区的空状态说明：光写"没有"会让人以为数据丢了 */
    const EMPTY_HINT = {
      事实: '还没有确认过的事实。聊得多了、它觉得重要会记下来。',
      经历: '还没有提炼出经历。等下一次「整理记忆」后才会有。',
      待问: '没有待确认的事。',
    }

      const sec = (title, items) => {
        const c = document.createElement('div')
        c.className = 'card'
        c.style.marginBottom = '10px'
        const h = document.createElement('div')
        h.className = 'md-sec-title'
        h.textContent = title + (items.length ? '  ' + items.length : '')
        c.appendChild(h)
        if (!items.length) {
          const e = document.createElement('div')
          e.className = 'empty'
          // 别只写「没有」——用户看到「聊了几条却全空」会以为坏了
          e.textContent = EMPTY_HINT[title] || '没有'
          c.appendChild(e)
        } else {
          for (const it of items) {
            const row = document.createElement('div')
            row.className = 'item'
            row.style.padding = '5px 0'
            row.textContent = it
            c.appendChild(row)
          }
        }
        box.appendChild(c)
      }

      sec('事实', (d.事实 || []).map((f) => (f.supersededAt ? f.text + '（已失效 ' + f.supersededAt + '）' : f.text)))
      sec('经历', (d.经历 || []).map((e) => (e.title || '') + (e.date ? '（' + e.date + '）' : '')))
      sec('待问', (d.待问 || []).map((o) => o.text))
    }

    if (DRAW.tab === 'chat') {
      if (!DRAW.chat.length) {
        box.innerHTML = '<div class="empty">最近没有聊天记录</div>'
        return
      }
      const wrap = document.createElement('div')
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px'
      for (const c of DRAW.chat) {
        const row = document.createElement('div')
        const mine = c.role === 'assistant'
        row.style.cssText =
          'display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') + ';gap:6px'
        const bubble = document.createElement('div')
        bubble.style.cssText =
          'max-width:70%;padding:6px 10px;border-radius:8px;font-size:12.5px;line-height:1.5;' +
          (mine ? 'background:rgba(88,166,255,.15);color:#cfe3ff' : 'background:rgba(255,255,255,.06)')
        bubble.textContent = c.text
        row.appendChild(bubble)
        wrap.appendChild(row)
        const t = document.createElement('div')
        t.className = 'hint'
        t.style.cssText = 'font-size:10px;margin-top:-2px;text-align:' + (mine ? 'right' : 'left')
        t.textContent = new Date(c.at).toLocaleString()
        wrap.appendChild(t)
      }
      box.appendChild(wrap)
    }

    if (DRAW.tab === 'timeline') {
      const d = DRAW.detail
      const events = []
      /** 纯日期（YYYY-MM-DD）按本地零点算，别直接 new Date(date)（那会按 UTC，显示成 08:00） */
      const parseDay = (v) => {
        const s = String(v || '')
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00').getTime()
        const t = new Date(s).getTime()
        return Number.isFinite(t) ? t : 0
      }
      // 同一天里排最前（-1），否则和当天的事件撞在同一个零点、顺序随机
      if (d?.首次见到) events.push({ at: (Number(d.首次见到) || parseDay(d.首次见到)) - 1, text: '第一次见到' })
      for (const e of d?.经历 || []) {
        if (e.date) events.push({ at: parseDay(e.date), text: e.title || e.date })
      }
      // 「第一次见到」永远排最前（它是时间线的起点，不该被当天的其它事件挤到中间）
      events.sort((a, b) => {
        if (a.text === '第一次见到') return -1
        if (b.text === '第一次见到') return 1
        return a.at - b.at
      })
      if (!events.length) {
        box.innerHTML = '<div class="empty">还没有时间线</div>'
        return
      }
      for (const e of events) {
        const row = document.createElement('div')
        row.className = 'item'
        row.style.cssText = 'padding:6px 0;border-left:2px solid rgba(88,166,255,.4);padding-left:10px'
        const t = document.createElement('div')
        t.className = 'hint'
        t.style.fontSize = '10.5px'
        t.textContent = e.at ? new Date(e.at).toLocaleDateString('zh-CN') : '时间未知'
        row.appendChild(t)
        const x = document.createElement('div')
        x.textContent = e.text
        row.appendChild(x)
        box.appendChild(row)
      }
    }

    if (DRAW.tab === 'impression') {
      // 它怎么称呼这个人：称呼由它自己取，你填的只是建议
      {
        const cc = document.createElement('div')
        cc.className = 'card'
        cc.style.marginBottom = '10px'
        cc.appendChild(
          Object.assign(document.createElement('div'), { className: 'op-t', textContent: '它怎么叫他' }),
        )
        const cur = document.createElement('div')
        cur.style.cssText = 'font-size:13px;margin-top:6px'
        if (DRAW.detail && DRAW.detail.称呼) {
          cur.textContent = '它现在叫：「' + DRAW.detail.称呼 + '」'
        } else {
          cur.className = 'hint'
          cur.textContent = '它还没给他起称呼。下次自我反思时会想一个。'
        }
        cc.appendChild(cur)

        const row = document.createElement('div')
        row.className = 'self-field'
        row.style.marginTop = '10px'
        row.appendChild(Object.assign(document.createElement('label'), { textContent: '建议' }))
        const inp = document.createElement('input')
        inp.className = 'self-input'
        inp.value = (DRAW.detail && DRAW.detail.称呼建议) || ''
        inp.placeholder = '你希望它怎么叫他（留空 = 不给建议）'
        row.appendChild(inp)
        const saveCall = document.createElement('button')
        saveCall.className = 'mini-btn'
        saveCall.textContent = '保存建议'
        saveCall.onclick = async () => {
          try {
            await sendJson('/api/person/callname', { id: DRAW.person.id, suggested: inp.value.trim() }, 'PUT')
            toast('建议已保存（它可能不采用）')
            loadDrawerData().then(renderDrawerBody)
          } catch (e) {
            alert('失败：' + e.message)
          }
        }
        row.appendChild(saveCall)
        cc.appendChild(row)
        cc.appendChild(
          Object.assign(document.createElement('div'), {
            className: 'hint',
            textContent: '称呼由它自己取；你填的只是建议，它完全可以叫自己想叫的。',
          }),
        )
        box.appendChild(cc)
      }

      const d = DRAW.detail
      const c = document.createElement('div')
      c.className = 'card'
      c.appendChild(Object.assign(document.createElement('div'), { className: 'op-t', textContent: '我对他的印象' }))
      const ta = document.createElement('textarea')
      ta.value = d?.印象 || ''
      ta.rows = 6
      ta.style.cssText =
        'width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px;color:var(--text);font-size:13px;line-height:1.6;margin-top:8px'
      c.appendChild(ta)
      const save = document.createElement('button')
      save.className = 'mini-btn'
      save.textContent = '保存印象'
      save.style.marginTop = '8px'
      save.onclick = async () => {
        try {
          await sendJson('/api/person/impression', { id: DRAW.person.id, text: ta.value }, 'PUT')
          toast('已保存')
          loadDrawerData().then(renderDrawerBody)
        } catch (e) {
          alert('失败：' + e.message)
        }
      }
      c.appendChild(save)

      // 画像
      c.appendChild(Object.assign(document.createElement('div'), { className: 'op-t', textContent: '画像' })).style.marginTop =
        '16px'
      const ta2 = document.createElement('textarea')
      ta2.value = d?.画像 || ''
      ta2.rows = 4
      ta2.style.cssText = ta.style.cssText
      c.appendChild(ta2)
      const save2 = document.createElement('button')
      save2.className = 'mini-btn'
      save2.textContent = '保存画像'
      save2.style.marginTop = '8px'
      save2.onclick = async () => {
        try {
          await sendJson('/api/person/profile', { id: DRAW.person.id, text: ta2.value }, 'PUT')
          toast('已保存')
        } catch (e) {
          alert('失败：' + e.message)
        }
      }
      c.appendChild(save2)
      box.appendChild(c)
    }
  }

  /* ============================================================
   * 挂到 window（供 HTML 里的 onclick 用）
   * ============================================================ */
  window.loadMembers = loadMembers
  // 给群页用：点成员能打开同一个抽屉
  window.openMemberDrawer = openDrawer
  window.memberFilter = function (key, value) {
    IF[key] = value
    renderTable()
  }
  window.memberSearch = function (v) {
    IF.q = v
    renderTable()
  }
  window.memberSort = function (v) {
    IF.sort = v
    renderTable()
  }
  window.memberOnlyReal = function (v) {
    IF.onlyReal = v
    renderTable()
  }
  window.memberOnlyChat = function (v) {
    IF.onlyChat = v
    renderTable()
  }
  window.closeDrawer = closeDrawer
})()
