/**
 * /me — member-facing SPA. Self-contained, vanilla DOM, no framework.
 *
 * Three modes:
 *   1. Not signed in → show login form.
 *   2. Signed in → show whoami + dispatch + reports.
 *   3. IdentityStore not wired on host → show a clear error.
 *
 * The page reuses the v4 identity cookie (`aipehub_identity`) set by
 * POST /api/admin/identity/login. Once that cookie exists, every
 * subsequent `fetch(..., {credentials:'same-origin'})` carries it
 * automatically — no JS-side token handling.
 */
;(function () {
  'use strict'

  // ---- DOM helpers --------------------------------------------------------
  function $(sel) { return document.querySelector(sel) }
  function show(sel) { const el = $(sel); if (el) el.classList.remove('hidden') }
  function hide(sel) { const el = $(sel); if (el) el.classList.add('hidden') }
  function setStatus(msg, kind) {
    const el = $('#status')
    if (!el) return
    el.textContent = msg || ''
    el.className = 'status ' + (kind || '')
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function fmtBytes(n) {
    if (typeof n !== 'number') return '—'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }
  function fmtTime(ms) {
    if (typeof ms !== 'number') return '—'
    try { return new Date(ms).toLocaleString() } catch (_) { return String(ms) }
  }

  // ---- HTTP ---------------------------------------------------------------
  async function api(method, path, body) {
    const opts = { method: method, credentials: 'same-origin', headers: {} }
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(path, opts)
    if (res.status === 204) return null
    let json = null
    try { json = await res.json() } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(
        (json && (json.error || json.message)) || ('HTTP ' + res.status),
      )
      err.status = res.status
      err.code = json && json.code
      throw err
    }
    return json
  }

  // ---- State --------------------------------------------------------------
  let currentUser = null   // { id, email, displayName, ... } | null
  let allowedWorkflows = []

  // ---- Whoami / bootstrap -------------------------------------------------
  async function bootstrap() {
    try {
      const me = await api('GET', '/api/admin/identity/me')
      // v3-admin shows up with user:null + role:'owner' — bounce them
      // to /admin (the /me surface needs a v4 user id to scope cases).
      if (!me || !me.user) {
        showLoggedOut()
        return
      }
      currentUser = me.user
      currentUser.role = me.role
      currentUser.authSource = me.authSource
      await showLoggedIn()
    } catch (err) {
      if (err.status === 401) {
        showLoggedOut()
        return
      }
      if (err.status === 503) {
        setStatus(
          '该 Host 没有启用 v4 IdentityStore — /me 不可用。请先在 host 配置里启用 identity store。',
          'error',
        )
        return
      }
      setStatus('读取用户身份失败: ' + err.message, 'error')
    }
  }

  function showLoggedOut() {
    currentUser = null
    show('#login-section')
    hide('#me-section')
    hide('#dispatch-section')
    hide('#reports-section')
  }

  async function showLoggedIn() {
    hide('#login-section')
    show('#me-section')
    show('#dispatch-section')
    show('#reports-section')
    const info = $('#me-info')
    if (info) {
      const dn = currentUser.displayName ? ' / ' + currentUser.displayName : ''
      info.textContent = currentUser.email + dn + ' · ' + currentUser.role +
        ' · 来源 ' + currentUser.authSource
    }
    try {
      const out = await api('GET', '/api/me/allowed-workflows')
      allowedWorkflows = (out && out.workflows) || []
      renderWorkflowSelector()
    } catch (err) {
      setStatus('读取可用工作流失败: ' + err.message, 'error')
    }
    await refreshReports()
  }

  // ---- Login form ---------------------------------------------------------
  function wireLogin() {
    const form = $('#login-form')
    if (!form) return
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      setStatus('登录中…', '')
      try {
        await api('POST', '/api/admin/identity/login', {
          email: form.email.value.trim(),
          password: form.password.value,
        })
        setStatus('登录成功', 'ok')
        await bootstrap()
      } catch (err) {
        setStatus('登录失败: ' + err.message, 'error')
      }
    })
  }

  function wireLogout() {
    const btn = $('#logout-btn')
    if (!btn) return
    btn.addEventListener('click', async function () {
      try {
        await api('POST', '/api/admin/identity/logout')
        setStatus('已登出', 'ok')
        showLoggedOut()
      } catch (err) {
        setStatus('登出失败: ' + err.message, 'error')
      }
    })
  }

  // ---- Workflow dispatch --------------------------------------------------
  function renderWorkflowSelector() {
    const sel = $('#wf-select')
    if (!sel) return
    sel.innerHTML = ''
    if (allowedWorkflows.length === 0) {
      const opt = document.createElement('option')
      opt.textContent = '(没有可用的工作流)'
      opt.disabled = true
      sel.appendChild(opt)
      $('#dispatch-btn').disabled = true
      return
    }
    for (const wf of allowedWorkflows) {
      const opt = document.createElement('option')
      opt.value = wf.workflowId
      opt.textContent = wf.label + ' (' + wf.workflowId + ')'
      sel.appendChild(opt)
    }
    sel.addEventListener('change', renderFormFields)
    renderFormFields()
  }

  function renderFormFields() {
    const sel = $('#wf-select')
    const root = $('#wf-form-fields')
    if (!sel || !root) return
    const wf = allowedWorkflows.find(function (w) { return w.workflowId === sel.value })
    root.innerHTML = ''
    if (!wf) return
    for (const field of wf.payloadFields) {
      const wrap = document.createElement('div')
      const label = document.createElement('label')
      label.textContent = field
      const ta = document.createElement('textarea')
      ta.dataset.field = field
      ta.placeholder = '请填写 ' + field
      label.appendChild(ta)
      wrap.appendChild(label)
      root.appendChild(wrap)
    }
  }

  function wireDispatch() {
    const btn = $('#dispatch-btn')
    if (!btn) return
    btn.addEventListener('click', async function () {
      const sel = $('#wf-select')
      const root = $('#wf-form-fields')
      if (!sel || !root || !sel.value) return
      const payload = {}
      root.querySelectorAll('textarea[data-field]').forEach(function (ta) {
        const v = ta.value.trim()
        if (v) payload[ta.dataset.field] = v
      })
      if (Object.keys(payload).length === 0) {
        setStatus('请填写至少一个字段', 'error')
        return
      }
      setStatus('派发中…', '')
      try {
        const out = await api('POST', '/api/me/dispatch', {
          workflowId: sel.value,
          payload: payload,
        })
        setStatus(
          '已派发 — workflowId=' + out.workflowId + ', caseId=' + out.caseId +
            '。工作流正在跑,等 1-3 分钟后刷新报告区。',
          'ok',
        )
      } catch (err) {
        setStatus('派发失败: ' + err.message, 'error')
      }
    })
  }

  // ---- Reports ------------------------------------------------------------
  async function refreshReports() {
    const tbody = $('#reports-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="4" class="meta">载入中…</td></tr>'
    try {
      const out = await api('GET', '/api/me/growth-reports')
      const reports = (out && out.reports) || []
      if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="meta">还没有报告 — 触发一次工作流并等它跑完。</td></tr>'
        return
      }
      tbody.innerHTML = ''
      for (const r of reports) {
        const tr = document.createElement('tr')
        const fname = r.path.split('/').pop() || r.path
        const downloadUrl = '/api/me/growth-reports/download?path=' + encodeURIComponent(r.path)
        tr.innerHTML =
          '<td>' + escHtml(fname) + '</td>' +
          '<td>' + escHtml(fmtBytes(r.sizeBytes)) + '</td>' +
          '<td>' + escHtml(fmtTime(r.ts)) + '</td>' +
          '<td><a href="' + downloadUrl + '" target="_blank" rel="noopener">下载</a></td>'
        tbody.appendChild(tr)
      }
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="4" class="error">加载失败: ' + escHtml(err.message) + '</td></tr>'
      if (err.status === 503) {
        setStatus(
          '该 Host 没有加载 personal-growth team — 报告列表不可用。',
          'error',
        )
      }
    }
  }

  function wireRefreshReports() {
    const btn = $('#refresh-reports-btn')
    if (!btn) return
    btn.addEventListener('click', function () {
      refreshReports().catch(function () { /* status already set */ })
    })
  }

  // ---- Init ---------------------------------------------------------------
  function init() {
    wireLogin()
    wireLogout()
    wireDispatch()
    wireRefreshReports()
    bootstrap().catch(function (err) {
      setStatus('初始化失败: ' + err.message, 'error')
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
