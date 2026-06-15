/**
 * Route B P1-M11d — outbound A2A agent registry (tab "联邦" in app.html,
 * panel #a2a-outbound-panel, below the peer panels).
 *
 * Self-contained module; same activation pattern as peer-admin-ui.js /
 * saml-ui.js (owner-only, MutationObserver on <body data-active-tab>, targets
 * its own panel by id). CRUD over the M11c admin routes:
 *
 *   GET    /api/admin/a2a-agents       list (with runtime liveness)
 *   POST   /api/admin/a2a-agents       register one (id is the dispatch target)
 *   PATCH  /api/admin/a2a-agents/:id    enable/disable, rotate url/skill/caps
 *   DELETE /api/admin/a2a-agents/:id    remove + unregister from the hub
 *
 * An outbound A2A agent is a LOCAL participant that forwards a matching
 * capability dispatch to an external agent's A2A message/send. The bearer is
 * NEVER entered here: `tokenEnv` names the env var the host reads it from, so
 * the table shows the env-var name (non-secret) and an honest liveness badge —
 * a row whose env var isn't set reads "未激活·环境变量未设", not "在跑". After
 * the operator provisions that env var, toggling the row off→on (a PATCH) makes
 * the host re-read it and register the agent without a full restart.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render a form that can't save.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.AipeHub at call time (app-core.js runs
  // synchronously before this panel is injected, so AipeHub is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.AipeHub
  function t() { return AH.t }

  const API = '/api/admin/a2a-agents'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // capabilities are entered comma/space separated; split + drop blanks.
  function parseCaps(s) {
    return String(s || '')
      .split(/[\s,]+/)
      .filter(Boolean)
  }

  function setStatus(root, msg, kind) {
    const el = $('#a2a-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.style.color = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e7e34' : '#555'
  }

  // Honest liveness badge — green only when actually registered on the hub.
  function statusBadge(a) {
    const d = t()
    const base =
      'display:inline-block;padding:0.1rem 0.45rem;border-radius:0.25rem;font-size:0.75rem;white-space:nowrap;'
    if (a.active) {
      return '<span style="' + base + 'background:#e6f4ea;color:#1e7e34;">' + d.a2aStRunning + '</span>'
    }
    const reason = a.inactiveReason
    const txt =
      reason === 'disabled'
        ? d.a2aStDisabled
        : reason === 'token_env_unset'
          ? d.a2aStTokenUnset
          : reason === 'id_conflict'
            ? d.a2aStIdConflict
            : reason === 'approval_unconfigured'
              ? d.a2aStApprovalUnconfigured
              : d.a2aStInactive
    return (
      '<span title="' + escHtml(reason || '') + '" style="' + base + 'background:#fdecea;color:#c0392b;">' +
      txt +
      '</span>'
    )
  }

  // Stream H2-OUT — dispatch mode. null lifecycle = blocking (remote must answer
  // in one turn); a lifecycle object = long-running (poll tasks/get while the
  // remote stays parked). `{}` opts in with the participant's defaults.
  function lifecycleText(a) {
    const d = t()
    if (!a.lifecycle) return '<span style="color:#888;">' + d.a2aModeBlocking + '</span>'
    const lc = a.lifecycle
    const parts = []
    if (lc.pollIntervalMs != null) parts.push(lc.pollIntervalMs + 'ms')
    if (lc.maxAttempts != null) parts.push('×' + lc.maxAttempts)
    const detail = parts.length ? ' (' + parts.join(' ') + ')' : d.a2aModeDefault
    return (
      '<span title="' + d.a2aModeLongTitle + '" style="color:#1e7e34;">' + d.a2aModeLong(detail) + '</span>'
    )
  }

  // Item 2 — the outbound-edge gate, rendered compact in one cell. Three knobs,
  // all default-off (so a row with none reads "—"):
  //   data-class : null=unrestricted (omit) / []=locked / [names]=allowlist
  //   quota      : per-window send budget (0/absent = off)
  //   approval   : require human approval in /me inbox before each outbound send
  // Data-class / quota match the P4-M4 mesh contract verbatim (same core gate).
  function gateCell(a) {
    const d = t()
    const parts = []
    const dc = a.allowedDataClasses
    if (dc != null) {
      // null = legacy accept-all → omit (it's the default, not a configured gate)
      parts.push(dc.length === 0 ? d.a2aGateDcLocked : d.a2aGateDcList(dc.join(', ')))
    }
    if (a.outboundQuotaBudget != null && a.outboundQuotaBudget > 0) {
      parts.push(d.a2aGateQuota(a.outboundQuotaBudget))
    }
    const head = parts.length
      ? '<span style="color:#555;">' + escHtml(parts.join(' · ')) + '</span>'
      : a.requireApprovalOutbound
        ? ''
        : '<span style="color:#bbb;">' + d.a2aGateNone + '</span>'
    // approval is the high-stakes knob → amber chip, like a governance flag
    const appr = a.requireApprovalOutbound
      ? ' <span style="display:inline-block;padding:0.05rem 0.35rem;border-radius:0.25rem;font-size:0.72rem;background:#fff3cd;color:#8a6d00;white-space:nowrap;">' +
        d.a2aGateApproval +
        '</span>'
      : ''
    return '<span style="font-size:0.8rem;">' + head + appr + '</span>'
  }

  // ---- API --------------------------------------------------------------

  async function readJson(r) {
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
    return (await readJson(await fetch(API))).agents || []
  }
  async function apiAdd(body) {
    return readJson(
      await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiPatch(id, patch) {
    return readJson(
      await fetch(API + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    )
  }
  async function apiDelete(id) {
    return readJson(await fetch(API + '/' + encodeURIComponent(id), { method: 'DELETE' }))
  }

  // ---- render -----------------------------------------------------------

  function buildUi(root) {
    const d = t()
    root.innerHTML =
      '<div style="padding:1rem;max-width:64rem;">' +
      '<h2 style="margin-top:0;">' + d.a2aTitle + '</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">' + d.a2aDesc + '</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;">' + d.a2aTokenNote + '</p>' +
      '<div id="a2a-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;color:#555;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">' + d.a2aAddSummary + '</summary>' +
      '<form id="a2a-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="id" type="text" placeholder="' + escHtml(d.a2aPhId) + '" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="' + escHtml(d.a2aPhLabel) + '" autocomplete="off" />' +
      '<input name="capabilities" type="text" placeholder="' + escHtml(d.a2aPhCaps) + '" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="url" type="url" placeholder="' + escHtml(d.a2aPhUrl) + '" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="tokenEnv" type="text" placeholder="' + escHtml(d.a2aPhTokenEnv) + '" required autocomplete="off" />' +
      '<input name="peerId" type="text" placeholder="' + escHtml(d.a2aPhPeerId) + '" autocomplete="off" />' +
      '<input name="targetSkill" type="text" placeholder="' + escHtml(d.a2aPhTargetSkill) + '" autocomplete="off" style="grid-column:1 / -1;" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="lifecycle" type="checkbox" /> ' + d.a2aLifecycleLabel + '</label>' +
      '<input name="pollIntervalMs" type="number" min="250" placeholder="' + escHtml(d.a2aPhPollInterval) + '" autocomplete="off" />' +
      '<input name="maxAttempts" type="number" min="1" placeholder="' + escHtml(d.a2aPhMaxAttempts) + '" autocomplete="off" />' +
      // Item 2 — outbound-edge gate (data-class allowlist / quota / approval).
      '<input name="allowedDataClasses" type="text" placeholder="' + escHtml(d.a2aPhDataClasses) + '" autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="outboundQuotaBudget" type="number" min="0" placeholder="' + escHtml(d.a2aPhQuotaBudget) + '" autocomplete="off" />' +
      '<label style="font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="requireApprovalOutbound" type="checkbox" /> ' + d.a2aApprovalLabel + '</label>' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> ' + d.a2aEnabledLabel + '</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">' + d.a2aBtnRegister + '</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">' + d.a2aRegisteredHeading + '</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">' + d.a2aColIdLabel + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColCaps + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColUrl + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColTokenEnv + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColMode + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColGate + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColStatus + '</th>' +
      '<th style="padding:0.4rem;">' + d.a2aColActions + '</th>' +
      '</tr></thead>' +
      '<tbody id="a2a-tbody"><tr><td colspan="8" style="padding:0.6rem;color:#888;">' + d.a2aLoading + '</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#a2a-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, agents) {
    const d = t()
    const tbody = $('#a2a-tbody', root)
    if (!tbody) return
    if (!agents.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" style="padding:0.6rem;color:#888;">' + escHtml(d.a2aEmpty) + '</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const a of agents) {
      const idLabel = a.label
        ? escHtml(a.label) + ' <code style="color:#888;">' + escHtml(a.id) + '</code>'
        : '<code>' + escHtml(a.id) + '</code>'
      const caps = (a.capabilities || []).map(function (c) { return escHtml(c) }).join(', ')
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code style="color:#555;">' + caps + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.url) + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.tokenEnv) + '</code></td>' +
        '<td style="padding:0.4rem;">' + lifecycleText(a) + '</td>' +
        '<td style="padding:0.4rem;">' + gateCell(a) + '</td>' +
        '<td style="padding:0.4rem;">' + statusBadge(a) + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="a2a-toggle" style="padding:0.25rem 0.5rem;">' +
        (a.enabled ? d.a2aBtnDisable : d.a2aBtnEnable) + '</button> ' +
        '<button type="button" class="a2a-life" style="padding:0.25rem 0.5rem;">' +
        (a.lifecycle ? d.a2aBtnToBlocking : d.a2aBtnToLong) + '</button> ' +
        '<button type="button" class="a2a-appr" style="padding:0.25rem 0.5rem;">' +
        (a.requireApprovalOutbound ? d.a2aBtnToDirect : d.a2aBtnToApproval) + '</button> ' +
        '<button type="button" class="a2a-del" style="padding:0.25rem 0.5rem;color:#c0392b;">' + d.a2aBtnDelete + '</button>' +
        '</td>'
      tr.querySelector('.a2a-toggle').addEventListener('click', function () {
        doPatch(root, a.id, { enabled: !a.enabled }, a.enabled ? t().a2aOkDisabled : t().a2aOkEnabled)
      })
      tr.querySelector('.a2a-life').addEventListener('click', function () {
        // Flip blocking <-> long-running (defaults). Precise poll tuning is via
        // re-registration, same as caps/url (the table has no inline field edit).
        doPatch(
          root,
          a.id,
          { lifecycle: a.lifecycle ? null : {} },
          a.lifecycle ? t().a2aOkToBlocking : t().a2aOkToLong,
        )
      })
      tr.querySelector('.a2a-appr').addEventListener('click', function () {
        // Flip outbound approval on/off (a per-policy toggle, like enabled).
        // data-class / quota tuning goes via re-registration (same as caps/url).
        doPatch(
          root,
          a.id,
          { requireApprovalOutbound: !a.requireApprovalOutbound },
          a.requireApprovalOutbound ? t().a2aOkToDirect : t().a2aOkToApproval,
        )
      })
      tr.querySelector('.a2a-del').addEventListener('click', function () {
        if (!window.confirm(t().a2aConfirmDelete(a.label || a.id))) return
        doDelete(root, a.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, t().a2aUnwired, 'error')
      return true
    }
    return false
  }

  async function load(root) {
    setStatus(root, t().a2aLoadingStatus, 'loading')
    try {
      const agents = await apiList()
      renderRows(root, agents)
      const live = agents.filter(function (a) { return a.active }).length
      setStatus(root, t().a2aLoadedStatus(agents.length, live), 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().a2aLoadFailed(err.message || err), 'error')
    }
  }

  async function handleAdd(root, e) {
    e.preventDefault()
    const form = e.target
    const fd = new FormData(form)
    const str = function (k) { return String(fd.get(k) || '').trim() }
    const body = {
      id: str('id'),
      capabilities: parseCaps(str('capabilities')),
      url: str('url'),
      tokenEnv: str('tokenEnv'),
      enabled: fd.get('enabled') != null,
    }
    // Optional: only send when filled, so the store keeps its default (null).
    const peerId = str('peerId')
    if (peerId) body.peerId = peerId
    const targetSkill = str('targetSkill')
    if (targetSkill) body.targetSkill = targetSkill
    const label = str('label')
    if (label) body.label = label
    // Stream H2-OUT — long-running lifecycle. Unchecked → omit (blocking default).
    // Checked → send a lifecycle object; empty numbers stay out so `{}` opts in
    // with the participant's defaults, a number tunes that field.
    if (fd.get('lifecycle') != null) {
      const lc = {}
      const poll = parseInt(str('pollIntervalMs'), 10)
      if (poll > 0) lc.pollIntervalMs = poll
      const max = parseInt(str('maxAttempts'), 10)
      if (max > 0) lc.maxAttempts = max
      body.lifecycle = lc
    }
    // Item 2 — outbound-edge gate. Empty data-class field → omit (keep the
    // store default null = unrestricted); a filled field → allowlist. (The add
    // form can't express [] / deny-all; that edge config goes via the API.)
    const dcs = parseCaps(str('allowedDataClasses'))
    if (dcs.length) body.allowedDataClasses = dcs
    // Empty quota → omit (no limit). A number (incl. 0 = off) → send.
    const qb = str('outboundQuotaBudget')
    if (qb !== '') {
      const n = parseInt(qb, 10)
      if (n >= 0) body.outboundQuotaBudget = n
    }
    if (fd.get('requireApprovalOutbound') != null) body.requireApprovalOutbound = true
    setStatus(root, t().a2aRegistering, 'loading')
    try {
      await apiAdd(body)
      form.reset()
      await load(root)
      setStatus(root, t().a2aRegistered, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().a2aRegisterFailed(err.message || err), 'error')
    }
  }

  async function doPatch(root, id, patch, okMsg) {
    setStatus(root, t().a2aSaving, 'loading')
    try {
      await apiPatch(id, patch)
      await load(root)
      setStatus(root, okMsg || t().a2aSaved, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().a2aSaveFailed(err.message || err), 'error')
    }
  }

  async function doDelete(root, id) {
    setStatus(root, t().a2aDeleting, 'loading')
    try {
      await apiDelete(id)
      await load(root)
      setStatus(root, t().a2aDeleted, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().a2aDeleteFailed(err.message || err), 'error')
    }
  }

  // ---- activation (mirror peer-admin-ui.js) -----------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    // Target our own panel by id, not section[data-tab="federation"] — that
    // tab holds several panels (peer onboarding + manifest browse) and a bare
    // data-tab selector would grab whichever comes first.
    const root = document.querySelector('#a2a-outbound-panel')
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
