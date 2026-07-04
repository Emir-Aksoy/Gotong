/**
 * Route B P1-M7b — peer onboarding (tab "联邦" in app.html, panel
 * #peer-admin-panel, above the read-only manifest browse).
 *
 * Self-contained module; same activation pattern as peer-manifest-ui.js
 * and saml-ui.js. Owner-only. CRUD over /api/admin/identity/peers:
 *   - list configured peers (peerId / endpoint / kind / enabled / connected)
 *   - add a peer (peerId + endpoint + shared bearer token + label + kind)
 *   - per row: enable / disable, rotate token, remove
 *
 * The shared bearer token is symmetric — mint it once with
 * `gotong mint-peer-token` (M7a) and register the SAME string on both
 * hubs. It is a SECRET: stored vault-encrypted, never returned by the
 * list route, so this panel never displays it (write-only — type it in
 * to set / rotate, never read back).
 *
 * Each row expands (button "策略") into the M7c trust-contract editor:
 * inbound ACL (capabilities + require-origin), outbound capability
 * allowlist, per-link inbound quota, data-class allowlist, callable-KB
 * allowlist, and revocation. All seven PATCH through the same route the
 * lifecycle actions use. Array fields follow one idiom — blank input =
 * null (the route's "default / all-allowed"), a comma list = an explicit
 * allowlist. (The []=lockdown state per axis is API-only; revoke the link
 * for a full deny.)
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time (app-core.js runs
  // synchronously before this panel is injected, so Gotong is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const API = '/api/admin/identity/peers'
  // PeerKind union (identity schema v12). Default 'service'.
  const KINDS = ['service', 'organization', 'project', 'personal']

  // ④-M1 pairing-code state. `selfInfo` = { hubId, wsPort } read once from
  // /api/federation/self; `pairToken` = the shared secret shown in the generate
  // box. Module-level so a language-switch rebuild (which re-runs buildUi and
  // wipes the DOM) re-seeds the same token instead of minting a new secret
  // mid-exchange.
  let selfInfo = null
  let pairToken = ''

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function setStatus(root, msg, kind) {
    const el = $('#pa-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'pa-status' + (kind ? ' pa-status-' + kind : '')
  }

  // Array policy fields use one idiom: a comma/space list ⇄ string[].
  // Blank ⇒ null, which the route reads as "default / all-allowed".
  function arrToText(arr) {
    return Array.isArray(arr) ? arr.join(', ') : ''
  }
  function textToArr(text) {
    const parts = String(text || '')
      .split(/[,\s]+/)
      .map(function (s) { return s.trim() })
      .filter(Boolean)
    return parts.length ? parts : null
  }

  // ---- API --------------------------------------------------------------

  async function readJson(r) {
    let json = null
    try { json = await r.json() } catch (_) { /* */ }
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || ('http ' + r.status)
      const err = new Error(msg)
      err.status = r.status
      throw err
    }
    return json
  }

  async function apiList() {
    const json = await readJson(await fetch(API))
    return (json && json.peers) || []
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
  async function apiPatch(id, body) {
    return readJson(
      await fetch(API + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }
  async function apiRemove(id) {
    return readJson(await fetch(API + '/' + encodeURIComponent(id), { method: 'DELETE' }))
  }

  // ④-M1 — best-effort read of this hub's own peerId + ws port to pre-fill the
  // pairing generate box. Non-fatal: if it 503s (personal mode) or fails, the
  // operator just types the fields by hand, so swallow everything to null.
  async function apiSelf() {
    try {
      const r = await fetch('/api/federation/self')
      if (!r.ok) return null
      return await r.json()
    } catch (_) {
      return null
    }
  }

  // ---- pairing code (ease-of-use ④-M1) ----------------------------------
  // Byte-identical mirror of packages/web/src/pairing-codec.ts — static files
  // can't import from src, so the transform is duplicated and the .ts unit test
  // pins the contract. A pairing code is a CONVENIENCE ENCODING, not a new
  // security mechanism: it just bundles { peerId, endpoint, token } into one
  // base64url string. The token is still the symmetric shared secret, carried
  // in the clear — treat the code exactly as you would the raw token.

  function b64urlFromBytes(bytes) {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function b64urlToString(code) {
    const b64 = String(code).replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }
  // 256-bit random token, same strength as `gotong mint-peer-token`.
  function genPairToken() {
    const bytes = new Uint8Array(32)
    ;(window.crypto || window.msCrypto).getRandomValues(bytes)
    return b64urlFromBytes(bytes)
  }
  // Keep the JSON key order { v, peerId, endpoint, token } identical to the .ts
  // codec so a code minted on one hub round-trips byte-for-byte on the other.
  function encodePairCode(input) {
    const peerId = String((input && input.peerId) || '').trim()
    const endpoint = String((input && input.endpoint) || '').trim()
    const token = String((input && input.token) || '').trim()
    if (!peerId || !endpoint || !token) throw new Error('peerId, endpoint and token are all required')
    const json = JSON.stringify({ v: 1, peerId: peerId, endpoint: endpoint, token: token })
    return b64urlFromBytes(new TextEncoder().encode(json))
  }
  function decodePairCode(code) {
    const trimmed = String(code || '').trim()
    if (!trimmed) throw new Error('empty pairing code')
    let parsed
    try {
      parsed = JSON.parse(b64urlToString(trimmed))
    } catch (_) {
      throw new Error('not a valid pairing code')
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not a valid pairing code')
    if (parsed.v !== 1) throw new Error('unsupported pairing-code version')
    const peerId = parsed.peerId
    const endpoint = parsed.endpoint
    const token = parsed.token
    if (
      typeof peerId !== 'string' ||
      typeof endpoint !== 'string' ||
      typeof token !== 'string' ||
      !peerId ||
      !endpoint ||
      !token
    ) {
      throw new Error('pairing code is missing peerId / endpoint / token')
    }
    return { peerId: peerId, endpoint: endpoint, token: token }
  }

  function pairingPanelHtml(d) {
    return (
      '<details class="pa-pair">' +
      '  <summary>' + escHtml(d.padmPairTitle) + '</summary>' +
      '  <p class="pa-pair-note">' + escHtml(d.padmPairNote) + '</p>' +
      '  <div class="pa-pair-accept">' +
      '    <label>' + escHtml(d.padmPairPasteLabel) +
      '      <textarea id="pa-pair-in" rows="2" placeholder="' + escHtml(d.padmPairPastePlaceholder) + '"></textarea></label>' +
      '    <button type="button" id="pa-pair-decode">' + escHtml(d.padmPairDecodeBtn) + '</button>' +
      '  </div>' +
      '  <div class="pa-pair-gen">' +
      '    <h3>' + escHtml(d.padmPairGenTitle) + '</h3>' +
      '    <div class="pa-pair-grid">' +
      '      <label>' + escHtml(d.padmPairMyId) +
      '        <input id="pa-pair-myid" type="text" readonly placeholder="' + escHtml(d.padmPairMyIdLoading) + '" /></label>' +
      '      <label>' + escHtml(d.padmPairMyEndpoint) + ' <small>' + escHtml(d.padmPairMyEndpointHint) + '</small>' +
      '        <input id="pa-pair-myendpoint" type="text" placeholder="wss://host:4000" /></label>' +
      '      <label>' + escHtml(d.padmPairToken) + ' <small>' + escHtml(d.padmPairTokenHint) + '</small>' +
      '        <input id="pa-pair-token" type="text" /></label>' +
      '      <button type="button" id="pa-pair-newtoken" class="pa-pair-newtoken">' + escHtml(d.padmPairNewToken) + '</button>' +
      '    </div>' +
      '    <button type="button" id="pa-pair-gen-btn">' + escHtml(d.padmPairGenBtn) + '</button>' +
      '    <div class="pa-pair-out-wrap" id="pa-pair-out-wrap" hidden>' +
      '      <label>' + escHtml(d.padmPairOutLabel) +
      '        <textarea id="pa-pair-out" rows="2" readonly></textarea></label>' +
      '      <button type="button" id="pa-pair-copy">' + escHtml(d.padmPairCopyBtn) + '</button>' +
      '    </div>' +
      '  </div>' +
      '</details>'
    )
  }

  // Fill the generate box from cached self info + the live token. Called on
  // first build, after the async self fetch lands, and on every lang rebuild.
  // Only writes blank fields so it never clobbers what the operator is editing.
  function fillSelf(root) {
    const idInput = $('#pa-pair-myid', root)
    if (idInput) idInput.value = (selfInfo && selfInfo.hubId) || ''
    const epInput = $('#pa-pair-myendpoint', root)
    if (epInput && !epInput.value) {
      const wsPort = (selfInfo && selfInfo.wsPort) || 4000
      epInput.value = 'wss://' + location.hostname + ':' + wsPort
    }
    const tokInput = $('#pa-pair-token', root)
    if (tokInput && !tokInput.value) tokInput.value = pairToken
  }

  function wirePairing(root) {
    if (!pairToken) pairToken = genPairToken()
    fillSelf(root)
    if (!selfInfo) {
      apiSelf().then(function (info) {
        if (info) {
          selfInfo = info
          fillSelf(root)
        }
      })
    }
    const decodeBtn = $('#pa-pair-decode', root)
    if (decodeBtn) decodeBtn.addEventListener('click', function () { onDecodePair(root) })
    const genBtn = $('#pa-pair-gen-btn', root)
    if (genBtn) genBtn.addEventListener('click', function () { onGenPair(root) })
    const newTokBtn = $('#pa-pair-newtoken', root)
    if (newTokBtn) {
      newTokBtn.addEventListener('click', function () {
        pairToken = genPairToken()
        const tokInput = $('#pa-pair-token', root)
        if (tokInput) tokInput.value = pairToken
      })
    }
    const copyBtn = $('#pa-pair-copy', root)
    if (copyBtn) copyBtn.addEventListener('click', function () { onCopyPair(root) })
  }

  function onDecodePair(root) {
    const raw = $('#pa-pair-in', root).value
    let decoded
    try {
      decoded = decodePairCode(raw)
    } catch (_) {
      setStatus(root, t().padmPairDecodeFailed, 'error')
      return
    }
    // Pre-fill the existing add-peer form — the operator confirms with 添加.
    $('#pa-peerId', root).value = decoded.peerId
    $('#pa-endpoint', root).value = decoded.endpoint
    $('#pa-token', root).value = decoded.token
    // Symmetric reuse: sync the inbound token into the generate box so the
    // reply code we hand back carries the SAME shared secret both sides enrol.
    pairToken = decoded.token
    const tokInput = $('#pa-pair-token', root)
    if (tokInput) tokInput.value = decoded.token
    const form = $('#pa-add-form', root)
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setStatus(root, t().padmPairDecoded, 'ok')
  }

  function onGenPair(root) {
    const peerId = ($('#pa-pair-myid', root).value || '').trim()
    const endpoint = ($('#pa-pair-myendpoint', root).value || '').trim()
    const token = ($('#pa-pair-token', root).value || '').trim()
    if (!peerId) { setStatus(root, t().padmPairNoSelfId, 'error'); return }
    if (!endpoint) { setStatus(root, t().padmPairNoEndpoint, 'error'); return }
    if (!token) { setStatus(root, t().padmPairNoToken, 'error'); return }
    let code
    try {
      code = encodePairCode({ peerId: peerId, endpoint: endpoint, token: token })
    } catch (_) {
      setStatus(root, t().padmPairGenFailed, 'error')
      return
    }
    pairToken = token
    const out = $('#pa-pair-out', root)
    if (out) out.value = code
    const outWrap = $('#pa-pair-out-wrap', root)
    if (outWrap) outWrap.hidden = false
    setStatus(root, t().padmPairGenerated, 'ok')
  }

  function onCopyPair(root) {
    const out = $('#pa-pair-out', root)
    if (!out || !out.value) return
    const done = function () { setStatus(root, t().padmPairCopied, 'ok') }
    const fallback = function () {
      out.select()
      try { document.execCommand('copy') } catch (_) { /* */ }
      done()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out.value).then(done, fallback)
    } else {
      fallback()
    }
  }

  // ---- render -----------------------------------------------------------

  function kindOptions(sel) {
    return KINDS.map(function (k) {
      return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + k + '</option>'
    }).join('')
  }

  function buildUi(root) {
    const d = t()
    root.innerHTML =
      '<header class="pa-header">' +
      '  <h2>' + escHtml(d.padmTitle) + '</h2>' +
      '  <p class="pa-meta">' + d.padmDesc + '</p>' +
      '  <span id="pa-status" class="pa-status"></span>' +
      '</header>' +
      '<form id="pa-add-form" class="pa-add-form" autocomplete="off">' +
      '  <div class="pa-field"><label>Peer ID' +
      '    <input id="pa-peerId" type="text" required placeholder="partner-hub" /></label></div>' +
      '  <div class="pa-field"><label>Endpoint URL' +
      '    <input id="pa-endpoint" type="text" required placeholder="wss://partner/federation" /></label></div>' +
      '  <div class="pa-field"><label>Peer Token (bearer)' +
      '    <input id="pa-token" type="password" required placeholder="gotong mint-peer-token" /></label></div>' +
      '  <div class="pa-field"><label>' + escHtml(d.padmLabelOptional) +
      '    <input id="pa-label" type="text" placeholder="' + escHtml(d.padmLabelPlaceholder) + '" /></label></div>' +
      '  <div class="pa-field"><label>' + escHtml(d.padmKind) +
      '    <select id="pa-kind">' + kindOptions('service') + '</select></label></div>' +
      '  <div class="pa-field pa-actions"><button id="pa-add-btn" type="submit">' + escHtml(d.padmAddBtn) + '</button></div>' +
      '</form>' +
      pairingPanelHtml(d) +
      '<section class="pa-list-wrap">' +
      '  <table class="pa-table">' +
      '    <thead><tr>' +
      '      <th>' + escHtml(d.padmColPeer) + '</th><th>Endpoint</th><th>' + escHtml(d.padmColKind) +
      '</th><th>' + escHtml(d.padmColState) + '</th><th>' + escHtml(d.padmColActions) + '</th>' +
      '    </tr></thead>' +
      '    <tbody id="pa-rows"><tr><td colspan="5" class="pa-empty">' + escHtml(d.padmLoadingCell) + '</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#pa-add-form', root).addEventListener('submit', function (e) {
      e.preventDefault()
      onAdd(root).catch(function () { /* setStatus handled it */ })
    })
    wirePairing(root)
  }

  function renderRows(root, peers) {
    const tbody = $('#pa-rows', root)
    if (!tbody) return
    if (!peers.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="pa-empty">' + escHtml(t().padmEmpty) + '</td></tr>'
      return
    }
    const d = t()
    tbody.innerHTML = ''
    for (const p of peers) {
      const idCell = p.label
        ? escHtml(p.label) + ' <code class="pa-id">' + escHtml(p.peerId) + '</code>'
        : '<code class="pa-id">' + escHtml(p.peerId) + '</code>'
      const enabled = p.enabled !== false
      const stateBits =
        '<span class="pa-badge ' + (enabled ? 'pa-on' : 'pa-off') + '">' +
        (enabled ? escHtml(d.padmStateEnabled) : escHtml(d.padmStateDisabled)) + '</span>' +
        '<span class="pa-badge ' + (p.connected ? 'pa-conn' : 'pa-disc') + '">' +
        (p.connected ? escHtml(d.padmStateOnline) : escHtml(d.padmStateOffline)) + '</span>' +
        (p.revocationState === 'revoked'
          ? '<span class="pa-badge pa-off">' + escHtml(d.padmStateRevoked) + '</span>' : '')
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td class="pa-peer">' + idCell + '</td>' +
        '<td class="pa-endpoint"><code>' + escHtml(p.endpointUrl) + '</code></td>' +
        '<td class="pa-kind">' + escHtml(p.kind || 'service') + '</td>' +
        '<td class="pa-state">' + stateBits + '</td>' +
        '<td class="pa-row-actions">' +
        '  <button type="button" class="pa-policy-toggle">' + escHtml(d.padmBtnPolicy) + '</button>' +
        '  <button type="button" class="pa-toggle">' + (enabled ? escHtml(d.padmBtnDisable) : escHtml(d.padmBtnEnable)) + '</button>' +
        '  <button type="button" class="pa-rotate">' + escHtml(d.padmBtnRotate) + '</button>' +
        '  <button type="button" class="pa-remove">' + escHtml(d.padmBtnRemove) + '</button>' +
        '</td>'
      // M7c — expandable trust-contract editor row, hidden until 策略 click.
      const detail = document.createElement('tr')
      detail.className = 'pa-policy-row'
      detail.hidden = true
      const cell = document.createElement('td')
      cell.colSpan = 5
      cell.innerHTML = policyEditorHtml(p)
      detail.appendChild(cell)
      tr.querySelector('.pa-policy-toggle').addEventListener('click', function () {
        detail.hidden = !detail.hidden
      })
      cell.querySelector('.pa-pol-save').addEventListener('click', function () {
        onSavePolicy(root, p.id, cell).catch(function () { /* setStatus handled it */ })
      })
      tr.querySelector('.pa-toggle').addEventListener('click', function () {
        doPatch(root, p.id, { enabled: !enabled }, enabled ? t().padmStateDisabled : t().padmStateEnabled)
      })
      tr.querySelector('.pa-rotate').addEventListener('click', function () {
        const tok = window.prompt(t().padmRotatePrompt)
        if (tok == null) return
        const trimmed = tok.trim()
        if (!trimmed) { setStatus(root, t().padmTokenEmpty, 'error'); return }
        doPatch(root, p.id, { peerToken: trimmed }, t().padmTokenRotated)
      })
      tr.querySelector('.pa-remove').addEventListener('click', function () {
        if (!window.confirm(t().padmConfirmRemove(p.label || p.peerId))) return
        doRemove(root, p.id)
      })
      tbody.appendChild(tr)
      tbody.appendChild(detail)
    }
  }

  // M7c — the per-link trust-contract editor (pre-filled from the list row;
  // every field is already in the GET response). escHtml doubles as attr
  // escaping (it encodes the double-quote).
  function policyEditorHtml(p) {
    const d = t()
    const acl = p.acl || {}
    const quota = p.perLinkQuotaBudget == null ? '' : String(p.perLinkQuotaBudget)
    const revoked = p.revocationState === 'revoked'
    return (
      '<div class="pa-policy">' +
      '  <div class="pa-policy-grid">' +
      '    <label>' + escHtml(d.padmPolAclCaps) + ' <small>' + escHtml(d.padmPolAclCapsHint) + '</small>' +
      '      <input class="pa-pol-aclcaps" type="text" value="' + escHtml(arrToText(acl.capabilities)) + '" /></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-requireorigin" type="checkbox"' +
      (acl.requireOrigin ? ' checked' : '') + ' /> ' + escHtml(d.padmPolRequireOrigin) + '</label>' +
      '    <label>' + escHtml(d.padmPolOutCaps) + ' <small>' + escHtml(d.padmPolOutCapsHint) + '</small>' +
      '      <input class="pa-pol-outcaps" type="text" value="' + escHtml(arrToText(p.outboundCaps)) + '" /></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-approve" type="checkbox"' +
      (p.requireApprovalOutbound ? ' checked' : '') + ' /> ' + escHtml(d.padmPolApprove) + '</label>' +
      '    <label>' + escHtml(d.padmPolDataClasses) + ' <small>' + escHtml(d.padmPolDataClassesHint) + '</small>' +
      '      <input class="pa-pol-dataclasses" type="text" value="' + escHtml(arrToText(p.allowedDataClasses)) + '" /></label>' +
      '    <label>' + escHtml(d.padmPolKb) + ' <small>' + escHtml(d.padmPolKbHint) + '</small>' +
      '      <input class="pa-pol-kb" type="text" value="' + escHtml(arrToText(p.allowedKnowledgeBases)) + '" /></label>' +
      '    <label>' + escHtml(d.padmPolQuota) + ' <small>' + escHtml(d.padmPolQuotaHint) + '</small>' +
      '      <input class="pa-pol-quota" type="number" min="0" step="1" value="' + escHtml(quota) + '" /></label>' +
      '    <label>' + escHtml(d.padmPolRevState) +
      '      <select class="pa-pol-revstate">' +
      '        <option value="active"' + (revoked ? '' : ' selected') + '>active</option>' +
      '        <option value="revoked"' + (revoked ? ' selected' : '') + '>revoked</option>' +
      '      </select></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-sharesummary" type="checkbox"' +
      (p.shareSummary ? ' checked' : '') + ' /> ' + escHtml(d.padmPolShareSummary) +
      ' <small>' + escHtml(d.padmPolShareSummaryHint) + '</small></label>' +
      // Stream G day-5 — opt-in to answer this peer's peer.transcript rpc with
      // one cross-hub task's execution trace. Strictly more revealing than the
      // summary's counts, so it is its own fail-closed flag (default off).
      '    <label class="pa-pol-check"><input class="pa-pol-sharetranscript" type="checkbox"' +
      (p.shareTranscript ? ' checked' : '') + ' /> ' + escHtml(d.padmPolShareTranscript) +
      ' <small>' + escHtml(d.padmPolShareTranscriptHint) + '</small></label>' +
      '  </div>' +
      '  <button type="button" class="pa-pol-save">' + escHtml(d.padmPolSave) + '</button>' +
      '</div>'
    )
  }

  async function onSavePolicy(root, id, detail) {
    const quotaRaw = $('.pa-pol-quota', detail).value.trim()
    let perLinkQuotaBudget = null
    if (quotaRaw !== '') {
      const n = Number(quotaRaw)
      if (!Number.isInteger(n) || n < 0) {
        setStatus(root, t().padmQuotaMustBeInt, 'error')
        return
      }
      perLinkQuotaBudget = n
    }
    const aclCaps = textToArr($('.pa-pol-aclcaps', detail).value)
    const acl = { requireOrigin: $('.pa-pol-requireorigin', detail).checked }
    if (aclCaps) acl.capabilities = aclCaps
    const body = {
      acl: acl,
      outboundCaps: textToArr($('.pa-pol-outcaps', detail).value),
      requireApprovalOutbound: $('.pa-pol-approve', detail).checked,
      allowedDataClasses: textToArr($('.pa-pol-dataclasses', detail).value),
      allowedKnowledgeBases: textToArr($('.pa-pol-kb', detail).value),
      perLinkQuotaBudget: perLinkQuotaBudget,
      revocationState: $('.pa-pol-revstate', detail).value,
      shareSummary: $('.pa-pol-sharesummary', detail).checked,
      shareTranscript: $('.pa-pol-sharetranscript', detail).checked,
    }
    setStatus(root, t().padmSavingPolicy, 'loading')
    try {
      await apiPatch(id, body)
      setStatus(root, t().padmPolicySaved, 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, t().padmPolicySaveFailed(err.message || err), 'error')
    }
  }

  // ---- mutations --------------------------------------------------------

  async function onAdd(root) {
    const peerId = $('#pa-peerId', root).value.trim()
    const endpointUrl = $('#pa-endpoint', root).value.trim()
    const peerToken = $('#pa-token', root).value
    const label = $('#pa-label', root).value.trim()
    const kind = $('#pa-kind', root).value
    if (!peerId || !endpointUrl || !peerToken) {
      setStatus(root, t().padmFieldsRequired, 'error')
      return
    }
    setStatus(root, t().padmAdding, 'loading')
    try {
      const body = { peerId: peerId, endpointUrl: endpointUrl, peerToken: peerToken, kind: kind }
      if (label) body.label = label
      await apiAdd(body)
      // Clear the secret field immediately; keep the form otherwise blank.
      $('#pa-add-form', root).reset()
      setStatus(root, t().padmAdded(peerId), 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, t().padmAddFailed(err.message || err), 'error')
    }
  }

  async function doPatch(root, id, body, okMsg) {
    setStatus(root, t().padmSaving, 'loading')
    try {
      await apiPatch(id, body)
      setStatus(root, okMsg || t().padmSaved, 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, t().padmSaveFailed(err.message || err), 'error')
    }
  }

  async function doRemove(root, id) {
    setStatus(root, t().padmRemoving, 'loading')
    try {
      await apiRemove(id)
      setStatus(root, t().padmRemoved, 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, t().padmRemoveFailed(err.message || err), 'error')
    }
  }

  // ---- load -------------------------------------------------------------

  async function load(root) {
    setStatus(root, t().padmLoading, 'loading')
    try {
      const peers = await apiList()
      renderRows(root, peers)
      setStatus(root, t().padmLoadedN(peers.length), 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, t().padmHostNoIdentity, 'error')
        return
      }
      setStatus(root, t().padmLoadFailed(err.message || err), 'error')
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
    const root = document.querySelector('#peer-admin-panel')
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
