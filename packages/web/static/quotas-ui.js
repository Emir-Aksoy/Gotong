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
    root.innerHTML =
      '<header class="q-header">' +
      '  <h2>组织配额(软上限)</h2>' +
      '  <p class="q-meta">阈值跨越时会写入审计日志(<code>org_quota_warn</code> / <code>org_quota_over</code> / <code>org_quota_recover</code>)。配额为软限,不阻断 LLM 调用;真正硬阻断由 per-user 配额负责。</p>' +
      '  <button id="q-refresh" type="button">刷新</button>' +
      '  <span id="q-status" class="q-status"></span>' +
      '</header>' +
      '<section class="q-list-wrap">' +
      '  <table class="q-table">' +
      '    <thead><tr>' +
      '      <th>Metric</th><th>Period</th><th>用量 / 配额</th><th>%</th><th>State</th><th>warnPct</th><th>last sweep</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody id="q-rows"><tr><td colspan="8" class="q-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      '<section class="q-form-wrap">' +
      '  <h3>新增 / 修改配额</h3>' +
      '  <p class="q-meta">同 (metric, period) 再次提交即覆盖既有值;不重置已累计的用量。</p>' +
      '  <div class="q-form">' +
      '    <label>metric<input id="q-form-metric" placeholder="llm_requests" maxlength="64"></label>' +
      '    <label>period<select id="q-form-period">' +
      PERIODS.map(function (p) { return '<option value="' + p + '">' + p + '</option>' }).join('') +
      '    </select></label>' +
      '    <label>quota<input id="q-form-quota" type="number" min="0" step="1" placeholder="1000"></label>' +
      '    <label>warnPct<input id="q-form-warn" type="number" min="1" max="99" step="1" placeholder="80"></label>' +
      '    <button id="q-form-save" type="button" class="q-primary">保存</button>' +
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
    setStatus(root, '加载...', 'loading')
    try {
      const out = await api('GET', '')
      renderRows(root, out.quotas || [])
      setStatus(root, '已加载 ' + (out.quotas?.length ?? 0) + ' 条', 'ok')
    } catch (err) {
      setStatus(root, '加载失败:' + err.message, 'error')
      throw err
    }
  }

  function renderRows(root, quotas) {
    const tbody = $('#q-rows', root)
    if (!tbody) return
    if (quotas.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="q-empty">还没有配额。在下方表单新增。</td></tr>'
      return
    }
    tbody.innerHTML = quotas.map(function (q) {
      // Progress bar: pct clamped to 100 for the bar width; the actual
      // number can be >100 (showing how over the cap usage is).
      const barPct = Math.min(100, q.pct)
      const stateLabel = q.state
      const sweepBehind = q.state !== q.lastState
      const sweepTip = sweepBehind
        ? 'host sweep 还没跑到这个状态(实时:' + q.state + ' / 上次扫描:' + q.lastState + ');审计日志要等下次 sweep 才补上'
        : ''
      const denomCell = q.quota === 0 ? '0 (禁用)' : String(q.quota)
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
        (sweepBehind ? ' <span class="q-state-stale" title="' + escHtml(sweepTip) + '">⚠ sweep stale</span>' : '') +
        '</td>' +
        '<td>' + q.warnPct + '%</td>' +
        '<td class="q-time">' + escHtml(fmtTime(q.lastChecked)) + '</td>' +
        '<td>' +
        '  <button type="button" data-act="edit" data-m="' + m + '" data-p="' + p + '">编辑</button>' +
        '  <button type="button" data-act="del" data-m="' + m + '" data-p="' + p + '">删除</button>' +
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
          if (!confirm('删除 ' + metric + ' / ' + period + ' 的配额?')) return
          api('DELETE', '/' + encodeURIComponent(metric) + '/' + period)
            .then(function () {
              setStatus(root, '已删除', 'ok')
              return refresh(root)
            })
            .catch(function (err) {
              setStatus(root, '删除失败:' + err.message, 'error')
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
      setStatus(root, 'metric 必填', 'error')
      return
    }
    const quota = Number(quotaStr)
    if (!Number.isFinite(quota) || !Number.isInteger(quota) || quota < 0) {
      setStatus(root, 'quota 必须是非负整数', 'error')
      return
    }
    const body = { metric: metric, period: period, quota: quota }
    if (warnStr) {
      const warn = Number(warnStr)
      if (!Number.isFinite(warn) || !Number.isInteger(warn) || warn < 1 || warn > 99) {
        setStatus(root, 'warnPct 必须是 1~99 的整数', 'error')
        return
      }
      body.warnPct = warn
    }
    try {
      await api('POST', '', body)
      setStatus(root, '已保存', 'ok')
      await refresh(root)
    } catch (err) {
      setStatus(root, '保存失败:' + err.message, 'error')
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
