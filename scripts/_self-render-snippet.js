/** 一页三段的段标题 */
function selfSection(title, hint) {
  const head = el('div', 'set-head')
  head.style.marginTop = '18px'
  const b = el('b', '', title)
  head.appendChild(b)
  head.appendChild(el('span', 'hint', hint))
  return head
}

/** 小标题（卡片内部的区块名） */
function selfBlockTitle(text, extra) {
  const t = el('div', 'op-t', text)
  if (extra) t.appendChild(el('span', 'sub', extra)).style.cssText = 'font-size:11px;color:#8b949e;margin-left:8px'
  return t
}

function renderSelfV2() {
  const body = $('self-body')
  if (!body || !SELF_DATA) return
  const d = SELF_DATA

  body.innerHTML = ''

  // 顶部说明：让人一眼知道这页为什么这么排
  const tip = el('div', 'hint', '三段：你设的 / 协商中 / 它长的 —— 每段标了谁说了算')
  tip.style.cssText = 'font-size:12px;color:#8b949e;padding:0 0 4px'
  body.appendChild(tip)

  /* ============================================================
   * 第一段：你设的
   * ============================================================ */
  body.appendChild(selfSection('你设的', '这些话是你的，它照做'))

  // 不能越的线
  {
    const c = el('div', 'card')
    c.appendChild(selfBlockTitle('不能越的线', '只有你能改，它只能提申请'))
    const core = d.core || {}
    const keys = Object.keys(core)
    if (!keys.length) {
      c.appendChild(el('div', 'empty', '还是空的。加几条它一定不能弄错的事。'))
    } else {
      for (const kind of keys) {
        const items = core[kind]
        if (!Array.isArray(items) || !items.length) continue
        const kt = el('div', 'op-t', kind)
        kt.style.cssText = 'font-size:12px;color:#8b949e;margin-top:10px'
        c.appendChild(kt)
        for (const it of items) {
          c.appendChild(el('div', 'item', '· ' + it)).style.fontSize = '13px'
        }
      }
    }
    body.appendChild(c)
  }

  // 怎么称呼你 + 说话风格
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('它怎么称呼你', ''))

    const sal = el('div')
    sal.style.cssText = 'font-size:13px;line-height:1.8'
    sal.textContent = d.salutation || '（按关系阶段自动变：你 / 哎 / 昵称 / 专属）'
    c.appendChild(sal)

    c.appendChild(selfBlockTitle('说话方式', '')).style.marginTop = '14px'

    const styleRow = el('div')
    styleRow.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:12.5px'
    const styleText = el('span', '', d.speechStyle || '（默认：短句、不追问、偶尔引用）')
    styleText.style.cssText = 'flex:1;color:#8b949e'
    styleRow.appendChild(styleText)
    const goBtn = el('button', 'mini-btn', '去设置')
    goBtn.style.cssText += ';font-size:11px;padding:1px 8px'
    goBtn.onclick = () => showGroup('settings', 'v-settings')
    styleRow.appendChild(goBtn)
    c.appendChild(styleRow)

    body.appendChild(c)
  }

  /* ============================================================
   * 第二段：协商中
   * ============================================================ */
  body.appendChild(selfSection('协商中', '这些是它想动、等你点头的'))

  // 它想改的
  if (SELF_REQUESTS.length) {
    body.appendChild(renderRequestBlock())
  } else {
    const c = el('div', 'card')
    c.appendChild(selfBlockTitle('它想改的', ''))
    c.appendChild(el('div', 'hint', '暂时没有。它想改被锁住的东西时会提申请，出现在这儿。')).style.fontSize = '11.5px'
    body.appendChild(c)
  }

  // 名字
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('名字', d.nameLocked ? '你定的' : '它自己取的'))

    const nameRow = el('div')
    nameRow.style.cssText = 'display:flex;align-items:center;gap:10px'
    const nm = el('div', 'txt', d.name || '（还没取名字）')
    nm.style.cssText = 'font-size:15px;font-weight:600'
    nameRow.appendChild(nm)
    if (d.nameReason) {
      const why = el('span', 'hint', d.nameReason)
      why.style.cssText = 'font-size:11.5px;color:#8b949e'
      nameRow.appendChild(why)
    }
    c.appendChild(nameRow)
    body.appendChild(c)
  }

  // 它自己写的规矩
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('它自己写的规矩', '进 prompt 当约束'))

    const traits = d.traits || []
    if (!traits.length) {
      c.appendChild(el('div', 'empty', '还没有。它会在反思里慢慢总结出来。'))
    } else {
      for (const [k, v] of traits) {
        const row = el('div')
        row.style.cssText = 'padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px'
        const kb = el('b', '', k + '：')
        kb.style.cssText = 'color:#8b949e;font-weight:500'
        row.appendChild(kb)
        row.appendChild(el('span', '', v))
        c.appendChild(row)
      }
    }
    body.appendChild(c)
  }

  /* ============================================================
   * 第三段：它长的
   * ============================================================ */
  body.appendChild(selfSection('它长的', '这些是它自己积出来的，你不改'))

  // 我是谁
  {
    const c = el('div', 'card')
    c.appendChild(selfBlockTitle('我是谁', d.aboutOwner === 'me' ? '你写的' : '它自己写的'))

    const ta = el('textarea')
    ta.value = d.selfText || ''
    ta.rows = 5
    ta.style.cssText =
      'width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px;color:var(--text);font-size:13px;line-height:1.6'
    c.appendChild(ta)

    const b1 = el('button', 'mini-btn', '保存自述')
    b1.style.marginTop = '8px'
    b1.onclick = () => saveSelfText(ta.value)
    c.appendChild(b1)

    // 所有权切换
    const ownerRow = el('div')
    ownerRow.style.cssText =
      'display:flex;align-items:center;gap:10px;margin-top:8px;font-size:11.5px;line-height:1.7'
    const isMine = d.aboutOwner === 'me'
    const ownerTag = el('span')
    ownerTag.innerHTML = isMine
      ? '<span style="color:#d29922">🔒 这是你写的，它只读</span>'
      : '<span style="color:#3fb950">✍️ 这是它自己写的，它会随反思更新</span>'
    ownerRow.appendChild(ownerTag)
    const ownerBtn = el('button', 'mini-btn', isMine ? '交回给它' : '我来写')
    ownerBtn.style.cssText += ';font-size:11px;padding:1px 8px'
    ownerBtn.onclick = () => switchSelfOwner(isMine ? 'it' : 'me')
    ownerRow.appendChild(ownerBtn)
    c.appendChild(ownerRow)

    if (d.aboutOwner === 'me' && d.aboutExtra) {
      const extraBox = el('div')
      extraBox.style.cssText =
        'margin-top:14px;padding:10px 12px;border-radius:8px;background:rgba(63,185,80,.07);border:1px solid rgba(63,185,80,.25)'
      extraBox.appendChild(selfBlockTitle('它补充的', '')).style.color = '#3fb950'
      const et = el('div', 'txt', d.aboutExtra)
      et.style.cssText = 'font-size:12.5px;line-height:1.7;white-space:pre-wrap'
      extraBox.appendChild(et)
      const note = el('div', 'hint', '这段它会随反思更新；上面那段是你的，它不会动。')
      note.style.cssText = 'font-size:11px;margin-top:6px;color:#8b949e'
      extraBox.appendChild(note)
      c.appendChild(extraBox)
    } else if (d.aboutOwner === 'me') {
      const note = el('div', 'hint', '它还没补充过什么。等它想明白会自己加在这儿。')
      note.style.cssText = 'font-size:11px;margin-top:10px;color:#8b949e'
      c.appendChild(note)
    }

    body.appendChild(c)
  }

  // 心情 + 生活
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('它现在的心情', ''))

    if (!d.mood) {
      c.appendChild(el('div', 'empty', '现在没有特别的心情'))
    } else {
      const mrow = el('div')
      mrow.style.cssText = 'display:flex;align-items:baseline;gap:10px'
      const emo = el('b', '', d.mood.情绪 || '—')
      emo.style.cssText = 'font-size:15px'
      mrow.appendChild(emo)
      const inten = Number(d.mood.强度 ?? 0)
      mrow.appendChild(el('span', 'hint', `强度 ${inten.toFixed(2)}`)).style.fontSize = '11.5px'
      c.appendChild(mrow)
      if (d.mood.原因) {
        const why = el('div', 'txt', '因为：' + d.mood.原因)
        why.style.cssText = 'font-size:12.5px;margin-top:6px;color:#8b949e'
        c.appendChild(why)
      }
    }

    const life = d.life || []
    if (life.length) {
      c.appendChild(selfBlockTitle('它的生活', '')).style.marginTop = '14px'
      for (const l of life.slice(-8).reverse()) {
        const row = el('div', 'item', '· ' + l)
        row.style.cssText = 'font-size:12.5px;line-height:1.7;padding:2px 0'
        c.appendChild(row)
      }
    }
    body.appendChild(c)
  }

  // 学到的说话方式 + 问题 + 自己的记忆
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('它学到的说话方式', '从"回得好的"里挑出来的'))

    const plays = d.plays || []
    if (!plays.length) {
      c.appendChild(el('div', 'empty', '还没学到'))
    } else {
      for (const x of plays.slice(0, 5)) {
        const row = el('div')
        row.style.cssText = 'padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)'
        if (x.scene) {
          const sc = el('div', 'hint', '他会说：' + x.scene)
          sc.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:2px'
          row.appendChild(sc)
        }
        row.appendChild(el('div', 'txt', x.reply || '（没有内容）')).style.fontSize = '12.5px'
        c.appendChild(row)
      }
    }

    const issues = d.issues || []
    if (issues.length) {
      c.appendChild(selfBlockTitle('它发现的问题', '')).style.marginTop = '14px'
      for (const it of issues.slice(-5).reverse()) {
        const row = el('div', 'item', '· ' + (it.text || it.msg || String(it)))
        row.style.cssText = 'font-size:12px;line-height:1.7;padding:2px 0;color:#8b949e'
        c.appendChild(row)
      }
    }

    const own = d.ownMemories || []
    if (own.length) {
      c.appendChild(selfBlockTitle('只属于它自己的记忆', '不和某个人绑在一起')).style.marginTop = '14px'
      for (const x of own.slice(0, 5)) {
        const row = el('div', 'item', '· ' + (x.text || x.title || ''))
        row.style.cssText = 'font-size:12px;line-height:1.7;padding:2px 0;color:#8b949e'
        c.appendChild(row)
      }
    }

    body.appendChild(c)
  }

  /* ============================================================
   * 观察：它是怎么变的
   * ============================================================ */
  body.appendChild(selfSection('它是怎么变的', '看它改了什么，不是让你改'))

  {
    const c = el('div', 'card')
    c.appendChild(selfBlockTitle('人格变化', '选两个版本对比'))

    const row = el('div')
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px'

    const mkSelect = () => {
      const s = el('select')
      s.style.cssText =
        'flex:1;min-width:120px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:inherit;font-size:12px'
      return s
    }

    const selOld = mkSelect()
    const selNew = mkSelect()
    row.appendChild(selOld)
    row.appendChild(el('span', 'hint', '→')).style.fontSize = '12px'
    row.appendChild(selNew)

    const cmp = el('button', 'mini-btn', '对比')
    cmp.style.cssText += ';font-size:11px;padding:1px 10px'
    row.appendChild(cmp)
    c.appendChild(row)

    const diffBox = el('div')
    diffBox.style.cssText =
      'margin-top:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;max-height:360px;overflow:auto'
    c.appendChild(diffBox)

    // 载入版本列表
    api('/api/self/versions')
      .then((r) => {
        const vs = r.versions || []
        if (!vs.length) {
          diffBox.innerHTML = '<div class="hint" style="color:#8b949e;font-family:inherit">还没有历史快照。改一次自述就会留一份。</div>'
          return
        }
        const fill = (s, idx) => {
          s.innerHTML = ''
          vs.forEach((v, i) => {
            const o = document.createElement('option')
            o.value = v.id
            o.textContent = v.id.replace(/^(\d{8})-(\d{6})$/, '$1 $2').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
            s.appendChild(o)
          })
          if (vs[idx]) s.value = vs[idx].id
        }
        fill(selOld, 1)
        fill(selNew, 0)

        const run = async () => {
          diffBox.innerHTML = '<div class="hint" style="color:#8b949e;font-family:inherit">对比中…</div>'
          try {
            const r2 = await api(
              `/api/self/versions/diff?a=${encodeURIComponent(selOld.value)}&b=${encodeURIComponent(selNew.value)}`,
            )
            diffBox.innerHTML = ''
            for (const ln of r2.lines || []) {
              const div = document.createElement('div')
              div.style.cssText = 'white-space:pre-wrap;padding:1px 6px;border-radius:3px'
              if (ln.type === 'add') {
                div.style.background = 'rgba(63,185,80,.12)'
                div.textContent = '+ ' + ln.text
              } else if (ln.type === 'del') {
                div.style.background = 'rgba(248,81,73,.12)'
                div.textContent = '- ' + ln.text
              } else {
                div.style.color = '#8b949e'
                div.textContent = '  ' + ln.text
              }
              if (!ln.text.trim()) div.textContent = ''
              diffBox.appendChild(div)
            }
          } catch (e) {
            diffBox.innerHTML = '<div class="hint" style="color:#f85149;font-family:inherit">对比失败：' + esc(e.message) + '</div>'
          }
        }
        cmp.onclick = run
        run()
      })
      .catch(() => {
        diffBox.innerHTML = '<div class="hint" style="color:#8b949e;font-family:inherit">版本列表读不到</div>'
      })

    body.appendChild(c)
  }

  // 漂移时间线
  {
    const c = el('div', 'card')
    c.style.marginTop = '12px'
    c.appendChild(selfBlockTitle('它变过几次', '相似度低于 45% 才算明显变了'))

    const box = el('div')
    box.style.cssText = 'margin-top:8px'
    box.innerHTML = '<div class="hint" style="color:#8b949e">读取中…</div>'
    c.appendChild(box)

    api('/api/self/drift')
      .then((r) => {
        const items = r.items || []
        box.innerHTML = ''
        if (!items.length) {
          box.innerHTML = '<div class="hint" style="color:#8b949e">还没记到明显的变化。</div>'
          return
        }
        for (const it of items.slice(0, 10)) {
          const row = el('div')
          row.style.cssText = 'padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)'
          const head = el('div')
          head.style.cssText = 'font-size:11px;color:#8b949e;margin-bottom:3px'
          head.textContent =
            new Date(it.at).toLocaleString() + ' · 相似度 ' + Math.round((it.sim || 0) * 100) + '%'
          row.appendChild(head)
          const f = el('div', 'hint', '旧：' + String(it.from || '').slice(0, 60))
          f.style.cssText = 'font-size:11.5px;color:#8b949e;line-height:1.6'
          row.appendChild(f)
          const t2 = el('div', 'txt', '新：' + String(it.to || '').slice(0, 60))
          t2.style.cssText = 'font-size:12px;line-height:1.6'
          row.appendChild(t2)
          box.appendChild(row)
        }
      })
      .catch(() => {
        box.innerHTML = '<div class="hint" style="color:#8b949e">漂移记录读不到</div>'
      })

    body.appendChild(c)
  }
}
