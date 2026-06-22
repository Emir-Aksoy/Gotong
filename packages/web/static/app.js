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
  const ROLE_LABELS = () => ({
    owner: t('meRoleOwner'),
    admin: t('meRoleAdmin'),
    member: t('meRoleMember'),
    viewer: t('meRoleViewer'),
  })
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

  // ---- i18n translator (REL-7) -----------------------------------------
  // Reads window.AipeHub.t on every call (it's a live getter that flips on
  // setLang), so dynamic panels render in the current language and re-render
  // correctly when the toggle fires. Function-form keys (interpolation) are
  // invoked with the passed args; plain-string keys ignore extra args.
  const t = (key, ...args) => {
    const v = window.AipeHub.t[key]
    return typeof v === 'function' ? v(...args) : v ?? key
  }

  // Bind a listener to a STATIC element exactly once, even if the binding
  // call runs again (REL-7 — onLangChange re-runs renderHome/renderSettings
  // to re-render dynamic panels in the new language; without this guard each
  // toggle would stack a duplicate listener on the static buttons/forms).
  // Delegated containers (#me-inbox-list etc.) are static too, so the same
  // single-flag guard fits — each listed element carries exactly one binding.
  function bindOnce(el, type, handler) {
    if (!el || el.dataset.boundOnce === '1') return
    el.dataset.boundOnce = '1'
    el.addEventListener(type, handler)
  }

  // ---- ease-of-use ⑨-M2 (A2) — "how to get a key" illustrated guide -----
  //
  // The single biggest first-run wall for a non-technical user isn't picking a
  // provider — it's "I have no idea how to obtain that key". This renders a
  // collapsible, per-provider step list (sign up → top up → create → copy)
  // right under each provider <select>, plus a prominent link to the official
  // key page (the user opens it in their own browser — we never navigate for
  // them). Steps are inline-bilingual so the flat i18n dict stays lean; the
  // chrome (summary / link label) lives in the dict like everything else.
  //
  // Real official destinations (verified): DeepSeek / Anthropic / OpenAI key
  // pages. Unknown provider → body cleared (no guide), never throws.
  const KEY_PROVIDER_GUIDES = {
    deepseek: {
      url: 'https://platform.deepseek.com/api_keys',
      zh: {
        steps: [
          '打开 platform.deepseek.com，用手机号或邮箱注册并登录',
          '进入「充值 / Top up」，最低约 ¥1 起，按量计费很便宜',
          '左侧打开「API keys」→ 点「创建 API key」',
          '复制以 sk- 开头的密钥，粘到下面的输入框',
        ],
      },
      en: {
        steps: [
          'Sign up and log in at platform.deepseek.com',
          'Open "Top up" — pay-as-you-go starts around ¥1, very cheap',
          'Open "API keys" in the sidebar → "Create API key"',
          'Copy the key starting with sk- and paste it below',
        ],
      },
    },
    anthropic: {
      url: 'https://console.anthropic.com/settings/keys',
      zh: {
        steps: [
          '打开 console.anthropic.com，注册并登录',
          '在「Billing」里充值或绑定信用卡（按量计费）',
          '打开「Settings → API keys」→ 点「Create Key」',
          '复制以 sk-ant- 开头的密钥，粘到下面',
        ],
      },
      en: {
        steps: [
          'Sign up and log in at console.anthropic.com',
          'Add credit or a card under "Billing" (pay-as-you-go)',
          'Open "Settings → API keys" → "Create Key"',
          'Copy the key starting with sk-ant- and paste it below',
        ],
      },
    },
    openai: {
      url: 'https://platform.openai.com/api-keys',
      zh: {
        steps: [
          '打开 platform.openai.com，注册并登录',
          '在「Billing」里充值（预付额度，按量扣）',
          '打开「API keys」→ 点「Create new secret key」',
          '复制以 sk- 开头的密钥，粘到下面（只显示一次，记得保存）',
        ],
      },
      en: {
        steps: [
          'Sign up and log in at platform.openai.com',
          'Add prepaid credit under "Billing"',
          'Open "API keys" → "Create new secret key"',
          'Copy the key starting with sk- and paste it below (shown once)',
        ],
      },
    },
  }

  // Render the guide body for a provider into bodyEl. Reads the live language
  // (window.AipeHub.lang) so a toggle re-renders correctly via refreshKeyGuides.
  function renderKeyGuide(bodyEl, provider) {
    if (!bodyEl) return
    const guide = KEY_PROVIDER_GUIDES[provider]
    if (!guide) { bodyEl.innerHTML = ''; return }
    const lang = (window.AipeHub && window.AipeHub.lang) || 'zh'
    const g = guide[lang] || guide.zh
    const steps = g.steps.map((s) => `<li>${escape(s)}</li>`).join('')
    bodyEl.innerHTML =
      `<ol class="key-guide-steps">${steps}</ol>` +
      `<a class="key-guide-link" href="${escape(guide.url)}" target="_blank" rel="noopener noreferrer">${escape(t('keyGuideOpenLink'))}</a>` +
      `<div class="key-guide-url">${escape(guide.url)}</div>`
  }

  // Wire a provider <select> to its guide body: bindOnce the change handler
  // (re-render on provider switch) + render once for the current value.
  function wireKeyGuide(selectId, bodyId) {
    const sel = document.getElementById(selectId)
    const body = document.getElementById(bodyId)
    if (!sel || !body) return
    bindOnce(sel, 'change', () => renderKeyGuide(body, sel.value))
    renderKeyGuide(body, sel.value)
  }

  // Re-render any present guide bodies in the current language. Registered as
  // an always-on (not SIGNED_IN-gated) lang subscriber so the setup wizard
  // (pre-login shell) re-renders too. No-ops when neither guide is mounted.
  function refreshKeyGuides() {
    const pairs = [
      ['setup-key-form', 'setup-key-guide-body'],
      ['me-cred-provider', 'me-cred-guide-body'],
    ]
    for (const [selId, bodyId] of pairs) {
      const body = document.getElementById(bodyId)
      if (!body) continue
      // setup uses <select name="provider"> inside the form; me-cred uses an id.
      const sel = selId === 'setup-key-form'
        ? document.querySelector('#setup-key-form select[name="provider"]')
        : document.getElementById(selId)
      if (sel) renderKeyGuide(body, sel.value)
    }
  }
  if (window.AipeHub && typeof window.AipeHub.onLangChange === 'function') {
    window.AipeHub.onLangChange(refreshKeyGuides)
  }

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
      if (subtitle) subtitle.textContent = t('meNotSignedIn')
      return
    }
    if (badge) {
      badge.textContent = ROLE_LABELS()[role] || role
      badge.classList.add(`role-${role}`)
    }
    if (subtitle) {
      subtitle.textContent =
        role === 'owner' || role === 'admin' ? t('meSubtitleAdmin') : t('meSubtitleMember')
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
      status.textContent = t('meSetupSettingUp')
      const fd = new FormData(form)
      const password = String(fd.get('password') || '')
      const confirm = String(fd.get('confirm') || '')
      if (password !== confirm) {
        status.className = 'login-status error'
        status.textContent = t('meSetupPwMismatch')
        return
      }
      if (password.length < 12) {
        status.className = 'login-status error'
        status.textContent = t('meSetupPwTooShort')
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
          status.textContent = j?.error || t('meSetupFailedHttp', r.status)
          return
        }
        status.className = 'login-status ok'
        status.textContent = t('meSetupDone')
        // ease-of-use ②-M1 — instead of reloading straight to login,
        // advance to the optional LLM-key step. The owner can set a key
        // (so their first agent has one) or skip to the login screen.
        revealKeyStep(form)
      } catch (err) {
        status.className = 'login-status error'
        status.textContent = t('meSetupFailedErr', err?.message || err)
      }
    })
  }

  // ease-of-use ②-M1 — first-run LLM key step (the second wizard panel).
  //
  // The select's value is a friendly provider name; we map it to the
  // (provider tag, baseURL) the host's key resolver expects. DeepSeek uses
  // the `openai-compatible` umbrella tag + its OpenAI-compatible /v1 base —
  // a managed DeepSeek agent (provider: openai-compatible) then resolves
  // this org key via the org-pool tier.
  const SETUP_KEY_PRESETS = {
    deepseek: { provider: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
    anthropic: { provider: 'anthropic', label: 'Anthropic' },
    openai: { provider: 'openai', label: 'OpenAI' },
  }

  function revealKeyStep(pwForm) {
    const keyForm = document.getElementById('setup-key-form')
    if (!keyForm) { window.location.reload(); return }
    // Hide the (now-done) password form, reveal the key step.
    if (pwForm) pwForm.hidden = true
    keyForm.hidden = false
    attachKeyForm(keyForm)
    const apiKey = keyForm.querySelector('input[name="apiKey"]')
    if (apiKey) apiKey.focus()
  }

  function attachKeyForm(keyForm) {
    if (keyForm.dataset.bound === '1') return
    keyForm.dataset.bound = '1'
    // ⑨-M2 — wire the "how to get a key" guide to the provider select (the
    // setup select has no id, so target it within the form by name).
    const provSel = keyForm.querySelector('select[name="provider"]')
    const guideBody = document.getElementById('setup-key-guide-body')
    if (provSel && guideBody) {
      bindOnce(provSel, 'change', () => renderKeyGuide(guideBody, provSel.value))
      renderKeyGuide(guideBody, provSel.value)
    }
    const status = document.getElementById('setup-key-status')
    const skipBtn = document.getElementById('setup-key-skip')
    // Skip → straight to the login screen (empty cookie state).
    if (skipBtn) {
      skipBtn.addEventListener('click', () => { window.location.reload() })
    }
    // ease-of-use ①TC — "test connection" probes the typed key WITHOUT saving
    // it, so a wrong key / wrong provider / empty balance is caught here. Maps
    // the friendly provider choice through SETUP_KEY_PRESETS (so DeepSeek's
    // openai-compatible baseURL is sent, not api.openai.com), POSTs the
    // loopback-only setup probe, and renders the verdict via the shared
    // describeKeyTest() words map (one source of truth with the admin form).
    const testBtn = document.getElementById('setup-key-test')
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const fd = new FormData(keyForm)
        const choice = String(fd.get('provider') || 'deepseek')
        const apiKey = String(fd.get('apiKey') || '').trim()
        const preset = SETUP_KEY_PRESETS[choice] || SETUP_KEY_PRESETS.deepseek
        if (!apiKey) {
          status.className = 'login-status error'
          status.textContent = t('testConnNeedKey')
          return
        }
        status.className = 'login-status'
        status.textContent = t('testConnTesting')
        testBtn.disabled = true
        try {
          const r = await fetch('/api/setup/test-llm-key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: preset.provider,
              apiKey,
              ...(preset.baseURL ? { baseURL: preset.baseURL } : {}),
            }),
          })
          if (!r.ok) {
            const j = await r.json().catch(() => ({}))
            status.className = 'login-status error'
            status.textContent = j?.error || t('meSetupFailedHttp', r.status)
            return
          }
          const d = window.AipeHub.describeKeyTest(await r.json())
          status.className = 'login-status ' + (d.level === 'ok' ? 'ok' : 'error')
          status.textContent = d.text
        } catch (err) {
          status.className = 'login-status error'
          status.textContent = t('meSetupFailedErr', err?.message || err)
        } finally {
          testBtn.disabled = false
        }
      })
    }
    keyForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const fd = new FormData(keyForm)
      const choice = String(fd.get('provider') || 'deepseek')
      const apiKey = String(fd.get('apiKey') || '').trim()
      const preset = SETUP_KEY_PRESETS[choice] || SETUP_KEY_PRESETS.deepseek
      if (!apiKey) {
        status.className = 'login-status error'
        status.textContent = t('setupKeyNeed')
        return
      }
      status.className = 'login-status'
      status.textContent = t('setupKeySaving')
      try {
        const r = await fetch('/api/setup/owner-llm-key', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: preset.provider,
            apiKey,
            ...(preset.baseURL ? { baseURL: preset.baseURL } : {}),
            label: preset.label,
          }),
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          status.className = 'login-status error'
          status.textContent = j?.error || t('meSetupFailedHttp', r.status)
          return
        }
        status.className = 'login-status ok'
        status.textContent = t('setupKeySaved')
        setTimeout(() => { window.location.reload() }, 700)
      } catch (err) {
        status.className = 'login-status error'
        status.textContent = t('meSetupFailedErr', err?.message || err)
      }
    })
  }

  // ---- Anonymous login --------------------------------------------------
  function attachLoginForm() {
    const form = document.getElementById('login-form')
    if (!form) return
    const status = document.getElementById('login-status')
    // Route B P1-M3f — the second-factor field, revealed on a totp challenge.
    const totpLabel = document.getElementById('login-totp-label')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      status.className = 'login-status'
      status.textContent = t('meLoginLoggingIn')
      const fd = new FormData(form)
      const totpCode = String(fd.get('totpCode') || '').trim()
      const body = JSON.stringify({
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
        // Only sent once the challenge field is revealed and filled; the server
        // treats an absent/blank code as "no code" and re-issues the challenge.
        ...(totpCode ? { totpCode } : {}),
      })
      try {
        const r = await fetch('/api/admin/identity/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          // P1-M3f — the password was right; the account has MFA on. Reveal the
          // code field and let the user resubmit the same form WITH the code.
          // This is not an error state, so style it as a neutral prompt.
          if (r.status === 401 && j?.challenge === 'totp') {
            if (totpLabel) totpLabel.hidden = false
            const codeInput = form.querySelector('[name="totpCode"]')
            status.className = 'login-status'
            // If a code was already supplied and still rejected, say so.
            status.textContent = totpCode ? t('meLoginTotpWrong') : t('meLoginTotpNeeded')
            if (codeInput) {
              codeInput.value = ''
              codeInput.focus()
            }
            return
          }
          status.className = 'login-status error'
          status.textContent = j?.error || t('meLoginFailedHttp', r.status)
          return
        }
        status.className = 'login-status ok'
        status.textContent = t('meLoginOk')
        // Reload so the server re-renders with the role meta injected.
        window.location.reload()
      } catch (err) {
        status.className = 'login-status error'
        status.textContent = t('meLoginFailedErr', err?.message || err)
      }
    })
  }

  // Route B P1-M4f/M5f — single sign-on. Ask the host which IdPs it accepts
  // over BOTH protocols (OIDC + SAML); a password-only hub returns [] (or 404
  // when a route isn't wired) and we leave #login-sso hidden. Clicking a button
  // is a top-level navigation to the public /start route, which 302s on to the
  // IdP — no fetch/CORS, the cookie comes back on the /callback (OIDC) or /acs
  // (SAML) redirect.
  async function renderSsoButtons() {
    const wrap = document.getElementById('login-sso')
    const list = document.getElementById('login-sso-buttons')
    if (!wrap || !list) return
    // Surface a failed round-trip the IdP redirect bounced back as ?*_error=.
    const params = new URLSearchParams(window.location.search)
    const ssoError = params.get('oidc_error') || params.get('saml_error')
    if (ssoError) {
      const status = document.getElementById('login-status')
      if (status) {
        status.className = 'login-status error'
        status.textContent = t('meSsoFailed', ssoError)
      }
    }
    list.innerHTML = ''
    // Fetch a provider list and append a button per IdP. `startPath` is the
    // public /start route for that protocol; returns how many were added so the
    // caller can decide whether to reveal the divider.
    const addButtons = async (endpoint, startPath) => {
      let providers = []
      try {
        const r = await fetch(endpoint)
        if (!r.ok) return 0
        const j = await r.json().catch(() => ({}))
        providers = Array.isArray(j?.providers) ? j.providers : []
      } catch {
        return 0 // network hiccup — password login still works, stay quiet.
      }
      let added = 0
      for (const p of providers) {
        if (!p || typeof p.id !== 'string') continue
        const name = (p.label || p.issuer || p.id)
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'login-sso-btn'
        btn.textContent = t('meSsoButton', name)
        btn.addEventListener('click', () => {
          window.location.href = startPath + '?provider=' + encodeURIComponent(p.id)
        })
        list.appendChild(btn)
        added++
      }
      return added
    }
    const counts = await Promise.all([
      addButtons('/api/auth/oidc/providers', '/api/auth/oidc/start'),
      addButtons('/api/auth/saml/providers', '/api/auth/saml/start'),
    ])
    if (counts[0] + counts[1] > 0) wrap.hidden = false
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
  // Every admin-shell tabbar button must be listed or the router falls the
  // click through to overview. mcp/usage/federation were added to app.html
  // after R14b folded quotas/reputation in but never registered here — so
  // they were silently unreachable; restored alongside the new oidc (SSO) tab.
  const ADMIN_TABS = new Set([
    'overview', 'agents', 'workflows', 'tasks', 'activity', 'services',
    'mcp', 'users', 'quotas', 'usage', 'reputation', 'federation', 'oidc',
    'saml',
  ])

  // ⑤-M1 — Simple mode (progressive disclosure). A per-device, user-controlled
  // toggle (localStorage) that trims the admin shell to a curated tab subset so
  // a first-time / casual operator isn't met with federation / SSO / quotas on
  // day one. Orthogonal to role AND to personal/team mode: it only narrows which
  // admin tabs the router activates + which sections render. It grants/removes
  // NO capability — the server still enforces every route. core / identity /
  // host routes are untouched; this lives entirely in the SPA.
  const SIMPLE_MODE_KEY = 'aipe_simple_mode'
  const SIMPLE_ADMIN_TABS = new Set(['overview', 'agents', 'workflows', 'tasks', 'usage'])
  function isSimpleMode() {
    try { return localStorage.getItem(SIMPLE_MODE_KEY) === '1' } catch (_) { return false }
  }
  // The admin tab set the router honors right now. In simple mode the advanced
  // tabs are treated as invalid, so currentTabFromHash / setActiveTab fall back
  // to overview — a stale #federation hash can't strand you on a hidden section.
  function effectiveAdminTabs() {
    return isSimpleMode() ? SIMPLE_ADMIN_TABS : ADMIN_TABS
  }

  function defaultTabForRole() {
    if (ADMIN_OR_OWNER) return 'overview'
    return 'home'
  }

  // Single-source-of-truth tab switcher. Toggles `.tab-hidden` on every
  // `<section data-tab=…>` and `.active` on each tabbar button. Matches
  // admin.js's setActiveTab contract exactly (we coexist in the same DOM).
  function setActiveTab(name) {
    const validAdminTab = ADMIN_OR_OWNER && effectiveAdminTabs().has(name)
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
    if (ADMIN_OR_OWNER && effectiveAdminTabs().has(h)) return h
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

  // ⑤-M1 — tag every advanced (non-simple) admin tab button + its section once
  // so the `body[data-simple-mode]` CSS rule can hide them declaratively.
  // Idempotent. The router guard in effectiveAdminTabs() is the primary defense
  // (a hidden tab can't be *activated*); the class + CSS is belt-and-suspenders
  // that also removes the buttons from the tabbar (setActiveTab never hides
  // buttons, only toggles `.active`).
  function markAdvancedTabs() {
    const advanced = (name) => ADMIN_TABS.has(name) && !SIMPLE_ADMIN_TABS.has(name)
    $$('.tabbar-btn').forEach((btn) => {
      if (advanced(btn.dataset.tab || '')) btn.classList.add('adv-only')
    })
    $$('section[data-tab]').forEach((sec) => {
      if (advanced(sec.dataset.tab || '')) sec.classList.add('adv-only')
    })
  }

  // Reflect the stored preference onto <body> + the settings checkbox. If the
  // currently-active tab just became hidden (live toggle while sitting on an
  // advanced tab), retreat to overview.
  function applySimpleMode() {
    const on = isSimpleMode()
    if (on) document.body.dataset.simpleMode = '1'
    else delete document.body.dataset.simpleMode
    const box = $('#settings-simple-mode')
    if (box) box.checked = on
    if (on && ADMIN_OR_OWNER && !effectiveAdminTabs().has(document.body.dataset.activeTab || '')) {
      gotoTab('overview')
    }
  }

  // Wire the settings toggle. Flipping it writes localStorage then re-applies —
  // applySimpleMode handles the body class, checkbox sync, and active-tab
  // retreat; markAdvancedTabs already tagged the elements at boot.
  function wireSimpleMode() {
    const box = $('#settings-simple-mode')
    if (!box) return
    box.checked = isSimpleMode()
    box.addEventListener('change', () => {
      try { localStorage.setItem(SIMPLE_MODE_KEY, box.checked ? '1' : '0') } catch (_) {}
      applySimpleMode()
    })
  }

  function wireTabs() {
    // ⑤-M1 — tag advanced tabs + reflect the stored simple-mode pref onto
    // <body> BEFORE the first resolve, so currentTabFromHash already rejects a
    // stale #federation hash and lands on overview.
    markAdvancedTabs()
    wireSimpleMode()
    if (isSimpleMode()) document.body.dataset.simpleMode = '1'
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
    await loadMyOwnAgents()
    await loadMyCredentials()
    bindOnce(document.getElementById('me-dispatch-btn'), 'click', submitDispatch)
    // SW-M7 — the hub steward ("管家"): one chat box drives plan → preview →
    // apply. The send button asks for a proposal; clicks inside the output area
    // (apply / submit-for-approval / go-to-inbox) are delegated since the cards
    // are re-rendered, but #me-steward-output is stable.
    bindOnce(document.getElementById('me-steward-send'), 'click', submitStewardPlan)
    bindOnce(document.getElementById('me-steward-output'), 'click', onStewardOutputClick)
    // ease-of-use ⑨-M1 (B1) — starter-prompt chips fill the steward box.
    bindOnce(document.getElementById('me-steward-suggest'), 'click', onStewardSuggestClick)
    // WFEDIT-M4 — open the NL editor for the currently-selected workflow.
    bindOnce(document.getElementById('me-wf-edit-load-btn'), 'click', loadWorkflowEditor)
    bindOnce(document.getElementById('me-refresh-reports-btn'), 'click', loadMyReports)
    bindOnce(document.getElementById('me-runs-refresh-btn'), 'click', loadMyRuns)
    bindOnce(document.getElementById('me-agents-refresh-btn'), 'click', loadMyAgents)
    bindOnce(document.getElementById('me-inbox-refresh-btn'), 'click', loadMyInbox)
    // Delegated: the list is re-rendered, but #me-inbox-list is stable.
    bindOnce(document.getElementById('me-inbox-list'), 'click', onInboxClick)
    // v5 A-M2 — my own agents: form submit + cancel + delegated edit/delete.
    bindOnce(document.getElementById('me-own-agent-form'), 'submit', submitOwnAgent)
    bindOnce(document.getElementById('me-own-cancel'), 'click', resetOwnForm)
    bindOnce(document.getElementById('me-own-agents-list'), 'click', onOwnAgentsClick)
    // v5 A-M3 — my API keys (BYO): create form + delegated delete.
    bindOnce(document.getElementById('me-cred-form'), 'submit', submitCredential)
    // ease-of-use ①TC-ME — test the typed BYO key before saving it.
    bindOnce(document.getElementById('me-cred-test'), 'click', submitTestCredential)
    bindOnce(document.getElementById('me-cred-list'), 'click', onCredListClick)
  }

  async function renderWhoami() {
    const info = document.getElementById('me-info')
    if (!info) return
    try {
      const r = await fetch('/api/admin/identity/me')
      if (!r.ok) { info.textContent = t('meLoadFailed'); return }
      const j = await r.json()
      const u = j?.user || j
      info.innerHTML = `
        <strong>${escape(u.displayName || u.email || u.id || '')}</strong>
        · ${escape(u.email || '')}
        · ${t('meRoleWord')} <code>${escape(u.role || role)}</code>
        ${u.id ? `· userId <code>${escape(u.id)}</code>` : ''}
      `
    } catch (err) {
      info.textContent = t('meLoadFailedErr', err?.message || err)
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
    sel.innerHTML = `<option>${escape(t('meLoading'))}</option>`
    try {
      const r = await fetch('/api/me/workflows')
      if (!r.ok) {
        sel.innerHTML = `<option value="">${escape(t('meNoWorkflows'))}</option>`
        fields.innerHTML = ''
        return
      }
      const j = await r.json()
      __myWorkflows = Array.isArray(j?.workflows) ? j.workflows : []
      if (__myWorkflows.length === 0) {
        sel.innerHTML = `<option value="">${escape(t('meNoWorkflowsYet'))}</option>`
        fields.innerHTML =
          `<p class="me-meta">${t('meNoMemberWorkflowsPre')}<code>surface.me</code>${t('meNoMemberWorkflowsPost')}</p>`
        return
      }
      sel.innerHTML = __myWorkflows
        .map((w) => `<option value="${escape(w.id)}">${escape(w.label || w.id)}</option>`)
        .join('')
      bindOnce(sel, 'change', renderWorkflowFields)
      renderWorkflowFields()
    } catch (err) {
      sel.innerHTML = `<option>${escape(t('meLoadFailedErr', err?.message || String(err)))}</option>`
    }
  }

  function renderWorkflowFields() {
    const sel = document.getElementById('me-wf-select')
    const fields = document.getElementById('me-wf-form-fields')
    if (!sel || !fields) return
    // WFEDIT-M4 — the editor body/status reference the PREVIOUSLY selected
    // workflow; reset them whenever the selection changes so a stale editor
    // can't be submitted against the wrong workflow.
    resetWorkflowEditor()
    const wf = __myWorkflows.find((w) => w.id === sel.value)
    const schema = wf && Array.isArray(wf.inputSchema) ? wf.inputSchema : []
    const desc = wf && wf.description ? `<p class="me-meta">${escape(wf.description)}</p>` : ''
    if (schema.length === 0) {
      fields.innerHTML = desc + `<p class="me-meta">${t('meWfNoFields')}</p>`
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
        const cap = typeof f.maxSizeMb === 'number' ? `<small class="me-meta">${t('meFieldMaxSize', escape(String(f.maxSizeMb)))}</small>` : ''
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
      status.textContent = t('meSelectWfFirst')
      return
    }
    const payload = {}
    status.className = 'me-status'
    status.textContent = t('meSubmitting')
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
        status.textContent = j?.error || t('meDispatchFailedHttp', r.status)
        return
      }
      status.className = 'me-status ok'
      status.textContent = t('meDispatched', j?.runId || j?.taskId || 'ok')
      // Refresh reports — the new run might already have produced an artifact
      // for fast workflows; for slow ones the user can hit refresh later.
      // Also refresh the runs list so the just-triggered run shows up.
      setTimeout(loadMyReports, 800)
      setTimeout(loadMyRuns, 800)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('meDispatchFailedErr', err?.message || err)
    }
  }

  // ===== WFEDIT-M4 — natural-language workflow editing (OpenClaw-style) =====
  //
  // The member describes a change in plain language; the host runs it through
  // the assistant, RE-PARSES, and enforces the cross-hub entry/exit lock
  // (enforceEditBoundary) before saving a new revision on the SAME workflow.
  // This panel just drives `GET .../editable` (show current YAML + the locked
  // boundary) and `POST .../edit { instruction }` (apply / echo violations).
  // The boundary is enforced server-side — the 🔒 notice here is honest UX,
  // not the security control.

  // WFEDIT-D3 — this edit session's conversation (client-held; the hub stores
  // nothing between requests). Each turn: {instruction, outcome, ok}. Sent with
  // every edit so the AI resolves "再…一点 / 改回去" references, and rendered as
  // a chat log. Reset whenever the editor opens (a new selection = new session).
  let editChat = []

  function resetWorkflowEditor() {
    editChat = []
    const body = document.getElementById('me-wf-edit-body')
    const status = document.getElementById('me-wf-edit-status')
    if (body) {
      body.innerHTML = ''
      delete body.dataset.workflowId
    }
    if (status) {
      status.className = 'me-status'
      status.textContent = ''
    }
  }

  // Render the locked-boundary notice. For a cross-hub workflow this lists the
  // trigger (ingress) + each off-hub egress step — the parts a member may NOT
  // touch. For a purely-local one only the trigger is pinned, so the member has
  // OpenClaw-style freedom over every step's logic.
  function renderEditBoundary(r) {
    const b = (r && r.boundary) || { trigger: '', egress: [] }
    const triggerLi = `<li>${t('meWfEditTrigger')}<code>${escape(b.trigger || '')}</code></li>`
    if (r && r.crossHub && Array.isArray(b.egress) && b.egress.length) {
      const egressLis = b.egress
        .map((e) => {
          const dc =
            Array.isArray(e.dataClasses) && e.dataClasses.length
              ? t('meWfEditDataClasses', e.dataClasses.map(escape).join(', '))
              : ''
          return `<li>${t('meWfEditEgressStep')}<code>${escape(e.stepId || '')}</code>${t(
            'meWfEditEgressArrow',
          )}<code>${escape(e.capability || '')}</code>${dc}</li>`
        })
        .join('')
      return (
        `<div class="me-wf-edit-locked"><strong>${t('meWfEditLockedTitle')}</strong>` +
        `<ul>${triggerLi}${egressLis}</ul></div>`
      )
    }
    return (
      `<div class="me-wf-edit-local"><strong>${t('meWfEditLocalTitlePre')}</strong>` +
      `${t('meWfEditLocalTitlePost')}<code>${escape(b.trigger || '')}</code>${t('meWfEditLocalTitleEnd')}</div>`
    )
  }

  // Fill the editor body from an `editable` payload (boundary + current YAML +
  // instruction form). Pure body render — never touches the status line, so the
  // post-edit refresh can keep the success message while showing new YAML.
  function renderEditorBody(j) {
    const body = document.getElementById('me-wf-edit-body')
    if (!body) return
    const editable = j && j.editable !== false
    const yaml = String((j && j.yaml) || '')
    body.innerHTML =
      renderEditBoundary(j) +
      `<details class="me-wf-edit-yaml"><summary>${t('meWfEditViewYaml')}</summary><pre>${escape(
        yaml,
      )}</pre></details>` +
      (editable
        ? `<label>${t('meWfEditInstructionLabel')}\n` +
          `<textarea id="me-wf-edit-instruction" rows="3" placeholder="${escape(t('meWfEditInstructionPlaceholder'))}"></textarea></label>` +
          `<button id="me-wf-edit-submit" type="button" class="me-primary-btn">${t('meWfEditApplyBtn')}</button>`
        : `<p class="me-meta">${t('meWfEditNotEditable')}</p>`)
    if (j && j.workflowId) body.dataset.workflowId = j.workflowId
    if (editable) {
      document.getElementById('me-wf-edit-submit')?.addEventListener('click', submitWorkflowEdit)
    }
  }

  async function loadWorkflowEditor() {
    const sel = document.getElementById('me-wf-select')
    const status = document.getElementById('me-wf-edit-status')
    if (!sel || !status) return
    if (!sel.value) {
      status.className = 'me-status error'
      status.textContent = t('meWfEditSelectFirst')
      return
    }
    resetWorkflowEditor()
    status.textContent = t('meLoading')
    try {
      const r = await fetch(`/api/me/workflows/${encodeURIComponent(sel.value)}/editable`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j || j.ok === false) {
        status.className = 'me-status error'
        status.textContent = editorErrorText(r.status, j)
        return
      }
      status.className = 'me-status'
      status.textContent = ''
      // editableView returns the workflowId; fall back to the selected one.
      if (!j.workflowId) j.workflowId = sel.value
      renderEditorBody(j)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('meLoadFailedErr', err?.message || err)
    }
  }

  async function submitWorkflowEdit() {
    const body = document.getElementById('me-wf-edit-body')
    const status = document.getElementById('me-wf-edit-status')
    const ta = document.getElementById('me-wf-edit-instruction')
    if (!body || !status || !ta) return
    const workflowId = body.dataset.workflowId
    const instruction = (ta.value || '').trim()
    if (!workflowId) {
      status.className = 'me-status error'
      status.textContent = t('meWfEditOpenFirst')
      return
    }
    if (!instruction) {
      status.className = 'me-status error'
      status.textContent = t('meWfEditDescribeFirst')
      return
    }
    status.className = 'me-status'
    status.textContent = t('meWfEditAiWorking')
    try {
      const r = await fetch(`/api/me/workflows/${encodeURIComponent(workflowId)}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // D3: prior turns (NOT this one) ride along so the AI has the session
        // context. Failed turns included — they say what was rejected.
        // D4: stream=true asks for NDJSON (live typing). Errors raised before
        // the stream opens (auth / rate-limit / 503) still come back as plain
        // JSON, so both shapes are handled below.
        body: JSON.stringify({
          instruction,
          stream: true,
          history: editChat.map((t) => ({ instruction: t.instruction, outcome: t.outcome })),
        }),
      })
      let j
      if ((r.headers.get('content-type') || '').includes('application/x-ndjson') && r.body) {
        j = await readEditStream(r)
        removeEditStreamPane()
        if (!j) {
          status.className = 'me-status error'
          status.textContent = t('meWfEditStreamBroken')
          return
        }
      } else {
        j = await r.json().catch(() => ({}))
      }
      if (r.ok && j && j.ok !== false) {
        status.className = 'me-status ok'
        const applied = j.applied === 'published' ? t('meWfEditPublished') : t('meWfEditDraftSaved')
        status.innerHTML = t('meWfEditSuccessLine', applied, j.explanation ? escape(j.explanation) : '')
        editChat.push({
          instruction,
          outcome: t('meWfEditChatSuccess', applied, j.explanation || '').trim(),
          ok: true,
        })
        // The edit may have changed the inputs — refresh the editor (new YAML)
        // without clobbering this success message. The dispatch form above is
        // refreshed on the next home render; we keep the selection stable here.
        await refreshEditorBody(workflowId)
        appendEditDiff(j.diff)
        renderEditChat()
        return
      }
      // Failure. A boundary_locked rejection gets the per-violation detail list
      // so the member sees exactly which cross-hub part they tried to move.
      status.className = 'me-status error'
      const errText = editorErrorText(r.status, j)
      let html = escape(errText)
      const violations =
        j && Array.isArray(j.violations) && j.violations.length
          ? j.violations.map((v) => (v && (v.detail || v.kind)) || '').filter(Boolean)
          : []
      if (violations.length) {
        html += '<ul>' + violations.map((v) => `<li>${escape(v)}</li>`).join('') + '</ul>'
      }
      status.innerHTML = html
      // A refused turn is still conversation — "换个说法" needs to know what
      // was just rejected. (Transport errors below are not: no AI saw them.)
      editChat.push({
        instruction,
        outcome: t('meWfEditChatFailure', errText, violations.length ? violations.join('; ') : ''),
        ok: false,
      })
      renderEditChat()
    } catch (err) {
      removeEditStreamPane()
      status.className = 'me-status error'
      status.textContent = t('meWfEditSaveFailedErr', err?.message || err)
    }
  }

  // Re-fetch `editable` for the same workflow and re-render the body only,
  // leaving the status line (a success message) intact. Best-effort.
  async function refreshEditorBody(workflowId) {
    try {
      const r = await fetch(`/api/me/workflows/${encodeURIComponent(workflowId)}/editable`)
      const j = await r.json().catch(() => ({}))
      if (r.ok && j && j.ok !== false) {
        if (!j.workflowId) j.workflowId = workflowId
        renderEditorBody(j)
      }
    } catch {
      /* keep the success message; the next manual reload will resync */
    }
  }

  // WFEDIT-D4 — consume the NDJSON edit stream: paint `chunk` lines into the
  // live-typing pane as they arrive, return the final `result` line (or null
  // when the connection died before one arrived).
  async function readEditStream(r) {
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let result = null
    const handleLine = (line) => {
      if (!line.trim()) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg && msg.kind === 'chunk' && typeof msg.text === 'string') appendEditStreamText(msg.text)
      else if (msg && msg.kind === 'result') result = msg
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf) handleLine(buf)
    } catch {
      /* dropped mid-stream — caller treats a missing result as the error */
    }
    return result
  }

  // The blue live-typing pane (the /me twin of the admin assist preview).
  // Created on the first chunk, just above the instruction form; torn down
  // once the result lands — the diff + chat then carry the durable outcome.
  function ensureEditStreamPane() {
    const body = document.getElementById('me-wf-edit-body')
    if (!body) return null
    let el = body.querySelector('.me-wf-stream')
    if (!el) {
      el = document.createElement('div')
      el.className = 'me-wf-stream'
      el.innerHTML = `<div class="me-wf-stream-head">${t('meWfEditAiTyping')}</div><pre></pre>`
      const label = body.querySelector('label')
      if (label) label.before(el)
      else body.appendChild(el)
    }
    return el
  }

  function appendEditStreamText(text) {
    const el = ensureEditStreamPane()
    if (!el) return
    const pre = el.querySelector('pre')
    if (!pre) return
    pre.textContent += text
    pre.scrollTop = pre.scrollHeight
  }

  function removeEditStreamPane() {
    document.querySelector('#me-wf-edit-body .me-wf-stream')?.remove()
  }

  // WFEDIT-D2 — show what the AI actually changed. The host edit pipeline is
  // the only place holding both sides of the same run, so the diff arrives in
  // the response; this stays a dumb renderer. Must run AFTER refreshEditorBody
  // because that re-render replaces the whole body.
  function appendEditDiff(diff) {
    const body = document.getElementById('me-wf-edit-body')
    if (!body || !Array.isArray(diff)) return
    if (!diff.some((l) => l && (l.kind === 'add' || l.kind === 'del'))) return
    const el = document.createElement('details')
    el.className = 'me-wf-diff'
    el.open = true
    el.innerHTML =
      `<summary>${t('meWfEditViewDiff')}</summary>` +
      `<div class="me-wf-diff-rows">${renderDiffRows(diff)}</div>`
    const yamlDetails = body.querySelector('.me-wf-edit-yaml')
    if (yamlDetails) yamlDetails.before(el)
    else body.prepend(el)
  }

  // Collapse long unchanged runs to "… N 行未变 …", keeping 2 context lines
  // next to each change (none at the very start/end of the file).
  function renderDiffRows(diff) {
    const out = []
    let i = 0
    while (i < diff.length) {
      if (!diff[i] || diff[i].kind !== 'same') {
        out.push(diffRow(diff[i]))
        i++
        continue
      }
      let j = i
      while (j < diff.length && diff[j] && diff[j].kind === 'same') j++
      const keepHead = i === 0 ? 0 : 2
      const keepTail = j === diff.length ? 0 : 2
      if (j - i > keepHead + keepTail + 1) {
        for (let k = i; k < i + keepHead; k++) out.push(diffRow(diff[k]))
        out.push(`<div class="me-wf-diff-skip">${escape(t('meWfDiffSkip', j - i - keepHead - keepTail))}</div>`)
        for (let k = j - keepTail; k < j; k++) out.push(diffRow(diff[k]))
      } else {
        for (let k = i; k < j; k++) out.push(diffRow(diff[k]))
      }
      i = j
    }
    return out.join('')
  }

  function diffRow(l) {
    const kind = l && l.kind === 'add' ? 'add' : l && l.kind === 'del' ? 'del' : 'same'
    const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
    return `<div class="me-wf-diff-${kind}">${sign} ${escape(String((l && l.text) || ''))}</div>`
  }

  // WFEDIT-D3 — render the session's conversation just above the instruction
  // form (chat mental model: history on top, input at the bottom). Creates or
  // updates in place, so it works on both paths: after a success the body was
  // re-rendered (div gone, recreate); after a refusal it wasn't (update).
  function renderEditChat() {
    const body = document.getElementById('me-wf-edit-body')
    if (!body) return
    let el = body.querySelector('.me-wf-chat')
    if (!editChat.length) {
      if (el) el.remove()
      return
    }
    if (!el) {
      el = document.createElement('div')
      el.className = 'me-wf-chat'
      const label = body.querySelector('label')
      if (label) label.before(el)
      else body.appendChild(el)
    }
    el.innerHTML =
      `<h4>${t('meWfEditChatHistory')}</h4>` +
      editChat
        .map(
          (turn) =>
            `<div class="me-wf-chat-turn"><div class="me-wf-chat-user">${t('meWfEditChatYou')}${escape(turn.instruction)}</div>` +
            `<div class="me-wf-chat-outcome${turn.ok ? '' : ' err'}">${escape(turn.outcome || '')}</div></div>`,
        )
        .join('')
  }

  // Friendly message for an editor error response. Prefers the server's human
  // text, then maps a few well-known reason codes, then falls back to status.
  function editorErrorText(httpStatus, j) {
    const msg = j && (j.message || j.error)
    if (msg) return String(msg)
    const code = j && j.code
    const byCode = {
      forbidden: t('meWfErrForbidden'),
      not_found: t('meWfErrNotFound'),
      no_source: t('meWfErrNoSource'),
      under_review: t('meWfErrUnderReview'),
      archived: t('meWfErrArchived'),
      boundary_locked: t('meWfErrBoundaryLocked'),
      assistant_failed: t('meWfErrAssistantFailed'),
      parse_failed: t('meWfErrParseFailed'),
      id_changed: t('meWfErrIdChanged'),
      structure_failed: t('meWfErrStructureFailed'),
      assistant_unavailable: t('meWfErrAssistantUnavailable'),
    }
    if (code && byCode[code]) return byCode[code]
    return t('meOpFailedHttp', httpStatus)
  }

  // ===== SW-M7 — hub steward ("管家") chat panel =============================
  //
  // A member describes what they want; the steward PROPOSES classified actions
  // (the host LLM call + server-side tiering). Each action is previewed with a
  // tier badge, then the member applies it: a SAFE action runs inline, a
  // DANGEROUS (delete) / CROSS-HUB workflow edit is parked in the inbox for a
  // second confirmation (the user's two hard constraints — enforced server-side;
  // this panel only previews + drives plan/apply). The tier the client shows is
  // advisory UI; `apply` re-derives it server-side and never trusts the client.

  // The classified actions from the LAST plan, indexed so an apply click can
  // forward the chosen action VERBATIM to the server (which re-validates it).
  let stewardActions = []
  // This steward conversation (client-held; the hub stores nothing between
  // requests). Sent with each plan so follow-ups like "再简单点" resolve.
  let stewardChat = []

  async function submitStewardPlan() {
    const input = document.getElementById('me-steward-input')
    const status = document.getElementById('me-steward-status')
    const output = document.getElementById('me-steward-output')
    if (!input || !status || !output) return
    const instruction = (input.value || '').trim()
    if (!instruction) {
      status.className = 'me-status error'
      status.textContent = t('meStewardEmptyInput')
      return
    }
    status.className = 'me-status'
    status.textContent = t('meStewardThinking')
    try {
      const r = await fetch('/api/me/steward/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction, history: stewardChat.slice(-12) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j || typeof j !== 'object' || !Array.isArray(j.actions)) {
        status.className = 'me-status error'
        status.textContent = (j && (j.error || j.message)) || t('meOpFailedHttp', r.status)
        return
      }
      status.className = 'me-status'
      status.textContent = ''
      // Multi-step memory: record the turn so the next instruction can refer back.
      stewardChat.push({ role: 'user', content: instruction })
      if (j.reply) stewardChat.push({ role: 'assistant', content: String(j.reply) })
      input.value = ''
      renderStewardProposal(j)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('meStewardPlanFailed', err?.message || err)
    }
  }

  // Render the steward's reply + one card per proposed action. `stewardActions`
  // is replaced so the apply handler reads the actions THIS proposal carried.
  function renderStewardProposal(j) {
    const out = document.getElementById('me-steward-output')
    if (!out) return
    stewardActions = Array.isArray(j.actions) ? j.actions : []
    const reply = j && j.reply ? `<div class="me-steward-reply">${escape(String(j.reply))}</div>` : ''
    const cards = stewardActions.map((ca, idx) => stewardActionCard(ca, idx)).join('')
    const note = stewardActions.length === 0 ? `<p class="me-meta">${t('meStewardNoActions')}</p>` : ''
    out.innerHTML = reply + cards + note
  }

  // One proposed action as a card. `inspect` is a read-only answer (no button);
  // `refuse` / forbidden is a grey out-of-scope note (no button); everything else
  // gets an apply button labelled by tier (safe → 执行 / gated → 提交审批).
  function stewardActionCard(ca, idx) {
    const action = (ca && ca.action) || {}
    const kind = action.kind
    const tier = (ca && ca.tier) || 'safe'
    const summary = (ca && ca.summary) || ''
    if (kind === 'inspect') {
      return `<div class="me-steward-card inspect"><div class="me-steward-answer">${escape(String(action.answer || summary))}</div></div>`
    }
    if (kind === 'refuse' || tier === 'forbidden') {
      const reason = String(action.reason || summary)
      return (
        `<div class="me-steward-card forbidden">${stewardTierBadge('forbidden')}` +
        `<div class="me-steward-summary">${escape(t('meStewardForbiddenNote'))}${escape(reason)}</div></div>`
      )
    }
    const gated = tier === 'dangerous' || tier === 'cross_hub'
    const label = gated ? t('meStewardSubmitApproval') : t('meStewardApply')
    return (
      `<div class="me-steward-card" data-idx="${idx}">` +
      stewardTierBadge(tier) +
      `<div class="me-steward-summary">${escape(summary)}</div>` +
      `<button type="button" class="me-primary-btn me-steward-apply-btn" data-idx="${idx}">${escape(label)}</button>` +
      `<div class="me-steward-result"></div></div>`
    )
  }

  function stewardTierBadge(tier) {
    const map = {
      safe: ['safe', t('meStewardTierSafe')],
      dangerous: ['dangerous', t('meStewardTierDangerous')],
      cross_hub: ['cross-hub', t('meStewardTierCrossHub')],
      forbidden: ['forbidden', t('meStewardTierForbidden')],
    }
    const pair = map[tier] || map.safe
    return `<span class="me-steward-tier ${pair[0]}">${escape(pair[1])}</span>`
  }

  // Delegated: an apply/submit button inside a card, or a go-to-inbox link.
  function onStewardOutputClick(ev) {
    const applyBtn = ev.target.closest && ev.target.closest('.me-steward-apply-btn')
    if (applyBtn) {
      applyStewardAction(applyBtn)
      return
    }
    const inboxBtn = ev.target.closest && ev.target.closest('.me-steward-goto-inbox')
    if (inboxBtn) gotoMyInbox()
  }

  // ease-of-use ⑨-M1 (B1) — one-tap starter prompts. The chip's visible text
  // is already localized by applyStaticI18n, so we just copy it into the
  // steward box (WYSIWYG) and focus, leaving the user free to edit before
  // asking. Delegated on the stable #me-steward-suggest container.
  function onStewardSuggestClick(ev) {
    const chip = ev.target.closest && ev.target.closest('.me-steward-chip')
    if (!chip) return
    const input = document.getElementById('me-steward-input')
    if (!input) return
    input.value = chip.textContent.trim()
    input.focus()
  }

  async function applyStewardAction(btn) {
    const idx = Number(btn.dataset.idx)
    const ca = stewardActions[idx]
    if (!ca || !ca.action) return
    const card = btn.closest('.me-steward-card')
    const resultEl = card && card.querySelector('.me-steward-result')
    const prev = btn.textContent
    btn.disabled = true
    btn.textContent = t('meStewardApplying')
    try {
      const r = await fetch('/api/me/steward/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The action is forwarded VERBATIM — the server re-validates + re-tiers it.
        body: JSON.stringify({ action: ca.action }),
      })
      const j = await r.json().catch(() => ({}))
      renderStewardResult(resultEl, btn, r, j)
      recordStewardOutcome(ca.action, r, j)
    } catch (err) {
      if (resultEl) {
        resultEl.className = 'me-steward-result error'
        resultEl.textContent = t('meStewardApplyFailed', err?.message || err)
      }
      btn.disabled = false
      btn.textContent = prev
    }
  }

  // Record a TERMINAL apply outcome into the conversation so the next plan POST
  // round-trips it: the host folds `{kind,status,subject}` into a `[执行结果] …`
  // line and the steward builds its next step on what already ran. Only the
  // whitelisted shape is sent — the host re-validates kind/status and renders the
  // text itself, so a client can't inject a "succeeded" narrative. An `invalid` /
  // transport error left the button live to retry, so it's not recorded.
  function recordStewardOutcome(action, r, j) {
    const kind = action && action.kind
    if (!kind) return
    const raw = j && j.status
    let status = null
    if (r.ok && raw === 'done') status = 'done'
    else if (raw === 'pending_approval' || raw === 'needs_approval') status = 'pending_approval'
    else if (raw === 'refused') status = 'refused'
    if (!status) return
    stewardChat.push({ role: 'assistant', content: '', result: { kind, status, subject: stewardSubjectOf(action, j) } })
  }

  // The thing an action acted on, for the result line. Reads only non-secret
  // identifier fields (never an env-var value / secret); the host clips it anyway.
  function stewardSubjectOf(action, j) {
    const res = (j && j.result) || {}
    const fromResult = res.agent && (res.agent.id || res.agent.label)
    const fromAction =
      action &&
      (action.id ||
        action.agentId ||
        action.workflowId ||
        action.handle ||
        action.provider ||
        action.credentialId ||
        action.peerId)
    return String(fromResult || fromAction || '')
  }

  // Render the outcome of an apply into the card, and retire the button on a
  // terminal result (done / parked / refused) so it can't be double-fired. An
  // `invalid` / transport error leaves the button live to retry.
  function renderStewardResult(resultEl, btn, r, j) {
    if (!resultEl) return
    const status = j && j.status
    if (r.ok && status === 'done') {
      const res = (j && j.result) || {}
      if (res.kind === 'create_agent' || res.kind === 'edit_agent') {
        resultEl.className = 'me-steward-result ok'
        const label = (res.agent && (res.agent.label || res.agent.id)) || ''
        resultEl.textContent =
          res.kind === 'create_agent' ? t('meStewardCreated', label) : t('meStewardEditedAgent', label)
        btn.remove()
        loadMyOwnAgents() // the new/changed helper shows up below
      } else if (res.kind === 'edit_workflow') {
        renderStewardWorkflowEdit(resultEl, res.edit)
        btn.remove()
      } else {
        resultEl.className = 'me-steward-result ok'
        resultEl.textContent = t('meStewardDone')
        btn.remove()
      }
      return
    }
    if (status === 'pending_approval') {
      resultEl.className = 'me-steward-result pending'
      resultEl.innerHTML =
        `${escape(t('meStewardPending'))} ` +
        `<button type="button" class="me-secondary-btn me-steward-goto-inbox">${escape(t('meStewardGoInbox'))}</button>`
      btn.remove()
      loadMyInbox() // refresh the inbox badge so the parked item is visible
      return
    }
    if (status === 'needs_approval') {
      resultEl.className = 'me-steward-result pending'
      resultEl.textContent = t('meStewardNeedsApproval')
      btn.remove()
      return
    }
    if (status === 'refused') {
      resultEl.className = 'me-steward-result error'
      resultEl.textContent = (j && j.reason) || t('meStewardForbiddenNote')
      btn.remove()
      return
    }
    // `invalid` (HTTP 400) or any {error}/{message} failure — keep the button live.
    resultEl.className = 'me-steward-result error'
    resultEl.textContent =
      (status === 'invalid' && j && j.reason) || (j && (j.error || j.message)) || t('meOpFailedHttp', r.status)
    btn.disabled = false
    btn.textContent =
      stewardActions[Number(btn.dataset.idx)] &&
      (stewardActions[Number(btn.dataset.idx)].tier === 'dangerous' ||
        stewardActions[Number(btn.dataset.idx)].tier === 'cross_hub')
        ? t('meStewardSubmitApproval')
        : t('meStewardApply')
  }

  // An `edit_workflow` outcome reuses the WFEDIT row diff. A locally-safe edit
  // can still come back `ok === false` (the assistant failed / boundary locked) —
  // an honest outcome, surfaced with the reason + any violations.
  function renderStewardWorkflowEdit(resultEl, edit) {
    if (!edit) {
      resultEl.className = 'me-steward-result ok'
      resultEl.textContent = t('meStewardDone')
      return
    }
    if (edit.ok === false) {
      resultEl.className = 'me-steward-result error'
      let html = escape(String(edit.message || edit.detail || t('meWfErrAssistantFailed')))
      const violations = Array.isArray(edit.violations)
        ? edit.violations.map((v) => (v && (v.detail || v.kind)) || '').filter(Boolean)
        : []
      if (violations.length) html += '<ul>' + violations.map((v) => `<li>${escape(v)}</li>`).join('') + '</ul>'
      resultEl.innerHTML = html
      return
    }
    resultEl.className = 'me-steward-result ok'
    const applied = edit.applied === 'published' ? t('meWfEditPublished') : t('meWfEditDraftSaved')
    let html = `<div>${escape(t('meStewardWorkflowEdited', applied, edit.explanation || ''))}</div>`
    if (Array.isArray(edit.diff) && edit.diff.some((l) => l && (l.kind === 'add' || l.kind === 'del'))) {
      html += `<div class="me-wf-diff-rows">${renderDiffRows(edit.diff)}</div>`
    }
    resultEl.innerHTML = html
  }

  // Scroll the member to the inbox panel (same home tab) + refresh it, so a
  // parked steward action is one click from the second confirmation.
  function gotoMyInbox() {
    if (window.AipeHub && typeof window.AipeHub.gotoTab === 'function') window.AipeHub.gotoTab('home')
    const inbox = document.querySelector('.me-inbox')
    if (inbox && inbox.scrollIntoView) inbox.scrollIntoView({ behavior: 'smooth', block: 'start' })
    loadMyInbox()
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
        status.textContent = t('meUploadSelectFile', key)
        return false
      }
      return true // optional + empty → leave the field unset
    }
    const file = files[0]
    try {
      setUpload('', t('meUploading'))
      const ref = await uploadMyFile(file)
      setUpload('ok', t('meUploaded', file.name, formatBytes(ref.size)))
      payload[key] = { type: 'file_ref', artifactId: ref.artifactId, mime: ref.mime }
      return true
    } catch (err) {
      setUpload('error', t('meUploadFailed', err?.message || err))
      status.className = 'me-status error'
      status.textContent = t('meUploadFailedFile', err?.message || err)
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
    tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meLoading')}</td></tr>`
    try {
      const r = await fetch('/api/me/runs')
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meLoadFailedHttp', r.status)}</td></tr>`
        return
      }
      const j = await r.json()
      const runs = Array.isArray(j?.runs) ? j.runs : []
      if (runs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meNoRuns')}</td></tr>`
        return
      }
      tbody.innerHTML = runs
        .map(
          (run) => `
            <tr>
              <td>${escape(run.workflowId || '?')}</td>
              <td>${renderRunStatus(run.status)}</td>
              <td>${escape(formatTs(run.startedAt))}</td>
              <td>${run.endedAt ? escape(formatTs(run.endedAt)) : `<span class="me-meta">${t('meInProgress')}</span>`}</td>
            </tr>`,
        )
        .join('')
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</td></tr>`
    }
  }

  // Map a RunStatus to a coloured pill. Falls back to the raw status string so a
  // future status value still renders (just without a dedicated colour). Labels
  // are read through the translator so they follow the active language.
  const ME_RUN_STATUS_KEYS = {
    running: 'meRunStatusRunning', done: 'meRunStatusDone', failed: 'meRunStatusFailed',
    cancelled: 'meRunStatusCancelled', suspended: 'meRunStatusSuspended',
  }
  function renderRunStatus(status) {
    const s = status || 'unknown'
    const key = ME_RUN_STATUS_KEYS[s]
    const label = key ? t(key) : s
    return `<span class="me-run-status me-run-${escape(s)}">${escape(label)}</span>`
  }

  // Member task inbox (Phase 16). Lists the caller's pending human-in-the-loop
  // steps; resolving one POSTs the decision and the parked workflow resumes.
  async function loadMyInbox() {
    const list = document.getElementById('me-inbox-list')
    const count = document.getElementById('me-inbox-count')
    if (!list) return
    list.innerHTML = `<p class="me-meta">${t('meLoading')}</p>`
    try {
      const r = await fetch('/api/me/inbox')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">${t('meLoadFailedHttp', r.status)}</p>`
        if (count) count.textContent = ''
        return
      }
      const j = await r.json()
      const items = Array.isArray(j?.items) ? j.items : []
      if (count) count.textContent = items.length ? String(items.length) : ''
      if (items.length === 0) {
        list.innerHTML = `<p class="me-meta">${t('meInboxEmpty')}</p>`
        return
      }
      list.innerHTML = items.map(renderInboxItem).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</p>`
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
      ? `<p class="me-inbox-handoff">${t('meInboxHandoff', escape(item.handoffNote))}</p>`
      : ''
    let controls = ''
    if (item.kind === 'approval') {
      // inbox-gov M3 — three outcomes. The comment is optional for approve /
      // reject but REQUIRED for "request changes", validated both
      // client- and server-side.
      controls = `
        <div class="me-inbox-approval">
          <textarea data-inbox-approval-comment rows="2" placeholder="${escape(t('meInboxCommentPlaceholder'))}"></textarea>
          <div class="me-inbox-actions">
            <button type="button" class="me-primary-btn" data-inbox-approve="${id}">${t('meInboxApprove')}</button>
            <button type="button" class="me-secondary-btn" data-inbox-changes="${id}">${t('meInboxRequestChanges')}</button>
            <button type="button" class="me-secondary-btn" data-inbox-reject="${id}">${t('meInboxReject')}</button>
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
      controls = `<div class="me-inbox-edit">${control}<button type="button" class="me-primary-btn" data-inbox-edit="${id}">${t('meInboxSubmit')}</button></div>`
    }
    // inbox-gov M2 — every pending item can be handed off to another member by
    // email (a toggle keeps the form out of the way until needed).
    const delegate = `
      <div class="me-inbox-delegate">
        <button type="button" class="me-link-btn" data-inbox-delegate-toggle="${id}">${t('meInboxDelegateToggle')}</button>
        <div class="me-inbox-delegate-form" data-inbox-delegate-form hidden>
          <input type="email" data-inbox-delegate-email placeholder="${escape(t('meInboxDelegateEmail'))}" autocomplete="off">
          <input type="text" data-inbox-delegate-note placeholder="${escape(t('meInboxDelegateNote'))}">
          <button type="button" class="me-secondary-btn" data-inbox-delegate-submit="${id}">${t('meInboxDelegateConfirm')}</button>
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
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = window.AipeHub.t.meInboxChangesNeedComment }
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
    if (statusEl) { statusEl.className = 'me-status'; statusEl.textContent = t('meSubmitting') }
    setButtons(true) // guard against a double-submit while in flight
    try {
      const r = await fetch(`/api/me/inbox/${encodeURIComponent(itemId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = j?.error || t('meInboxProcessFailedHttp', r.status) }
        setButtons(false)
        return
      }
      // Resolved — refresh the list (updates count + empty state).
      await loadMyInbox()
    } catch (err) {
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = t('meInboxProcessFailedErr', err?.message || err) }
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
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = t('meInboxNeedEmail') }
      return
    }
    const setButtons = (disabled) => {
      if (itemEl) itemEl.querySelectorAll('button').forEach((b) => { b.disabled = disabled })
    }
    if (statusEl) { statusEl.className = 'me-status'; statusEl.textContent = t('meInboxDelegating') }
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
        if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = j?.error || t('meInboxDelegateFailedHttp', r.status) }
        setButtons(false)
        return
      }
      // Handed off — it's no longer mine; refresh updates count + empty state.
      await loadMyInbox()
    } catch (err) {
      if (statusEl) { statusEl.className = 'me-status error'; statusEl.textContent = t('meInboxDelegateFailedErr', err?.message || err) }
      setButtons(false)
    }
  }

  async function loadMyReports() {
    const tbody = document.getElementById('me-reports-tbody')
    if (!tbody) return
    tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meLoading')}</td></tr>`
    try {
      const r = await fetch('/api/me/growth-reports')
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meLoadFailedHttp', r.status)}</td></tr>`
        return
      }
      const j = await r.json()
      const reports = Array.isArray(j?.reports) ? j.reports : []
      if (reports.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${t('meNoReports')}</td></tr>`
        return
      }
      tbody.innerHTML = reports
        .map(
          (r) => `
            <tr>
              <td>${escape(r.filename || r.path || '?')}</td>
              <td>${formatBytes(r.size)}</td>
              <td>${escape(formatTs(r.modifiedAt || r.createdAt))}</td>
              <td><a href="/api/me/growth-reports/download?path=${encodeURIComponent(r.path || '')}" download>${t('meDownload')}</a></td>
            </tr>`,
        )
        .join('')
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</td></tr>`
    }
  }

  // Member agent directory (Phase 19 P1-M3). Shows the sanitized "my AI helpers"
  // list — capabilities + online state only; the host already stripped prompts /
  // keys / model config, so nothing sensitive reaches the client.
  async function loadMyAgents() {
    const list = document.getElementById('me-agents-list')
    if (!list) return
    list.innerHTML = `<p class="me-meta">${t('meLoading')}</p>`
    try {
      const r = await fetch('/api/me/agents')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">${t('meLoadFailedHttp', r.status)}</p>`
        return
      }
      const j = await r.json()
      const agents = Array.isArray(j?.agents) ? j.agents : []
      if (agents.length === 0) {
        list.innerHTML = `<p class="me-meta">${t('meNoAgents')}</p>`
        return
      }
      list.innerHTML = agents.map(renderAgentCard).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</p>`
    }
  }

  function renderAgentCard(a) {
    const caps = Array.isArray(a.capabilities) ? a.capabilities : []
    const capChips = caps.length
      ? caps.map((c) => `<span class="me-cap-chip">${escape(c)}</span>`).join('')
      : `<span class="me-meta">${t('meNone')}</span>`
    const desc = a.description ? `<p class="me-meta">${escape(a.description)}</p>` : ''
    const dotCls = a.online ? 'me-agent-online' : 'me-agent-offline'
    const onlineLabel = a.online ? t('meOnline') : t('meOffline')
    // v5 D-M4 — read-only "this helper wakes itself on a cadence" badge.
    const heartbeatBadge = a.heartbeat?.enabled
      ? `<span class="me-heartbeat-badge" title="${escape(t('meHeartbeatTitle'))}">${t('meHeartbeatBadge')}</span>`
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

  // ---- My own agents (v5 A-M2) -----------------------------------------
  // A member builds + manages helpers they OWN. The server forces ownership
  // and composes the id from the session user, so the client just collects a
  // friendly form and renders the owned list with edit / delete.
  let myOwnAgents = []

  async function loadMyOwnAgents() {
    const list = document.getElementById('me-own-agents-list')
    if (!list) return
    await populateProviderSelect()
    list.innerHTML = `<p class="me-meta">${t('meLoading')}</p>`
    try {
      const r = await fetch('/api/me/agents/owned')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">${t('meLoadFailedHttp', r.status)}</p>`
        return
      }
      const j = await r.json()
      myOwnAgents = Array.isArray(j?.agents) ? j.agents : []
      if (myOwnAgents.length === 0) {
        list.innerHTML = `<p class="me-meta">${t('meNoOwnAgents')}</p>`
        return
      }
      list.innerHTML = myOwnAgents.map(renderOwnAgentCard).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</p>`
    }
  }

  async function populateProviderSelect() {
    const sel = document.getElementById('me-own-provider')
    if (!sel || sel.dataset.loaded === '1') return
    try {
      const r = await fetch('/api/me/agents/providers')
      const j = await r.json().catch(() => ({}))
      const providers = Array.isArray(j?.providers) ? j.providers : []
      if (providers.length === 0) {
        // Never normally hit — 'mock' is always available — but if it is, point
        // at the BYO-key panel below (in personal mode you ARE the admin).
        sel.innerHTML = `<option value="">${escape(t('meNoModels'))}</option>`
        return
      }
      sel.innerHTML = providers.map((p) => `<option value="${escape(p)}">${escape(p)}</option>`).join('')
      sel.dataset.loaded = '1'
    } catch { /* leave empty; submit will surface the server error */ }
  }

  // After a BYO key is added/removed the provider picker must re-derive — a new
  // key lights up its provider (anthropic/openai); a removed one may drop it.
  async function refreshProviderSelect() {
    const sel = document.getElementById('me-own-provider')
    if (sel) sel.dataset.loaded = ''
    await populateProviderSelect()
  }

  function renderOwnAgentCard(a) {
    const caps = Array.isArray(a.capabilities) ? a.capabilities : []
    const capChips = caps.length
      ? caps.map((c) => `<span class="me-cap-chip">${escape(c)}</span>`).join('')
      : `<span class="me-meta">${t('meNone')}</span>`
    const dotCls = a.online ? 'me-agent-online' : 'me-agent-offline'
    const onlineLabel = a.online ? t('meOnline') : t('meOffline')
    const model = a.model ? ` · ${escape(a.model)}` : ''
    return `
      <div class="me-agent-card" data-own-id="${escape(a.id)}">
        <div class="me-agent-head">
          <span class="me-agent-dot ${dotCls}" title="${escape(onlineLabel)}"></span>
          <strong>${escape(a.label || a.id)}</strong>
          <span class="me-meta">${escape(a.provider || '')}${model}</span>
        </div>
        <div class="me-agent-caps">${capChips}</div>
        <div class="me-own-agent-row-actions">
          <button type="button" class="me-secondary-btn" data-own-edit="${escape(a.id)}">${t('meEdit')}</button>
          <button type="button" class="me-secondary-btn" data-own-grants="${escape(a.id)}">${t('meManageAccess')}</button>
          <button type="button" class="me-secondary-btn me-danger-btn" data-own-delete="${escape(a.id)}">${t('meDelete')}</button>
        </div>
        <div class="me-grants-wrap" data-grants-wrap="${escape(a.id)}" hidden></div>
      </div>`
  }

  function resetOwnForm() {
    const form = document.getElementById('me-own-agent-form')
    if (!form) return
    form.reset()
    document.getElementById('me-own-editing').value = ''
    document.getElementById('me-own-handle').disabled = false
    document.getElementById('me-own-submit').textContent = t('meCreateAgent')
    document.getElementById('me-own-cancel').hidden = true
    const status = document.getElementById('me-own-status')
    if (status) { status.textContent = ''; status.className = 'me-status' }
  }

  function enterEditMode(agent) {
    document.getElementById('me-own-editing').value = agent.id
    // id is immutable — show the handle (last segment) but lock it.
    const handle = String(agent.id).split('.').slice(2).join('.') || agent.id
    const hEl = document.getElementById('me-own-handle')
    hEl.value = handle
    hEl.disabled = true
    document.getElementById('me-own-label').value = agent.label || ''
    document.getElementById('me-own-caps').value = (agent.capabilities || []).join(', ')
    document.getElementById('me-own-provider').value = agent.provider || ''
    document.getElementById('me-own-model').value = agent.model || ''
    document.getElementById('me-own-system').value = agent.system || ''
    document.getElementById('me-own-submit').textContent = t('meSaveChanges')
    document.getElementById('me-own-cancel').hidden = false
    document.getElementById('me-own-agent-form')?.scrollIntoView?.({ behavior: 'smooth' })
  }

  function parseCaps(raw) {
    return String(raw || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async function submitOwnAgent(e) {
    e.preventDefault()
    const status = document.getElementById('me-own-status')
    status.className = 'me-status'
    status.textContent = t('meSubmitting')
    const editingId = document.getElementById('me-own-editing').value
    const body = {
      label: document.getElementById('me-own-label').value.trim(),
      capabilities: parseCaps(document.getElementById('me-own-caps').value),
      provider: document.getElementById('me-own-provider').value,
      model: document.getElementById('me-own-model').value.trim(),
      system: document.getElementById('me-own-system').value,
    }
    let url = '/api/me/agents'
    let method = 'POST'
    if (editingId) {
      url = `/api/me/agents/${encodeURIComponent(editingId)}`
      method = 'PUT'
    } else {
      body.id = document.getElementById('me-own-handle').value.trim()
    }
    try {
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        status.className = 'me-status error'
        status.textContent = t('meFailedColon', escape(j?.error || `HTTP ${r.status}`))
        return
      }
      status.className = 'me-status ok'
      status.textContent = editingId ? t('meSaved') : t('meCreated')
      resetOwnForm()
      await loadMyOwnAgents()
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('meFailedColon', escape(err?.message || String(err)))
    }
  }

  async function onOwnAgentsClick(e) {
    const editId = e.target?.getAttribute?.('data-own-edit')
    if (editId) {
      const agent = myOwnAgents.find((a) => a.id === editId)
      if (agent) enterEditMode(agent)
      return
    }
    const delId = e.target?.getAttribute?.('data-own-delete')
    if (delId) {
      if (!confirm(t('meConfirmDeleteAgent'))) return
      try {
        const r = await fetch(`/api/me/agents/${encodeURIComponent(delId)}`, { method: 'DELETE' })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          alert(t('meDeleteFailedErr', j?.error || `HTTP ${r.status}`))
          return
        }
        await loadMyOwnAgents()
      } catch (err) {
        alert(t('meDeleteFailedErr', err?.message || String(err)))
      }
      return
    }
    // v5 A-M4 — share this agent: toggle the inline access panel, add a grant,
    // or revoke one. The panel is lazy-loaded into the card on first open.
    const grantsId = e.target?.getAttribute?.('data-own-grants')
    if (grantsId) {
      const card = e.target.closest('.me-agent-card')
      const wrap = card?.querySelector('[data-grants-wrap]')
      if (!wrap) return
      if (wrap.hidden) {
        wrap.hidden = false
        e.target.textContent = t('meCollapseAccess')
        await loadAgentGrants(grantsId, wrap)
      } else {
        wrap.hidden = true
        e.target.textContent = t('meManageAccess')
      }
      return
    }
    const addFor = e.target?.getAttribute?.('data-grant-add')
    if (addFor) {
      await submitAgentGrant(addFor, e.target.closest('[data-grants-wrap]'))
      return
    }
    const revokeKey = e.target?.getAttribute?.('data-grant-remove')
    if (revokeKey) {
      const agentId = e.target.getAttribute('data-grant-agent')
      if (!confirm(t('meConfirmRevokeGrant'))) return
      await removeAgentGrant(agentId, revokeKey, e.target.closest('[data-grants-wrap]'))
      return
    }
  }

  // ---- v5 A-M4 — agent access grants (sharing) --------------------------
  // An agent's owner shares it with other principals. Co-ownership (grant a
  // user 'owner') is the functional level today: the grantee then sees + manages
  // the agent from their own workbench. viewer / editor are recorded for when
  // finer agent-level enforcement lands. The host owns the owner gate + the
  // orphan guard (you can't leave an agent with no owner), so the UI just
  // surfaces its errors.
  const GRANT_KIND_KEYS = { user: 'meGrantKindUser', agent: 'meGrantKindAgent', peer: 'meGrantKindPeer', hub: 'meGrantKindHub' }
  const GRANT_PERM_KEYS = { viewer: 'meGrantPermViewer', editor: 'meGrantPermEditor', owner: 'meGrantPermOwner' }
  const grantKindLabel = (k) => (GRANT_KIND_KEYS[k] ? t(GRANT_KIND_KEYS[k]) : k)
  const grantPermLabel = (p) => (GRANT_PERM_KEYS[p] ? t(GRANT_PERM_KEYS[p]) : p)

  async function loadAgentGrants(agentId, wrap) {
    if (!wrap) return
    wrap.innerHTML = `<p class="me-meta">${t('meLoading')}</p>`
    try {
      const r = await fetch(`/api/me/agents/${encodeURIComponent(agentId)}/grants`)
      if (!r.ok) {
        wrap.innerHTML = `<p class="me-meta">${t('meLoadFailedHttp', r.status)}</p>`
        return
      }
      const j = await r.json()
      const grants = Array.isArray(j?.grants) ? j.grants : []
      wrap.innerHTML = renderGrantsPanel(agentId, grants)
    } catch (err) {
      wrap.innerHTML = `<p class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</p>`
    }
  }

  function renderGrantsPanel(agentId, grants) {
    const rows = grants.length
      ? grants.map((g) => renderGrantRow(agentId, g)).join('')
      : `<p class="me-meta">${t('meNoGrants')}</p>`
    const kindOpts = Object.keys(GRANT_KIND_KEYS)
      .filter((k) => k !== 'hub') // member sharing targets a user / agent / peer
      .map((k) => `<option value="${k}">${escape(grantKindLabel(k))}</option>`)
      .join('')
    const permOpts = Object.keys(GRANT_PERM_KEYS)
      .map((p) => `<option value="${p}">${escape(grantPermLabel(p))}</option>`)
      .join('')
    return `
      <div class="me-grants-list">${rows}</div>
      <div class="me-grant-add">
        <select data-grant-kind aria-label="${escape(t('meGrantKindAria'))}">${kindOpts}</select>
        <input type="text" data-grant-pid placeholder="${escape(t('meGrantPidPlaceholder'))}" autocomplete="off" />
        <select data-grant-perm aria-label="${escape(t('meGrantPermAria'))}">${permOpts}</select>
        <button type="button" class="me-secondary-btn" data-grant-add="${escape(agentId)}">${t('meGrantAdd')}</button>
      </div>
      <div class="me-status" data-grant-status></div>`
  }

  function renderGrantRow(agentId, g) {
    const kindLabel = grantKindLabel(g.principalKind)
    const permLabel = grantPermLabel(g.perm)
    const selfTag = g.isSelf ? ` <span class="me-meta">${t('meGrantSelf')}</span>` : ''
    return `
      <div class="me-grant-row">
        <span class="me-cap-chip">${escape(permLabel)}</span>
        <span class="me-grant-who">${escape(kindLabel)} · <code>${escape(g.principalId)}</code>${selfTag}</span>
        <button type="button" class="me-secondary-btn me-danger-btn"
          data-grant-remove="${escape(g.principalKey)}" data-grant-agent="${escape(agentId)}">${t('meRevoke')}</button>
      </div>`
  }

  async function submitAgentGrant(agentId, wrap) {
    if (!wrap) return
    const kind = wrap.querySelector('[data-grant-kind]')?.value
    const pid = wrap.querySelector('[data-grant-pid]')?.value?.trim()
    const perm = wrap.querySelector('[data-grant-perm]')?.value
    const status = wrap.querySelector('[data-grant-status]')
    if (!pid) {
      if (status) { status.textContent = t('meGrantNeedPid'); status.className = 'me-status error' }
      return
    }
    if (status) { status.textContent = t('meGranting'); status.className = 'me-status' }
    try {
      const r = await fetch(`/api/me/agents/${encodeURIComponent(agentId)}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ principalKind: kind, principalId: pid, perm }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (status) { status.textContent = t('meFailedColon', escape(j?.error || `HTTP ${r.status}`)); status.className = 'me-status error' }
        return
      }
      await loadAgentGrants(agentId, wrap) // re-render the panel (stays open)
    } catch (err) {
      if (status) { status.textContent = t('meFailedColon', escape(err?.message || String(err))); status.className = 'me-status error' }
    }
  }

  async function removeAgentGrant(agentId, principalKey, wrap) {
    try {
      const r = await fetch(
        `/api/me/agents/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(principalKey)}`,
        { method: 'DELETE' },
      )
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(t('meRevokeFailedErr', j?.error || `HTTP ${r.status}`))
        return
      }
      await loadAgentGrants(agentId, wrap)
    } catch (err) {
      alert(t('meRevokeFailedErr', err?.message || String(err)))
    }
  }

  // v5 A-M3 — my own API keys ("bring your own key"). The member supplies a
  // raw key; the server stores it encrypted under their account and never
  // returns it. List shows metadata + delete only (rotate = delete + re-add).
  // The helpers above use these as a fallback when the org has no key.
  let myCredentials = []

  async function loadMyCredentials() {
    const list = document.getElementById('me-cred-list')
    if (!list) return
    list.innerHTML = `<p class="me-meta">${t('meLoading')}</p>`
    try {
      const r = await fetch('/api/me/credentials')
      if (!r.ok) {
        list.innerHTML = `<p class="me-meta">${t('meLoadFailedHttp', r.status)}</p>`
        return
      }
      const j = await r.json()
      myCredentials = Array.isArray(j?.credentials) ? j.credentials : []
      populateCredProviderSelect(Array.isArray(j?.providers) ? j.providers : [])
      if (myCredentials.length === 0) {
        list.innerHTML = `<p class="me-meta">${t('meNoCreds')}</p>`
        return
      }
      list.innerHTML = myCredentials.map(renderCredCard).join('')
    } catch (err) {
      list.innerHTML = `<p class="me-meta">${escape(t('meLoadFailedErr', err?.message || String(err)))}</p>`
    }
  }

  function populateCredProviderSelect(providers) {
    const sel = document.getElementById('me-cred-provider')
    if (!sel || sel.dataset.loaded === '1') return
    if (providers.length === 0) {
      sel.innerHTML = `<option value="">${escape(t('meNoProviders'))}</option>`
      return
    }
    sel.innerHTML = providers.map((p) => `<option value="${escape(p)}">${escape(p)}</option>`).join('')
    sel.dataset.loaded = '1'
    // ⑨-M2 — once real provider options exist, wire the "how to get a key"
    // guide (change → re-render + initial render for the first option).
    wireKeyGuide('me-cred-provider', 'me-cred-guide-body')
  }

  function renderCredCard(c) {
    const label = c.label ? ` · ${escape(c.label)}` : ''
    const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''
    return `
      <div class="me-agent-card" data-cred-id="${escape(c.id)}">
        <div class="me-agent-head">
          <span class="me-agent-dot me-agent-online" title="${escape(t('meCredSavedTitle'))}"></span>
          <strong>${escape(c.provider || '')}</strong>
          <span class="me-meta">${label}${created ? ' · ' + escape(created) : ''}</span>
        </div>
        <div class="me-own-agent-row-actions">
          <button type="button" class="me-secondary-btn me-danger-btn" data-cred-delete="${escape(c.id)}">${t('meDelete')}</button>
        </div>
      </div>`
  }

  async function submitCredential(e) {
    e.preventDefault()
    const status = document.getElementById('me-cred-status')
    status.className = 'me-status'
    status.textContent = t('meSavingDots')
    const body = {
      provider: document.getElementById('me-cred-provider').value,
      apiKey: document.getElementById('me-cred-key').value,
      label: document.getElementById('me-cred-label').value.trim(),
    }
    try {
      const r = await fetch('/api/me/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        status.className = 'me-status error'
        status.textContent = t('meFailedColon', escape(j?.error || `HTTP ${r.status}`))
        return
      }
      status.className = 'me-status ok'
      status.textContent = t('meSaved')
      document.getElementById('me-cred-form').reset()
      await loadMyCredentials()
      // The just-added key may unlock a real provider for the agent picker above.
      await refreshProviderSelect()
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('meFailedColon', escape(err?.message || String(err)))
    }
  }

  // ease-of-use ①TC-ME — member "test connection": probe the typed BYO key
  // WITHOUT saving it, so a wrong key / wrong provider / empty balance is
  // caught before the member commits it. POSTs the member probe
  // (/api/me/test-llm-key — provider-restricted to anthropic/openai, no
  // baseURL → zero arbitrary-endpoint surface) and renders the verdict via the
  // SAME describeKeyTest() words map the setup wizard + admin form use.
  async function submitTestCredential() {
    const status = document.getElementById('me-cred-status')
    const provider = document.getElementById('me-cred-provider').value
    const apiKey = document.getElementById('me-cred-key').value.trim()
    const btn = document.getElementById('me-cred-test')
    if (!apiKey) {
      status.className = 'me-status error'
      status.textContent = t('testConnNeedKey')
      return
    }
    status.className = 'me-status'
    status.textContent = t('testConnTesting')
    if (btn) btn.disabled = true
    try {
      const r = await fetch('/api/me/test-llm-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        status.className = 'me-status error'
        status.textContent = j?.error || `HTTP ${r.status}`
        return
      }
      const d = window.AipeHub.describeKeyTest(await r.json())
      status.className = 'me-status ' + (d.level === 'ok' ? 'ok' : 'error')
      status.textContent = d.text
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = err?.message || String(err)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  async function onCredListClick(e) {
    const delId = e.target?.getAttribute?.('data-cred-delete')
    if (!delId) return
    if (!confirm(t('meConfirmDeleteCred'))) return
    try {
      const r = await fetch(`/api/me/credentials/${encodeURIComponent(delId)}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(t('meDeleteFailedErr', j?.error || `HTTP ${r.status}`))
        return
      }
      await loadMyCredentials()
      // A removed key may drop its provider from the agent picker above.
      await refreshProviderSelect()
    } catch (err) {
      alert(t('meDeleteFailedErr', err?.message || String(err)))
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
            ${escape(u.displayName || '')} · ${escape(u.email || '')} · ${t('meRoleWord')} <code>${escape(u.role || role)}</code>
          `
        }
      } catch { /* meh */ }
    }
    bindOnce(document.getElementById('settings-password-form'), 'submit', submitPasswordChange)
    // Route B P1-M3f — two-factor (TOTP) self-service panel.
    renderMfa().catch((err) => console.error('[app] renderMfa failed', err))
  }

  // ---- Two-factor (TOTP) self-service (Route B P1-M3f) -----------------
  // Renders the current MFA state into #settings-mfa and wires the
  // enroll → confirm → disable controls. The plaintext secret is shown
  // exactly once (on enroll) for manual key entry; otpauth:// is offered
  // as a link. QR image rendering is a later nicety — manual key entry
  // works in every authenticator app.
  async function renderMfa() {
    const host = document.getElementById('settings-mfa')
    if (!host || !SIGNED_IN) return
    let state = 'none'
    try {
      const r = await fetch('/api/me/totp')
      if (r.status === 503) {
        host.innerHTML = `<p class="hint">${escape(t('meMfaNoCrypto'))}</p>`
        return
      }
      if (r.ok) state = (await r.json())?.state || 'none'
    } catch {
      host.innerHTML = `<p class="hint">${escape(t('meMfaLoadFailed'))}</p>`
      return
    }

    if (state === 'active') {
      host.innerHTML =
        `<p>${escape(t('meMfaStatusWord'))}<strong>${escape(t('meMfaStatusEnabled'))}</strong></p>` +
        `<label>${escape(t('meMfaDisableLabel'))}` +
        `<input id="mfa-disable-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="${escape(t('meMfaCodePlaceholder'))}" /></label>` +
        `<button id="mfa-disable-btn" type="button" class="me-secondary-btn">${escape(t('meMfaDisableBtn'))}</button>` +
        '<div id="mfa-status" class="me-status"></div>'
      document.getElementById('mfa-disable-btn')?.addEventListener('click', () => {
        const code = String(document.getElementById('mfa-disable-code')?.value || '').trim()
        mfaPost('/api/me/totp/disable', { code }, t('meMfaDisabled'))
      })
      return
    }

    if (state === 'pending') {
      host.innerHTML =
        `<p>${escape(t('meMfaStatusWord'))}<strong>${escape(t('meMfaStatusPending'))}</strong>${escape(t('meMfaStatusPendingNote'))}</p>` +
        `<label>${escape(t('meMfaConfirmLabel'))}` +
        `<input id="mfa-confirm-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="${escape(t('meMfaCodePlaceholder'))}" /></label>` +
        '<div class="settings-actions">' +
        `<button id="mfa-confirm-btn" type="button" class="me-primary-btn">${escape(t('meMfaConfirmBtn'))}</button>` +
        `<button id="mfa-restart-btn" type="button" class="me-secondary-btn">${escape(t('meMfaRegenBtn'))}</button>` +
        `<button id="mfa-cancel-btn" type="button" class="me-secondary-btn">${escape(t('meCancel'))}</button>` +
        '</div><div id="mfa-status" class="me-status"></div>'
      document.getElementById('mfa-confirm-btn')?.addEventListener('click', () => {
        const code = String(document.getElementById('mfa-confirm-code')?.value || '').trim()
        mfaPost('/api/me/totp/confirm', { code }, t('meMfaEnabled'))
      })
      document.getElementById('mfa-restart-btn')?.addEventListener('click', () => startMfaEnroll())
      // A pending (never-confirmed) enrollment can be cancelled with no code.
      document.getElementById('mfa-cancel-btn')?.addEventListener('click', () => {
        mfaPost('/api/me/totp/disable', {}, t('meMfaSetupCancelled'))
      })
      return
    }

    // state === 'none'
    host.innerHTML =
      `<p class="hint">${escape(t('meMfaIntro'))}</p>` +
      `<button id="mfa-enroll-btn" type="button" class="me-primary-btn">${escape(t('meMfaEnrollBtn'))}</button>` +
      '<div id="mfa-status" class="me-status"></div>'
    document.getElementById('mfa-enroll-btn')?.addEventListener('click', () => startMfaEnroll())
  }

  async function startMfaEnroll() {
    const host = document.getElementById('settings-mfa')
    if (!host) return
    host.innerHTML = `<div id="mfa-status" class="me-status">${escape(t('meMfaGenerating'))}</div>`
    try {
      const r = await fetch('/api/me/totp/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        host.innerHTML =
          '<div id="mfa-status" class="me-status error">' +
          escape(j?.error || t('meMfaEnrollFailedHttp', r.status)) +
          '</div>'
        return
      }
      host.innerHTML =
        `<p>${escape(t('meMfaAddKey'))}</p>` +
        `<p><code class="mfa-secret">${escape(j.secretBase32 || '')}</code></p>` +
        `<p class="hint"><a href="${escape(j.otpauthUri || '')}">${escape(t('meMfaOtpauthLink'))}</a>${escape(t('meMfaQrTodo'))}</p>` +
        `<label>${escape(t('meMfaEnterCode'))}` +
        `<input id="mfa-confirm-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="${escape(t('meMfaCodePlaceholder'))}" /></label>` +
        `<button id="mfa-confirm-btn" type="button" class="me-primary-btn">${escape(t('meMfaConfirmBtn'))}</button>` +
        '<div id="mfa-status" class="me-status"></div>'
      document.getElementById('mfa-confirm-btn')?.addEventListener('click', () => {
        const code = String(document.getElementById('mfa-confirm-code')?.value || '').trim()
        mfaPost('/api/me/totp/confirm', { code }, t('meMfaEnabled'))
      })
    } catch (err) {
      host.innerHTML =
        '<div id="mfa-status" class="me-status error">' + escape(t('meMfaEnrollFailedErr', String(err?.message || err))) + '</div>'
    }
  }

  // POST a TOTP action; on success re-render to reflect the new state, on
  // failure keep the current panel and show the error inline.
  async function mfaPost(url, body, okMsg) {
    const status = document.getElementById('mfa-status')
    if (status) {
      status.className = 'me-status'
      status.textContent = t('meSubmitting')
    }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        const s = document.getElementById('mfa-status')
        if (s) {
          s.className = 'me-status error'
          s.textContent = j?.error || t('meOpFailedHttp', r.status)
        }
        return
      }
      await renderMfa()
    } catch (err) {
      const s = document.getElementById('mfa-status')
      if (s) {
        s.className = 'me-status error'
        s.textContent = t('meOpFailedErr', err?.message || err)
      }
    }
    void okMsg // state change is self-evident after re-render; keep arg for clarity
  }

  async function submitPasswordChange(e) {
    e.preventDefault()
    const form = e.currentTarget
    const status = document.getElementById('settings-password-status')
    status.className = 'me-status'
    status.textContent = t('meSubmitting')
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
        status.textContent = j?.error || t('mePwChangeFailedHttp', r.status)
        return
      }
      status.className = 'me-status ok'
      status.textContent = t('mePwUpdated')
      form.reset()
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t('mePwChangeFailedErr', err?.message || err)
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
      // SW-M9 A-M8 — operator-console steward panel (overview tab). Self-contained
      // like the federation panels; only needs window.AipeHub + its own DOM.
      .then(() => inject('/operator-steward-ui.js'))
      .then(() => inject('/identity-ui.js'))
      .then(() => inject('/quotas-ui.js'))
      .then(() => inject('/reputation-ui.js'))
      .then(() => inject('/usage-ui.js'))
      .then(() => inject('/peer-admin-ui.js'))
      .then(() => inject('/peer-manifest-ui.js'))
      .then(() => inject('/peer-summary-ui.js'))
      .then(() => inject('/a2a-ui.js'))
      .then(() => inject('/acp-ui.js'))
      .then(() => inject('/oidc-ui.js'))
      .then(() => inject('/saml-ui.js'))
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
      if (!wizardStarted) {
        attachLoginForm()
        // SSO buttons sit alongside the password form; only the wizard
        // (fresh host, no owner yet) suppresses them.
        renderSsoButtons()
      }
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

    // REL-7 — re-render the JS-rendered /me panels when the language toggle
    // fires. applyStaticI18n (in app-core) already handles markup with
    // [data-i18n]; this covers the dynamic lists/cards. The bindOnce guards
    // above keep re-running renderHome/renderSettings idempotent (no stacked
    // listeners on the static buttons/forms). applyOrgMode re-asserts the
    // personal-mode subtitle, which applyStaticI18n would otherwise reset to
    // the generic team subtitle.
    window.AipeHub.onLangChange(() => {
      if (!SIGNED_IN) return
      applyOrgMode().catch((err) => console.warn('[app] applyOrgMode (lang) failed', err))
      renderHome().catch((err) => console.error('[app] renderHome (lang) failed', err))
      renderSettings().catch((err) => console.error('[app] renderSettings (lang) failed', err))
    })
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
      subtitle.textContent = t('meSubtitlePersonal')
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
      `<button id="upgrade-team-btn" type="button" class="btn-primary">${escape(t('meUpgradeBtn'))}</button>` +
      `<p class="hint">${escape(t('meUpgradeHint'))}</p>` +
      '<span id="upgrade-status" class="login-status"></span>'
    const btn = $('#upgrade-team-btn')
    const status = $('#upgrade-status')
    btn?.addEventListener('click', async () => {
      if (!window.confirm(t('meConfirmUpgrade'))) return
      btn.disabled = true
      status.textContent = t('meUpgrading')
      try {
        const r = await fetch('/api/admin/identity/org-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'team' }),
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          status.textContent = t('meUpgradeFailed', j?.error || r.status)
          status.className = 'login-status error'
          btn.disabled = false
          return
        }
        status.textContent = t('meUpgradeOk')
        status.className = 'login-status ok'
        setTimeout(() => window.location.reload(), 600)
      } catch (err) {
        status.textContent = t('meUpgradeFailed', err?.message || err)
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
