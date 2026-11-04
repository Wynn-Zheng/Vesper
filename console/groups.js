/**
 * 群页。
 *
 * 重做前的样子：52 个人平铺，每个人一行 [认识tag][头像][名字][facts.md relation.yaml...][建档按钮]
 *   - 文件名是技术细节，用户不需要看
 *   - 52 个「建档」按钮排成一片，信息密度极低
 *   - 分成「认识」和「不认识」但视觉上一模一样
 *
 * 现在：
 *   - 群是一张卡片（人数/认识几个/最近活跃）
 *   - 认识的成员列在卡片里（关系/记忆/对话，能点进抽屉）
 *   - 只认识名字的折叠起来（默认收起，想看再展开）
 */
;(function () {
  'use strict'

  let DATA = { groups: [], others: [], table: [] }

  /* ============================================================
   * 加载
   * ============================================================ */
  async function loadGroups2() {
    const box = document.getElementById('groups-body')
    if (!box) return
    box.innerHTML = '<div class="hint">加载中…</div>'

    try {
      // 同时拿群名单和成员表：群名单只有"认不认识"，
      // 关系分/记忆数/最近说话这些在成员表里。
      const [g, t] = await Promise.all([
        api('/api/groups'),
        api('/api/member/table').catch(() => ({ rows: [], nameless: [] })),
      ])

      const byId = new Map()
      for (const r of [...(t.rows || []), ...(t.nameless || [])]) byId.set(String(r.账号), r)

      DATA = {
        groups: g.groups || [],
        others: g.others || [],
        table: [...(t.rows || []), ...(t.nameless || [])],
      }
      // 把表格数据挂到每个成员上
      for (const grp of DATA.groups) {
        for (const m of grp.members || []) {
          m.__row = byId.get(String(m.id)) || null
        }
      }

      render()
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'
    }
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  function render() {
    const box = document.getElementById('groups-body')
    if (!box) return
    box.innerHTML = ''

    const groups = DATA.groups
    if (!groups.length) {
      box.innerHTML =
        '<div class="card"><div class="empty">还没拉到群名单。在群里说句话，或者去「测试 → 工具连通性」看看连接。</div></div>'
      return
    }

    const totalPeople = groups.reduce((a, g) => a + (g.总人数 ?? g.总数 ?? 0), 0)
    const totalKnown = groups.reduce((a, g) => a + (g.认识几个 ?? 0), 0)

    // 顶部汇总
    const head = el('div', 'card')
    head.style.marginBottom = '12px'
    const hr = el('div')
    hr.style.cssText = 'display:flex;gap:16px;align-items:baseline;flex-wrap:wrap'
    const ht = el('b', '', '群成员')
    ht.style.fontSize = '15px'
    hr.appendChild(ht)
    hr.appendChild(el('span', 'hint', `${groups.length} 个群 · ${totalPeople} 人次 · 认识 ${totalKnown} 个`))
    const rf = el('button', 'mini-btn', '刷新')
    rf.style.marginLeft = 'auto'
    rf.onclick = loadGroups2
    hr.appendChild(rf)
    head.appendChild(hr)
    box.appendChild(head)

    // 每个群一张卡
    for (const g of groups) {
      box.appendChild(groupCard(g))
    }

    // 只私聊过、不在任何群的人
    if (DATA.others.length) {
      const c = el('div', 'card')
      c.style.marginTop = '12px'
      c.appendChild(el('div', 'op-t', '不在任何群里的'))
      c.appendChild(el('div', 'hint', '只私聊过，没在任何群名单里')).style.marginBottom = '8px'
      for (const m of DATA.others) {
        // 后端给的是"档案 id + QQ 号"；memberRow 里建档/打开档案都按 QQ 号走，
        // 以前直接把档案 id 当账号传下去，建出来的人 id 和账号对不上。
        c.appendChild(memberRow({ ...m, id: m.account || m.id, 昵称: m.name, 认识: true }, null))
      }
      box.appendChild(c)
    }
  }

  function groupCard(g) {
    const card = el('div', 'card')
    card.style.marginBottom = '12px'

    const members = g.members || []
    const known = members.filter((m) => m.认识)
    const unknown = members.filter((m) => !m.认识)
    const total = g.总人数 ?? g.总数 ?? members.length

    /* --- 群头 --- */
    const head = el('div')
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px'

    // 群图标
    const ico = el('span')
    ico.style.cssText =
      'width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(88,166,255,.12);color:#58a6ff'
    ico.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
    head.appendChild(ico)

    const info = el('div')
    info.style.cssText = 'flex:1;min-width:0'
    const name = el('div', '', '群 ' + (g.groupId ?? g.id ?? '?'))
    name.style.cssText = 'font-size:14px;font-weight:600'
    info.appendChild(name)
    const sub = el('div')
    sub.style.cssText = 'font-size:11.5px;color:#8b949e;margin-top:1px'
    sub.textContent = `${total} 人 · 认识 ${known.length} 个`
    info.appendChild(sub)
    head.appendChild(info)

    card.appendChild(head)

    /* --- 认识的人 --- */
    if (known.length) {
      const sec = el('div')
      sec.style.marginBottom = unknown.length ? '10px' : '0'
      const label = el('div')
      label.style.cssText = 'font-size:11.5px;color:#8b949e;margin-bottom:5px'
      label.textContent = '认识的（' + known.length + '）'
      sec.appendChild(label)
      for (const m of known) sec.appendChild(memberRow(m, g))
      card.appendChild(sec)
    } else {
      const empty = el('div', 'hint', '这个群里还没有认识的人')
      empty.style.cssText = 'font-size:12px;padding:4px 0 8px'
      card.appendChild(empty)
    }

    /* --- 只认识名字的：折叠 --- */
    if (unknown.length) {
      const det = document.createElement('details')
      det.style.cssText = 'margin-top:4px'

      const sum = document.createElement('summary')
      sum.style.cssText =
        'font-size:11.5px;color:#8b949e;cursor:pointer;padding:5px 0;user-select:none;list-style:none'
      sum.textContent = '只看得到名字的（' + unknown.length + '）— 点开'

      det.appendChild(sum)

      const list = el('div')
      list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px 0 2px'
      for (const m of unknown) {
        const chip = el('span')
        chip.style.cssText =
          'font-size:11.5px;padding:3px 8px;border-radius:12px;background:rgba(255,255,255,.05);color:#8b949e;cursor:pointer'
        chip.textContent = m.名片 || m.昵称 || m.id
        chip.title = '点一下建档'
        chip.onclick = () => {
          if (typeof createPersonFromGroup === 'function') {
            createPersonFromGroup(String(m.id), m.名片 || '')
          }
        }
        list.appendChild(chip)
      }
      det.appendChild(list)
      card.appendChild(det)
    }

    return card
  }

  /** 一行成员：头像 + 名字 + 关系/记忆/对话 + 操作 */
  function memberRow(m, grp) {
    const row = el('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px;cursor:pointer;transition:background .12s'
    row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,.04)')
    row.onmouseleave = () => (row.style.background = '')

    // 头像
    const initial = (m.名片 || m.昵称 || '?').trim().slice(0, 1) || '?'
    const av = el('span', '', initial)
    av.style.cssText = `width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;background:${avatarColor(String(m.id))}`
    row.appendChild(av)

    // 名字
    const nm = el('div')
    nm.style.cssText = 'min-width:0;flex:1'
    const n1 = el('div')
    n1.style.cssText = 'font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    n1.textContent = m.名片 || m.昵称 || m.id
    nm.appendChild(n1)

    // 昵称和名片不同的时候补一句
    const r = m.__row
    if (m.昵称 && m.昵称 !== m.名片) {
      const n2 = el('div', 'hint', '昵称 ' + m.昵称)
      n2.style.cssText = 'font-size:10.5px;opacity:.7'
      nm.appendChild(n2)
    }
    row.appendChild(nm)

    // 关系 + 记忆 + 对话（从成员表拿）
    if (r) {
      const meta = []
      if (r.关系?.值 > 0) meta.push(r.关系.阶段 + ' ' + r.关系.值)
      if (r.记忆?.facts) meta.push(r.记忆.facts + ' 事实')
      if (r.对话?.turns) meta.push(r.对话.turns + ' 条对话')

      if (meta.length) {
        const mm = el('div', 'hint', meta.join(' · '))
        mm.style.cssText = 'font-size:11px;flex:none;text-align:right'
        row.appendChild(mm)
      }

      // 操作
      const act = el('button', 'mini-btn', '看详情')
      act.style.cssText += ';font-size:11px;padding:1px 8px;flex:none'
      act.onclick = (e) => {
        e.stopPropagation()
        // 复用成员页的抽屉
        if (typeof window.openMemberDrawer === 'function') {
          window.openMemberDrawer(r)
        } else {
          // 兜底：跳到成员页
          document.querySelector('#nav button[data-v="people"]')?.click()
        }
      }
      row.appendChild(act)
    } else {
      // 没档案
      const tag = el('span', 'hint', '没建档')
      tag.style.cssText = 'font-size:10.5px;opacity:.6;flex:none'
      row.appendChild(tag)

      const mk = el('button', 'mini-btn', '建档')
      mk.style.cssText += ';font-size:11px;padding:1px 8px;flex:none'
      mk.onclick = (e) => {
        e.stopPropagation()
        if (typeof createPersonFromGroup === 'function') {
          createPersonFromGroup(String(m.id), m.名片 || '')
        }
      }
      row.appendChild(mk)
    }

    return row
  }

  window.loadGroups2 = loadGroups2
})()
