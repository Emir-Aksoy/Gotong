/**
 * Phase 18 A-M3 — cross-hub peer capability manifest browse + refresh
 * (tab "联邦" in app.html).
 *
 * Self-contained module; same activation pattern as reputation-ui.js.
 * Owner-only tab. Shows what each connected peer advertises over the
 * authenticated mesh link (the `peer.manifest` rpc, A-M1) and lets the
 * owner force an on-demand refresh — the whole mesh or one peer.
 *
 * The host caches manifests in-process (A-M2), not on disk: before the
 * first refresh a peer reads "未知" rather than a stale boot snapshot,
 * which is the honest state. Three states surface per row:
 *   - online        connected now (caps fresh, or "未刷新" if never fetched)
 *   - stale         cached caps but the peer is offline right now
 *   - unknown       offline and never fetched
 *
 * Read + refresh only — no edit surface. A peer's advertised caps are
 * its own to declare; the local trust contract that decides what we
 * ACCEPT from it is the B-track policy editor, a separate concern.
 *
 * ~150 LOC; auditable in one pass.
 */
;(function () {
  'use strict'

  const LIST_API = '/api/admin/peer-manifests'
  const REFRESH_API = '/api/admin/peer-manifests/refresh'

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

  function setStatus(root, msg, kind) {
    const el = $('#pf-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'pf-status' + (kind ? ' pf-status-' + kind : '')
  }

  // Map a row to its status chip. lastFetchedAt==null on an online peer
  // means "connected but never refreshed" — caps are still empty until
  // the owner pulls them, so we say so rather than imply we know them.
  function statusOf(row) {
    if (row.online) {
      return row.lastFetchedAt == null
        ? { cls: 'pf-online', label: '在线·未刷新' }
        : { cls: 'pf-online', label: '在线' }
    }
    if (row.stale) return { cls: 'pf-stale', label: '离线·缓存' }
    return { cls: 'pf-unknown', label: '离线·未知' }
  }

  // ---- API --------------------------------------------------------------

  async function readPeers(r) {
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
    return (json && json.peers) || []
  }

  async function apiList() {
    return readPeers(await fetch(LIST_API))
  }

  // peerId undefined → refresh the whole mesh; a string → just that peer.
  async function apiRefresh(peerId) {
    const body = peerId ? { peerId } : {}
    return readPeers(
      await fetch(REFRESH_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  // Phase 19 P4-M3 — a capability is now a rich descriptor {id, version?,
  // costHint?, dataClasses?, …}. Render the id chip + any present metadata as
  // small inline text. Tolerate a bare string in case an older peer sneaks one
  // past the host's normaliser.
  function renderCap(c) {
    if (typeof c === 'string') c = { id: c }
    if (!c || typeof c.id !== 'string') return ''
    const bits = []
    if (c.version) bits.push('v' + c.version)
    if (c.costHint) bits.push('成本:' + c.costHint)
    if (Array.isArray(c.dataClasses) && c.dataClasses.length) {
      bits.push('数据:' + c.dataClasses.join('/'))
    }
    const meta = bits.length
      ? ' <small class="pf-cap-meta">' + escHtml(bits.join(' · ')) + '</small>'
      : ''
    return '<span class="pf-cap">' + escHtml(c.id) + meta + '</span>'
  }

  // ---- render -----------------------------------------------------------

  function buildUi(root) {
    root.innerHTML =
      '<header class="pf-header">' +
      '  <h2>Peer 能力清单(federation manifest)</h2>' +
      '  <p class="pf-meta">每个已连接 peer 通过认证 mesh 链路广播的能力(<code>peer.manifest</code> RPC)。' +
      '清单缓存在内存里 —— 刷新前显示<strong>未知</strong>而不是陈旧快照。本面板只读;' +
      '决定「接受 peer 什么」的入站信任契约在别处(policy 编辑器)。</p>' +
      '  <button id="pf-refresh-all" type="button">刷新全部</button>' +
      '  <span id="pf-status" class="pf-status"></span>' +
      '</header>' +
      '<section class="pf-list-wrap">' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>Peer</th><th>状态</th><th>能力</th><th>最近刷新</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody id="pf-rows"><tr><td colspan="5" class="pf-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#pf-refresh-all', root).addEventListener('click', function () {
      doRefresh(root, undefined).catch(function () { /* setStatus handled it */ })
    })
  }

  function renderRows(root, peers) {
    const tbody = $('#pf-rows', root)
    if (!tbody) return
    if (!peers.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="pf-empty">还没有已配置的 peer。' +
        '在本页上方「对端」面板添加一个 peer 后,这里会列出它广播的能力。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const row of peers) {
      const st = statusOf(row)
      const peerCell = row.label
        ? escHtml(row.label) + ' <code class="pf-id">' + escHtml(row.peer) + '</code>'
        : '<code class="pf-id">' + escHtml(row.peer) + '</code>'
      const caps = row.capabilities || []
      const capCell = caps.length
        ? caps.map(renderCap).join('')
        : '<span class="pf-cap-empty">未知(点刷新)</span>'
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td class="pf-peer">' + peerCell + '</td>' +
        '<td><span class="pf-badge ' + st.cls + '">' + escHtml(st.label) + '</span></td>' +
        '<td class="pf-caps">' + capCell + '</td>' +
        '<td class="pf-time">' + escHtml(fmtTime(row.lastFetchedAt)) + '</td>' +
        '<td><button type="button" class="pf-row-refresh">刷新</button></td>'
      tr.querySelector('.pf-row-refresh').addEventListener('click', function () {
        doRefresh(root, row.peer).catch(function () { /* setStatus handled it */ })
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / refresh ---------------------------------------------------

  async function load(root) {
    setStatus(root, '加载...', 'loading')
    try {
      const peers = await apiList()
      renderRows(root, peers)
      setStatus(root, '已加载 ' + peers.length + ' 个 peer', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
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
      const peers = await apiRefresh(peerId)
      renderRows(root, peers)
      setStatus(root, '已刷新', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, 'host 未启用 peer 联邦', 'error')
        return
      }
      setStatus(root, '刷新失败:' + (err.message || err), 'error')
      throw err
    }
  }

  // ---- activation (mirror reputation-ui.js) -----------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    // Target our own panel by id, not the generic section[data-tab="federation"]
    // first-match — the federation tab now also hosts the peer-admin panel
    // (Route B P1-M7b), and a bare data-tab selector would grab whichever
    // comes first in the DOM.
    const root = document.querySelector('#peer-federation-panel')
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
