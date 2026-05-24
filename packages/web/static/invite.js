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
        return { title: '链接无效', detail: '没有找到这个邀请。链接可能输错了,或已被撤销。' }
      case 'invitation_expired':
        return { title: '链接已过期', detail: '这条邀请的有效期已过。' }
      case 'invitation_revoked':
        return { title: '链接已撤销', detail: '邀请人在你激活前撤销了这条邀请。' }
      case 'invitation_already_used':
        return { title: '链接已被使用', detail: '这条邀请已经被激活过了 — 如果不是你激活的,请联系邀请人。' }
      default:
        return { title: '无法加载邀请', detail: (err && err.message) || '未知错误' }
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
    const token = readTokenFromPath()
    // Scrub immediately — even before lookup, in case the lookup fails
    // and the user copy-pastes the URL "for help."
    if (token) scrubTokenFromUrl()
    if (!token) {
      renderFail('链接格式错误', 'URL 里没有有效的 token,请检查邀请链接是否完整。')
      return
    }
    try {
      const invitation = await lookupInvite(token)
      if (!invitation) {
        renderFail('链接无效', '没有找到这个邀请。')
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
        setStatus('两次输入的密码不一致', 'error')
        return
      }
      if (pw.length < 8) {
        setStatus('密码至少 8 个字符', 'error')
        return
      }
      const btn = $('#accept-btn')
      if (btn) btn.disabled = true
      setStatus('正在激活账号…')
      try {
        await acceptInvite(token, pw, dn || undefined)
        setStatus('账号已激活,正在跳转…', 'ok')
        // Replace history entry so the browser back button doesn't land
        // back on the now-consumed invite page.
        window.location.replace('/me')
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
        setStatus('激活失败: ' + err.message, 'error')
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
