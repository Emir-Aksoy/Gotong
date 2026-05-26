/**
 * Phase 6 #1 — Peer reputation read-only dashboard (tab "信誉" in app.html).
 *
 * Self-contained module; same activation pattern as quotas-ui.js. Owner-only
 * tab. Reputation is derived from feedback ledger (see M5b) and applied as
 * routing preference by DefaultScheduler — this UI is purely observational,
 * there's no edit/reset surface here (resetting reputation would corrupt
 * the historical EWMA; the right way to "punish a bad peer" is to write
 * negative feedback, not to nuke its score).
 *
 * Rows sorted server-side: score desc, then sampleCount desc, then peerHubId.
 * Empty state shows a hint that scores only appear after feedback flows in.
 *
 * ~150 LOC; auditable in one pass.
 */
;(function () {
  'use strict'

  const API = '/api/admin/identity/reputation'

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
    const el = $('#rep-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'rep-status' + (kind ? ' rep-status-' + kind : '')
  }

  async function fetchSnapshot() {
    const r = await fetch(API)
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
    return json
  }

  // Score range is [-1, +1]. We render a centered bar:
  //   - negative scores fill from center leftward (red)
  //   - positive scores fill from center rightward (green)
  //   - exactly zero shows a thin neutral marker
  // Width is |score| * 50% of the bar (since center = 50%).
  function scoreClass(score) {
    if (!Number.isFinite(score)) return 'rep-bar-neutral'
    if (score > 0.05) return 'rep-bar-pos'
    if (score < -0.05) return 'rep-bar-neg'
    return 'rep-bar-neutral'
  }

  // Audit #150 — defensive: snapshot rows occasionally show up with
  // undefined / NaN score (sampleCount=0 division corner cases, or
  // a stale snapshot from a peer that never reported). Don't let
  // those crash the row render (`.toFixed` on undefined throws) or
  // produce a broken CSS width (`NaN%`).
  function safeScore(raw) {
    return Number.isFinite(raw) ? raw : null
  }
  function fmtScore(raw) {
    return raw === null ? '—' : raw.toFixed(3)
  }

  function buildUi(root) {
    root.innerHTML =
      '<header class="rep-header">' +
      '  <h2>Peer 信誉(reputation)</h2>' +
      '  <p class="rep-meta">EWMA(α=0.7)的滑动平均,从 hub.feedback ledger 派生。范围 <code>[-1, +1]</code>;调度器按分数降序排候选 peer(详见 <code>docs/zh/REPUTATION-ROUTING.md</code>)。本面板只读 — 想压低评分请写负反馈,不要手动重置。</p>' +
      '  <button id="rep-refresh" type="button">刷新</button>' +
      '  <span id="rep-status" class="rep-status"></span>' +
      '</header>' +
      '<section class="rep-list-wrap">' +
      '  <table class="rep-table">' +
      '    <thead><tr>' +
      '      <th>Peer</th><th>Score</th><th>样本数</th><th>最近更新</th>' +
      '    </tr></thead>' +
      '    <tbody id="rep-rows"><tr><td colspan="4" class="rep-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#rep-refresh', root).addEventListener('click', function () {
      refresh(root).catch(function () { /* setStatus handled it */ })
    })
  }

  async function refresh(root) {
    setStatus(root, '加载...', 'loading')
    try {
      const out = await fetchSnapshot()
      renderRows(root, out.reputation || [])
      const n = (out.reputation || []).length
      setStatus(root, '已加载 ' + n + ' 个 peer', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, 'host 未启用 reputation snapshot', 'error')
        return
      }
      setStatus(root, '加载失败:' + (err.message || err), 'error')
      throw err
    }
  }

  function renderRows(root, items) {
    const tbody = $('#rep-rows', root)
    if (!tbody) return
    if (items.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="rep-empty">还没有反馈数据。' +
        '一旦跨 hub 任务跑过 + feedback ledger 有写入,这里会自动出现。' +
        '</td></tr>'
      return
    }
    tbody.innerHTML = items.map(function (r) {
      const peerCell = r.label
        ? escHtml(r.label) + ' <code class="rep-id">' + escHtml(r.peerHubId) + '</code>'
        : '<code class="rep-id">' + escHtml(r.peerHubId) + '</code>'
      // Audit #150 — guard non-finite score (sampleCount=0 corner case).
      const score = safeScore(r && r.score)
      const scoreFixed = fmtScore(score)
      const barCls = scoreClass(score)
      // half-width of bar fill = |score| * 50%; null score → 0 bar.
      const fillPct = score === null ? 0 : Math.min(50, Math.abs(score) * 50)
      const fillOffset = score !== null && score < 0 ? (50 - fillPct) : 50
      return (
        '<tr>' +
        '<td class="rep-peer">' + peerCell + '</td>' +
        '<td>' +
        '  <div class="rep-bar">' +
        '    <div class="rep-bar-center"></div>' +
        '    <div class="rep-bar-fill ' + barCls + '" style="left:' + fillOffset + '%;width:' + fillPct + '%"></div>' +
        '    <span class="rep-bar-label">' + scoreFixed + '</span>' +
        '  </div>' +
        '</td>' +
        '<td>' + r.sampleCount + '</td>' +
        '<td class="rep-time">' + escHtml(fmtTime(r.lastUpdatedAt)) + '</td>' +
        '</tr>'
      )
    }).join('')
  }

  // ---- activation -------------------------------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'reputation'
  }

  function maybeRefresh(root) {
    if (!isActive()) return Promise.resolve()
    return refresh(root)
  }

  function init() {
    const root = document.querySelector('section[data-tab="reputation"]')
    if (!root) return
    buildUi(root)
    new MutationObserver(function () {
      maybeRefresh(root).catch(function () { /* setStatus reported it */ })
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    if (isActive()) {
      maybeRefresh(root).catch(function () { /* */ })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
