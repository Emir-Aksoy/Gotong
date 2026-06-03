/**
 * Route B P1-M4f-3 — OIDC identity-provider registry (tab "SSO" in app.html).
 *
 * Self-contained module; same activation pattern as peer-manifest-ui.js /
 * reputation-ui.js (owner-only tab, MutationObserver on <body data-active-tab>).
 * The hub is a Relying Party here: the owner registers the external IdPs it
 * accepts single sign-on from. CRUD over the M4f-1 admin routes:
 *
 *   GET    /api/admin/oidc/providers       list (never carries the secret)
 *   POST   /api/admin/oidc/providers       register one
 *   PATCH  /api/admin/oidc/providers/:id    enable/disable, rotate/clear secret
 *   DELETE /api/admin/oidc/providers/:id    remove
 *
 * The client_secret is WRITE-ONLY: the list only ever tells us `hasClientSecret`
 * (a boolean), never the value. A blank secret = a public / PKCE-only client.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render an empty form that can't save.
 *
 * ~190 LOC; auditable in one pass.
 */
;(function () {
  'use strict'

  const API = '/api/admin/oidc/providers'
  // The login callback the IdP must redirect back to. The redirect URI the
  // owner registers here AND at the IdP has to point at this path (M4e-2
  // oidc-routes.ts). Shown as a hint so they don't guess.
  const CALLBACK_PATH = '/api/auth/oidc/callback'

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
    const el = $('#oidc-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'oidc-status' + (kind ? ' oidc-status-' + kind : '')
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
    return (await readJson(await fetch(API))).providers || []
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
    root.innerHTML =
      '<div style="padding:1rem;max-width:64rem;">' +
      '<h2 style="margin-top:0;">单点登录 / SSO (OIDC)</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">注册本 hub 接受单点登录的外部身份提供方 (IdP)。' +
      '成员在登录页会看到「用 X 登录」按钮。<strong>SSO 只放已存在的本地用户进门</strong> —— ' +
      '按 IdP 断言的已验证邮箱匹配现有账号,绝不自动开户。</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;">回调地址 (在 IdP 处也要登记同一个): ' +
      '<code>' + escHtml(CALLBACK_PATH) + '</code> —— 即 <code>https://&lt;你的域名&gt;' + escHtml(CALLBACK_PATH) + '</code></p>' +
      '<div id="oidc-status" class="oidc-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">注册 IdP</summary>' +
      '<form id="oidc-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="issuer" type="url" placeholder="issuer (https://accounts.google.com)" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="显示名 (按钮文字, 可选)" autocomplete="off" />' +
      '<input name="clientId" type="text" placeholder="client_id" required autocomplete="off" />' +
      '<input name="redirectUri" type="url" placeholder="redirect_uri (…' + escHtml(CALLBACK_PATH) + ')" required autocomplete="off" />' +
      '<input name="scope" type="text" placeholder="scope (留空=openid email profile)" autocomplete="off" />' +
      '<input name="clientSecret" type="password" placeholder="client_secret (留空=公开/PKCE 客户端)" autocomplete="new-password" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> 启用 (成员登录页立即可见)</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">注册</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">已注册 IdP</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">标签 / Issuer</th>' +
      '<th style="padding:0.4rem;">Client ID</th>' +
      '<th style="padding:0.4rem;">Scope</th>' +
      '<th style="padding:0.4rem;">状态</th>' +
      '<th style="padding:0.4rem;">密钥</th>' +
      '<th style="padding:0.4rem;">操作</th>' +
      '</tr></thead>' +
      '<tbody id="oidc-tbody"><tr><td colspan="6" style="padding:0.6rem;color:#888;">载入中…</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#oidc-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, providers) {
    const tbody = $('#oidc-tbody', root)
    if (!tbody) return
    if (!providers.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="padding:0.6rem;color:#888;">还没有注册 IdP。在上面表单注册一个后,' +
        '成员登录页会出现对应的 SSO 按钮。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const p of providers) {
      const idLabel = p.label
        ? escHtml(p.label) + ' <code style="color:#888;">' + escHtml(p.issuer) + '</code>'
        : '<code>' + escHtml(p.issuer) + '</code>'
      const stateBadge = p.enabled
        ? '<span class="oidc-badge oidc-on">启用</span>'
        : '<span class="oidc-badge oidc-off">停用</span>'
      const secretBadge = p.hasClientSecret
        ? '<span class="oidc-badge oidc-on">有</span>'
        : '<span class="oidc-badge oidc-off">公开</span>'
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code>' + escHtml(p.clientId) + '</code></td>' +
        '<td style="padding:0.4rem;">' + escHtml(p.scope || '—') + '</td>' +
        '<td style="padding:0.4rem;">' + stateBadge + '</td>' +
        '<td style="padding:0.4rem;">' + secretBadge + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="oidc-toggle" style="padding:0.25rem 0.5rem;">' +
        (p.enabled ? '停用' : '启用') + '</button> ' +
        '<button type="button" class="oidc-secret" style="padding:0.25rem 0.5rem;">轮换密钥</button> ' +
        '<button type="button" class="oidc-del" style="padding:0.25rem 0.5rem;color:#c0392b;">删除</button>' +
        '</td>'
      tr.querySelector('.oidc-toggle').addEventListener('click', function () {
        doPatch(root, p.id, { enabled: !p.enabled }, p.enabled ? '已停用' : '已启用')
      })
      tr.querySelector('.oidc-secret').addEventListener('click', function () {
        // Prompt is fine here: the secret is write-only and never round-trips.
        // An empty string demotes the provider back to a public/PKCE client.
        const next = window.prompt('输入新的 client_secret (留空=改为公开/PKCE 客户端):', '')
        if (next == null) return // cancelled
        doPatch(root, p.id, { clientSecret: next }, next ? '密钥已轮换' : '已改为公开客户端')
      })
      tr.querySelector('.oidc-del').addEventListener('click', function () {
        if (!window.confirm('删除 IdP「' + (p.label || p.issuer) + '」? 已联结的用户将无法再用它登录。')) return
        doDelete(root, p.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, '此主机未启用身份存储 (OIDC 不可用)', 'error')
      return true
    }
    return false
  }

  async function load(root) {
    setStatus(root, '载入…', 'loading')
    try {
      const providers = await apiList()
      renderRows(root, providers)
      setStatus(root, '已注册 ' + providers.length + ' 个 IdP', 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, '载入失败:' + (err.message || err), 'error')
    }
  }

  async function handleAdd(root, e) {
    e.preventDefault()
    const form = e.target
    const fd = new FormData(form)
    const str = function (k) { return String(fd.get(k) || '').trim() }
    const body = {
      issuer: str('issuer'),
      clientId: str('clientId'),
      redirectUri: str('redirectUri'),
      enabled: fd.get('enabled') != null,
    }
    // Optional fields: only send when filled, so the store keeps its defaults.
    const scope = str('scope')
    if (scope) body.scope = scope
    const secret = str('clientSecret')
    if (secret) body.clientSecret = secret
    const label = str('label')
    if (label) body.label = label
    setStatus(root, '注册…', 'loading')
    try {
      await apiAdd(body)
      form.reset()
      await load(root)
      setStatus(root, '已注册', 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, '注册失败:' + (err.message || err), 'error')
    }
  }

  async function doPatch(root, id, patch, okMsg) {
    setStatus(root, '保存…', 'loading')
    try {
      await apiPatch(id, patch)
      await load(root)
      setStatus(root, okMsg || '已保存', 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, '保存失败:' + (err.message || err), 'error')
    }
  }

  async function doDelete(root, id) {
    setStatus(root, '删除…', 'loading')
    try {
      await apiDelete(id)
      await load(root)
      setStatus(root, '已删除', 'ok')
    } catch (err) {
      if (unwired(root, err)) return
      setStatus(root, '删除失败:' + (err.message || err), 'error')
    }
  }

  // ---- activation (mirror peer-manifest-ui.js) --------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'oidc'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    const root = document.querySelector('section[data-tab="oidc"]')
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
