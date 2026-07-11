/**
 * Phase 17 (Sprint 4) — usage / cost dashboard (tab "用量" in app.html).
 *
 * Self-contained module; same activation pattern as reputation-ui.js /
 * quotas-ui.js. Owner-only. Reads the usage-ledger summary
 * (GET /api/admin/identity/usage/summary?groupBy=…) and renders a cost
 * roll-up table; offers CSV / JSONL export of the ledger + audit log via
 * plain download anchors (same-origin cookie auth, owner-gated server-side).
 *
 * Purely observational — there's no edit surface. Cost is shown in USD
 * derived from the integer micro-USD the server reports.
 *
 * ~150 LOC; auditable in one pass.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time (app-core.js runs
  // synchronously before this panel is injected, so Gotong is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const SUMMARY_API = '/api/admin/identity/usage/summary'
  const LEDGER_EXPORT = '/api/admin/identity/usage/ledger/export'
  const AUDIT_EXPORT = '/api/admin/identity/audit/export'

  // Dimension options — `labelKey` resolves against the live dict at build time
  // so the selector relabels on language switch.
  const GROUP_OPTIONS = [
    { value: 'user', labelKey: 'usgGroupUser' },
    { value: 'agent', labelKey: 'usgGroupAgent' },
    { value: 'workflow', labelKey: 'usgGroupWorkflow' },
    { value: 'model', labelKey: 'usgGroupModel' },
    { value: 'day', labelKey: 'usgGroupDay' },
    // Phase 19 P4-M2 — federated-peer dimension. '(none)' bucket = local usage.
    { value: 'peer', labelKey: 'usgGroupPeer' },
  ]

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // Integer micro-USD → "$0.0000". 1e6 micros == $1.
  function fmtUsd(micros) {
    var n = Number.isFinite(micros) ? micros : 0
    return '$' + (n / 1e6).toFixed(4)
  }
  function fmtInt(n) {
    return Number.isFinite(n) ? String(n) : '0'
  }
  // NA-M4 — 缓存命中率:cacheRead / 提示词全量。NA-M1b 之后 inputTokens
  // 只计「新鲜段」,所以模型实际看到的提示词 = input + cacheCreation +
  // cacheRead 三段互斥之和;没有提示词流量时显示 '—' 而非 0%。
  function fmtHitRate(r) {
    var read = r.cacheReadTokens || 0
    var total = (r.inputTokens || 0) + (r.cacheCreationTokens || 0) + read
    if (total <= 0) return '—'
    return ((read / total) * 100).toFixed(1) + '%'
  }

  function setStatus(root, msg, kind) {
    const el = $('#usage-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'usage-status' + (kind ? ' usage-status-' + kind : '')
  }

  function currentGroupBy(root) {
    const sel = $('#usage-groupby', root)
    return (sel && sel.value) || 'user'
  }

  async function fetchSummary(groupBy) {
    const r = await fetch(SUMMARY_API + '?groupBy=' + encodeURIComponent(groupBy))
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

  function buildUi(root) {
    const d = t()
    const opts = GROUP_OPTIONS.map(function (o) {
      return '<option value="' + o.value + '">' + escHtml(d[o.labelKey]) + '</option>'
    }).join('')
    root.innerHTML =
      '<header class="usage-header">' +
      '  <h2>' + escHtml(d.usgTitle) + '</h2>' +
      '  <p class="usage-meta">' + d.usgIntro + '</p>' +
      '  <div class="usage-controls">' +
      '    <label>' + escHtml(d.usgGroupByLabel) + ' <select id="usage-groupby">' + opts + '</select></label>' +
      '    <button id="usage-refresh" type="button">' + escHtml(d.usgRefreshBtn) + '</button>' +
      '    <span id="usage-status" class="usage-status"></span>' +
      '  </div>' +
      '</header>' +
      '<section class="usage-list-wrap">' +
      '  <table class="usage-table">' +
      '    <thead><tr>' +
      '      <th>' + escHtml(d.usgColDimension) + '</th><th>' + escHtml(d.usgColCalls) + '</th><th>' + escHtml(d.usgColInputTokens) + '</th><th>' + escHtml(d.usgColOutputTokens) + '</th><th>' + escHtml(d.usgColCacheRead) + '</th><th>' + escHtml(d.usgColCacheHit) + '</th><th>' + escHtml(d.usgColCostUsd) + '</th>' +
      '    </tr></thead>' +
      '    <tbody id="usage-rows"><tr><td colspan="7" class="usage-empty">' + escHtml(d.usgLoadingCell) + '</td></tr></tbody>' +
      '    <tfoot id="usage-foot"></tfoot>' +
      '  </table>' +
      '</section>' +
      '<section class="usage-export">' +
      '  <h3>' + escHtml(d.usgExportTitle) + '</h3>' +
      '  <p class="usage-meta">' + escHtml(d.usgExportHint) + '</p>' +
      '  <div class="usage-export-links">' +
      '    <a class="usage-dl" href="' + LEDGER_EXPORT + '?format=csv" download>' + escHtml(d.usgDlLedgerCsv) + '</a>' +
      '    <a class="usage-dl" href="' + LEDGER_EXPORT + '?format=jsonl" download>' + escHtml(d.usgDlLedgerJsonl) + '</a>' +
      '    <a class="usage-dl" href="' + AUDIT_EXPORT + '?format=csv" download>' + escHtml(d.usgDlAuditCsv) + '</a>' +
      '    <a class="usage-dl" href="' + AUDIT_EXPORT + '?format=jsonl" download>' + escHtml(d.usgDlAuditJsonl) + '</a>' +
      '  </div>' +
      '</section>'

    $('#usage-refresh', root).addEventListener('click', function () {
      refresh(root).catch(function () { /* setStatus handled it */ })
    })
    $('#usage-groupby', root).addEventListener('change', function () {
      refresh(root).catch(function () { /* */ })
    })
  }

  async function refresh(root) {
    const groupBy = currentGroupBy(root)
    setStatus(root, t().usgLoading, 'loading')
    try {
      const out = await fetchSummary(groupBy)
      renderRows(root, out.rows || [])
      setStatus(root, t().usgLoadedN((out.rows || []).length), 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, t().usgHostDisabled, 'error')
        return
      }
      setStatus(root, t().usgLoadFailed(err.message || err), 'error')
      throw err
    }
  }

  function renderRows(root, rows) {
    const tbody = $('#usage-rows', root)
    const tfoot = $('#usage-foot', root)
    if (!tbody) return
    if (rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="usage-empty">' + escHtml(t().usgEmpty) + '</td></tr>'
      if (tfoot) tfoot.innerHTML = ''
      return
    }
    let totCalls = 0, totIn = 0, totOut = 0, totCost = 0, totCacheRead = 0, totCacheWrite = 0
    tbody.innerHTML = rows.map(function (r) {
      totCalls += r.calls || 0
      totIn += r.inputTokens || 0
      totOut += r.outputTokens || 0
      totCacheRead += r.cacheReadTokens || 0
      totCacheWrite += r.cacheCreationTokens || 0
      totCost += r.costMicros || 0
      return (
        '<tr>' +
        '<td class="usage-key">' + escHtml(r.key) + '</td>' +
        '<td>' + fmtInt(r.calls) + '</td>' +
        '<td>' + fmtInt(r.inputTokens) + '</td>' +
        '<td>' + fmtInt(r.outputTokens) + '</td>' +
        '<td>' + fmtInt(r.cacheReadTokens) + '</td>' +
        '<td>' + escHtml(fmtHitRate(r)) + '</td>' +
        '<td class="usage-cost">' + escHtml(fmtUsd(r.costMicros)) + '</td>' +
        '</tr>'
      )
    }).join('')
    if (tfoot) {
      // 合计行的命中率从合计数算(而非各行平均),口径与逐行一致。
      tfoot.innerHTML =
        '<tr class="usage-total">' +
        '<td>' + escHtml(t().usgTotal) + '</td>' +
        '<td>' + fmtInt(totCalls) + '</td>' +
        '<td>' + fmtInt(totIn) + '</td>' +
        '<td>' + fmtInt(totOut) + '</td>' +
        '<td>' + fmtInt(totCacheRead) + '</td>' +
        '<td>' + escHtml(fmtHitRate({ inputTokens: totIn, cacheCreationTokens: totCacheWrite, cacheReadTokens: totCacheRead })) + '</td>' +
        '<td class="usage-cost">' + escHtml(fmtUsd(totCost)) + '</td>' +
        '</tr>'
    }
  }

  // ---- activation -------------------------------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'usage'
  }

  function maybeRefresh(root) {
    if (!isActive()) return Promise.resolve()
    return refresh(root)
  }

  function init() {
    const root = document.querySelector('section[data-tab="usage"]')
    if (!root) return
    buildUi(root)
    new MutationObserver(function () {
      maybeRefresh(root).catch(function () { /* setStatus reported it */ })
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    // Re-render on language switch — relabel the static shell (keeping the
    // chosen dimension), then reload the rows when the tab is showing so the
    // total/empty labels and dimension keys pick up the new dict too.
    AH.onLangChange(function () {
      const keep = currentGroupBy(root)
      buildUi(root)
      const sel = $('#usage-groupby', root)
      if (sel) sel.value = keep
      if (isActive()) refresh(root).catch(function () { /* setStatus reported it */ })
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
