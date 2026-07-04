/**
 * ACP-OUT-M5 — outbound ACP agent registry (tab "联邦" in app.html,
 * panel #acp-outbound-panel, below the A2A panel).
 *
 * Self-contained module; same activation pattern as a2a-ui.js / peer-admin-ui.js
 * (owner-only, MutationObserver on <body data-active-tab>, targets its own panel
 * by id). CRUD over the M3 admin routes:
 *
 *   GET    /api/admin/acp-agents       list (with runtime liveness)
 *   POST   /api/admin/acp-agents       register one (id is the dispatch target)
 *   PATCH  /api/admin/acp-agents/:id    enable/disable, edit command/args/cwd/caps
 *   DELETE /api/admin/acp-agents/:id    remove + unregister from the hub
 *
 * An outbound ACP agent is a LOCAL participant that drives a coding agent
 * (Claude Code / Codex) over a LONG-LIVED ACP session — spawn once, hold the
 * session, dispatch many tasks. Unlike A2A there is NOTHING secret to enter, not
 * even an env-var pointer: an ACP bridge rides the underlying agent's OWN login
 * (`claude` / `codex` already logged in on this machine), so the whole record
 * (command/args/cwd) is non-secret config shown in full. The badge stays honest —
 * a disabled row reads "已停用", not "在跑"; toggle it on (a PATCH) and the host
 * registers it on the running hub without a restart.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render a form that can't save.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time (app-core.js runs
  // synchronously before this panel is injected, so Gotong is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const API = '/api/admin/acp-agents'

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
  // args are whitespace-separated argv tokens; NOT comma-split (a comma can be a
  // legitimate character inside an argument). Quoting/embedded-space argv is an
  // edge case the MVP form doesn't model — edit the stored record directly for that.
  function parseArgs(s) {
    return String(s || '')
      .split(/\s+/)
      .filter(Boolean)
  }

  function setStatus(root, msg, kind) {
    const el = $('#acp-status', root)
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
      return '<span style="' + base + 'background:#e6f4ea;color:#1e7e34;">' + d.acpStRunning + '</span>'
    }
    const reason = a.inactiveReason
    const txt =
      reason === 'disabled'
        ? d.acpStDisabled
        : reason === 'id_conflict'
          ? d.acpStIdConflict
          : reason === 'not_found'
            ? d.acpStNotFound
            : d.acpStInactive
    return (
      '<span title="' + escHtml(reason || '') + '" style="' + base + 'background:#fdecea;color:#c0392b;">' +
      txt +
      '</span>'
    )
  }

  // Item 2 — the outbound-edge gate, rendered compact in one cell. ACP has just
  // two knobs (NO approval toggle — its per-tool dangerousToolGate already
  // escalates to the /me inbox, D5). For ACP the data-class gate is a GOVERNANCE
  // control over what classes of context get fed to a third-party coding agent,
  // not an org-egress gate (the agent runs as a local subprocess on its own
  // login). Both default-off, so a row with neither reads "—":
  //   data-class : null=unrestricted (omit) / []=locked / [names]=allowlist
  //   quota      : per-window dispatch budget (0/absent = off, runaway guard)
  function gateCell(a) {
    const d = t()
    const parts = []
    const dc = a.allowedDataClasses
    if (dc != null) {
      parts.push(dc.length === 0 ? d.acpGateDcLocked : d.acpGateDcList(dc.join(', ')))
    }
    if (a.outboundQuotaBudget != null && a.outboundQuotaBudget > 0) {
      parts.push(d.acpGateQuota(a.outboundQuotaBudget))
    }
    return parts.length
      ? '<span style="font-size:0.8rem;color:#555;">' + escHtml(parts.join(' · ')) + '</span>'
      : '<span style="font-size:0.8rem;color:#bbb;">' + d.acpGateNone + '</span>'
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
      '<h2 style="margin-top:0;">' + d.acpTitle + '</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">' + d.acpDesc + '</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;">' + d.acpKeyNote + '</p>' +
      '<div id="acp-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;color:#555;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">' + d.acpAddSummary + '</summary>' +
      '<form id="acp-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="id" type="text" placeholder="' + escHtml(d.acpPhId) + '" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="' + escHtml(d.acpPhLabel) + '" autocomplete="off" />' +
      '<input name="capabilities" type="text" placeholder="' + escHtml(d.acpPhCaps) + '" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="command" type="text" placeholder="' + escHtml(d.acpPhCommand) + '" required autocomplete="off" />' +
      '<input name="args" type="text" placeholder="' + escHtml(d.acpPhArgs) + '" autocomplete="off" />' +
      '<input name="cwd" type="text" placeholder="' + escHtml(d.acpPhCwd) + '" autocomplete="off" style="grid-column:1 / -1;" />' +
      // Item 2 — outbound-edge gate (data-class allowlist / quota; no approval, D5).
      '<input name="allowedDataClasses" type="text" placeholder="' + escHtml(d.acpPhDataClasses) + '" autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="outboundQuotaBudget" type="number" min="0" placeholder="' + escHtml(d.acpPhQuotaBudget) + '" autocomplete="off" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> ' + d.acpEnabledLabel + '</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">' + d.acpBtnRegister + '</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">' + d.acpRegisteredHeading + '</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">' + d.acpColIdLabel + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColCaps + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColCmd + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColCwd + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColGate + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColStatus + '</th>' +
      '<th style="padding:0.4rem;">' + d.acpColActions + '</th>' +
      '</tr></thead>' +
      '<tbody id="acp-tbody"><tr><td colspan="7" style="padding:0.6rem;color:#888;">' + d.acpLoading + '</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#acp-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, agents) {
    const d = t()
    const tbody = $('#acp-tbody', root)
    if (!tbody) return
    if (!agents.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" style="padding:0.6rem;color:#888;">' + escHtml(d.acpEmpty) + '</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const a of agents) {
      const idLabel = a.label
        ? escHtml(a.label) + ' <code style="color:#888;">' + escHtml(a.id) + '</code>'
        : '<code>' + escHtml(a.id) + '</code>'
      const caps = (a.capabilities || []).map(function (c) { return escHtml(c) }).join(', ')
      const cmdLine = escHtml([a.command].concat(a.args || []).join(' '))
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code style="color:#555;">' + caps + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + cmdLine + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.cwd || '—') + '</code></td>' +
        '<td style="padding:0.4rem;">' + gateCell(a) + '</td>' +
        '<td style="padding:0.4rem;">' + statusBadge(a) + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="acp-toggle" style="padding:0.25rem 0.5rem;">' +
        (a.enabled ? d.acpBtnDisable : d.acpBtnEnable) + '</button> ' +
        '<button type="button" class="acp-del" style="padding:0.25rem 0.5rem;color:#c0392b;">' + d.acpBtnDelete + '</button>' +
        '</td>'
      tr.querySelector('.acp-toggle').addEventListener('click', function () {
        doPatch(root, a.id, { enabled: !a.enabled }, a.enabled ? t().acpOkDisabled : t().acpOkEnabled)
      })
      tr.querySelector('.acp-del').addEventListener('click', function () {
        if (!window.confirm(t().acpConfirmDelete(a.label || a.id))) return
        doDelete(root, a.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, t().acpUnwired, 'error')
      return true
    }
    return false
  }

  async function load(root) {
    setStatus(root, t().acpLoadingStatus, 'loading')
    try {
      const agents = await apiList()
      renderRows(root, agents)
      const live = agents.filter(function (a) { return a.active }).length
      setStatus(root, t().acpLoadedStatus(agents.length, live), 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().acpLoadFailed(err.message || err), 'error')
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
      command: str('command'),
      args: parseArgs(str('args')),
      enabled: fd.get('enabled') != null,
    }
    // Optional: only send when filled, so the store keeps its default (null).
    const cwd = str('cwd')
    if (cwd) body.cwd = cwd
    const label = str('label')
    if (label) body.label = label
    // Item 2 — outbound-edge gate. Empty data-class → omit (default null =
    // unrestricted); a filled field → governance allowlist. (No [] via the form.)
    const dcs = parseCaps(str('allowedDataClasses'))
    if (dcs.length) body.allowedDataClasses = dcs
    // Empty quota → omit (no limit). A number (incl. 0 = off) → send.
    const qb = str('outboundQuotaBudget')
    if (qb !== '') {
      const n = parseInt(qb, 10)
      if (n >= 0) body.outboundQuotaBudget = n
    }
    setStatus(root, t().acpRegistering, 'loading')
    try {
      await apiAdd(body)
      form.reset()
      await load(root)
      setStatus(root, t().acpRegistered, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().acpRegisterFailed(err.message || err), 'error')
    }
  }

  async function doPatch(root, id, patch, okMsg) {
    setStatus(root, t().acpSaving, 'loading')
    try {
      await apiPatch(id, patch)
      await load(root)
      setStatus(root, okMsg || t().acpSaved, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().acpSaveFailed(err.message || err), 'error')
    }
  }

  async function doDelete(root, id) {
    setStatus(root, t().acpDeleting, 'loading')
    try {
      await apiDelete(id)
      await load(root)
      setStatus(root, t().acpDeleted, 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, t().acpDeleteFailed(err.message || err), 'error')
    }
  }

  // ---- activation (mirror a2a-ui.js) ------------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    // Target our own panel by id, not section[data-tab="federation"] — that
    // tab holds several panels (peer onboarding + manifest + A2A) and a bare
    // data-tab selector would grab whichever comes first.
    const root = document.querySelector('#acp-outbound-panel')
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
