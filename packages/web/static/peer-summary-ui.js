/**
 * v5 Stream E5-M4 + F-M6 — cross-hub control plane ("控制面") browse + refresh +
 * TRENDS + ALERTS (tab "联邦" in app.html, panel #peer-summary-panel).
 *
 * The aggregate view: this hub's own privacy-safe footprint joined with each
 * connected peer's VOLUNTARILY-SHARED summary (the `peer.summary` rpc, E5-M2).
 * Counts only — assets / runs / windowed LLM usage / suspended tasks; NEVER raw
 * rows. A peer only shows numbers if it opted into sharing with us (per-link
 * `shareSummary`, fail-closed); otherwise its row carries an honest reason
 * ("未共享" / 离线) instead of fabricated zeros.
 *
 * Stream F layers day-2 + day-3 features on top, all reading the same counts-only
 * data the live aggregate shows:
 *   - 趋势 (F-M2/M3): a per-source per-metric sparkline read from persisted
 *     snapshots (GET /api/admin/peer-summaries/history). Each "刷新" captures one
 *     data point; the local footprint is always captured, a peer only when its
 *     summary fetch succeeds.
 *   - 告警 (F-M4/M5): threshold rules (CRUD over /peer-summary-alerts/rules)
 *     evaluated LIVE against the current summaries — a breach is a fact about NOW,
 *     recomputed each load.
 *   - 触发历史 + 通知渠道 (day-3): persisted firing lifecycle (edge-triggered:
 *     open once on breach, resolve once on clear) read from /firings, and webhook
 *     channels (CRUD + 测试) over /channels. A channel stores an env-var NAME, not
 *     a secret; proactive delivery rides an opt-in host sweep
 *     (GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS) — until that's set, channels only fire on
 *     the 测试 button. Still counts-only end to end: a delivered payload carries
 *     numbers / ids / threshold, never a name or a row.
 *
 * North-Star honest: a control plane OBSERVES, it never OWNS. We aggregate +
 * trend + alert on what sovereign peers choose to disclose — nothing is pulled
 * without the remote hub's opt-in gate letting it through.
 *
 * Self-contained module; same activation pattern as peer-manifest-ui.js. The
 * metric labels mirror the host registry (peer-summary-metrics.ts) — keep them
 * in sync if the host adds a scalar metric, same convention as the summary-field
 * accessors below.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time (app-core.js runs
  // synchronously before this panel is injected, so Gotong is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const LIST_API = '/api/admin/peer-summaries'
  const REFRESH_API = '/api/admin/peer-summaries/refresh'
  const HISTORY_API = '/api/admin/peer-summaries/history'
  const ALERTS_API = '/api/admin/peer-summary-alerts'
  const RULES_API = '/api/admin/peer-summary-alerts/rules'
  const FIRINGS_API = '/api/admin/peer-summary-alerts/firings'
  const CHANNELS_API = '/api/admin/peer-summary-alerts/channels'

  // JS mirror of the host metric registry (PEER_SUMMARY_METRIC_KEYS). The host
  // is the authority — these are only the labels + the dropdown order; the
  // route validates the metric. Cost is the one metric rendered as µ$.
  // Labels are read from the live i18n dict at call time (psMetric* keys) so the
  // dropdowns + table cells relabel on language switch.
  const METRIC_KEYS = [
    'assets.agents',
    'assets.workflows',
    'assets.publishedWorkflows',
    'assets.peers',
    'runs.total',
    'llm.calls',
    'llm.tokens',
    'llm.costMicros',
    'health.suspendedTasks',
    'alerts.openFirings', // cross-hub-agg M3 — trendable + meta-alertable
  ]
  function metricLabels() {
    return t().psMetricLabels
  }
  const COST_METRIC = 'llm.costMicros'
  const CMP_SYMBOL = { gt: '>', gte: '≥', lt: '<', lte: '≤' }

  // Sources for the trend / rule dropdowns — derived from the last list() load
  // (local first, then each configured peer). Keyed exactly as the host keys
  // snapshots + alert sources: 'local' | peerId (the '*' wildcard is rule-only).
  let sourceList = []

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
  // A metric value formatted per its kind (cost → µ$, everything else integer).
  function fmtMetric(metric, value) {
    return metric === COST_METRIC ? fmtCost(value) : String(num(value))
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
    const d = t()
    if (row.summary) {
      return row.online
        ? { cls: 'pf-online', label: d.psStOnline }
        : { cls: 'pf-stale', label: d.psStOfflineCached }
    }
    if (row.lastError && /not shared/i.test(row.lastError)) {
      return { cls: 'pf-unknown', label: d.psStNotShared }
    }
    if (row.online) return { cls: 'pf-stale', label: d.psStOnlineNoSummary }
    return { cls: 'pf-unknown', label: d.psStOfflineUnknown }
  }

  // A source key → human label (for breaches + rule rows + dropdowns).
  function sourceLabelOf(src) {
    if (src === '*') return t().psSourceAny
    if (src === 'local') return t().psSourceLocal
    const found = sourceList.filter(function (s) { return s.value === src })[0]
    return found ? found.label : src
  }
  function metricLabelOf(metric) {
    return metricLabels()[metric] || metric
  }

  // ---- counts cells (shared by the local footprint + each peer) ----------

  function assetsText(s) {
    const a = (s && s.assets) || {}
    return t().psAssetsText(num(a.agents), num(a.workflows), num(a.publishedWorkflows), num(a.peers))
  }
  function runsText(s) {
    const r = (s && s.runs) || {}
    const by = r.byStatus || {}
    const parts = Object.keys(by)
      .sort()
      .map(function (k) { return escHtml(k) + ':' + num(by[k]) })
    const tail = parts.length ? ' <small>(' + parts.join(' ') + ')</small>' : ''
    return t().psRunsTotal(num(r.total)) + tail
  }
  function llmText(s) {
    const l = (s && s.llm) || {}
    return t().psLlmText(num(l.calls), num(l.tokens), fmtCost(l.costMicros))
  }
  function llmWindow(s) {
    const days = num(s && s.llm && s.llm.windowDays)
    return days ? t().psLlmWindow(days) : 'LLM'
  }
  function healthText(s) {
    // cross-hub-agg M3: per-hub open-firing count rides in the health cell — its
    // own alerting state alongside suspended tasks (both pure scalars).
    return t().psHealthText(
      num(s && s.health && s.health.suspendedTasks),
      num(s && s.alerts && s.alerts.openFirings),
    )
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

  async function apiHistory(source, metric) {
    const url =
      HISTORY_API + '?source=' + encodeURIComponent(source) + '&metric=' + encodeURIComponent(metric)
    return readBody(await fetch(url))
  }
  async function apiAlerts() {
    return readBody(await fetch(ALERTS_API))
  }
  async function apiAddRule(body) {
    return readBody(
      await fetch(RULES_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiPatchRule(id, body) {
    return readBody(
      await fetch(RULES_API + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiDeleteRule(id) {
    return readBody(await fetch(RULES_API + '/' + encodeURIComponent(id), { method: 'DELETE' }))
  }

  // Firing history — newest first, bounded so the panel never pulls unbounded.
  async function apiFirings() {
    return readBody(await fetch(FIRINGS_API + '?limit=50'))
  }
  async function apiChannels() {
    return readBody(await fetch(CHANNELS_API))
  }
  async function apiAddChannel(body) {
    return readBody(
      await fetch(CHANNELS_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiPatchChannel(id, body) {
    return readBody(
      await fetch(CHANNELS_API + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiDeleteChannel(id) {
    return readBody(await fetch(CHANNELS_API + '/' + encodeURIComponent(id), { method: 'DELETE' }))
  }
  // Synthetic delivery — POSTs a test payload even to a disabled channel, so the
  // operator can verify reachability without waiting for a real breach.
  async function apiTestChannel(id) {
    return readBody(
      await fetch(CHANNELS_API + '/' + encodeURIComponent(id) + '/test', { method: 'POST' }),
    )
  }

  // ---- render: shell ----------------------------------------------------

  function cmpOptions() {
    const d = t()
    return (
      '<option value="gt">' + d.psCmpGt + ' (&gt;)</option>' +
      '<option value="gte">' + d.psCmpGte + ' (≥)</option>' +
      '<option value="lt">' + d.psCmpLt + ' (&lt;)</option>' +
      '<option value="lte">' + d.psCmpLte + ' (≤)</option>'
    )
  }

  function buildUi(root) {
    const d = t()
    root.innerHTML =
      '<header class="pf-header">' +
      '  <h2>' + d.psTitle + '</h2>' +
      '  <p class="pf-meta">' + d.psDesc + '</p>' +
      '  <button id="ps-refresh-all" type="button">' + d.psRefreshAll + '</button>' +
      '  <span id="ps-status" class="pf-status"></span>' +
      '</header>' +
      '<section class="pf-list-wrap">' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>Hub</th><th>' + d.psColStatus + '</th><th>' + d.psColAssets + '</th><th>' + d.psColRuns +
      '</th><th id="ps-llm-head">LLM</th><th>' + d.psColHealth + '</th><th>' + d.psColLastRefresh + '</th><th></th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-rows"><tr><td colspan="8" class="pf-empty">' + d.psLoading + '</td></tr></tbody>' +
      '  </table>' +
      '  <div id="ps-agg" class="ps-agg"></div>' +
      '</section>' +
      // --- 告警 (F-M5): live breaches evaluated against the current summaries ---
      '<section class="ps-section ps-alerts">' +
      '  <h3>' + d.psAlertsTitle + '</h3>' +
      '  <p class="pf-meta">' + d.psAlertsDesc + '</p>' +
      '  <div id="ps-alerts-body"><span class="ps-spark-empty">' + d.psLoading + '</span></div>' +
      '</section>' +
      // --- 触发历史 (day-3): persisted firing lifecycle, edge-triggered ---
      '<section class="ps-section ps-firings">' +
      '  <h3>' + d.psFiringsTitle + '</h3>' +
      '  <p class="pf-meta">' + d.psFiringsDesc + '</p>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>' + d.psColSource + '</th><th>' + d.psColMetric + '</th><th>' + d.psColCondition + '</th><th>' +
      d.psColFiredValue + '</th><th>' + d.psColStatus + '</th><th>' + d.psColOpened + '</th><th>' + d.psColResolved + '</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-firings-rows"><tr><td colspan="7" class="pf-empty">' + d.psLoading + '</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      // --- 趋势 (F-M3): per-source per-metric sparkline from persisted snapshots ---
      '<section class="ps-section ps-trend">' +
      '  <h3>' + d.psTrendTitle + '</h3>' +
      '  <div class="ps-controls">' +
      '    <label>' + d.psFieldSource + ' <select id="ps-trend-source"></select></label>' +
      '    <label>' + d.psFieldMetric + ' <select id="ps-trend-metric"></select></label>' +
      '  </div>' +
      '  <div id="ps-trend-chart" class="ps-chart"><span class="ps-spark-empty">' + d.psPickSourceMetric + '</span></div>' +
      '  <p class="pf-meta">' + d.psTrendDesc + '</p>' +
      '</section>' +
      // --- 告警规则 (F-M5): CRUD over the rule store ---
      '<section class="ps-section ps-rules">' +
      '  <h3>' + d.psRulesTitle + '</h3>' +
      '  <form id="ps-rule-form" class="ps-rule-form" autocomplete="off">' +
      '    <label>' + d.psFieldSource + ' <select id="ps-rule-source"></select></label>' +
      '    <label>' + d.psFieldMetric + ' <select id="ps-rule-metric"></select></label>' +
      '    <label>' + d.psFieldCompare + ' <select id="ps-rule-cmp">' + cmpOptions() + '</select></label>' +
      '    <label>' + d.psFieldThreshold + ' <input id="ps-rule-threshold" type="number" step="any" required /></label>' +
      '    <label>' + d.psFieldLabelOpt + ' <input id="ps-rule-label" type="text" placeholder="' + d.psRuleLabelPh + '" /></label>' +
      '    <button type="submit">' + d.psAddRule + '</button>' +
      '  </form>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>' + d.psColSource + '</th><th>' + d.psColMetric + '</th><th>' + d.psColCondition + '</th><th>' +
      d.psColLabel + '</th><th>' + d.psColStatus + '</th><th>' + d.psColActions + '</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-rules-rows"><tr><td colspan="6" class="pf-empty">' + d.psLoading + '</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      // --- 通知渠道 (day-3 + 多通道): webhook / im / email (no secret in the row) ---
      '<section class="ps-section ps-channels">' +
      '  <h3>' + d.psChannelsTitle + '</h3>' +
      '  <p class="pf-meta">' + d.psChannelsDesc + '</p>' +
      '  <form id="ps-channel-form" class="ps-rule-form" autocomplete="off">' +
      '    <label>' + d.psFieldKind + ' <select id="ps-channel-kind">' +
      '      <option value="webhook">webhook</option>' +
      '      <option value="im">' + d.psKindIm + '</option>' +
      '      <option value="email">' + d.psKindEmail + '</option>' +
      '    </select></label>' +
      '    <label id="ps-channel-platform-wrap" hidden>' + d.psFieldPlatform + ' <select id="ps-channel-platform">' +
      '      <option value="telegram">telegram</option>' +
      '      <option value="slack">slack</option>' +
      '      <option value="discord">discord</option>' +
      '      <option value="lark">lark</option>' +
      '    </select></label>' +
      '    <label>URL <input id="ps-channel-url" type="url" required placeholder="https://hooks.example.com/..." /></label>' +
      '    <label id="ps-channel-target-wrap" hidden><span id="ps-channel-target-label">' + d.psFieldTarget + '</span> ' +
      '      <input id="ps-channel-target" type="text" placeholder="' + d.psTargetPh + '" /></label>' +
      '    <label>' + d.psFieldAuthEnvOpt + ' <input id="ps-channel-headerenv" type="text" placeholder="' + d.psAuthEnvPh + '" /></label>' +
      '    <label>' + d.psFieldLabelOpt + ' <input id="ps-channel-label" type="text" placeholder="' + d.psChannelLabelPh + '" /></label>' +
      '    <button type="submit">' + d.psAddChannel + '</button>' +
      '  </form>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>' + d.psColChannel + '</th><th>' + d.psFieldKind + '</th><th>' + d.psColDestination + '</th><th>' +
      d.psColAuth + '</th><th>' + d.psColStatus + '</th><th>' + d.psColActions + '</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-channels-rows"><tr><td colspan="6" class="pf-empty">' + d.psLoading + '</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#ps-refresh-all', root).addEventListener('click', function () {
      doRefresh(root, undefined).catch(function () { /* setStatus handled it */ })
    })
    $('#ps-trend-source', root).addEventListener('change', function () {
      loadTrend(root).catch(function () { /* chart shows the error */ })
    })
    $('#ps-trend-metric', root).addEventListener('change', function () {
      loadTrend(root).catch(function () { /* chart shows the error */ })
    })
    $('#ps-rule-form', root).addEventListener('submit', function (e) {
      e.preventDefault()
      onAddRule(root).catch(function () { /* setStatus handled it */ })
    })
    $('#ps-channel-form', root).addEventListener('submit', function (e) {
      e.preventDefault()
      onAddChannel(root).catch(function () { /* setStatus handled it */ })
    })
    // Per-kind fields: platform is im-only; target is the im chat/room id OR the
    // email recipient (so it shows for im + email, with a kind-aware label).
    $('#ps-channel-kind', root).addEventListener('change', function () {
      updateChannelFields(root)
    })
    updateChannelFields(root)
  }

  // Show/hide + relabel the platform/target fields to match the chosen kind.
  function updateChannelFields(root) {
    const kind = $('#ps-channel-kind', root).value
    const platWrap = $('#ps-channel-platform-wrap', root)
    const targetWrap = $('#ps-channel-target-wrap', root)
    const targetLabel = $('#ps-channel-target-label', root)
    if (platWrap) platWrap.hidden = kind !== 'im'
    if (targetWrap) targetWrap.hidden = kind !== 'im' && kind !== 'email'
    if (targetLabel) targetLabel.textContent = kind === 'email' ? t().psTargetEmail : t().psTargetChatRoom
  }

  // Fill a <select> from [{value,label}], preserving the current selection if it
  // still exists (so a refresh doesn't reset the user's chosen source/metric).
  function fillSelect(sel, options) {
    if (!sel) return
    const prev = sel.value
    const hasPrev = options.some(function (o) { return o.value === prev })
    sel.innerHTML = options
      .map(function (o) {
        const selected = o.value === prev && hasPrev ? ' selected' : ''
        return '<option value="' + escHtml(o.value) + '"' + selected + '>' + escHtml(o.label) + '</option>'
      })
      .join('')
  }
  function metricOpt(k) {
    return { value: k, label: metricLabels()[k] + ' (' + k + ')' }
  }
  function populateControls(root) {
    const metricOpts = METRIC_KEYS.map(metricOpt)
    fillSelect($('#ps-trend-source', root), sourceList)
    fillSelect($('#ps-trend-metric', root), metricOpts)
    fillSelect($('#ps-rule-source', root), [{ value: '*', label: t().psSourceAnyOpt }].concat(sourceList))
    fillSelect($('#ps-rule-metric', root), metricOpts)
  }

  // ---- render: summary table (E5-M4) ------------------------------------

  function dataCells(s) {
    return (
      '<td class="pf-caps">' + assetsText(s) + '</td>' +
      '<td class="pf-caps">' + runsText(s) + '</td>' +
      '<td class="pf-caps">' + llmText(s) + '</td>' +
      '<td class="pf-caps">' + healthText(s) + '</td>'
    )
  }

  // Cross-hub alert aggregation (cross-hub-agg M3): the federation-wide count of
  // currently-open alert firings — this hub's own plus every peer that shared a
  // summary. Counts only: a pure sum of scalars, no firing ever crosses the wire.
  // Honest by construction — peers that didn't share (or are offline) are NOT
  // counted as zero; we say how many were left out instead of fabricating calm.
  function renderAggregate(root, data) {
    const box = $('#ps-agg', root)
    if (!box) return
    const local = data.local || null
    const peers = data.peers || []
    if (!local && !peers.length) {
      box.innerHTML = ''
      return
    }
    let total = 0
    let known = 0
    let hubs = 0
    if (local) {
      total += num(local.alerts && local.alerts.openFirings)
      known += 1
      hubs += 1
    }
    for (const row of peers) {
      hubs += 1
      if (row.summary) {
        total += num(row.summary.alerts && row.summary.alerts.openFirings)
        known += 1
      }
    }
    const unknown = hubs - known
    const cls = total > 0 ? 'ps-agg-firing' : 'ps-agg-calm'
    const icon = total > 0 ? '🔴' : '✓'
    const d = t()
    box.innerHTML =
      '<span class="' + cls + '">' + icon + ' ' + d.psAggLabel(total) + '</span>' +
      ' <small>' + d.psAggDetail(known, unknown) + '</small>'
  }

  // Derive the trend/rule source list from a list() payload (local + peers).
  function deriveSources(data) {
    const local = data.local || null
    const out = [
      { value: 'local', label: t().psSourceLocal + (local && local.hubId ? ' (' + local.hubId + ')' : '') },
    ]
    for (const row of data.peers || []) {
      out.push({ value: row.peer, label: row.label ? row.label + ' (' + row.peer + ')' : row.peer })
    }
    return out
  }

  function renderRows(root, data) {
    const tbody = $('#ps-rows', root)
    if (!tbody) return
    tbody.innerHTML = ''

    // Local footprint pinned first — this hub always knows its own counts.
    const local = data.local || null
    const head = $('#ps-llm-head', root)
    if (head) head.textContent = local ? llmWindow(local) : 'LLM'
    const d = t()
    const localRow = document.createElement('tr')
    localRow.className = 'ps-local'
    if (local) {
      localRow.innerHTML =
        '<td class="pf-peer"><strong>' + d.psSourceLocal + '</strong> <code class="pf-id">' + escHtml(local.hubId) + '</code></td>' +
        '<td><span class="pf-badge pf-online">' + d.psBadgeLocal + '</span></td>' +
        dataCells(local) +
        '<td class="pf-time">' + escHtml(fmtTime(local.generatedAt)) + '</td>' +
        '<td></td>'
    } else {
      localRow.innerHTML = '<td colspan="8" class="pf-cap-empty">' + d.psLocalUnavailable + '</td>'
    }
    tbody.appendChild(localRow)

    const peers = data.peers || []
    if (!peers.length) {
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td colspan="8" class="pf-empty">' + d.psNoPeers + '</td>'
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
          '<td><button type="button" class="ps-row-refresh">' + d.psRefresh + '</button></td>'
      } else {
        // No counts to show — say WHY (not shared / offline) instead of zeros.
        const reason = row.lastError ? escHtml(row.lastError) : d.psNotRefreshedYet
        tr.innerHTML =
          '<td class="pf-peer">' + peerCell + '</td>' +
          '<td><span class="pf-badge ' + st.cls + '">' + escHtml(st.label) + '</span></td>' +
          '<td colspan="4" class="pf-cap-empty">' + reason + '</td>' +
          '<td class="pf-time">' + escHtml(fmtTime(row.lastFetchedAt)) + '</td>' +
          '<td><button type="button" class="ps-row-refresh">' + d.psRefresh + '</button></td>'
      }
      tr.querySelector('.ps-row-refresh').addEventListener('click', function () {
        doRefresh(root, row.peer).catch(function () { /* setStatus handled it */ })
      })
      tbody.appendChild(tr)
    }
  }

  // ---- render: trend sparkline (F-M6) -----------------------------------

  // A minimal inline-SVG sparkline. One point → just a dot (a polyline of one
  // vertex draws nothing). A flat series → a mid-height line (span guarded to 1).
  function sparklineSvg(points) {
    const w = 360
    const h = 48
    const pad = 4
    const n = points.length
    const vals = points.map(function (p) { return p.value })
    const min = Math.min.apply(null, vals)
    const max = Math.max.apply(null, vals)
    const span = max - min || 1
    function px(i) {
      return n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1)
    }
    function py(v) {
      return h - pad - ((v - min) * (h - 2 * pad)) / span
    }
    const pts = points
      .map(function (p, i) { return px(i).toFixed(1) + ',' + py(p.value).toFixed(1) })
      .join(' ')
    const lastX = px(n - 1).toFixed(1)
    const lastY = py(points[n - 1].value).toFixed(1)
    return (
      '<svg class="ps-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" ' +
      'preserveAspectRatio="none" role="img">' +
      '<polyline points="' + pts + '" fill="none" stroke="#1a6a3a" stroke-width="1.5" ' +
      'stroke-linejoin="round" stroke-linecap="round" />' +
      '<circle cx="' + lastX + '" cy="' + lastY + '" r="2.5" fill="#1a6a3a" />' +
      '</svg>'
    )
  }

  function renderTrend(chart, points, metric) {
    const d = t()
    if (!points.length) {
      chart.innerHTML =
        '<span class="ps-spark-empty">' + d.psTrendNoSnapshots + '</span>'
      return
    }
    const vals = points.map(function (p) { return p.value })
    const min = Math.min.apply(null, vals)
    const max = Math.max.apply(null, vals)
    const first = points[0]
    const last = points[points.length - 1]
    chart.innerHTML =
      sparklineSvg(points) +
      '<div class="ps-trend-meta">' +
      d.psTrendMeta(
        points.length,
        escHtml(fmtTime(first.capturedAt)),
        escHtml(fmtTime(last.capturedAt)),
        escHtml(fmtMetric(metric, last.value)),
        escHtml(fmtMetric(metric, min)),
        escHtml(fmtMetric(metric, max)),
      ) +
      '</div>'
  }

  async function loadTrend(root) {
    const srcSel = $('#ps-trend-source', root)
    const metSel = $('#ps-trend-metric', root)
    const chart = $('#ps-trend-chart', root)
    if (!srcSel || !metSel || !chart) return
    const source = srcSel.value
    const metric = metSel.value
    if (!source || !metric) {
      chart.innerHTML = '<span class="ps-spark-empty">' + t().psPickSourceMetric + '</span>'
      return
    }
    chart.innerHTML = '<span class="ps-spark-empty">' + t().psTrendLoading + '</span>'
    try {
      const data = await apiHistory(source, metric)
      renderTrend(chart, data.points || [], metric)
    } catch (err) {
      if (err.status === 503) {
        chart.innerHTML = '<span class="ps-spark-empty">' + t().psHostNoFederation + '</span>'
        return
      }
      chart.innerHTML =
        '<span class="ps-spark-empty">' + t().psTrendLoadFailed(escHtml(err.message || String(err))) + '</span>'
    }
  }

  // ---- render: alerts + rules (F-M6) ------------------------------------

  function renderAlerts(root, breaches) {
    const box = $('#ps-alerts-body', root)
    if (!box) return
    if (!breaches.length) {
      box.innerHTML = '<span class="ps-ok">✓ ' + t().psNoBreaches + '</span>'
      return
    }
    box.innerHTML =
      '<div class="ps-breaches">' +
      breaches
        .map(function (b) {
          const name = b.label ? escHtml(b.label) : escHtml(metricLabelOf(b.metric))
          const sym = CMP_SYMBOL[b.comparator] || escHtml(b.comparator)
          return (
            '<span class="ps-breach">⚠ ' + name + ' — ' +
            escHtml(sourceLabelOf(b.source)) + ': ' +
            escHtml(fmtMetric(b.metric, b.value)) + ' ' + sym + ' ' +
            escHtml(fmtMetric(b.metric, b.threshold)) +
            ' <code class="pf-id">' + escHtml(b.metric) + '</code></span>'
          )
        })
        .join('') +
      '</div>'
  }

  function renderRules(root, rules) {
    const tbody = $('#ps-rules-rows', root)
    if (!tbody) return
    const d = t()
    if (!rules.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pf-empty">' + d.psNoRules + '</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const r of rules) {
      const sym = CMP_SYMBOL[r.comparator] || r.comparator
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td>' + escHtml(sourceLabelOf(r.source)) + '</td>' +
        '<td class="pf-caps">' + escHtml(metricLabelOf(r.metric)) +
        ' <code class="pf-id">' + escHtml(r.metric) + '</code></td>' +
        '<td>' + escHtml(sym) + ' ' + escHtml(fmtMetric(r.metric, r.threshold)) + '</td>' +
        '<td>' + (r.label ? escHtml(r.label) : '—') + '</td>' +
        '<td><span class="pf-badge ' + (r.enabled ? 'pf-online' : 'pf-unknown') + '">' +
        (r.enabled ? d.psEnabled : d.psDisabled) + '</span></td>' +
        '<td class="ps-rule-actions">' +
        '  <button type="button" class="ps-rule-toggle">' + (r.enabled ? d.psDisable : d.psEnable) + '</button>' +
        '  <button type="button" class="ps-rule-remove">' + d.psDelete + '</button>' +
        '</td>'
      tr.querySelector('.ps-rule-toggle').addEventListener('click', function () {
        doRulePatch(root, r.id, { enabled: !r.enabled })
      })
      tr.querySelector('.ps-rule-remove').addEventListener('click', function () {
        if (!window.confirm(t().psConfirmDeleteRule)) return
        doRuleRemove(root, r.id)
      })
      tbody.appendChild(tr)
    }
  }

  async function loadAlertsAndRules(root) {
    try {
      const data = await apiAlerts()
      renderAlerts(root, data.alerts || [])
      renderRules(root, data.rules || [])
    } catch (err) {
      const box = $('#ps-alerts-body', root)
      const rows = $('#ps-rules-rows', root)
      const msg =
        err.status === 503 ? t().psHostNoFederation : t().psLoadFailed(err.message || String(err))
      if (box) box.innerHTML = '<span class="ps-spark-empty">' + escHtml(msg) + '</span>'
      if (rows) rows.innerHTML = '<tr><td colspan="6" class="pf-empty">' + escHtml(msg) + '</td></tr>'
    }
  }

  // ---- render: firings + channels (day-3) -------------------------------

  // A firing is open until resolved — open reads as a live concern (amber),
  // resolved as a closed lifecycle (green).
  function firingStateBadge(f) {
    return f.resolvedAt == null
      ? '<span class="pf-badge pf-unknown">🔴 ' + t().psFiringOpen + '</span>'
      : '<span class="pf-badge pf-online">' + t().psFiringResolved + '</span>'
  }

  function renderFirings(root, firings) {
    const tbody = $('#ps-firings-rows', root)
    if (!tbody) return
    if (!firings.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="pf-empty">' + t().psNoFirings + '</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const f of firings) {
      const sym = CMP_SYMBOL[f.comparator] || f.comparator
      const tr = document.createElement('tr')
      if (f.resolvedAt == null) tr.className = 'ps-firing-open'
      tr.innerHTML =
        '<td>' + escHtml(sourceLabelOf(f.source)) + '</td>' +
        '<td class="pf-caps">' + escHtml(metricLabelOf(f.metric)) +
        ' <code class="pf-id">' + escHtml(f.metric) + '</code></td>' +
        '<td>' + escHtml(sym) + ' ' + escHtml(fmtMetric(f.metric, f.threshold)) + '</td>' +
        '<td>' + escHtml(fmtMetric(f.metric, f.value)) + '</td>' +
        '<td>' + firingStateBadge(f) + '</td>' +
        '<td class="pf-time">' + escHtml(fmtTime(f.openedAt)) + '</td>' +
        '<td class="pf-time">' + (f.resolvedAt == null ? '—' : escHtml(fmtTime(f.resolvedAt))) + '</td>'
      tbody.appendChild(tr)
    }
  }

  // Destination cell: im shows its platform + (target or "via url"); email shows
  // the recipient; webhook has no separate destination (the url IS it).
  function channelDestCell(c) {
    if (c.kind === 'im') {
      const plat = c.platform ? '<strong>' + escHtml(c.platform) + '</strong>' : '?'
      const to = c.target ? ' → <code class="pf-id">' + escHtml(c.target) + '</code>' : ' (via url)'
      return plat + to
    }
    if (c.kind === 'email') {
      return c.target ? '<code class="pf-id">' + escHtml(c.target) + '</code>' : '?'
    }
    return '—'
  }

  function renderChannels(root, channels) {
    const tbody = $('#ps-channels-rows', root)
    if (!tbody) return
    const d = t()
    if (!channels.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pf-empty">' + d.psNoChannels + '</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const c of channels) {
      const label = c.label
        ? escHtml(c.label) + ' <code class="pf-id">' + escHtml(c.url) + '</code>'
        : '<code class="pf-id">' + escHtml(c.url) + '</code>'
      // The row carries the env-var NAME ($NAME), never the bearer value.
      const authCell = c.headerEnv ? '<code class="pf-id">$' + escHtml(c.headerEnv) + '</code>' : '—'
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td class="pf-peer">' + label + '</td>' +
        '<td>' + escHtml(c.kind) + '</td>' +
        '<td>' + channelDestCell(c) + '</td>' +
        '<td>' + authCell + '</td>' +
        '<td><span class="pf-badge ' + (c.enabled ? 'pf-online' : 'pf-unknown') + '">' +
        (c.enabled ? d.psEnabled : d.psDisabled) + '</span></td>' +
        '<td class="ps-rule-actions">' +
        '  <button type="button" class="ps-channel-test">' + d.psTest + '</button>' +
        '  <button type="button" class="ps-channel-toggle">' + (c.enabled ? d.psDisable : d.psEnable) + '</button>' +
        '  <button type="button" class="ps-channel-remove">' + d.psDelete + '</button>' +
        '</td>'
      tr.querySelector('.ps-channel-test').addEventListener('click', function () {
        doChannelTest(root, c.id)
      })
      tr.querySelector('.ps-channel-toggle').addEventListener('click', function () {
        doChannelPatch(root, c.id, { enabled: !c.enabled })
      })
      tr.querySelector('.ps-channel-remove').addEventListener('click', function () {
        if (!window.confirm(t().psConfirmDeleteChannel)) return
        doChannelRemove(root, c.id)
      })
      tbody.appendChild(tr)
    }
  }

  async function loadFiringsAndChannels(root) {
    try {
      const [firings, channels] = await Promise.all([apiFirings(), apiChannels()])
      renderFirings(root, firings.firings || [])
      renderChannels(root, channels.channels || [])
    } catch (err) {
      const fr = $('#ps-firings-rows', root)
      const cr = $('#ps-channels-rows', root)
      const msg =
        err.status === 503 ? t().psHostNoFederation : t().psLoadFailed(err.message || String(err))
      if (fr) fr.innerHTML = '<tr><td colspan="7" class="pf-empty">' + escHtml(msg) + '</td></tr>'
      if (cr) cr.innerHTML = '<tr><td colspan="6" class="pf-empty">' + escHtml(msg) + '</td></tr>'
    }
  }

  // ---- mutations: channels (day-3) --------------------------------------

  async function onAddChannel(root) {
    const kind = $('#ps-channel-kind', root).value
    const url = $('#ps-channel-url', root).value.trim()
    const headerEnv = $('#ps-channel-headerenv', root).value.trim()
    const label = $('#ps-channel-label', root).value.trim()
    const platform = $('#ps-channel-platform', root).value
    const target = $('#ps-channel-target', root).value.trim()
    if (!url) {
      setStatus(root, t().psUrlRequired, 'error')
      return
    }
    const body = { kind: kind, url: url }
    // platform is im-only; target is the im chat/room id OR the email recipient.
    if (kind === 'im') body.platform = platform
    if ((kind === 'im' || kind === 'email') && target) body.target = target
    if (headerEnv) body.headerEnv = headerEnv
    if (label) body.label = label
    setStatus(root, t().psAddingChannel, 'loading')
    try {
      await apiAddChannel(body)
      $('#ps-channel-url', root).value = ''
      $('#ps-channel-headerenv', root).value = ''
      $('#ps-channel-label', root).value = ''
      $('#ps-channel-target', root).value = ''
      setStatus(root, t().psChannelAdded, 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, t().psAddChannelFailed(err.message || err), 'error')
    }
  }

  async function doChannelPatch(root, id, body) {
    setStatus(root, t().psSavingChannel, 'loading')
    try {
      await apiPatchChannel(id, body)
      setStatus(root, t().psChannelSaved, 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, t().psSaveChannelFailed(err.message || err), 'error')
    }
  }

  async function doChannelRemove(root, id) {
    setStatus(root, t().psDeletingChannel, 'loading')
    try {
      await apiDeleteChannel(id)
      setStatus(root, t().psChannelDeleted, 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, t().psDeleteChannelFailed(err.message || err), 'error')
    }
  }

  // Synthetic delivery — surfaces the per-channel result (ok + status, or the
  // transport/non-2xx error) so the operator sees reachability immediately.
  async function doChannelTest(root, id) {
    setStatus(root, t().psSendingTest, 'loading')
    try {
      const data = await apiTestChannel(id)
      const r = data.result || {}
      if (r.ok) {
        setStatus(root, t().psTestDeliverOk(r.status || 'ok'), 'ok')
      } else {
        setStatus(root, t().psTestDeliverFailed(r.error || 'http ' + (r.status || '?')), 'error')
      }
    } catch (err) {
      setStatus(root, t().psTestFailed(err.message || err), 'error')
    }
  }

  // ---- mutations: rules -------------------------------------------------

  async function onAddRule(root) {
    const source = $('#ps-rule-source', root).value
    const metric = $('#ps-rule-metric', root).value
    const comparator = $('#ps-rule-cmp', root).value
    const thresholdRaw = $('#ps-rule-threshold', root).value.trim()
    const label = $('#ps-rule-label', root).value.trim()
    if (!source || !metric) {
      setStatus(root, t().psSourceMetricRequired, 'error')
      return
    }
    const threshold = Number(thresholdRaw)
    if (thresholdRaw === '' || !Number.isFinite(threshold)) {
      setStatus(root, t().psThresholdNumber, 'error')
      return
    }
    const body = { source: source, metric: metric, comparator: comparator, threshold: threshold }
    if (label) body.label = label
    setStatus(root, t().psAddingRule, 'loading')
    try {
      await apiAddRule(body)
      $('#ps-rule-threshold', root).value = ''
      $('#ps-rule-label', root).value = ''
      setStatus(root, t().psRuleAdded, 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, t().psAddRuleFailed(err.message || err), 'error')
    }
  }

  async function doRulePatch(root, id, body) {
    setStatus(root, t().psSavingRule, 'loading')
    try {
      await apiPatchRule(id, body)
      setStatus(root, t().psRuleSaved, 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, t().psSaveRuleFailed(err.message || err), 'error')
    }
  }

  async function doRuleRemove(root, id) {
    setStatus(root, t().psDeletingRule, 'loading')
    try {
      await apiDeleteRule(id)
      setStatus(root, t().psRuleDeleted, 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, t().psDeleteRuleFailed(err.message || err), 'error')
    }
  }

  // ---- load / refresh ---------------------------------------------------

  // Apply a list()/refresh() payload to the summary table + source dropdowns.
  function applyData(root, data) {
    renderRows(root, data)
    renderAggregate(root, data)
    sourceList = deriveSources(data)
    populateControls(root)
  }

  async function load(root) {
    setStatus(root, t().psLoadingStatus, 'loading')
    try {
      const data = await apiList()
      applyData(root, data)
      setStatus(root, t().psLoaded((data.peers || []).length), 'ok')
      await Promise.all([loadTrend(root), loadAlertsAndRules(root), loadFiringsAndChannels(root)])
    } catch (err) {
      if (err.status === 503) {
        applyData(root, {})
        renderAlerts(root, [])
        renderRules(root, [])
        renderFirings(root, [])
        renderChannels(root, [])
        setStatus(root, t().psHostNoFederation, 'error')
        return
      }
      setStatus(root, t().psLoadFailed(err.message || err), 'error')
      throw err
    }
  }

  async function doRefresh(root, peerId) {
    setStatus(root, peerId ? t().psRefreshingOne(peerId) : t().psRefreshingAll, 'loading')
    try {
      const data = await apiRefresh(peerId)
      applyData(root, data)
      setStatus(root, t().psRefreshed, 'ok')
      // A refresh captured a fresh snapshot — re-read the trend + re-evaluate +
      // re-read firings (the opt-in sweep may have opened/resolved in the bg).
      await Promise.all([loadTrend(root), loadAlertsAndRules(root), loadFiringsAndChannels(root)])
    } catch (err) {
      if (err.status === 503) {
        applyData(root, {})
        setStatus(root, t().psHostNoFederation, 'error')
        return
      }
      setStatus(root, t().psRefreshFailed(err.message || err), 'error')
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
    // Re-render on language switch — relabel the static shell, and reload the
    // rows when the tab is showing so the live data picks up the new dict too.
    AH.onLangChange(function () {
      buildUi(root)
      if (isActive()) load(root).catch(function () { /* setStatus reported it */ })
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
