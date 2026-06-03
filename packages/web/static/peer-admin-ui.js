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
 * `aipehub mint-peer-token` (M7a) and register the SAME string on both
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

  const API = '/api/admin/identity/peers'
  // PeerKind union (identity schema v12). Default 'service'.
  const KINDS = ['service', 'organization', 'project', 'personal']

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

  // ---- render -----------------------------------------------------------

  function kindOptions(sel) {
    return KINDS.map(function (k) {
      return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + k + '</option>'
    }).join('')
  }

  function buildUi(root) {
    root.innerHTML =
      '<header class="pa-header">' +
      '  <h2>对端 / Peers (联邦)</h2>' +
      '  <p class="pa-meta">登记本 hub 信任的联邦对端。认证是<strong>对称</strong>的:' +
      '同一 bearer token 两边各登记一次 —— 用 <code>aipehub mint-peer-token</code> 生成,' +
      '走安全信道交换。token 是 secret, 加密存 vault, <strong>永不回显</strong>(只能写入 / 轮换)。</p>' +
      '  <span id="pa-status" class="pa-status"></span>' +
      '</header>' +
      '<form id="pa-add-form" class="pa-add-form" autocomplete="off">' +
      '  <div class="pa-field"><label>Peer ID' +
      '    <input id="pa-peerId" type="text" required placeholder="partner-hub" /></label></div>' +
      '  <div class="pa-field"><label>Endpoint URL' +
      '    <input id="pa-endpoint" type="text" required placeholder="wss://partner/federation" /></label></div>' +
      '  <div class="pa-field"><label>Peer Token (bearer)' +
      '    <input id="pa-token" type="password" required placeholder="aipehub mint-peer-token" /></label></div>' +
      '  <div class="pa-field"><label>标签 (可选)' +
      '    <input id="pa-label" type="text" placeholder="合作方 hub" /></label></div>' +
      '  <div class="pa-field"><label>类型' +
      '    <select id="pa-kind">' + kindOptions('service') + '</select></label></div>' +
      '  <div class="pa-field pa-actions"><button id="pa-add-btn" type="submit">添加 peer</button></div>' +
      '</form>' +
      '<section class="pa-list-wrap">' +
      '  <table class="pa-table">' +
      '    <thead><tr>' +
      '      <th>对端</th><th>Endpoint</th><th>类型</th><th>状态</th><th>操作</th>' +
      '    </tr></thead>' +
      '    <tbody id="pa-rows"><tr><td colspan="5" class="pa-empty">加载中...</td></tr></tbody>' +
      '  </table>' +
      '</section>'

    $('#pa-add-form', root).addEventListener('submit', function (e) {
      e.preventDefault()
      onAdd(root).catch(function () { /* setStatus handled it */ })
    })
  }

  function renderRows(root, peers) {
    const tbody = $('#pa-rows', root)
    if (!tbody) return
    if (!peers.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="pa-empty">还没有已登记的 peer。用上面的表单添加一个。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const p of peers) {
      const idCell = p.label
        ? escHtml(p.label) + ' <code class="pa-id">' + escHtml(p.peerId) + '</code>'
        : '<code class="pa-id">' + escHtml(p.peerId) + '</code>'
      const enabled = p.enabled !== false
      const stateBits =
        '<span class="pa-badge ' + (enabled ? 'pa-on' : 'pa-off') + '">' +
        (enabled ? '已启用' : '已停用') + '</span>' +
        '<span class="pa-badge ' + (p.connected ? 'pa-conn' : 'pa-disc') + '">' +
        (p.connected ? '在线' : '离线') + '</span>' +
        (p.revocationState === 'revoked'
          ? '<span class="pa-badge pa-off">已撤销</span>' : '')
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td class="pa-peer">' + idCell + '</td>' +
        '<td class="pa-endpoint"><code>' + escHtml(p.endpointUrl) + '</code></td>' +
        '<td class="pa-kind">' + escHtml(p.kind || 'service') + '</td>' +
        '<td class="pa-state">' + stateBits + '</td>' +
        '<td class="pa-row-actions">' +
        '  <button type="button" class="pa-policy-toggle">策略</button>' +
        '  <button type="button" class="pa-toggle">' + (enabled ? '停用' : '启用') + '</button>' +
        '  <button type="button" class="pa-rotate">轮换 token</button>' +
        '  <button type="button" class="pa-remove">删除</button>' +
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
        doPatch(root, p.id, { enabled: !enabled }, enabled ? '已停用' : '已启用')
      })
      tr.querySelector('.pa-rotate').addEventListener('click', function () {
        const tok = window.prompt(
          '粘贴新的 peer token (用 `aipehub mint-peer-token` 生成)。\n两边都要换成同一新值。',
        )
        if (tok == null) return
        const trimmed = tok.trim()
        if (!trimmed) { setStatus(root, 'token 不能为空', 'error'); return }
        doPatch(root, p.id, { peerToken: trimmed }, 'token 已轮换')
      })
      tr.querySelector('.pa-remove').addEventListener('click', function () {
        if (!window.confirm('删除 peer ' + (p.label || p.peerId) + '? 链路会断开。')) return
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
    const acl = p.acl || {}
    const quota = p.perLinkQuotaBudget == null ? '' : String(p.perLinkQuotaBudget)
    const revoked = p.revocationState === 'revoked'
    return (
      '<div class="pa-policy">' +
      '  <div class="pa-policy-grid">' +
      '    <label>入站 ACL capabilities <small>(逗号分隔, 留空=接受全部)</small>' +
      '      <input class="pa-pol-aclcaps" type="text" value="' + escHtml(arrToText(acl.capabilities)) + '" /></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-requireorigin" type="checkbox"' +
      (acl.requireOrigin ? ' checked' : '') + ' /> 入站要求带 origin</label>' +
      '    <label>出站 capability 白名单 <small>(留空=全放)</small>' +
      '      <input class="pa-pol-outcaps" type="text" value="' + escHtml(arrToText(p.outboundCaps)) + '" /></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-approve" type="checkbox"' +
      (p.requireApprovalOutbound ? ' checked' : '') + ' /> 出站需人工审批</label>' +
      '    <label>允许的数据类 <small>(留空=全放)</small>' +
      '      <input class="pa-pol-dataclasses" type="text" value="' + escHtml(arrToText(p.allowedDataClasses)) + '" /></label>' +
      '    <label>可调用知识库 <small>(留空=全部可调)</small>' +
      '      <input class="pa-pol-kb" type="text" value="' + escHtml(arrToText(p.allowedKnowledgeBases)) + '" /></label>' +
      '    <label>每链路入站配额 <small>(非负整数, 留空=无限)</small>' +
      '      <input class="pa-pol-quota" type="number" min="0" step="1" value="' + escHtml(quota) + '" /></label>' +
      '    <label>撤销状态' +
      '      <select class="pa-pol-revstate">' +
      '        <option value="active"' + (revoked ? '' : ' selected') + '>active</option>' +
      '        <option value="revoked"' + (revoked ? ' selected' : '') + '>revoked</option>' +
      '      </select></label>' +
      '    <label class="pa-pol-check"><input class="pa-pol-sharesummary" type="checkbox"' +
      (p.shareSummary ? ' checked' : '') + ' /> 向该对端共享本 hub 摘要 <small>(仅计数, 控制面用)</small></label>' +
      '  </div>' +
      '  <button type="button" class="pa-pol-save">保存策略</button>' +
      '</div>'
    )
  }

  async function onSavePolicy(root, id, detail) {
    const quotaRaw = $('.pa-pol-quota', detail).value.trim()
    let perLinkQuotaBudget = null
    if (quotaRaw !== '') {
      const n = Number(quotaRaw)
      if (!Number.isInteger(n) || n < 0) {
        setStatus(root, '每链路配额必须是非负整数', 'error')
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
    }
    setStatus(root, '保存策略...', 'loading')
    try {
      await apiPatch(id, body)
      setStatus(root, '策略已保存', 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, '保存策略失败: ' + (err.message || err), 'error')
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
      setStatus(root, 'Peer ID / Endpoint / Token 都必填', 'error')
      return
    }
    setStatus(root, '添加中...', 'loading')
    try {
      const body = { peerId: peerId, endpointUrl: endpointUrl, peerToken: peerToken, kind: kind }
      if (label) body.label = label
      await apiAdd(body)
      // Clear the secret field immediately; keep the form otherwise blank.
      $('#pa-add-form', root).reset()
      setStatus(root, '已添加 ' + peerId, 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, '添加失败: ' + (err.message || err), 'error')
    }
  }

  async function doPatch(root, id, body, okMsg) {
    setStatus(root, '保存中...', 'loading')
    try {
      await apiPatch(id, body)
      setStatus(root, okMsg || '已保存', 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, '保存失败: ' + (err.message || err), 'error')
    }
  }

  async function doRemove(root, id) {
    setStatus(root, '删除中...', 'loading')
    try {
      await apiRemove(id)
      setStatus(root, '已删除', 'ok')
      await load(root)
    } catch (err) {
      setStatus(root, '删除失败: ' + (err.message || err), 'error')
    }
  }

  // ---- load -------------------------------------------------------------

  async function load(root) {
    setStatus(root, '加载...', 'loading')
    try {
      const peers = await apiList()
      renderRows(root, peers)
      setStatus(root, '已登记 ' + peers.length + ' 个 peer', 'ok')
    } catch (err) {
      if (err.status === 503) {
        renderRows(root, [])
        setStatus(root, 'host 未启用 identity / peer (个人模式)', 'error')
        return
      }
      setStatus(root, '加载失败: ' + (err.message || err), 'error')
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
