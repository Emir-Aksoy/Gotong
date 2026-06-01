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

  const SUMMARY_API = '/api/admin/identity/usage/summary'
  const LEDGER_EXPORT = '/api/admin/identity/usage/ledger/export'
  const AUDIT_EXPORT = '/api/admin/identity/audit/export'

  const GROUP_OPTIONS = [
    { value: 'user', label: '用户' },
    { value: 'agent', label: '智能体' },
    { value: 'workflow', label: '工作流' },
    { value: 'model', label: '模型' },
    { value: 'day', label: '按天' },
    // Phase 19 P4-M2 — federated-peer dimension. '(none)' bucket = local usage.
    { value: 'peer', label: '联邦对端' },
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
    const opts = GROUP_OPTIONS.map(function (o) {
      return '<option value="' + o.value + '">' + escHtml(o.label) + '</option>'
    }).join('')
    root.innerHTML =
      '<header class="usage-header">' +
      '  <h2>用量 / 成本</h2>' +
      '  <p class="usage-meta">从用量账本(usage ledger)按维度汇总 token 与成本。成本由服务端按模型价目表算好(整数 micro-USD),这里换算成美元显示;未知模型记 token、成本计 0。价目可用 <code>&lt;AIPE_SPACE&gt;/pricing.json</code> 覆盖。</p>' +
      '  <div class="usage-controls">' +
      '    <label>分组 <select id="usage-groupby">' + opts + '</select></label>' +
      '    <button id="usage-refresh" type="button">刷新</button>' +
      '    <span id="usage-status" class="usage-status"></span>' +
      '  </div>' +
      '</header>' +
      '<section class="usage-list-wrap">' +
      '  <table class="usage-table">' +
      '    <thead><tr>' +
      '      <th>维度</th><th>调用数</th><th>输入 token</th><th>输出 token</th><th>成本(USD)</th>' +
      '    </tr></thead>' +
      '    <tbody id="usage-rows"><tr><td colspan="5" class="usage-empty">加载中...</td></tr></tbody>' +
      '    <tfoot id="usage-foot"></tfoot>' +
      '  </table>' +
      '</section>' +
      '<section class="usage-export">' +
      '  <h3>导出</h3>' +
      '  <p class="usage-meta">下载完整账本或审计日志(最多 10000 行)。</p>' +
      '  <div class="usage-export-links">' +
      '    <a class="usage-dl" href="' + LEDGER_EXPORT + '?format=csv" download>账本 CSV</a>' +
      '    <a class="usage-dl" href="' + LEDGER_EXPORT + '?format=jsonl" download>账本 JSONL</a>' +
      '    <a class="usage-dl" href="' + AUDIT_EXPORT + '?format=csv" download>审计 CSV</a>' +
      '    <a class="usage-dl" href="' + AUDIT_EXPORT + '?format=jsonl" download>审计 JSONL</a>' +
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
    setStatus(root, '加载...', 'loading')
    try {
      const out = await fetchSummary(groupBy)
      renderRows(root, out.rows || [])
      setStatus(root, '已加载 ' + (out.rows || []).length + ' 行', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, 'host 未启用用量账本', 'error')
        return
      }
      setStatus(root, '加载失败:' + (err.message || err), 'error')
      throw err
    }
  }

  function renderRows(root, rows) {
    const tbody = $('#usage-rows', root)
    const tfoot = $('#usage-foot', root)
    if (!tbody) return
    if (rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="usage-empty">还没有用量数据。一旦有 LLM 调用产生 token,这里会自动出现。</td></tr>'
      if (tfoot) tfoot.innerHTML = ''
      return
    }
    let totCalls = 0, totIn = 0, totOut = 0, totCost = 0
    tbody.innerHTML = rows.map(function (r) {
      totCalls += r.calls || 0
      totIn += r.inputTokens || 0
      totOut += r.outputTokens || 0
      totCost += r.costMicros || 0
      return (
        '<tr>' +
        '<td class="usage-key">' + escHtml(r.key) + '</td>' +
        '<td>' + fmtInt(r.calls) + '</td>' +
        '<td>' + fmtInt(r.inputTokens) + '</td>' +
        '<td>' + fmtInt(r.outputTokens) + '</td>' +
        '<td class="usage-cost">' + escHtml(fmtUsd(r.costMicros)) + '</td>' +
        '</tr>'
      )
    }).join('')
    if (tfoot) {
      tfoot.innerHTML =
        '<tr class="usage-total">' +
        '<td>合计</td>' +
        '<td>' + fmtInt(totCalls) + '</td>' +
        '<td>' + fmtInt(totIn) + '</td>' +
        '<td>' + fmtInt(totOut) + '</td>' +
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
