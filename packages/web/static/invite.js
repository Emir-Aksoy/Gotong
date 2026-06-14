/**
 * /invite/<token> — anonymous accept page.
 *
 * Flow:
 *   1. Pull the token out of the URL path (`/invite/<token>`).
 *   2. GET /api/invites/<token> → render the invite info OR a failure
 *      message (expired / revoked / used / not found, distinguished
 *      by the response's `code` field).
 *   3. On form submit, POST /api/invites/<token>/accept with
 *      { password, displayName? }. Server mints user + session + sets
 *      cookie; we redirect to /me on success.
 *
 * No framework, no build step — mirrors me.js. ~140 LOC.
 */
;(function () {
  'use strict'

  // --- i18n (self-contained) ---------------------------------------------
  // This page does NOT load the shared app-core.js engine — it's a minimal
  // standalone accept surface. So bilingual text lives in a small local
  // dict here. Language is detected from the same `lang` cookie the main
  // SPA sets (so a returning member keeps their choice), falling back to
  // navigator.language, then zh. Detection-only — no toggle — to keep the
  // page lightweight; the main app's toggle is what writes the cookie.
  function detectLang() {
    try {
      const m = /(?:^|;\s*)lang=([^;]+)/.exec(document.cookie || '')
      if (m) {
        const v = decodeURIComponent(m[1]).toLowerCase()
        if (v === 'en' || v === 'zh') return v
      }
    } catch (_) { /* no cookie access */ }
    try {
      const nav = (navigator.language || '').toLowerCase()
      if (nav && nav.indexOf('zh') !== 0) return 'en'
    } catch (_) { /* no navigator */ }
    return 'zh'
  }

  const T = {
    zh: {
      docTitle: 'AipeHub · 接受邀请',
      h1: 'AipeHub · 接受邀请',
      intro: '设置密码后立即激活账号并跳转到你的工作流页面。',
      verifying: '正在验证邀请链接…',
      emailLabel: '邀请邮箱:',
      roleLabel: '分配角色:',
      expiresLabel: '到期:',
      displayNameLabel: '显示名 (可选,会显示在你创建的工作流上)',
      passwordLabel: '设置密码 (至少 8 个字符)',
      password2Label: '再次输入密码',
      activateBtn: '激活账号',
      failTitleDefault: '链接不可用',
      contactInviter: '请联系给你发邀请的人重新生成一条链接。',
      notFoundTitle: '链接无效',
      notFoundDetail: '没有找到这个邀请。链接可能输错了,或已被撤销。',
      notFoundShort: '没有找到这个邀请。',
      expiredTitle: '链接已过期',
      expiredDetail: '这条邀请的有效期已过。',
      revokedTitle: '链接已撤销',
      revokedDetail: '邀请人在你激活前撤销了这条邀请。',
      usedTitle: '链接已被使用',
      usedDetail: '这条邀请已经被激活过了 — 如果不是你激活的,请联系邀请人。',
      loadFailTitle: '无法加载邀请',
      unknownError: '未知错误',
      badFormatTitle: '链接格式错误',
      badFormatDetail: 'URL 里没有有效的 token,请检查邀请链接是否完整。',
      pwMismatch: '两次输入的密码不一致',
      pwTooShort: '密码至少 8 个字符',
      activating: '正在激活账号…',
      activatedRedirect: '账号已激活,正在跳转…',
      activateFailPrefix: '激活失败: ',
    },
    en: {
      docTitle: 'AipeHub · Accept invitation',
      h1: 'AipeHub · Accept invitation',
      intro: 'Set a password to activate your account and jump straight to your workflows.',
      verifying: 'Verifying the invite link…',
      emailLabel: 'Invited email:',
      roleLabel: 'Assigned role:',
      expiresLabel: 'Expires:',
      displayNameLabel: 'Display name (optional — shown on the workflows you create)',
      passwordLabel: 'Set a password (at least 8 characters)',
      password2Label: 'Re-enter password',
      activateBtn: 'Activate account',
      failTitleDefault: 'Link unavailable',
      contactInviter: 'Ask whoever invited you to generate a fresh link.',
      notFoundTitle: 'Invalid link',
      notFoundDetail: "This invite wasn't found. The link may be mistyped, or it was revoked.",
      notFoundShort: "This invite wasn't found.",
      expiredTitle: 'Link expired',
      expiredDetail: 'This invitation is past its expiry.',
      revokedTitle: 'Link revoked',
      revokedDetail: 'The inviter revoked this invitation before you activated it.',
      usedTitle: 'Link already used',
      usedDetail: "This invitation has already been activated — if that wasn't you, contact the inviter.",
      loadFailTitle: "Couldn't load the invite",
      unknownError: 'Unknown error',
      badFormatTitle: 'Malformed link',
      badFormatDetail: "The URL has no valid token — check that the invite link is complete.",
      pwMismatch: 'The two passwords do not match',
      pwTooShort: 'Password must be at least 8 characters',
      activating: 'Activating your account…',
      activatedRedirect: 'Account activated, redirecting…',
      activateFailPrefix: 'Activation failed: ',
    },
  }

  const LANG = detectLang()
  const t = T[LANG] || T.zh

  // Apply the dict to [data-i18n] elements + <title> + <html lang> on boot.
  function applyStatic() {
    try {
      document.documentElement.lang = LANG
      document.title = t.docTitle
    } catch (_) { /* */ }
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const k = el.getAttribute('data-i18n')
      if (t[k] != null) el.textContent = t[k]
    })
  }

  // --- DOM helpers --------------------------------------------------------
  function $(sel) {
    return document.querySelector(sel)
  }
  function show(sel) {
    const el = $(sel)
    if (el) el.classList.remove('hidden')
  }
  function hide(sel) {
    const el = $(sel)
    if (el) el.classList.add('hidden')
  }
  function setText(sel, text) {
    const el = $(sel)
    if (el) el.textContent = text
  }
  function setStatus(msg, kind) {
    const el = $('#status')
    if (!el) return
    el.textContent = msg || ''
    el.classList.remove('error', 'ok')
    if (kind === 'error') el.classList.add('error')
    else if (kind === 'ok') el.classList.add('ok')
  }

  function fmtTime(ms) {
    if (ms == null) return '—'
    try {
      return new Date(ms).toLocaleString()
    } catch (_) {
      return String(ms)
    }
  }

  // --- Token from URL -----------------------------------------------------
  // The server route is /invite/<token>. We strip the prefix and
  // decodeURIComponent so a token containing url-encoded chars is
  // handled. (Our base64url tokens won't have any, but this is
  // defensive.)
  function readTokenFromPath() {
    const p = window.location.pathname
    const m = /^\/invite\/([^/?#]+)\/?$/.exec(p)
    if (!m) return null
    try {
      return decodeURIComponent(m[1])
    } catch (_) {
      return m[1]
    }
  }

  // --- API ---------------------------------------------------------------
  async function lookupInvite(token) {
    const res = await fetch('/api/invites/' + encodeURIComponent(token), {
      credentials: 'same-origin',
    })
    let json = null
    try {
      json = await res.json()
    } catch (_) {
      /* 503 plain */
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || ('HTTP ' + res.status))
      err.code = json && json.code
      err.status = res.status
      throw err
    }
    return (json && json.invitation) || null
  }

  async function acceptInvite(token, password, displayName) {
    const body = { password: password }
    if (displayName) body.displayName = displayName
    const res = await fetch('/api/invites/' + encodeURIComponent(token) + '/accept', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json = null
    try {
      json = await res.json()
    } catch (_) {
      /* 429 plain */
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || ('HTTP ' + res.status))
      err.code = json && json.code
      err.status = res.status
      throw err
    }
    return json
  }

  // --- Render -------------------------------------------------------------
  function renderInvite(invitation) {
    setText('#invite-email', invitation.email)
    setText('#invite-role', invitation.role)
    setText('#invite-expires', fmtTime(invitation.expiresAt))
    if (invitation.displayName) {
      const dn = document.querySelector('#accept-form input[name="displayName"]')
      if (dn) dn.value = invitation.displayName
    }
    hide('#loading-section')
    hide('#fail-section')
    show('#accept-section')
  }

  function renderFail(title, detail) {
    setText('#fail-title', title)
    setText('#fail-detail', detail)
    hide('#loading-section')
    hide('#accept-section')
    show('#fail-section')
  }

  // Map server `code` → friendly title + detail. Distinct from a 400
  // bad-password (which keeps the user on the form with a status error).
  function failFromError(err) {
    switch (err && err.code) {
      case 'invitation_not_found':
        return { title: t.notFoundTitle, detail: t.notFoundDetail }
      case 'invitation_expired':
        return { title: t.expiredTitle, detail: t.expiredDetail }
      case 'invitation_revoked':
        return { title: t.revokedTitle, detail: t.revokedDetail }
      case 'invitation_already_used':
        return { title: t.usedTitle, detail: t.usedDetail }
      default:
        return { title: t.loadFailTitle, detail: (err && err.message) || t.unknownError }
    }
  }

  // AUDIT-P3-05: scrub the token from window.location so it doesn't
  // hang around in the browser address bar / history / browser-sync /
  // user screenshots. Called immediately after we've grabbed the token
  // into a local variable; the in-memory `token` is what we'll POST
  // with later. After this runs, the URL reads `/invite` (no token).
  function scrubTokenFromUrl() {
    try {
      window.history.replaceState({}, '', '/invite')
    } catch (_) {
      /* old browsers without history API — accept the leak */
    }
  }

  // --- Boot ---------------------------------------------------------------
  async function init() {
    applyStatic()
    const token = readTokenFromPath()
    // Scrub immediately — even before lookup, in case the lookup fails
    // and the user copy-pastes the URL "for help."
    if (token) scrubTokenFromUrl()
    if (!token) {
      renderFail(t.badFormatTitle, t.badFormatDetail)
      return
    }
    try {
      const invitation = await lookupInvite(token)
      if (!invitation) {
        renderFail(t.notFoundTitle, t.notFoundShort)
        return
      }
      if (invitation.status !== 'pending') {
        const f = failFromError({ code: 'invitation_' + invitation.status })
        renderFail(f.title, f.detail)
        return
      }
      renderInvite(invitation)
      wireForm(token)
    } catch (err) {
      const f = failFromError(err)
      renderFail(f.title, f.detail)
    }
  }

  function wireForm(token) {
    const form = $('#accept-form')
    if (!form) return
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      const pw = form.password.value
      const pw2 = form.password2.value
      const dn = (form.displayName.value || '').trim()
      if (pw !== pw2) {
        setStatus(t.pwMismatch, 'error')
        return
      }
      if (pw.length < 8) {
        setStatus(t.pwTooShort, 'error')
        return
      }
      const btn = $('#accept-btn')
      if (btn) btn.disabled = true
      setStatus(t.activating)
      try {
        await acceptInvite(token, pw, dn || undefined)
        setStatus(t.activatedRedirect, 'ok')
        // Replace history entry so the browser back button doesn't land
        // back on the now-consumed invite page. C1c — /me was folded
        // into the unified SPA at /; the new user lands on the `home`
        // tab as their default.
        window.location.replace('/')
      } catch (err) {
        if (btn) btn.disabled = false
        // 410-class failures (the link became unusable mid-flow — e.g.
        // someone revoked it between our lookup and submit) → switch to
        // the fail page rather than letting the user keep retrying.
        if (
          err.code === 'invitation_expired' ||
          err.code === 'invitation_revoked' ||
          err.code === 'invitation_already_used' ||
          err.code === 'invitation_not_found'
        ) {
          const f = failFromError(err)
          renderFail(f.title, f.detail)
          return
        }
        setStatus(t.activateFailPrefix + err.message, 'error')
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
