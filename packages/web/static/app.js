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

  // ---- Shared formatters from app-core.js's window.AipeHub -------------
  // escapeHtml is aliased to the historical local name `escape`; formatBytes
  // is the guarded copy. R14 — these were 3 duplicated local defs.
  const { escapeHtml: escape, formatBytes, formatTs } = window.AipeHub

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

  // ---- A2.3 — first-time setup wizard ----------------------------------
  //
  // Detect whether we're in bootstrap mode (single user, no password yet).
  // If yes, show the wizard instead of the login form. Resolves to true
  // when the SPA continues with the wizard (caller should NOT also
  // attach the login form).
  async function maybeStartSetupWizard() {
    try {
      const r = await fetch('/api/setup/needs-bootstrap')
      if (!r.ok) return false
      const j = await r.json()
      if (!j?.bootstrap) return false
    } catch {
      return false
    }
    // Bootstrap mode — hide login shell, show wizard.
    const loginShell = document.getElementById('login-shell')
    const wizard = document.getElementById('setup-wizard')
    if (loginShell) loginShell.hidden = true
    if (wizard) wizard.hidden = false
    attachSetupForm()
    return true
  }

  function attachSetupForm() {
    const form = document.getElementById('setup-form')
    if (!form) return
    const status = document.getElementById('setup-status')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      status.className = 'login-status'
      status.textContent = '设置中…'
      const fd = new FormData(form)
      const password = String(fd.get('password') || '')
      const confirm = String(fd.get('confirm') || '')
      if (password !== confirm) {
        status.className = 'login-status error'
        status.textContent = '两次密码不一致'
        return
      }
      if (password.length < 12) {
        status.className = 'login-status error'
        status.textContent = '密码至少 12 位'
        return
      }
      try {
        const r = await fetch('/api/setup/owner-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          status.className = 'login-status error'
          status.textContent = j?.error || `设置失败 (HTTP ${r.status})`
          return
        }
        status.className = 'login-status ok'
        status.textContent = '密码已设,现在去登录…'
        // Swap to the login form so the operator can sign in with the
        // newly-set password. Reload picks up an empty cookie state (no
        // session yet) and renders the login shell.
        setTimeout(() => { window.location.reload() }, 700)
      } catch (err) {
        status.className = 'login-status error'
        status.textContent = `设置失败: ${err?.message || err}`
      }
    })
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

  // ---- Tab nav (hash-driven, sole router for the whole console) --------
  //
  // R14b — this orchestrator owns the ONE tab router: it wires the tabbar
  // clicks + the single hashchange listener and drives setActiveTab across
  // BOTH families (admin tabs overview/agents/workflows/tasks/activity/
  // services/users AND the C1-only home/settings). admin.js used to run a
  // second setActiveTab + hashchange of its own — both fired on every
  // change and, since admin.js loads later, it stomped C1 tabs back to
  // overview. Now setActiveTab dispatches `aipehub:tabchange` and admin.js
  // just listens for its per-tab side effects. See window.AipeHub.gotoTab.
  //
  // ADMIN_TABS must list EVERY admin-shell tabbar button so the router can
  // activate it. `quotas` / `reputation` are real tabs whose sections are
  // populated by the lazy-loaded quotas-ui.js / reputation-ui.js bundles
  // (they observe <body data-active-tab> and refresh when it flips to their
  // name). Neither router used to include them, so clicking those buttons
  // just fell through to overview — R14b folds them into the one router.
  const C1_TABS = new Set(['home', 'settings'])
  const ADMIN_TABS = new Set(['overview', 'agents', 'workflows', 'tasks', 'activity', 'services', 'users', 'quotas', 'reputation'])

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
    // Notify subscribers (admin.js) of the resolved tab so they can run
    // per-tab side effects (e.g. refresh growth reports on 'workflows')
    // without owning a competing router.
    window.dispatchEvent(new CustomEvent('aipehub:tabchange', { detail: { name } }))
  }

  function currentTabFromHash() {
    const h = (window.location.hash || '').slice(1)
    if (ADMIN_OR_OWNER && ADMIN_TABS.has(h)) return h
    if (C1_TABS.has(h)) return h
    return defaultTabForRole()
  }

  // Programmatic navigation. Mirrors a tabbar click: set the hash
  // (→ hashchange → setActiveTab) unless we're already there, in which
  // case switch directly. Exposed on window.AipeHub so admin.js can do
  // cross-tab jumps (e.g. click a task_result row → open the Tasks tab).
  function gotoTab(name) {
    if (window.location.hash !== `#${name}`) {
      window.location.hash = name
    } else {
      setActiveTab(name)
    }
  }

  function wireTabs() {
    $$('.tabbar-btn:not([hidden])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.tab
        if (name) gotoTab(name)
      })
    })
    window.addEventListener('hashchange', () => setActiveTab(currentTabFromHash()))
    setActiveTab(currentTabFromHash())
  }

  // Publish gotoTab for admin.js (lazy-loaded later in boot). app-core.js
  // already created window.AipeHub by the time this IIFE evaluates — line ~37
  // destructures from it, so it's guaranteed present here. We expose only
  // gotoTab (not setActiveTab): callers must go through the hash so the URL
  // stays in sync — a bare setActiveTab would diverge body state from #hash.
  window.AipeHub.gotoTab = gotoTab

  // ---- Home tab — port of /me functionality (whoami / dispatch / reports)
  //
  // Mirrors me.js conceptually but uses the C1 DOM ids and reuses the
  // /api/me/* routes verbatim — the server-side caseId=userId scoping
  // is non-negotiable and stays in me-routes.ts unchanged.

  async function renderHome() {
    if (!SIGNED_IN) return
    await renderWhoami()
    await loadMyWorkflows()
    await loadMyRuns()
    await loadMyInbox()
    await loadMyReports()
    await loadMyAgents()
    document.getElementById('me-dispatch-btn')?.addEventListener('click', submitDispatch)
    document.getElementById('me-refresh-reports-btn')?.addEventListener('click', loadMyReports)
    document.getElementById('me-runs-refresh-btn')?.addEventListener('click', loadMyRuns)
    document.getElementById('me-agents-refresh-btn')?.addEventListener('click', loadMyAgents)
    document.getElementById('me-inbox-refresh-btn')?.addEventListener('click', loadMyInbox)
    // Delegated: the list is re-rendered, but #me-inbox-list is stable.
    document.getElementById('me-inbox-list')?.addEventListener('click', onInboxClick)
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

  // Member-facing workflow catalog (Phase 14). DERIVED server-side from
  // workflows declaring surface.me.enabled for this caller's role — the
  // generic replacement for the old hardcoded allowlist. Each entry is
  // the PUBLIC projection: { id, label, description?, inputSchema } —
  // capability / userScopeField are deliberately NOT exposed.
  let __myWorkflows = []
  async function loadMyWorkflows() {
    const sel = document.getElementById('me-wf-select')
    const fields = document.getElementById('me-wf-form-fields')
    if (!sel || !fields) return
    sel.innerHTML = '<option>加载中…</option>'
    try {
      const r = await fetch('/api/me/workflows')
      if (!r.ok) {
        sel.innerHTML = '<option value="">无可用工作流</option>'
        fields.innerHTML = ''
        return
      }
      const j = await r.json()
      __myWorkflows = Array.isArray(j?.workflows) ? j.workflows : []
      if (__myWorkflows.length === 0) {
        sel.innerHTML = '<option value="">暂无可用工作流</option>'
        fields.innerHTML =
          '<p class="me-meta">还没有面向成员的工作流 — 管理员可在工作流定义里开启 <code>surface.me</code>。</p>'
        return
      }
      sel.innerHTML = __myWorkflows
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
    const wf = __myWorkflows.find((w) => w.id === sel.value)
    const schema = wf && Array.isArray(wf.inputSchema) ? wf.inputSchema : []
    const desc = wf && wf.description ? `<p class="me-meta">${escape(wf.description)}</p>` : ''
    if (schema.length === 0) {
      fields.innerHTML = desc + '<p class="me-meta">该工作流不需要额外字段。</p>'
      return
    }
    fields.innerHTML = desc + schema.map(renderField).join('')
  }

  // Render one PayloadFieldSpec (the surface.me.inputSchema element shape)
  // as a labelled control. The payload key is `f.id` — NOT `f.name`; the
  // scope key is never in this list (forced server-side), so a member can
  // only ever run for themselves. `data-type` is read back at submit so
  // numbers go out as numbers.
  function renderField(f) {
    const id = f && f.id
    if (!id) return ''
    const idAttr = escape(id)
    const req = f.required ? ' *' : ''
    const reqAttr = f.required ? ' required' : ''
    const ph = escape(f.placeholder || '')
    const hint = f.hint ? `<small class="me-meta">${escape(f.hint)}</small>` : ''
    let control
    switch (f.type) {
      case 'textarea':
        control = `<textarea name="${idAttr}" data-type="textarea" rows="${Number(f.rows) || 4}" placeholder="${ph}"${reqAttr}></textarea>`
        break
      case 'number':
        control = `<input type="number" name="${idAttr}" data-type="number" placeholder="${ph}"${reqAttr}>`
        break
      case 'select': {
        const opts = Array.isArray(f.options) ? f.options : []
        control = `<select name="${idAttr}" data-type="select"${reqAttr}>${opts
          .map((o) => `<option value="${escape(o.value)}">${escape(o.label || o.value)}</option>`)
          .join('')}</select>`
        break
      }
      case 'file': {
        // Phase 19 P1-M5 — real uploader. The file is read at submit time
        // (submitDispatch uploads to /api/me/uploads → sends a file_ref block),
        // mirroring the admin wf-start form, so a file picked but never
        // submitted leaves no orphan artifact.
        const accept = f.accept ? ` accept="${escape(f.accept)}"` : ''
        const cap = typeof f.maxSizeMb === 'number' ? `<small class="me-meta">（≤ ${escape(String(f.maxSizeMb))} MB）</small>` : ''
        control = `<input type="file" name="${idAttr}" data-type="file"${accept}${reqAttr}>${cap}<small class="me-upload-status" data-upload-status></small>`
        break
      }
      default: // 'text'
        control = `<input type="text" name="${idAttr}" data-type="text" placeholder="${ph}"${reqAttr}>`
    }
    return `<label>${escape(f.label || id)}${req}\n${control}\n${hint}</label>`
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
    status.className = 'me-status'
    status.textContent = '提交中…'
    // File fields upload at submit time (→ file_ref block), so we can't use a
    // sync forEach: a failed/required-missing upload aborts the whole dispatch.
    for (const el of fields.querySelectorAll('[name]')) {
      const key = el.getAttribute('name')
      if (!key) continue
      const dtype = el.getAttribute('data-type')
      if (dtype === 'file') {
        const ok = await collectFileField(el, key, payload, status)
        if (!ok) return // upload failed / required missing — message already set
        continue
      }
      if (dtype === 'number') {
        if (el.value === '') continue // leave unset rather than send NaN
        payload[key] = Number(el.value)
        continue
      }
      payload[key] = el.value
    }
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
      // Also refresh the runs list so the just-triggered run shows up.
      setTimeout(loadMyReports, 800)
      setTimeout(loadMyRuns, 800)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = `派发失败: ${err?.message || err}`
    }
  }

  // Upload a file-type field's selected file to /api/me/uploads and stash the
  // resulting file_ref block into `payload[key]`. Returns false (with a status
  // message set) when a required file is missing or the upload fails, so the
  // caller aborts the dispatch. Mirrors the admin wf-start file contract.
  async function collectFileField(el, key, payload, status) {
    const files = el.files
    const label = el.closest('label')
    const statusEl = label ? label.querySelector('[data-upload-status]') : null
    const setUpload = (cls, text) => {
      if (!statusEl) return
      statusEl.className = `me-upload-status${cls ? ` ${cls}` : ''}`
      statusEl.textContent = text
    }
    if (!files || files.length === 0) {
      if (el.hasAttribute('required')) {
        status.className = 'me-status error'
        status.textContent = `请为「${key}」选择一个文件`
        return false
      }
      return true // optional + empty → leave the field unset
    }
    const file = files[0]
    try {
      setUpload('', '上传中…')
      const ref = await uploadMyFile(file)
      setUpload('ok', `已上传:${file.name}(${formatBytes(ref.size)})`)
      payload[key] = { type: 'file_ref', artifactId: ref.artifactId, mime: ref.mime }
      return true
    } catch (err) {
      setUpload('error', `上传失败:${err?.message || err}`)
      status.className = 'me-status error'
      status.textContent = `文件上传失败:${err?.message || err}`
      return false
    }
  }

  // POST one File to /api/me/uploads (scoped to me/<userId> server-side) →
  // { artifactId, mime, size }. Mirrors admin uploadOneFile but on the member
  // route: don't set content-type explicitly so the browser fills it from
  // File.type (the server reads ?mime first, then the header).
  async function uploadMyFile(file) {
    const params = new URLSearchParams()
    params.set('filename', file.name)
    if (file.type) params.set('mime', file.type)
    const r = await fetch(`/api/me/uploads?${params.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* keep HTTP msg */ }
      throw new Error(msg)
    }
    return r.json()
  }

  // Member recent runs (Phase 19 P1-M2). Lists the caller's own workflow runs,
  // newest first — server-scoped, so a member never sees another user's runs.
  async function loadMyRuns() {
    const tbody = document.getElementById('me-runs-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="4" class="me-meta">加载中…</td></tr>'
    try {
      const r = await fetch('/api/me/runs')
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">加载失败 (HTTP ${r.status})</td></tr>`
        return
      }
      const j = await r.json()
      const runs = Array.isArray(j?.runs) ? j.runs : []
      if (runs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="me-meta">还没有运行记录 — 上面发起一次工作流试试。</td></tr>'
        return
      }
      tbody.innerHTML = runs
        .map(
          (run) => `
            <tr>
              <td>${escape(run.workflowId || '?')}</td>
              <td>${renderRunStatus(run.status)}</td>
              <td>${escape(formatTs(run.startedAt))}</td>
              <td>${run.endedAt ? escape(formatTs(run.endedAt)) : '<span class="me-meta">进行中</span>'}</td>
            </tr>`,
        )
        .join('')
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="me-meta">加载失败: ${escape(err?.message || String(err))}</td></tr>`
    }
  }

  // Map a RunStatus to a coloured pill. Falls back to the raw status string so a
  // future status value still renders (just without a dedicated colour).
  const ME_RUN_STATUS_LABELS = {
    running: '进行中', done: '已完成', failed: '失败', cancelled: '已取消', suspended: '挂起',
  }
  function renderRunStatus(status) {
    const s = status || 'unknown'
    const label = ME_RUN_STATUS_LABELS[s] || s
    return `<span class="me-run-status me-run-${escape(s)}">${escape(label)}</span>`
  }

  // Member task inbox (Phase 16). Lists the caller's pending human-in-the-loop
  // steps; resolving one POSTs the decision and the parked workflow resumes.
  async function loadMyInbox() {
    const list = document.getElementById('me-inbox-list')
    const count = document.getElementById('me-inbox-count')
    if (!list) return
    list.innerHTML = '<p class="me-meta">加载中…</p>'
    try {
      const r = await fetch('/api/me/inbox')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">加载失败 (HTTP ${r.status})</p>`
        if (count) count.textContent = ''
        return
      }
      const j = await r.json()
      const items = Array.isArray(j?.items) ? j.items : []
      if (count) count.textContent = items.length ? String(items.length) : ''
      if (items.length === 0) {
        list.innerHTML = '<p class="me-meta">暂无待处理任务。</p>'
        return
      }
      list.innerHTML = items.map(renderInboxItem).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">加载失败: ${escape(err?.message || String(err))}</p>`
    }
  }

  // Render one pending item with controls keyed to its kind. The decision shape
  // is validated server-side against the item's kind; `data-*` carry the ids.
  function renderInboxItem(item) {
    const id = escape(item.itemId || '')
    const heading = item.title ? `<strong>${escape(item.title)}</strong>` : ''
    const prompt = `<p class="me-inbox-prompt">${escape(item.prompt || '')}</p>`
    // inbox-gov M2 — if this was handed off, show the context the delegator left.
    const handoff = item.handoffNote
      ? `<p class="me-inbox-handoff">📨 交接说明：${escape(item.handoffNote)}</p>`
      : ''
    let controls = ''
    if (item.kind === 'approval') {
      // inbox-gov M3 — three outcomes. The comment is optional for approve /
      // reject but REQUIRED for "退回修改" (request changes), validated both
      // client- and server-side.
      controls = `
        <div class="me-inbox-approval">
          <textarea data-inbox-approval-comment rows="2" placeholder="意见（退回修改时必填）"></textarea>
          <div class="me-inbox-actions">
            <button type="button" class="me-primary-btn" data-inbox-approve="${id}">批准</button>
            <button type="button" class="me-secondary-btn" data-inbox-changes="${id}">退回修改</button>
            <button type="button" class="me-secondary-btn" data-inbox-reject="${id}">拒绝</button>
          </div>
        </div>`
    } else if (item.kind === 'choice') {
      const opts = Array.isArray(item.options) ? item.options : []
      controls = `<div class="me-inbox-actions">${opts
        .map(
          (o) =>
            `<button type="button" class="me-secondary-btn" data-inbox-choice="${id}" data-value="${escape(o.value)}">${escape(o.label || o.value)}</button>`,
        )
        .join('')}</div>`
    } else if (item.kind === 'edit') {
      const ef = item.editField || {}
      const def = escape(ef.defaultValue || '')
      const ph = escape(ef.placeholder || '')
      const control = ef.multiline
        ? `<textarea data-inbox-edit-field rows="4" placeholder="${ph}">${def}</textarea>`
        : `<input type="text" data-inbox-edit-field placeholder="${ph}" value="${def}">`
      controls = `<div class="me-inbox-edit">${control}<button type="button" class="me-primary-btn" data-inbox-edit="${id}">提交</button></div>`
    }
    // inbox-gov M2 — every pending item can be handed off to another member by
    // email (a toggle keeps the form out of the way until needed).
    const delegate = `
      <div class="me-inbox-delegate">
        <button type="button" class="me-link-btn" data-inbox-delegate-toggle="${id}">转派给他人…</button>
        <div class="me-inbox-delegate-form" data-inbox-delegate-form hidden>
          <input type="email" data-inbox-delegate-email placeholder="对方邮箱" autocomplete="off">
          <input type="text" data-inbox-delegate-note placeholder="交接说明（可选）">
          <button type="button" class="me-secondary-btn" data-inbox-delegate-submit="${id}">确认转派</button>
        </div>
      </div>`
    return `
      <div class="me-inbox-item" data-inbox-item="${id}">
        ${heading}${handoff}${prompt}${controls}${delegate}
        <div class="me-status" data-inbox-status></div>
      </div>`
  }

  function onInboxClick(ev) {
    const t = ev.target
    if (!t || !t.getAttribute) return
    // inbox-gov M3 — approval comment (shared by approve / reject / changes).
    const approvalComment = (id) => {
      const item = t.closest('.me-inbox-item')
      const field = item ? item.querySelector('[data-inbox-approval-comment]') : null
      return field ? field.value.trim() : ''
    }
    const approve = t.getAttribute('data-inbox-approve')
    if (approve) {
      const c = approvalComment(approve)
      const d = { kind: 'approval', approved: true }
      if (c) d.comment = c
      return resolveInbox(approve, d, t)
    }
    const reject = t.getAttribute('data-inbox-reject')
    if (reject) {
      const c = approvalComment(reject)
      const d = { kind: 'approval', approved: false }
      if (c) d.comment = c
      return resolveInbox(reject, d, t)
    }
    const changes = t.getAttribute('data-inbox-changes')
    if (changes) {
      const c = approvalComment(changes)
      if (!c) {
        const item = t.closest('.me-inbox-item')
        const statusEl = item ? item.querySelector('[data-inbox-status]') : null
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = '退回修改需要填写意见' }
        return
      }
      return resolveInbox(changes, { kind: 'approval', approved: false, changesRequested: true, comment: c }, t)
    }
    const choice = t.getAttribute('data-inbox-choice')
    if (choice) {
      return resolveInbox(choice, { kind: 'choice', value: t.getAttribute('data-value') || '' }, t)
    }
    const edit = t.getAttribute('data-inbox-edit')
    if (edit) {
      const item = t.closest('.me-inbox-item')
      const field = item ? item.querySelector('[data-inbox-edit-field]') : null
      return resolveInbox(edit, { kind: 'edit', value: field ? field.value : '' }, t)
    }
    // inbox-gov M2 — toggle the delegate form, or submit a handoff.
    const delegToggle = t.getAttribute('data-inbox-delegate-toggle')
    if (delegToggle) {
      const item = t.closest('.me-inbox-item')
      const form = item ? item.querySelector('[data-inbox-delegate-form]') : null
      if (form) form.hidden = !form.hidden
      return
    }
    const delegSubmit = t.getAttribute('data-inbox-delegate-submit')
    if (delegSubmit) {
      const item = t.closest('.me-inbox-item')
      const emailEl = item ? item.querySelector('[data-inbox-delegate-email]') : null
      const noteEl = item ? item.querySelector('[data-inbox-delegate-note]') : null
      return delegateInbox(delegSubmit, emailEl ? emailEl.value : '', noteEl ? noteEl.value : '', t)
    }
  }

  async function resolveInbox(itemId, decision, fromEl) {
    const itemEl = fromEl && fromEl.closest ? fromEl.closest('.me-inbox-item') : null
    const statusEl = itemEl ? itemEl.querySelector('[data-inbox-status]') : null
    const setButtons = (disabled) => {
      if (itemEl) itemEl.querySelectorAll('button').forEach((b) => { b.disabled = disabled })
    }
    if (statusEl) { statusEl.className = 'me-status'; statusEl.textContent = '提交中…' }
    setButtons(true) // guard against a double-submit while in flight
    try {
      const r = await fetch(`/api/me/inbox/${encodeURIComponent(itemId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = j?.error || `处理失败 (HTTP ${r.status})` }
        setButtons(false)
        return
      }
      // Resolved — refresh the list (updates count + empty state).
      await loadMyInbox()
    } catch (err) {
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = `处理失败: ${err?.message || err}` }
      setButtons(false)
    }
  }

  // inbox-gov M2 — hand a pending item off to another member by email. On
  // success the item leaves the caller's list (re-fetched), landing in the
  // target's inbox with the note as its handoff context.
  async function delegateInbox(itemId, toEmail, note, fromEl) {
    const itemEl = fromEl && fromEl.closest ? fromEl.closest('.me-inbox-item') : null
    const statusEl = itemEl ? itemEl.querySelector('[data-inbox-status]') : null
    const email = (toEmail || '').trim()
    if (!email) {
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = '请填写对方邮箱' }
      return
    }
    const setButtons = (disabled) => {
      if (itemEl) itemEl.querySelectorAll('button').forEach((b) => { b.disabled = disabled })
    }
    if (statusEl) { statusEl.className = 'me-status'; statusEl.textContent = '转派中…' }
    setButtons(true)
    try {
      const body = { toEmail: email }
      const trimmedNote = (note || '').trim()
      if (trimmedNote) body.note = trimmedNote
      const r = await fetch(`/api/me/inbox/${encodeURIComponent(itemId)}/delegate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = j?.error || `转派失败 (HTTP ${r.status})` }
        setButtons(false)
        return
      }
      // Handed off — it's no longer mine; refresh updates count + empty state.
      await loadMyInbox()
    } catch (err) {
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = `转派失败: ${err?.message || err}` }
      setButtons(false)
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

  // Member agent directory (Phase 19 P1-M3). Shows the sanitized "my AI helpers"
  // list — capabilities + online state only; the host already stripped prompts /
  // keys / model config, so nothing sensitive reaches the client.
  async function loadMyAgents() {
    const list = document.getElementById('me-agents-list')
    if (!list) return
    list.innerHTML = '<p class="me-meta">加载中…</p>'
    try {
      const r = await fetch('/api/me/agents')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">加载失败 (HTTP ${r.status})</p>`
        return
      }
      const j = await r.json()
      const agents = Array.isArray(j?.agents) ? j.agents : []
      if (agents.length === 0) {
        list.innerHTML = '<p class="me-meta">还没有可用的 AI 助手 — 管理员可在「智能体」里创建。</p>'
        return
      }
      list.innerHTML = agents.map(renderAgentCard).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">加载失败: ${escape(err?.message || String(err))}</p>`
    }
  }

  function renderAgentCard(a) {
    const caps = Array.isArray(a.capabilities) ? a.capabilities : []
    const capChips = caps.length
      ? caps.map((c) => `<span class="me-cap-chip">${escape(c)}</span>`).join('')
      : '<span class="me-meta">无</span>'
    const desc = a.description ? `<p class="me-meta">${escape(a.description)}</p>` : ''
    const dotCls = a.online ? 'me-agent-online' : 'me-agent-offline'
    const onlineLabel = a.online ? '在线' : '离线'
    // v5 D-M4 — read-only "this helper wakes itself on a cadence" badge.
    const heartbeatBadge = a.heartbeat?.enabled
      ? '<span class="me-heartbeat-badge" title="定时唤醒已开启">⏰ 定时</span>'
      : ''
    return `
      <div class="me-agent-card">
        <div class="me-agent-head">
          <span class="me-agent-dot ${dotCls}" title="${onlineLabel}"></span>
          <strong>${escape(a.label || a.id)}</strong>
          ${heartbeatBadge}
        </div>
        ${desc}
        <div class="me-agent-caps">${capChips}</div>
      </div>`
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
    // admin-wf-assist.js registers window.AipeHub.installWorkflowAssist
    // which admin.js then calls at IIFE init time — so it MUST load before
    // admin.js; identity-ui.js depends on the users-panel DOM that
    // admin.html declares. We just chain.
    inject('/admin-wf-assist.js')
      .then(() => inject('/admin.js'))
      .then(() => inject('/identity-ui.js'))
      .then(() => inject('/quotas-ui.js'))
      .then(() => inject('/reputation-ui.js'))
      .then(() => inject('/usage-ui.js'))
      .then(() => inject('/peer-manifest-ui.js'))
      .catch((err) => {
        console.error('[app] failed to load admin bundles', err)
      })
  }

  // ---- Boot ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    renderRoleBadge()
    applyRoleVisibility()
    if (!SIGNED_IN) {
      // Bootstrap mode takes precedence — when the host is freshly
      // booted and the owner has no password, we skip the login form
      // (it would 401 the operator anyway) and walk them through the
      // setup wizard. If maybeStartSetupWizard returns false we're in
      // the normal anonymous case → attach the login form.
      const wizardStarted = await maybeStartSetupWizard()
      if (!wizardStarted) attachLoginForm()
      return
    }
    // Signed in — reveal tabbar and wire everything.
    show($('#admin-tabbar'))
    wireTabs()
    attachLogout()
    // Phase 7 M5 — fetch org mode and apply body class. Drives CSS
    // overrides (personal mode hides role badge + tweaks subtitle copy)
    // and decides whether to render the "升级到团队" button.
    applyOrgMode().catch((err) => console.warn('[app] applyOrgMode failed', err))
    renderHome().catch((err) => console.error('[app] renderHome failed', err))
    renderSettings().catch((err) => console.error('[app] renderSettings failed', err))
    loadAdminBundles()
  })

  // Phase 7 M5 — org mode body-class + upgrade-button wiring.
  // Calls GET /api/me/mode (signed-in only), sets body.mode-personal or
  // body.mode-team, and injects an "升级到团队" button when the caller
  // is owner AND mode is personal.
  async function applyOrgMode() {
    let info = { mode: 'team', canUpgrade: false }
    try {
      const r = await fetch('/api/me/mode')
      if (r.ok) info = await r.json()
    } catch (err) {
      console.warn('[app] /api/me/mode failed', err)
    }
    const body = document.body
    body.classList.remove('mode-personal', 'mode-team')
    body.classList.add(`mode-${info.mode}`)
    // Subtitle copy: personal mode users shouldn't see "管理员控制台"
    // even when they're owner — that's a team concept.
    const subtitle = $('#role-subtitle')
    if (subtitle && info.mode === 'personal') {
      subtitle.textContent = '我的 AI 桌面'
    }
    // Upgrade button — injected into settings tab when applicable.
    if (info.canUpgrade) {
      wireUpgradeButton()
    }
  }

  function wireUpgradeButton() {
    // Find a stable injection point in settings; if the settings tab
    // hasn't rendered yet, retry on next tick.
    const slot = $('#settings-upgrade-slot')
    if (!slot) {
      setTimeout(wireUpgradeButton, 100)
      return
    }
    if (slot.dataset.wired === '1') return
    slot.dataset.wired = '1'
    slot.innerHTML =
      '<button id="upgrade-team-btn" type="button" class="btn-primary">升级到团队模式</button>' +
      '<p class="hint">升级后 admin 控制台显示完整管理 tab。' +
      '可以邀请其他用户/接入跨 hub peer/配额管理。不可一键回退。</p>' +
      '<span id="upgrade-status" class="login-status"></span>'
    const btn = $('#upgrade-team-btn')
    const status = $('#upgrade-status')
    btn?.addEventListener('click', async () => {
      if (!window.confirm('确定升级到团队模式? 升级后部分 admin 控件会显示出来。')) return
      btn.disabled = true
      status.textContent = '升级中…'
      try {
        const r = await fetch('/api/admin/identity/org-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'team' }),
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          status.textContent = `失败: ${j?.error || r.status}`
          status.className = 'login-status error'
          btn.disabled = false
          return
        }
        status.textContent = '升级成功,正在刷新…'
        status.className = 'login-status ok'
        setTimeout(() => window.location.reload(), 600)
      } catch (err) {
        status.textContent = `失败: ${err?.message || err}`
        status.className = 'login-status error'
        btn.disabled = false
      }
    })
  }
})()

// PWA (Phase 12 M9) — register the app-shell service worker. Registration
// only works in a secure context (https, or http on localhost / 127.0.0.1),
// so a plain-http LAN host simply skips it. Failures are non-fatal: the app
// is fully functional without offline support, so we swallow the error.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.debug('SW registration skipped/failed (non-fatal):', err)
    })
  })
}
