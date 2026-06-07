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
 *     (AIPE_PEER_SUMMARY_ALERT_SWEEP_MS) — until that's set, channels only fire on
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
  const METRIC_LABELS = {
    'assets.agents': 'Agents 数',
    'assets.workflows': '工作流数',
    'assets.publishedWorkflows': '已发布工作流',
    'assets.peers': 'Peer 数',
    'runs.total': '运行总数',
    'llm.calls': 'LLM 调用数',
    'llm.tokens': 'LLM tokens',
    'llm.costMicros': 'LLM 成本 (µ$)',
    'health.suspendedTasks': '挂起任务',
  }
  const METRIC_KEYS = Object.keys(METRIC_LABELS)
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

  // A source key → human label (for breaches + rule rows + dropdowns).
  function sourceLabelOf(src) {
    if (src === '*') return '任意来源'
    if (src === 'local') return '本 hub'
    const found = sourceList.filter(function (s) { return s.value === src })[0]
    return found ? found.label : src
  }
  function metricLabelOf(metric) {
    return METRIC_LABELS[metric] || metric
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
    return (
      '<option value="gt">大于 (&gt;)</option>' +
      '<option value="gte">大于等于 (≥)</option>' +
      '<option value="lt">小于 (&lt;)</option>' +
      '<option value="lte">小于等于 (≤)</option>'
    )
  }

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
      '</section>' +
      // --- 告警 (F-M5): live breaches evaluated against the current summaries ---
      '<section class="ps-section ps-alerts">' +
      '  <h3>告警</h3>' +
      '  <p class="pf-meta">规则对<strong>当前</strong>摘要实时求值,不保存历史触发记录 —— 触发是「此刻」的事实。' +
      '来源可选「本 hub」「某 peer」或「任意来源 (*)」。</p>' +
      '  <div id="ps-alerts-body"><span class="ps-spark-empty">加载中...</span></div>' +
      '</section>' +
      // --- 触发历史 (day-3): persisted firing lifecycle, edge-triggered ---
      '<section class="ps-section ps-firings">' +
      '  <h3>触发历史</h3>' +
      '  <p class="pf-meta">每条是一次<strong>开启 → 解决</strong>的完整生命周期(<strong>边沿触发</strong>:' +
      '越线时记一次、恢复时标记解决,不会每轮求值重复记)。仅计数 —— 阈值、触发值、时间,绝不含原始记录。</p>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>来源</th><th>指标</th><th>条件</th><th>触发值</th><th>状态</th><th>开启</th><th>解决</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-firings-rows"><tr><td colspan="7" class="pf-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      // --- 趋势 (F-M3): per-source per-metric sparkline from persisted snapshots ---
      '<section class="ps-section ps-trend">' +
      '  <h3>趋势</h3>' +
      '  <div class="ps-controls">' +
      '    <label>来源 <select id="ps-trend-source"></select></label>' +
      '    <label>指标 <select id="ps-trend-metric"></select></label>' +
      '  </div>' +
      '  <div id="ps-trend-chart" class="ps-chart"><span class="ps-spark-empty">选择来源与指标</span></div>' +
      '  <p class="pf-meta">趋势读自持久化的<strong>计数快照</strong> —— 每次「刷新」采集一个数据点' +
      '(本 hub 总会采,peer 仅在成功拉取摘要时采)。</p>' +
      '</section>' +
      // --- 告警规则 (F-M5): CRUD over the rule store ---
      '<section class="ps-section ps-rules">' +
      '  <h3>告警规则</h3>' +
      '  <form id="ps-rule-form" class="ps-rule-form" autocomplete="off">' +
      '    <label>来源 <select id="ps-rule-source"></select></label>' +
      '    <label>指标 <select id="ps-rule-metric"></select></label>' +
      '    <label>比较 <select id="ps-rule-cmp">' + cmpOptions() + '</select></label>' +
      '    <label>阈值 <input id="ps-rule-threshold" type="number" step="any" required /></label>' +
      '    <label>标签 (可选) <input id="ps-rule-label" type="text" placeholder="如: 挂起过多" /></label>' +
      '    <button type="submit">添加规则</button>' +
      '  </form>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>来源</th><th>指标</th><th>条件</th><th>标签</th><th>状态</th><th>操作</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-rules-rows"><tr><td colspan="6" class="pf-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>' +
      // --- 通知渠道 (day-3 + 多通道): webhook / im / email (no secret in the row) ---
      '<section class="ps-section ps-channels">' +
      '  <h3>通知渠道</h3>' +
      '  <p class="pf-meta">告警越线时把<strong>计数摘要</strong>投递到 webhook / 即时通讯(IM) / 邮件(边沿触发:开启发一次、解决发一次)。' +
      '渠道只存<strong>环境变量名</strong>(headerEnv)与目的地,绝不存密钥本身 —— host 在投递时从该环境变量读取令牌。' +
      'IM 用<strong>无状态平台 send</strong>:slack/discord/lark 是 incoming-webhook(令牌在 URL 里),telegram 走 bot API(令牌从环境变量读、拼进路径)。' +
      '<strong>主动投递需开启轮询</strong>:设 <code>AIPE_PEER_SUMMARY_ALERT_SWEEP_MS</code>(≥10000)host 才会定期' +
      '求值并投递;未设时渠道仅在下方「测试」按钮触发时发出。</p>' +
      '  <form id="ps-channel-form" class="ps-rule-form" autocomplete="off">' +
      '    <label>类型 <select id="ps-channel-kind">' +
      '      <option value="webhook">webhook</option>' +
      '      <option value="im">IM (即时通讯)</option>' +
      '      <option value="email">email (邮件)</option>' +
      '    </select></label>' +
      '    <label id="ps-channel-platform-wrap" hidden>平台 <select id="ps-channel-platform">' +
      '      <option value="telegram">telegram</option>' +
      '      <option value="slack">slack</option>' +
      '      <option value="discord">discord</option>' +
      '      <option value="lark">lark</option>' +
      '    </select></label>' +
      '    <label>URL <input id="ps-channel-url" type="url" required placeholder="https://hooks.example.com/..." /></label>' +
      '    <label id="ps-channel-target-wrap" hidden><span id="ps-channel-target-label">目标</span> ' +
      '      <input id="ps-channel-target" type="text" placeholder="如: -1001234567890 或 ops@example.com" /></label>' +
      '    <label>鉴权环境变量 (可选) <input id="ps-channel-headerenv" type="text" placeholder="如: OPS_WEBHOOK_TOKEN" /></label>' +
      '    <label>标签 (可选) <input id="ps-channel-label" type="text" placeholder="如: 运维群" /></label>' +
      '    <button type="submit">添加渠道</button>' +
      '  </form>' +
      '  <table class="pf-table">' +
      '    <thead><tr>' +
      '      <th>渠道</th><th>类型</th><th>目的地</th><th>鉴权</th><th>状态</th><th>操作</th>' +
      '    </tr></thead>' +
      '    <tbody id="ps-channels-rows"><tr><td colspan="6" class="pf-empty">加载中...</td></tr></tbody>' +
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
    if (targetLabel) targetLabel.textContent = kind === 'email' ? '收件人' : '目标 chat/room id'
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
    return { value: k, label: METRIC_LABELS[k] + ' (' + k + ')' }
  }
  function populateControls(root) {
    const metricOpts = METRIC_KEYS.map(metricOpt)
    fillSelect($('#ps-trend-source', root), sourceList)
    fillSelect($('#ps-trend-metric', root), metricOpts)
    fillSelect($('#ps-rule-source', root), [{ value: '*', label: '任意来源 (*)' }].concat(sourceList))
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

  // Derive the trend/rule source list from a list() payload (local + peers).
  function deriveSources(data) {
    const local = data.local || null
    const out = [
      { value: 'local', label: '本 hub' + (local && local.hubId ? ' (' + local.hubId + ')' : '') },
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
    if (!points.length) {
      chart.innerHTML =
        '<span class="ps-spark-empty">暂无快照 —— 「刷新全部」以采集首个数据点</span>'
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
      points.length + ' 个数据点 · ' +
      escHtml(fmtTime(first.capturedAt)) + ' → ' + escHtml(fmtTime(last.capturedAt)) +
      ' · 最新 ' + escHtml(fmtMetric(metric, last.value)) +
      ' · 最小 ' + escHtml(fmtMetric(metric, min)) +
      ' · 最大 ' + escHtml(fmtMetric(metric, max)) +
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
      chart.innerHTML = '<span class="ps-spark-empty">选择来源与指标</span>'
      return
    }
    chart.innerHTML = '<span class="ps-spark-empty">加载趋势...</span>'
    try {
      const data = await apiHistory(source, metric)
      renderTrend(chart, data.points || [], metric)
    } catch (err) {
      if (err.status === 503) {
        chart.innerHTML = '<span class="ps-spark-empty">host 未启用 peer 联邦</span>'
        return
      }
      chart.innerHTML =
        '<span class="ps-spark-empty">趋势加载失败: ' + escHtml(err.message || String(err)) + '</span>'
    }
  }

  // ---- render: alerts + rules (F-M6) ------------------------------------

  function renderAlerts(root, breaches) {
    const box = $('#ps-alerts-body', root)
    if (!box) return
    if (!breaches.length) {
      box.innerHTML = '<span class="ps-ok">✓ 当前没有触发的告警</span>'
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
    if (!rules.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pf-empty">还没有告警规则。用上面的表单添加一条。</td></tr>'
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
        (r.enabled ? '启用' : '停用') + '</span></td>' +
        '<td class="ps-rule-actions">' +
        '  <button type="button" class="ps-rule-toggle">' + (r.enabled ? '停用' : '启用') + '</button>' +
        '  <button type="button" class="ps-rule-remove">删除</button>' +
        '</td>'
      tr.querySelector('.ps-rule-toggle').addEventListener('click', function () {
        doRulePatch(root, r.id, { enabled: !r.enabled })
      })
      tr.querySelector('.ps-rule-remove').addEventListener('click', function () {
        if (!window.confirm('删除该告警规则?')) return
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
        err.status === 503 ? 'host 未启用 peer 联邦' : '加载失败: ' + (err.message || String(err))
      if (box) box.innerHTML = '<span class="ps-spark-empty">' + escHtml(msg) + '</span>'
      if (rows) rows.innerHTML = '<tr><td colspan="6" class="pf-empty">' + escHtml(msg) + '</td></tr>'
    }
  }

  // ---- render: firings + channels (day-3) -------------------------------

  // A firing is open until resolved — open reads as a live concern (amber),
  // resolved as a closed lifecycle (green).
  function firingStateBadge(f) {
    return f.resolvedAt == null
      ? '<span class="pf-badge pf-unknown">🔴 开启中</span>'
      : '<span class="pf-badge pf-online">已解决</span>'
  }

  function renderFirings(root, firings) {
    const tbody = $('#ps-firings-rows', root)
    if (!tbody) return
    if (!firings.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="pf-empty">还没有触发记录。规则越线时会在这里留下一条开启→解决的生命周期。</td></tr>'
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
    if (!channels.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pf-empty">还没有通知渠道。用上面的表单添加一个 webhook / IM / 邮件渠道。</td></tr>'
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
        (c.enabled ? '启用' : '停用') + '</span></td>' +
        '<td class="ps-rule-actions">' +
        '  <button type="button" class="ps-channel-test">测试</button>' +
        '  <button type="button" class="ps-channel-toggle">' + (c.enabled ? '停用' : '启用') + '</button>' +
        '  <button type="button" class="ps-channel-remove">删除</button>' +
        '</td>'
      tr.querySelector('.ps-channel-test').addEventListener('click', function () {
        doChannelTest(root, c.id)
      })
      tr.querySelector('.ps-channel-toggle').addEventListener('click', function () {
        doChannelPatch(root, c.id, { enabled: !c.enabled })
      })
      tr.querySelector('.ps-channel-remove').addEventListener('click', function () {
        if (!window.confirm('删除该通知渠道?')) return
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
        err.status === 503 ? 'host 未启用 peer 联邦' : '加载失败: ' + (err.message || String(err))
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
      setStatus(root, 'URL 必填', 'error')
      return
    }
    const body = { kind: kind, url: url }
    // platform is im-only; target is the im chat/room id OR the email recipient.
    if (kind === 'im') body.platform = platform
    if ((kind === 'im' || kind === 'email') && target) body.target = target
    if (headerEnv) body.headerEnv = headerEnv
    if (label) body.label = label
    setStatus(root, '添加渠道...', 'loading')
    try {
      await apiAddChannel(body)
      $('#ps-channel-url', root).value = ''
      $('#ps-channel-headerenv', root).value = ''
      $('#ps-channel-label', root).value = ''
      $('#ps-channel-target', root).value = ''
      setStatus(root, '渠道已添加', 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, '添加渠道失败: ' + (err.message || err), 'error')
    }
  }

  async function doChannelPatch(root, id, body) {
    setStatus(root, '保存渠道...', 'loading')
    try {
      await apiPatchChannel(id, body)
      setStatus(root, '渠道已保存', 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, '保存渠道失败: ' + (err.message || err), 'error')
    }
  }

  async function doChannelRemove(root, id) {
    setStatus(root, '删除渠道...', 'loading')
    try {
      await apiDeleteChannel(id)
      setStatus(root, '渠道已删除', 'ok')
      await loadFiringsAndChannels(root)
    } catch (err) {
      setStatus(root, '删除渠道失败: ' + (err.message || err), 'error')
    }
  }

  // Synthetic delivery — surfaces the per-channel result (ok + status, or the
  // transport/non-2xx error) so the operator sees reachability immediately.
  async function doChannelTest(root, id) {
    setStatus(root, '发送测试...', 'loading')
    try {
      const data = await apiTestChannel(id)
      const r = data.result || {}
      if (r.ok) {
        setStatus(root, '测试投递成功 (' + (r.status || 'ok') + ')', 'ok')
      } else {
        setStatus(root, '测试投递失败: ' + (r.error || 'http ' + (r.status || '?')), 'error')
      }
    } catch (err) {
      setStatus(root, '测试失败: ' + (err.message || err), 'error')
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
      setStatus(root, '来源 / 指标必填', 'error')
      return
    }
    const threshold = Number(thresholdRaw)
    if (thresholdRaw === '' || !Number.isFinite(threshold)) {
      setStatus(root, '阈值必须是数字', 'error')
      return
    }
    const body = { source: source, metric: metric, comparator: comparator, threshold: threshold }
    if (label) body.label = label
    setStatus(root, '添加规则...', 'loading')
    try {
      await apiAddRule(body)
      $('#ps-rule-threshold', root).value = ''
      $('#ps-rule-label', root).value = ''
      setStatus(root, '规则已添加', 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, '添加规则失败: ' + (err.message || err), 'error')
    }
  }

  async function doRulePatch(root, id, body) {
    setStatus(root, '保存规则...', 'loading')
    try {
      await apiPatchRule(id, body)
      setStatus(root, '规则已保存', 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, '保存规则失败: ' + (err.message || err), 'error')
    }
  }

  async function doRuleRemove(root, id) {
    setStatus(root, '删除规则...', 'loading')
    try {
      await apiDeleteRule(id)
      setStatus(root, '规则已删除', 'ok')
      await loadAlertsAndRules(root)
    } catch (err) {
      setStatus(root, '删除规则失败: ' + (err.message || err), 'error')
    }
  }

  // ---- load / refresh ---------------------------------------------------

  // Apply a list()/refresh() payload to the summary table + source dropdowns.
  function applyData(root, data) {
    renderRows(root, data)
    sourceList = deriveSources(data)
    populateControls(root)
  }

  async function load(root) {
    setStatus(root, '加载...', 'loading')
    try {
      const data = await apiList()
      applyData(root, data)
      setStatus(root, '已加载 ' + ((data.peers || []).length) + ' 个 peer', 'ok')
      await Promise.all([loadTrend(root), loadAlertsAndRules(root), loadFiringsAndChannels(root)])
    } catch (err) {
      if (err.status === 503) {
        applyData(root, {})
        renderAlerts(root, [])
        renderRules(root, [])
        renderFirings(root, [])
        renderChannels(root, [])
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
      applyData(root, data)
      setStatus(root, '已刷新', 'ok')
      // A refresh captured a fresh snapshot — re-read the trend + re-evaluate +
      // re-read firings (the opt-in sweep may have opened/resolved in the bg).
      await Promise.all([loadTrend(root), loadAlertsAndRules(root), loadFiringsAndChannels(root)])
    } catch (err) {
      if (err.status === 503) {
        applyData(root, {})
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
