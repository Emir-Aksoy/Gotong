/**
 * v5 Stream E5-M4 — cross-hub control plane ("控制面") browse + refresh
 * (tab "联邦" in app.html, panel #peer-summary-panel).
 *
 * The aggregate view: this hub's own privacy-safe footprint joined with each
 * connected peer's VOLUNTARILY-SHARED summary (the `peer.summary` rpc, E5-M2).
 * Counts only — assets / runs / windowed LLM usage / suspended tasks; NEVER raw
 * rows. A peer only shows numbers if it opted into sharing with us (per-link
 * `shareSummary`, fail-closed); otherwise its row carries an honest reason
 * ("未共享" / 离线) instead of fabricated zeros.
 *
 * North-Star honest: a control plane OBSERVES, it never OWNS. We aggregate what
 * sovereign peers choose to disclose — nothing is pulled without the remote
 * hub's opt-in gate letting it through.
 *
 * Read + refresh only. Same activation/CSS as peer-manifest-ui.js (reuses the
 * pf-* classes), so this panel needs no new stylesheet.
 */
;(function () {
  'use strict'

  const LIST_API = '/api/admin/peer-summaries'
  const REFRESH_API = '/api/admin/peer-summaries/refresh'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function fmtTime(ms) {
    if (ms == null || !ms) return '—'
    try {
      return new Date(ms).toLocaleString()
    } catch (_) {
      return String(ms)
    }
  }
  // costMicros is integer micro-USD (1e6 == $1). Whole dollars render clean;
  // fractions get 4 places so a few cents never reads as $0.
  function fmtCost(micros) {
    const n = Number(micros) || 0
    if (n === 0) return '$0'
    const dollars = n / 1e6
    return '$' + (n % 1e6 === 0 ? dollars.toFixed(0) : dollars.toFixed(4))
  }
  function num(n) {
    return Number(n) || 0
  }

  function setStatus(root, msg, kind) {
    const el = $('#ps-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'pf-status' + (kind ? ' pf-status-' + kind : '')
  }

  // A peer row's status chip. The whole point of E5 is the opt-in: a peer that
  // hasn't shared must read differently from one that's merely offline.
  function statusOf(row) {
    if (row.summary) {
      return row.online
        ? { cls: 'pf-online', label: '在线' }
        : { cls: 'pf-stale', label: '离线·缓存' }
    }
    if (row.lastError && /not shared/i.test(row.lastError)) {
      return { cls: 'pf-unknown', label: '未共享' }
    }
    if (row.online) return { cls: 'pf-stale', label: '在线·无摘要' }
    return { cls: 'pf-unknown', label: '离线·未知' }
  }

  // ---- counts cells (shared by the local footprint + each peer) ----------

  function assetsText(s) {
    const a = (s && s.assets) || {}
    return (
      'Agents ' + num(a.agents) +
      ' · 工作流 ' + num(a.workflows) + '(发布 ' + num(a.publishedWorkflows) + ')' +
      ' · Peers ' + num(a.peers)
    )
  }
  function runsText(s) {
    const r = (s && s.runs) || {}
    const by = r.byStatus || {}
    const parts = Object.keys(by)
      .sort()
      .map(function (k) { return escHtml(k) + ':' + num(by[k]) })
    const tail = parts.length ? ' <small>(' + parts.join(' ') + ')</small>' : ''
    return '总 ' + num(r.total) + tail
  }
  function llmText(s) {
    const l = (s && s.llm) || {}
    return (
      '调用 ' + num(l.calls) +
      ' · ' + num(l.tokens) + ' tok' +
      ' · ' + fmtCost(l.costMicros)
    )
  }
  function llmWindow(s) {
    const d = num(s && s.llm && s.llm.windowDays)
    return d ? '近 ' + d + ' 天' : 'LLM'
  }
  function healthText(s) {
    return '挂起 ' + num(s && s.health && s.health.suspendedTasks)
  }

  // ---- API --------------------------------------------------------------

  async function readBody(r) {
    let json = null
    try {
      json = await r.json()
    } catch (_) { /* */ }
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || ('http ' + r.status)
      const err = new Error(msg)
      err.status = r.status
      throw err
    }
    return json || {}
  }

  async function apiList() {
    return readBody(await fetch(LIST_API))
  }

  // peerId undefined → refresh every connected peer; a string → just that one.
  async function apiRefresh(peerId) {
    const body = peerId ? { peerId } : {}
    return readBody(
      await fetch(REFRESH_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  // ---- render -----------------------------------------------------------

  function buildUi(root) {
    root.innerHTML =
      '<header class="pf-header">' +
      '  <h2>控制面(cross-hub 摘要聚合)</h2>' +
      '  <p class="pf-meta">本 hub 的隐私安全 footprint,加上每个已连接 peer <strong>自愿共享</strong>的摘要' +
      '(<code>peer.summary</code> RPC)。<strong>只有计数</strong> —— 资产 / 运行 / 近窗 LLM 用量 / 挂起任务,' +
      '绝不含原始记录。peer 必须在其 per-link 策略里勾选「向该对端共享摘要」才会出数字;否则只显示原因。' +
      '控制面只<strong>观察</strong>,不接管 —— 每个 hub 自主决定披露什么。</p>' +
      '  <button id="ps-refresh-all" type="button">刷新全部</button>' +
      '  <span id="ps-status" class="pf-status"></span>' +
      '</header>' +
      '<section class="pf-list-wrap">' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>Hub</th><th>状态</th><th>资产</th><th>运行</th><th id="ps-llm-head">LLM</th><th>健康</th><th>最近刷新</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-rows"><tr><td colspan="8" class="pf-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#ps-refresh-all', root).addEventListener('click', function () {
      doRefresh(root, undefined).catch(function () { /* setStatus handled it */ })
    })
  }

  function dataCells(s) {
    return (
      '<td class="pf-caps">' + assetsText(s) + '</td>' +
      '<td class="pf-caps">' + runsText(s) + '</td>' +
      '<td class="pf-caps">' + llmText(s) + '</td>' +
      '<td class="pf-caps">' + healthText(s) + '</td>'
    )
  }

  function renderRows(root, data) {
    const tbody = $('#ps-rows', root)
    if (!tbody) return
    tbody.innerHTML = ''

    // Local footprint pinned first — this hub always knows its own counts.
    const local = data.local || null
    const head = $('#ps-llm-head', root)
    if (head) head.textContent = local ? llmWindow(local) : 'LLM'
    const localRow = document.createElement('tr')
    localRow.className = 'ps-local'
    if (local) {
      localRow.innerHTML =
        '<td class="pf-peer"><strong>本 hub</strong> <code class="pf-id">' + escHtml(local.hubId) + '</code></td>' +
        '<td><span class="pf-badge pf-online">本地</span></td>' +
        dataCells(local) +
        '<td class="pf-time">' + escHtml(fmtTime(local.generatedAt)) + '</td>' +
        '<td></td>'
    } else {
      localRow.innerHTML = '<td colspan="8" class="pf-cap-empty">本地 footprint 不可用</td>'
    }
    tbody.appendChild(localRow)

    const peers = data.peers || []
    if (!peers.length) {
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td colspan="8" class="pf-empty">还没有已配置的 peer。在本页「对端」面板添加 peer,' +
        '并在其策略里勾选「向该对端共享摘要」后,这里会聚合它的计数。</td>'
      tbody.appendChild(tr)
      return
    }

    for (const row of peers) {
      const st = statusOf(row)
      const peerCell = row.label
        ? escHtml(row.label) + ' <code class="pf-id">' + escHtml(row.peer) + '</code>'
        : '<code class="pf-id">' + escHtml(row.peer) + '</code>'
      const tr = document.createElement('tr')
      if (row.summary) {
        tr.innerHTML =
          '<td class="pf-peer">' + peerCell + '</td>' +
          '<td><span class="pf-badge ' + st.cls + '">' + escHtml(st.label) + '</span></td>' +
          dataCells(row.summary) +
          '<td class="pf-time">' + escHtml(fmtTime(row.lastFetchedAt)) + '</td>' +
          '<td><button type="button" class="ps-row-refresh">刷新</button></td>'
      } else {
        // No counts to show — say WHY (not shared / offline) instead of zeros.
        const reason = row.lastError ? escHtml(row.lastError) : '尚未刷新'
        tr.innerHTML =
          '<td class="pf-peer">' + peerCell + '</td>' +
          '<td><span class="pf-badge ' + st.cls + '">' + escHtml(st.label) + '</span></td>' +
          '<td colspan="4" class="pf-cap-empty">' + reason + '</td>' +
          '<td class="pf-time">' + escHtml(fmtTime(row.lastFetchedAt)) + '</td>' +
          '<td><button type="button" class="ps-row-refresh">刷新</button></td>'
      }
      tr.querySelector('.ps-row-refresh').addEventListener('click', function () {
        doRefresh(root, row.peer).catch(function () { /* setStatus handled it */ })
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / refresh ---------------------------------------------------

  async function load(root) {
    setStatus(root, '加载...', 'loading')
    try {
      const data = await apiList()
      renderRows(root, data)
      setStatus(root, '已加载 ' + ((data.peers || []).length) + ' 个 peer', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, {})
        setStatus(root, 'host 未启用 peer 联邦', 'error')
        return
      }
      setStatus(root, '加载失败:' + (err.message || err), 'error')
      throw err
    }
  }

  async function doRefresh(root, peerId) {
    setStatus(root, peerId ? '刷新 ' + peerId + '...' : '刷新全部...', 'loading')
    try {
      const data = await apiRefresh(peerId)
      renderRows(root, data)
      setStatus(root, '已刷新', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, {})
        setStatus(root, 'host 未启用 peer 联邦', 'error')
        return
      }
      setStatus(root, '刷新失败:' + (err.message || err), 'error')
      throw err
    }
  }

  // ---- activation (mirror peer-manifest-ui.js) --------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    const root = document.querySelector('#peer-summary-panel')
    if (!root) return
    buildUi(root)
    new MutationObserver(function () {
      maybeLoad(root).catch(function () { /* setStatus reported it */ })
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    if (isActive()) {
      maybeLoad(root).catch(function () { /* */ })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
