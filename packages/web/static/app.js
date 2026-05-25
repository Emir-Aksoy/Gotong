/* AipeHub — unified SPA orchestrator (C1).
 *
 * Boot order:
 *   1. Read the server-injected role meta (`<meta name="x-aipehub-role">`).
 *      Possible values:
 *        ''                 — anonymous (no v4 cookie or session expired)
 *        'owner'|'admin'    — full admin shell available
 *        'member'|'viewer'  — home + settings only
 *   2. If anonymous → render login shell, attach submit handler.
 *   3. Else → reveal tabbar + apply data-roles visibility filter,
 *      wire home + settings tabs, and for owner/admin lazy-load
 *      admin.js + identity-ui.js (they target #managed-agents etc.
 *      and would no-op for member/viewer).
 *
 * Security note: the role meta is render hint only. Every API call is
 * gated server-side; faking the meta gets you a visually broken page
 * but not access to a route you're not entitled to. This is the same
 * "client renders, server enforces" pattern admin.js has always used.
 */
(() => {
  const ROLE_META = document.querySelector('meta[name="x-aipehub-role"]')
  const role = (ROLE_META?.getAttribute('content') || '').trim()
  const ROLE_LABELS = { owner: '所有者', admin: '管理员', member: '成员', viewer: '只读' }
  const ADMIN_OR_OWNER = role === 'owner' || role === 'admin'
  const SIGNED_IN = role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer'

  // ---- DOM helpers ------------------------------------------------------
  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.from(document.querySelectorAll(sel))
  const setText = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt }
  const show = (el) => { if (el) el.hidden = false }
  const hide = (el) => { if (el) el.hidden = true }

  // ---- Apply role visibility filter ------------------------------------
  // Hide every [data-roles] element whose role list doesn't include the
  // viewer. Anonymous viewers get `data-roles="anonymous"` matches only.
  function applyRoleVisibility() {
    const visibleSet = SIGNED_IN ? new Set([role]) : new Set(['anonymous'])
    $$('[data-roles]').forEach((el) => {
      const allowed = (el.dataset.roles || '').split(',').map((s) => s.trim()).filter(Boolean)
      const shouldShow = allowed.some((r) => visibleSet.has(r))
      if (!shouldShow) {
        el.hidden = true
      } else {
        el.hidden = false
      }
    })
  }

  // ---- Role badge + subtitle -------------------------------------------
  function renderRoleBadge() {
    const badge = $('#role-badge')
    const subtitle = $('#role-subtitle')
    if (!SIGNED_IN) {
      if (badge) badge.textContent = ''
      if (subtitle) subtitle.textContent = '未登录'
      return
    }
    if (badge) {
      badge.textContent = ROLE_LABELS[role] || role
      badge.classList.add(`role-${role}`)
    }
    if (subtitle) {
      subtitle.textContent =
        role === 'owner' || role === 'admin' ? '管理员控制台' : '我的工作流'
    }
  }

  // ---- Anonymous login --------------------------------------------------
  function attachLoginForm() {
    const form = document.getElementById('login-form')
    if (!form) return
    const status = document.getElementById('login-status')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      status.className = 'login-status'
      status.textContent = '登录中…'
      const fd = new FormData(form)
      const body = JSON.stringify({
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
      })
      try {
        const r = await fetch('/api/admin/identity/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          status.className = 'login-status error'
          status.textContent = j?.error || `登录失败 (HTTP ${r.status})`
          return
        }
        status.className = 'login-status ok'
        status.textContent = '登录成功,正在加载…'
        // Reload so the server re-renders with the role meta injected.
        window.location.reload()
      } catch (err) {
        status.className = 'login-status error'
        status.textContent = `登录失败: ${err?.message || err}`
      }
    })
  }

  // ---- Logout (header button + settings button) ------------------------
  async function doLogout() {
    try {
      await fetch('/api/admin/identity/logout', { method: 'POST' })
    } catch { /* best-effort */ }
    // Belt-and-suspenders: also clear the v3 admin cookie if present.
    try {
      await fetch('/api/admin/logout', { method: 'POST' })
    } catch { /* best-effort */ }
    window.location.href = '/'
  }

  function attachLogout() {
    document.getElementById('logout-btn')?.addEventListener('click', doLogout)
    document.getElementById('settings-logout-btn')?.addEventListener('click', doLogout)
  }

  // ---- Tab nav (hash-driven, identical contract to admin.js) -----------
  //
  // admin.js owns the hash listener for its own tabs (overview/agents/
  // workflows/tasks/activity/services/users). Our orchestrator owns
  // hash-driven activation for the C1-only tabs (home, settings) AND
  // computes the default tab on first paint based on role. We do NOT
  // remove admin.js's hashchange listener — both fire on each change;
  // each only acts on tabs it knows about.
  const C1_TABS = new Set(['home', 'settings'])
  const ADMIN_TABS = new Set(['overview', 'agents', 'workflows', 'tasks', 'activity', 'services', 'users'])

  function defaultTabForRole() {
    if (ADMIN_OR_OWNER) return 'overview'
    return 'home'
  }

  // Single-source-of-truth tab switcher. Toggles `.tab-hidden` on every
  // `<section data-tab=…>` and `.active` on each tabbar button. Matches
  // admin.js's setActiveTab contract exactly (we coexist in the same DOM).
  function setActiveTab(name) {
    const validAdminTab = ADMIN_OR_OWNER && ADMIN_TABS.has(name)
    const validC1Tab = C1_TABS.has(name)
    if (!validAdminTab && !validC1Tab) {
      name = defaultTabForRole()
    }
    $$('section[data-tab]').forEach((sec) => {
      const matches = (sec.dataset.tab || '') === name
      sec.classList.toggle('tab-hidden', !matches)
    })
    $$('.tabbar-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn.dataset.tab || '') === name)
    })
    document.body.dataset.activeTab = name
  }

  function currentTabFromHash() {
    const h = (window.location.hash || '').slice(1)
    if (ADMIN_OR_OWNER && ADMIN_TABS.has(h)) return h
    if (C1_TABS.has(h)) return h
    return defaultTabForRole()
  }

  function wireTabs() {
    $$('.tabbar-btn:not([hidden])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.tab
        if (!name) return
        // Setting hash triggers hashchange → setActiveTab below.
        if (window.location.hash !== `#${name}`) {
          window.location.hash = name
        } else {
          setActiveTab(name)
        }
      })
    })
    window.addEventListener('hashchange', () => setActiveTab(currentTabFromHash()))
    setActiveTab(currentTabFromHash())
  }

  // ---- Home tab — port of /me functionality (whoami / dispatch / reports)
  //
  // Mirrors me.js conceptually but uses the C1 DOM ids and reuses the
  // /api/me/* routes verbatim — the server-side caseId=userId scoping
  // is non-negotiable and stays in me-routes.ts unchanged.

  async function renderHome() {
    if (!SIGNED_IN) return
    await renderWhoami()
    await loadAllowedWorkflows()
    await loadMyReports()
    document.getElementById('me-dispatch-btn')?.addEventListener('click', submitDispatch)
    document.getElementById('me-refresh-reports-btn')?.addEventListener('click', loadMyReports)
  }

  async function renderWhoami() {
    const info = document.getElementById('me-info')
    if (!info) return
    try {
      const r = await fetch('/api/admin/identity/me')
      if (!r.ok) { info.textContent = '加载失败'; return }
      const j = await r.json()
      const u = j?.user || j
      info.innerHTML = `
        <strong>${escape(u.displayName || u.email || u.id || '')}</strong>
        · ${escape(u.email || '')}
        · 角色 <code>${escape(u.role || role)}</code>
        ${u.id ? `· userId <code>${escape(u.id)}</code>` : ''}
      `
    } catch (err) {
      info.textContent = `加载失败: ${err?.message || err}`
    }
  }

  let __allowedWorkflows = []
  async function loadAllowedWorkflows() {
    const sel = document.getElementById('me-wf-select')
    const fields = document.getElementById('me-wf-form-fields')
    if (!sel || !fields) return
    sel.innerHTML = '<option>加载中…</option>'
    try {
      const r = await fetch('/api/me/allowed-workflows')
      if (!r.ok) {
        sel.innerHTML = '<option>无可用工作流</option>'
        fields.innerHTML = ''
        return
      }
      const j = await r.json()
      __allowedWorkflows = Array.isArray(j?.workflows) ? j.workflows : []
      if (__allowedWorkflows.length === 0) {
        sel.innerHTML = '<option>暂无 owner 分配的工作流</option>'
        fields.innerHTML = ''
        return
      }
      sel.innerHTML = __allowedWorkflows
        .map((w) => `<option value="${escape(w.id)}">${escape(w.label || w.id)}</option>`)
        .join('')
      sel.addEventListener('change', renderWorkflowFields)
      renderWorkflowFields()
    } catch (err) {
      sel.innerHTML = `<option>加载失败: ${escape(err?.message || String(err))}</option>`
    }
  }

  function renderWorkflowFields() {
    const sel = document.getElementById('me-wf-select')
    const fields = document.getElementById('me-wf-form-fields')
    if (!sel || !fields) return
    const wf = __allowedWorkflows.find((w) => w.id === sel.value)
    if (!wf || !Array.isArray(wf.payloadFields) || wf.payloadFields.length === 0) {
      fields.innerHTML = '<p class="me-meta">该工作流不需要额外字段。</p>'
      return
    }
    fields.innerHTML = wf.payloadFields
      .map(
        (f) => `
          <label>${escape(f.label || f.name)}${f.required ? ' *' : ''}
            <textarea name="${escape(f.name)}" placeholder="${escape(f.placeholder || '')}"${f.required ? ' required' : ''}></textarea>
          </label>`,
      )
      .join('')
  }

  async function submitDispatch() {
    const sel = document.getElementById('me-wf-select')
    const fields = document.getElementById('me-wf-form-fields')
    const status = document.getElementById('me-dispatch-status')
    if (!sel || !fields || !status) return
    if (!sel.value) {
      status.className = 'me-status error'
      status.textContent = '请先选择一个工作流'
      return
    }
    const payload = {}
    fields.querySelectorAll('textarea[name]').forEach((ta) => {
      payload[ta.name] = ta.value
    })
    status.className = 'me-status'
    status.textContent = '提交中…'
    try {
      const r = await fetch('/api/me/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: sel.value, payload }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        status.className = 'me-status error'
        status.textContent = j?.error || `派发失败 (HTTP ${r.status})`
        return
      }
      status.className = 'me-status ok'
      status.textContent = `已派发,运行 id: ${j?.runId || j?.taskId || 'ok'}`
      // Refresh reports — the new run might already have produced an artifact
      // for fast workflows; for slow ones the user can hit refresh later.
      setTimeout(loadMyReports, 800)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = `派发失败: ${err?.message || err}`
    }
  }

  async function loadMyReports() {
    const tbody = document.getElementById('me-reports-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="4" class="me-meta">加载中…</td></tr>'
    try {
      const r = await fetch('/api/me/growth-reports')
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">加载失败 (HTTP ${r.status})</td></tr>`
        return
      }
      const j = await r.json()
      const reports = Array.isArray(j?.reports) ? j.reports : []
      if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="me-meta">还没有报告 — 派发一次工作流试试。</td></tr>'
        return
      }
      tbody.innerHTML = reports
        .map(
          (r) => `
            <tr>
              <td>${escape(r.filename || r.path || '?')}</td>
              <td>${formatBytes(r.size)}</td>
              <td>${escape(formatTs(r.modifiedAt || r.createdAt))}</td>
              <td><a href="/api/me/growth-reports/download?path=${encodeURIComponent(r.path || '')}" download>下载</a></td>
            </tr>`,
        )
        .join('')
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="me-meta">加载失败: ${escape(err?.message || String(err))}</td></tr>`
    }
  }

  // ---- Settings tab -----------------------------------------------------
  async function renderSettings() {
    if (!SIGNED_IN) return
    const acct = document.getElementById('settings-account')
    if (acct) {
      try {
        const r = await fetch('/api/admin/identity/me')
        if (r.ok) {
          const j = await r.json()
          const u = j?.user || j
          acct.innerHTML = `
            ${escape(u.displayName || '')} · ${escape(u.email || '')} · 角色 <code>${escape(u.role || role)}</code>
          `
        }
      } catch { /* meh */ }
    }
    document.getElementById('settings-password-form')?.addEventListener('submit', submitPasswordChange)
  }

  async function submitPasswordChange(e) {
    e.preventDefault()
    const form = e.currentTarget
    const status = document.getElementById('settings-password-status')
    status.className = 'me-status'
    status.textContent = '提交中…'
    const fd = new FormData(form)
    try {
      const r = await fetch('/api/admin/identity/me/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: String(fd.get('current') || ''),
          newPassword: String(fd.get('next') || ''),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        status.className = 'me-status error'
        status.textContent = j?.error || `修改失败 (HTTP ${r.status})`
        return
      }
      status.className = 'me-status ok'
      status.textContent = '密码已更新'
      form.reset()
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = `修改失败: ${err?.message || err}`
    }
  }

  // ---- Dynamic load of admin.js + identity-ui.js -----------------------
  //
  // Loaded only when role permits — these bundles target #managed-agents
  // / #users-panel DOM verbatim and their init paths assume the admin
  // shell is real. Loading them for member/viewer would either no-op
  // silently (best case) or throw on missing DOM (worst case).
  function loadAdminBundles() {
    if (!ADMIN_OR_OWNER) return
    const inject = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = reject
      document.head.appendChild(s)
    })
    // Order matters: admin.js depends on window.AipeHub from app-core.js
    // (already loaded via the synchronous <script defer> tag above us);
    // identity-ui.js depends on the users-panel DOM that admin.html
    // declares. We just chain.
    inject('/admin.js')
      .then(() => inject('/identity-ui.js'))
      .catch((err) => {
        console.error('[app] failed to load admin bundles', err)
      })
  }

  // ---- Tiny utilities --------------------------------------------------
  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }
  function formatTs(t) {
    if (!t) return '—'
    try {
      const d = typeof t === 'number' ? new Date(t) : new Date(String(t))
      if (Number.isNaN(d.getTime())) return String(t)
      return d.toLocaleString()
    } catch { return String(t) }
  }

  // ---- Boot ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    renderRoleBadge()
    applyRoleVisibility()
    if (!SIGNED_IN) {
      attachLoginForm()
      return
    }
    // Signed in — reveal tabbar and wire everything.
    show($('#admin-tabbar'))
    wireTabs()
    attachLogout()
    renderHome().catch((err) => console.error('[app] renderHome failed', err))
    renderSettings().catch((err) => console.error('[app] renderSettings failed', err))
    loadAdminBundles()
  })
})()
