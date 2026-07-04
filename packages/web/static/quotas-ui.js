/**
 * C2 — Org soft-quota management UI (tab "配额" in app.html).
 *
 * Self-contained, same pattern as identity-ui.js. Owner-only tab; the
 * server's owner gate is the actual authority (this file's hide/show
 * is just UX hygiene).
 *
 * What this UI does:
 *   - List configured (metric, period) quotas with current usage
 *     and a per-row progress bar (0–100% green; warnPct–100 amber;
 *     ≥100% red). Each row shows the live derived state (computed
 *     in the GET handler from sumUsage) plus the lastState snapshot
 *     from the most recent host orgQuotaSweep — when they diverge,
 *     a tooltip surfaces that the sweep is overdue.
 *   - Add / edit (upsert) a quota with optional warnPct override.
 *   - Delete a quota (no typed confirmation — admins re-set quickly
 *     by upsert if needed; cap removal isn't blast-radius).
 *
 * Sparkline was originally on the wishlist but skipped: we don't
 * persist historical usage values (B2.3 sweep just rolls them) so a
 * sparkline would require a NEW time-series table. Deferred to a
 * future task if anyone asks; meanwhile the progress bar + state
 * badge cover the operational signal.
 *
 * ~250 LOC; auditable in one pass.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time. `t()` returns
  // the current-language dict; render/handler functions read t().<key> at call
  // time, and we re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const API = '/api/admin/identity/org-quotas'
  const PERIODS = ['hourly', 'daily', 'monthly', 'total']

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
    if (ms == null) return '—'
    try {
      return new Date(ms).toLocaleString()
    } catch (_) {
      return String(ms)
    }
  }

  function setStatus(root, msg, kind) {
    const el = $('#q-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'q-status' + (kind ? ' q-status-' + kind : '')
  }

  async function api(method, path, body) {
    const init = { method: method, headers: { 'content-type': 'application/json' } }
    if (body) init.body = JSON.stringify(body)
    const r = await fetch(API + path, init)
    let json = null
    try {
      json = await r.json()
    } catch (_) { /* */ }
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || ('http ' + r.status)
      throw new Error(msg)
    }
    return json
  }

  // ---- rendering --------------------------------------------------------

  function buildUi(root) {
    const d = t()
    root.innerHTML =
      '<header class="q-header">' +
      '  <h2>' + escHtml(d.qtaTitle) + '</h2>' +
      '  <p class="q-meta">' + d.qtaIntro + '</p>' +
      '  <button id="q-refresh" type="button">' + escHtml(d.qtaRefreshBtn) + '</button>' +
      '  <span id="q-status" class="q-status"></span>' +
      '</header>' +
      '<section class="q-list-wrap">' +
      '  <table class="q-table">' +
      '    <thead><tr>' +
      '      <th>' + escHtml(d.qtaColMetric) + '</th><th>' + escHtml(d.qtaColPeriod) + '</th><th>' + escHtml(d.qtaColUsageQuota) + '</th><th>' + escHtml(d.qtaColPct) + '</th><th>' + escHtml(d.qtaColState) + '</th><th>' + escHtml(d.qtaColWarnPct) + '</th><th>' + escHtml(d.qtaColLastSweep) + '</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody id="q-rows"><tr><td colspan="8" class="q-empty">' + escHtml(d.qtaLoadingCell) + '</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      '<section class="q-form-wrap">' +
      '  <h3>' + escHtml(d.qtaFormTitle) + '</h3>' +
      '  <p class="q-meta">' + escHtml(d.qtaFormHint) + '</p>' +
      '  <div class="q-form">' +
      '    <label>metric<input id="q-form-metric" placeholder="llm_requests" maxlength="64"></label>' +
      '    <label>period<select id="q-form-period">' +
      PERIODS.map(function (p) { return '<option value="' + p + '">' + p + '</option>' }).join('') +
      '    </select></label>' +
      '    <label>quota<input id="q-form-quota" type="number" min="0" step="1" placeholder="1000"></label>' +
      '    <label>warnPct<input id="q-form-warn" type="number" min="1" max="99" step="1" placeholder="80"></label>' +
      '    <button id="q-form-save" type="button" class="q-primary">' + escHtml(d.qtaSaveBtn) + '</button>' +
      '  </div>' +
      '</section>'

    $('#q-refresh', root).addEventListener('click', function () {
      refresh(root).catch(function () { /* setStatus handled it */ })
    })
    $('#q-form-save', root).addEventListener('click', function () {
      submitForm(root).catch(function () { /* setStatus handled it */ })
    })
  }

  async function refresh(root) {
    setStatus(root, t().qtaLoading, 'loading')
    try {
      const out = await api('GET', '')
      renderRows(root, out.quotas || [])
      setStatus(root, t().qtaLoadedN(out.quotas?.length ?? 0), 'ok')
    } catch (err) {
      setStatus(root, t().qtaLoadFailed(err.message), 'error')
      throw err
    }
  }

  function renderRows(root, quotas) {
    const d = t()
    const tbody = $('#q-rows', root)
    if (!tbody) return
    if (quotas.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="q-empty">' + escHtml(d.qtaEmpty) + '</td></tr>'
      return
    }
    tbody.innerHTML = quotas.map(function (q) {
      // Progress bar: pct clamped to 100 for the bar width; the actual
      // number can be >100 (showing how over the cap usage is).
      const barPct = Math.min(100, q.pct)
      const stateLabel = q.state
      const sweepBehind = q.state !== q.lastState
      const sweepTip = sweepBehind
        ? d.qtaSweepTip(q.state, q.lastState)
        : ''
      const denomCell = q.quota === 0 ? d.qtaDisabledDenom : String(q.quota)
      const m = encodeURIComponent(q.metric)
      const p = encodeURIComponent(q.period)
      return (
        '<tr data-metric="' + escHtml(q.metric) + '" data-period="' + q.period + '">' +
        '<td><code>' + escHtml(q.metric) + '</code></td>' +
        '<td>' + escHtml(q.period) + '</td>' +
        '<td>' + escHtml(String(q.usage)) + ' / ' + escHtml(denomCell) + '</td>' +
        '<td>' +
        '  <div class="q-bar q-bar-' + stateLabel + (sweepBehind ? ' q-bar-stale' : '') + '" title="' + escHtml(sweepTip) + '">' +
        '    <div class="q-bar-fill" style="width:' + barPct + '%"></div>' +
        '    <span class="q-bar-label">' + q.pct + '%</span>' +
        '  </div>' +
        '</td>' +
        '<td><span class="q-state q-state-' + stateLabel + '">' + escHtml(stateLabel) + '</span>' +
        (sweepBehind ? ' <span class="q-state-stale" title="' + escHtml(sweepTip) + '">' + escHtml(d.qtaSweepStale) + '</span>' : '') +
        '</td>' +
        '<td>' + q.warnPct + '%</td>' +
        '<td class="q-time">' + escHtml(fmtTime(q.lastChecked)) + '</td>' +
        '<td>' +
        '  <button type="button" data-act="edit" data-m="' + m + '" data-p="' + p + '">' + escHtml(d.qtaEditBtn) + '</button>' +
        '  <button type="button" data-act="del" data-m="' + m + '" data-p="' + p + '">' + escHtml(d.qtaDelBtn) + '</button>' +
        '</td>' +
        '</tr>'
      )
    }).join('')

    // Wire row actions (delegation would be tidier but row counts are
    // tiny — manual binding is clearer to read).
    Array.from(tbody.querySelectorAll('button[data-act]')).forEach(function (btn) {
      const act = btn.getAttribute('data-act')
      const metric = decodeURIComponent(btn.getAttribute('data-m'))
      const period = btn.getAttribute('data-p')
      if (act === 'edit') {
        btn.addEventListener('click', function () {
          const row = quotas.find(function (q) {
            return q.metric === metric && q.period === period
          })
          if (!row) return
          $('#q-form-metric', root).value = row.metric
          $('#q-form-period', root).value = row.period
          $('#q-form-quota', root).value = String(row.quota)
          $('#q-form-warn', root).value = String(row.warnPct)
          $('#q-form-save', root).scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      } else if (act === 'del') {
        btn.addEventListener('click', function () {
          if (!confirm(t().qtaConfirmDelete(metric, period))) return
          api('DELETE', '/' + encodeURIComponent(metric) + '/' + period)
            .then(function () {
              setStatus(root, t().qtaDeleted, 'ok')
              return refresh(root)
            })
            .catch(function (err) {
              setStatus(root, t().qtaDeleteFailed(err.message), 'error')
            })
        })
      }
    })
  }

  async function submitForm(root) {
    const metric = $('#q-form-metric', root).value.trim()
    const period = $('#q-form-period', root).value
    const quotaStr = $('#q-form-quota', root).value
    const warnStr = $('#q-form-warn', root).value
    if (!metric) {
      setStatus(root, t().qtaMetricRequired, 'error')
      return
    }
    const quota = Number(quotaStr)
    if (!Number.isFinite(quota) || !Number.isInteger(quota) || quota < 0) {
      setStatus(root, t().qtaQuotaInvalid, 'error')
      return
    }
    const body = { metric: metric, period: period, quota: quota }
    if (warnStr) {
      const warn = Number(warnStr)
      if (!Number.isFinite(warn) || !Number.isInteger(warn) || warn < 1 || warn > 99) {
        setStatus(root, t().qtaWarnPctInvalid, 'error')
        return
      }
      body.warnPct = warn
    }
    try {
      await api('POST', '', body)
      setStatus(root, t().qtaSaved, 'ok')
      await refresh(root)
    } catch (err) {
      setStatus(root, t().qtaSaveFailed(err.message), 'error')
    }
  }

  // ---- activation -------------------------------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'quotas'
  }

  function maybeRefresh(root) {
    if (!isActive()) return Promise.resolve()
    return refresh(root)
  }

  function init() {
    const root = document.querySelector('section[data-tab="quotas"]')
    if (!root) return
    buildUi(root)
    new MutationObserver(function () {
      maybeRefresh(root).catch(function () { /* setStatus reported it */ })
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    // Re-render on language switch — relabel the static shell while preserving
    // any in-progress form input, then reload the rows when the tab is showing
    // so the empty/state labels and sweep tips pick up the new dict too.
    AH.onLangChange(function () {
      const keep = {
        metric: ($('#q-form-metric', root) || {}).value || '',
        period: ($('#q-form-period', root) || {}).value || '',
        quota: ($('#q-form-quota', root) || {}).value || '',
        warn: ($('#q-form-warn', root) || {}).value || '',
      }
      buildUi(root)
      const setVal = function (sel, v) { const el = $(sel, root); if (el) el.value = v }
      setVal('#q-form-metric', keep.metric)
      if (keep.period) setVal('#q-form-period', keep.period)
      setVal('#q-form-quota', keep.quota)
      setVal('#q-form-warn', keep.warn)
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
