/**
 * Route B P1-M5f-3 — SAML 2.0 IdP registry (tab "SAML" in app.html).
 *
 * Self-contained module; same activation pattern as oidc-ui.js /
 * peer-manifest-ui.js (owner-only tab, MutationObserver on
 * <body data-active-tab>). The hub is a SAML Service Provider here: the owner
 * registers the external IdPs it accepts assertions from. CRUD over the M5f-1
 * admin routes:
 *
 *   GET    /api/admin/saml/providers       list (cert included — it's public)
 *   POST   /api/admin/saml/providers       register one
 *   PATCH  /api/admin/saml/providers/:id    enable/disable, rotate cert/urls
 *   DELETE /api/admin/saml/providers/:id    remove
 *
 * Unlike OIDC there is NO secret to hide: `idpCert` is a PUBLIC X.509
 * verification key — pinning it is the whole security model, so the list
 * carries it in full and the owner can audit which cert is pinned. The IdP
 * posts assertions to the SP's ACS (a fixed host-configured URL), and a
 * per-provider "SP 元数据" link hands the IdP admin the entityID + ACS.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render a form that can't save.
 */
;(function () {
  'use strict'

  const API = '/api/admin/saml/providers'
  // The IdP must POST assertions to this path (the absolute URL is
  // host-configured via AIPE_PUBLIC_URL; M5e saml-routes.ts /acs). Shown as a
  // hint so the owner registers the matching ACS at the IdP.
  const ACS_PATH = '/api/auth/saml/acs'
  // Per-provider SP metadata (entityID + ACS) for the IdP admin to import.
  const METADATA_PATH = '/api/auth/saml/metadata'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // A short, stable preview of a PEM cert for the table (the full value sits in
  // the cell's title=). We strip the PEM armor + whitespace and show the head
  // of the base64 body — enough to eyeball "is this the cert I expect".
  function certPreview(pem) {
    const body = String(pem || '')
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '')
    if (!body) return '—'
    return body.slice(0, 16) + (body.length > 16 ? '…' : '')
  }

  function setStatus(root, msg, kind) {
    const el = $('#saml-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.className = 'saml-status' + (kind ? ' saml-status-' + kind : '')
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
      '<h2 style="margin-top:0;">单点登录 / SSO (SAML 2.0)</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">注册本 hub 接受 SAML 断言的外部身份提供方 (IdP)。' +
      '成员在登录页会看到「用 X 登录」按钮。<strong>SSO 只放已存在的本地用户进门</strong> —— ' +
      '按 IdP 签名断言里的邮箱匹配现有账号,绝不自动开户。</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;">断言接收地址 (ACS, 在 IdP 处登记): ' +
      '<code>' + escHtml(ACS_PATH) + '</code> —— 即 <code>https://&lt;你的域名&gt;' + escHtml(ACS_PATH) + '</code>。' +
      '注册后每行有「SP 元数据」链接可交给 IdP 管理员。</p>' +
      '<div id="saml-status" class="saml-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">注册 IdP</summary>' +
      '<form id="saml-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="idpEntityId" type="text" placeholder="IdP entityID (断言 Issuer)" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="显示名 (按钮文字, 可选)" autocomplete="off" />' +
      '<input name="ssoUrl" type="url" placeholder="SSO URL (HTTP-Redirect 端点)" required autocomplete="off" />' +
      '<input name="spEntityId" type="text" placeholder="SP entityID (本 hub, 断言 Audience)" required autocomplete="off" />' +
      '<textarea name="idpCert" placeholder="IdP 签名证书 (X.509 PEM, 公开验证钥)" required autocomplete="off" ' +
      'style="grid-column:1 / -1;min-height:6rem;font-family:monospace;font-size:0.78rem;"></textarea>' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> 启用 (成员登录页立即可见)</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">注册</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">已注册 IdP</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">标签 / EntityID</th>' +
      '<th style="padding:0.4rem;">SSO URL</th>' +
      '<th style="padding:0.4rem;">证书</th>' +
      '<th style="padding:0.4rem;">状态</th>' +
      '<th style="padding:0.4rem;">操作</th>' +
      '</tr></thead>' +
      '<tbody id="saml-tbody"><tr><td colspan="5" style="padding:0.6rem;color:#888;">载入中…</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#saml-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, providers) {
    const tbody = $('#saml-tbody', root)
    if (!tbody) return
    if (!providers.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="padding:0.6rem;color:#888;">还没有注册 IdP。在上面表单注册一个后,' +
        '成员登录页会出现对应的 SSO 按钮。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const p of providers) {
      const idLabel = p.label
        ? escHtml(p.label) + ' <code style="color:#888;">' + escHtml(p.idpEntityId) + '</code>'
        : '<code>' + escHtml(p.idpEntityId) + '</code>'
      const stateBadge = p.enabled
        ? '<span class="saml-badge saml-on">启用</span>'
        : '<span class="saml-badge saml-off">停用</span>'
      const metaUrl = METADATA_PATH + '?provider=' + encodeURIComponent(p.id)
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(p.ssoUrl) + '</code></td>' +
        '<td style="padding:0.4rem;"><code title="' + escHtml(p.idpCert) + '">' + escHtml(certPreview(p.idpCert)) + '</code></td>' +
        '<td style="padding:0.4rem;">' + stateBadge + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="saml-toggle" style="padding:0.25rem 0.5rem;">' +
        (p.enabled ? '停用' : '启用') + '</button> ' +
        '<button type="button" class="saml-cert" style="padding:0.25rem 0.5rem;">轮换证书</button> ' +
        '<a class="saml-meta" href="' + escHtml(metaUrl) + '" target="_blank" rel="noopener" ' +
        'style="padding:0.25rem 0.5rem;display:inline-block;">SP 元数据</a> ' +
        '<button type="button" class="saml-del" style="padding:0.25rem 0.5rem;color:#c0392b;">删除</button>' +
        '</td>'
      tr.querySelector('.saml-toggle').addEventListener('click', function () {
        doPatch(root, p.id, { enabled: !p.enabled }, p.enabled ? '已停用' : '已启用')
      })
      tr.querySelector('.saml-cert').addEventListener('click', function () {
        // The cert is public and round-trips fine; prompt is acceptable for the
        // occasional IdP key rotation (the owner pastes the new PEM).
        const next = window.prompt('粘贴新的 IdP 签名证书 (X.509 PEM):', '')
        if (next == null) return // cancelled
        const trimmed = next.trim()
        if (!trimmed) {
          setStatus(root, '证书不能为空 (留空已忽略)', 'error')
          return
        }
        doPatch(root, p.id, { idpCert: trimmed }, '证书已轮换')
      })
      tr.querySelector('.saml-del').addEventListener('click', function () {
        if (!window.confirm('删除 IdP「' + (p.label || p.idpEntityId) + '」? 已联结的用户将无法再用它登录。')) return
        doDelete(root, p.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, '此主机未启用身份存储 (SAML 不可用)', 'error')
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
      idpEntityId: str('idpEntityId'),
      ssoUrl: str('ssoUrl'),
      idpCert: str('idpCert'),
      spEntityId: str('spEntityId'),
      enabled: fd.get('enabled') != null,
    }
    // Optional: only send when filled, so the store keeps its default (null).
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

  // ---- activation (mirror oidc-ui.js) -----------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'saml'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    const root = document.querySelector('section[data-tab="saml"]')
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
