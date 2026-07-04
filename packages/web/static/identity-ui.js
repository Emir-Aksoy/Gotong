/**
 * v4 identity / user-management UI (tab "用户" in admin.html).
 *
 * Self-contained — does NOT extend admin.js. The only coupling is:
 *   - tab visibility is driven by admin.js's `setActiveTab()` which
 *     toggles `tab-hidden` class on `<section data-tab="users">`
 *     and writes `document.body.dataset.activeTab`. We observe the
 *     latter via MutationObserver and (re-)render on activation.
 *   - DOMContentLoaded fires after admin.js because the script tag
 *     order in admin.html is: app-core → admin → identity-ui.
 *
 * All UI is built at runtime — no markup beyond an empty container in
 * admin.html. That keeps the contract between this file and the rest
 * of the SPA at "you give me a div, I take over." Adding / removing
 * the tab is a 1-line change in admin.html and admin.js (TABS array).
 *
 * Why plain DOM instead of a framework: the rest of admin.js is plain
 * DOM, and the user count this UI manages is bounded enough (single
 * org, dozens of users at most) that no virtualization / diffing is
 * needed. ~270 LOC; everything is auditable in one pass.
 */
;(function () {
  'use strict'

  // i18n — read the live dict off window.Gotong at call time (app-core.js runs
  // synchronously before this panel is injected, so Gotong is always defined).
  // `t()` returns the current-language dict; re-render on language change.
  const AH = window.Gotong
  function t() { return AH.t }

  const API_BASE = '/api/admin/identity'
  const ROLES = ['owner', 'admin', 'member', 'viewer']
  // Owner is intentionally NOT here — the store refuses owner invites
  // (link leak == owner escalation). Promote post-accept via setRole.
  const INVITE_ROLES = ['admin', 'member', 'viewer']
  const INVITE_STATUSES = ['pending', 'expired', 'accepted', 'revoked']
  const ONE_HOUR_MS = 60 * 60 * 1000
  const ONE_DAY_MS = 24 * ONE_HOUR_MS

  // ---- DOM helpers --------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function $$(sel, root) {
    return Array.from((root || document).querySelectorAll(sel))
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]
    })
  }
  function fmtTime(ms) {
    if (ms == null) return '—'
    try {
      return new Date(ms).toLocaleString()
    } catch (_) {
      return String(ms)
    }
  }

  // V4-AUDIT-09 — typed-text confirmation for high-blast-radius actions
  // (granting owner / revoking the last password / etc). A plain
  // `confirm()` is too easy to dismiss with a stray Enter key. We force
  // the operator to type the literal phrase so it's a deliberate act.
  //
  // Returns true if the operator typed the exact `requiredText`; false
  // if they cancelled or typed anything else.
  function confirmDanger(title, body, requiredText) {
    const phrase = requiredText || 'CONFIRM'
    const lines = [
      title,
      '',
      body,
      '',
      t().idnConfirmPrompt(phrase),
    ]
    const typed = prompt(lines.join('\n'))
    if (typed == null) return false
    return typed.trim() === phrase
  }

  // ---- HTTP ---------------------------------------------------------------
  async function api(method, path, body) {
    const opts = {
      method: method,
      credentials: 'same-origin',
      headers: {},
    }
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(API_BASE + path, opts)
    if (res.status === 204) return null
    let json = null
    try {
      json = await res.json()
    } catch (_) {
      /* non-JSON response (eg 503 plain) */
    }
    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || ('HTTP ' + res.status)
      const err = new Error(msg)
      err.code = json && json.code
      err.status = res.status
      throw err
    }
    return json
  }

  // ---- Rendering ----------------------------------------------------------
  function setStatus(msg, isError) {
    const el = $('#id-status')
    if (!el) return
    el.textContent = msg || ''
    el.style.color = isError ? '#c0392b' : '#27ae60'
  }

  async function refreshMe() {
    const meEl = $('#id-me')
    if (!meEl) return
    try {
      const me = await api('GET', '/me')
      const who = me.user ? me.user.email : t().idnNoV4Binding
      const display = me.user && me.user.displayName ? ' / ' + me.user.displayName : ''
      meEl.textContent = t().idnMeLine(who, display, me.role, me.authSource)
    } catch (err) {
      meEl.textContent = t().idnMeReadFailed(err.message)
    }
  }

  async function refreshUsers() {
    const tbody = $('#id-users-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="6">' + escHtml(t().idnLoading) + '</td></tr>'
    try {
      const data = await api('GET', '/users')
      renderUserRows(tbody, data.users || [])
    } catch (err) {
      tbody.innerHTML = ''
      setStatus(t().idnUsersLoadFailed(err.message), true)
    }
  }

  // V4-AUDIT-06: render the audit log into the dedicated tbody. Filters
  // are read from the form inputs above the table.
  async function refreshAudit() {
    const tbody = $('#id-audit-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="6">' + escHtml(t().idnLoading) + '</td></tr>'
    try {
      const params = new URLSearchParams()
      const limit = $('#id-audit-limit')
      if (limit && limit.value) params.set('limit', limit.value)
      const action = $('#id-audit-action')
      if (action && action.value.trim()) params.set('action', action.value.trim())
      const successSel = $('#id-audit-success')
      if (successSel && successSel.value) params.set('success', successSel.value)
      const qs = params.toString()
      const data = await api('GET', '/audit' + (qs ? '?' + qs : ''))
      const entries = (data && data.entries) || []
      renderAuditRows(tbody, entries)
    } catch (err) {
      tbody.innerHTML = ''
      setStatus(t().idnAuditLoadFailed(err.message), true)
    }
  }

  function renderAuditRows(tbody, entries) {
    tbody.innerHTML = ''
    if (entries.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#888;padding:1rem;">' + escHtml(t().idnAuditEmpty) + '</td></tr>'
      return
    }
    for (const e of entries) {
      // Render metadata as JSON; keep it short to avoid blowing the row.
      let metaText = ''
      if (e.metadata && typeof e.metadata === 'object') {
        try {
          metaText = JSON.stringify(e.metadata)
        } catch (_) {
          metaText = '(unserialisable)'
        }
        if (metaText.length > 160) metaText = metaText.slice(0, 157) + '…'
      }
      const successCell = e.success
        ? '<span style="color:#27ae60;">✓</span>'
        : '<span style="color:#c0392b;">✗</span>'
      const targetText =
        e.targetUserId || e.targetCredentialId
          ? (e.targetUserId || '') + (e.targetCredentialId ? ' / ' + e.targetCredentialId : '')
          : '—'
      const actorText =
        e.actorUserId
          ? e.actorUserId + ' (' + e.actorSource + ')'
          : '(' + e.actorSource + ')'
      const tr = document.createElement('tr')
      tr.innerHTML =
        '<td>' + escHtml(fmtTime(e.ts)) + '</td>' +
        '<td>' + successCell + '</td>' +
        '<td>' + escHtml(e.action) + '</td>' +
        '<td>' + escHtml(actorText) + '</td>' +
        '<td>' + escHtml(targetText) + '</td>' +
        '<td style="font-family:monospace;font-size:0.8em;color:#666;">' +
        escHtml(metaText) + '</td>'
      tbody.appendChild(tr)
    }
  }

  function renderUserRows(tbody, items) {
    tbody.innerHTML = ''
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:1rem;">' + escHtml(t().idnUsersEmpty) + '</td></tr>'
      return
    }
    for (const item of items) {
      const u = item.user || item
      const currentRole = item.role || '—'
      const tr = document.createElement('tr')
      tr.dataset.userId = u.id
      const roleSelect = ROLES.map(function (r) {
        const sel = r === currentRole ? ' selected' : ''
        return '<option value="' + escHtml(r) + '"' + sel + '>' + escHtml(r) + '</option>'
      }).join('')
      tr.innerHTML =
        '<td>' +
        escHtml(u.email) +
        '</td>' +
        '<td>' +
        escHtml(u.displayName || '—') +
        '</td>' +
        '<td><select data-act="role">' +
        roleSelect +
        '</select></td>' +
        '<td>' +
        escHtml(fmtTime(u.createdAt)) +
        '</td>' +
        '<td>' +
        escHtml(fmtTime(u.lastLoginAt)) +
        '</td>' +
        '<td class="id-actions">' +
        '<button type="button" data-act="creds" title="' + escHtml(t().idnBtnCredsTitle) + '">' + escHtml(t().idnBtnCreds) + '</button>' +
        '<button type="button" data-act="pw" title="' + escHtml(t().idnBtnPwTitle) + '">' + escHtml(t().idnBtnPw) + '</button>' +
        '<button type="button" data-act="key" title="' + escHtml(t().idnBtnKeyTitle) + '">' + escHtml(t().idnBtnKey) + '</button>' +
        '</td>'
      tbody.appendChild(tr)
    }
    wireRowActions(tbody)
  }

  function wireRowActions(tbody) {
    $$('tr', tbody).forEach(function (tr) {
      const userId = tr.dataset.userId
      if (!userId) return
      const sel = $('select[data-act="role"]', tr)
      if (sel) {
        // Snapshot the role at row-render time so we can compare on
        // change and revert if the operator backs out of the dangerous
        // confirmation.
        const originalRole = sel.value
        sel.addEventListener('change', async function () {
          const newRole = sel.value
          // V4-AUDIT-09: refuse to promote to owner without an explicit
          // typed confirmation. Owner can rotate passwords, create
          // users, and revoke credentials for the entire org — it's
          // not a casual click.
          if (newRole === 'owner' && originalRole !== 'owner') {
            const ok = confirmDanger(
              t().idnGrantOwnerTitle,
              t().idnGrantOwnerBody,
              'GRANT OWNER',
            )
            if (!ok) {
              sel.value = originalRole
              setStatus(t().idnGrantOwnerCancelled, false)
              return
            }
          }
          try {
            await api('PATCH', '/users/' + encodeURIComponent(userId), {
              role: newRole,
            })
            setStatus(t().idnRoleUpdated(newRole))
          } catch (err) {
            // Revert dropdown on backend rejection (e.g. last-owner protection)
            sel.value = originalRole
            setStatus(t().idnRoleUpdateFailed(err.message), true)
          }
        })
      }
      const pwBtn = $('button[data-act="pw"]', tr)
      if (pwBtn) {
        pwBtn.addEventListener('click', async function () {
          const pw = prompt(t().idnPwPrompt)
          if (pw == null) return
          try {
            await api('PATCH', '/users/' + encodeURIComponent(userId), { password: pw })
            setStatus(t().idnPwUpdated)
          } catch (err) {
            setStatus(t().idnPwUpdateFailed(err.message), true)
          }
        })
      }
      const keyBtn = $('button[data-act="key"]', tr)
      if (keyBtn) {
        keyBtn.addEventListener('click', async function () {
          const label = prompt(t().idnKeyLabelPrompt)
          if (label === null) return
          try {
            const body = label ? { label: label } : {}
            const out = await api('POST', '/users/' + encodeURIComponent(userId) + '/api-key', body)
            // Show ONCE in a separate window — alert() is intentional;
            // a fancy modal would risk getting dismissed by an accidental
            // background click and the key would be irrecoverable.
            window.prompt(
              t().idnKeyShowOnce,
              out.key,
            )
            setStatus(t().idnKeyIssued(out.credentialId))
          } catch (err) {
            setStatus(t().idnKeyIssueFailed(err.message), true)
          }
        })
      }
      const credsBtn = $('button[data-act="creds"]', tr)
      if (credsBtn) {
        credsBtn.addEventListener('click', async function () {
          try {
            const out = await api('GET', '/users/' + encodeURIComponent(userId) + '/credentials')
            const creds = out.credentials || []
            if (creds.length === 0) {
              alert(t().idnNoCreds)
              return
            }
            const lines = creds.map(function (c) {
              const label =
                c.label ||
                (c.kind === 'password' ? c.identifier : t().idnCredKindLabel(c.kind)) ||
                c.id
              return c.id + ' · ' + c.kind + ' · ' + label + ' · created ' + fmtTime(c.createdAt)
            })
            const toRevoke = prompt(
              t().idnCredListPrompt + lines.join('\n'),
            )
            if (!toRevoke) return
            const target = creds.find(function (c) { return c.id === toRevoke })
            if (!target) {
              setStatus(t().idnCredNotFound, true)
              return
            }
            // V4-AUDIT-09: revoking a `password` credential locks that
            // user out of any future v4 login (no other way to set a
            // new password without owner action). Demand typed confirm.
            // Token revocation is reversible (operator can issue a new
            // key), so the lighter native confirm is enough.
            if (target.kind === 'password') {
              const ok = confirmDanger(
                t().idnRevokePwTitle,
                t().idnRevokePwBody(target.identifier || target.id),
                'REVOKE PASSWORD',
              )
              if (!ok) {
                setStatus(t().idnRevokePwCancelled, false)
                return
              }
            } else {
              if (!confirm(t().idnConfirmRevokeCred(target.kind, toRevoke))) return
            }
            await api('DELETE', '/credentials/' + encodeURIComponent(toRevoke))
            setStatus(t().idnCredRevoked)
          } catch (err) {
            setStatus(t().idnCredOpFailed(err.message), true)
          }
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Phase 3 — invitation panel.
  //
  // The flow: owner fills in {email, role, displayName?, ttl?}, server
  // mints a row + token, UI shows the resulting URL ONCE in a prompt so
  // the operator can copy it and deliver it out-of-band (Signal, 1Password,
  // a piece of paper, whatever — that's the org's call).
  //
  // Status column displays the COMPUTED status from the server (it does
  // the "expired" overlay for us). Revoke turns a pending/expired row
  // into revoked; we refuse to revoke an already-accepted row at the
  // store level so the button is hidden in that case.
  // -------------------------------------------------------------------------

  function buildInviteUrl(token) {
    return window.location.origin + '/invite/' + encodeURIComponent(token)
  }

  async function refreshInvites() {
    const tbody = $('#id-invites-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="6">' + escHtml(t().idnLoading) + '</td></tr>'
    try {
      const params = new URLSearchParams()
      const status = $('#id-invites-status')
      if (status && status.value) params.set('status', status.value)
      const qs = params.toString()
      const data = await api('GET', '/invites' + (qs ? '?' + qs : ''))
      renderInviteRows(tbody, (data && data.invitations) || [])
    } catch (err) {
      tbody.innerHTML = ''
      setStatus(t().idnInvitesLoadFailed(err.message), true)
    }
  }

  function renderInviteRows(tbody, items) {
    tbody.innerHTML = ''
    if (items.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#888;padding:1rem;">' + escHtml(t().idnInvitesEmpty) + '</td></tr>'
      return
    }
    for (const inv of items) {
      const tr = document.createElement('tr')
      tr.dataset.invId = inv.id
      tr.dataset.invEmail = inv.email
      const statusColor =
        inv.status === 'pending'
          ? '#27ae60'
          : inv.status === 'accepted'
          ? '#1f6feb'
          : inv.status === 'revoked'
          ? '#c0392b'
          : '#888' // expired
      const statusCell =
        '<span style="color:' + statusColor + ';">' + escHtml(inv.status) + '</span>'
      // Only pending / expired / revoked invites can be revoked at the
      // store level (accepted is terminal — it's a real user now). We
      // also skip the button on already-revoked rows to avoid a no-op
      // click; the column then shows '—'.
      const canRevoke = inv.status === 'pending' || inv.status === 'expired'
      const actionCell = canRevoke
        ? '<button type="button" data-act="revoke" title="' + escHtml(t().idnBtnRevokeTitle) + '">' + escHtml(t().idnBtnRevoke) + '</button>'
        : '—'
      tr.innerHTML =
        '<td>' + escHtml(inv.email) + '</td>' +
        '<td>' + escHtml(inv.role) + '</td>' +
        '<td>' + statusCell + '</td>' +
        '<td>' + escHtml(fmtTime(inv.createdAt)) + '</td>' +
        '<td>' + escHtml(fmtTime(inv.expiresAt)) + '</td>' +
        '<td class="id-actions">' + actionCell + '</td>'
      tbody.appendChild(tr)
    }
    wireInviteRowActions(tbody)
  }

  function wireInviteRowActions(tbody) {
    $$('tr', tbody).forEach(function (tr) {
      const invId = tr.dataset.invId
      const invEmail = tr.dataset.invEmail
      if (!invId) return
      const btn = $('button[data-act="revoke"]', tr)
      if (!btn) return
      btn.addEventListener('click', async function () {
        if (!confirm(t().idnConfirmRevokeInvite(invEmail))) return
        try {
          await api('DELETE', '/invites/' + encodeURIComponent(invId))
          setStatus(t().idnInviteRevoked)
          await refreshInvites()
        } catch (err) {
          setStatus(t().idnInviteRevokeFailed(err.message), true)
        }
      })
    })
  }

  async function handleCreateInviteSubmit(e) {
    e.preventDefault()
    const form = e.target
    const email = (form.email.value || '').trim()
    if (!email) {
      setStatus(t().idnEmailRequired, true)
      return
    }
    const role = form.role.value || 'member'
    const ttlHoursRaw = form.ttlHours.value
    const ttlHours = ttlHoursRaw ? Number(ttlHoursRaw) : 24
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
      setStatus(t().idnTtlPositive, true)
      return
    }
    const body = {
      email: email,
      role: role,
      ttlMs: Math.round(ttlHours * ONE_HOUR_MS),
    }
    const dn = (form.displayName.value || '').trim()
    if (dn) body.displayName = dn
    try {
      const out = await api('POST', '/invites', body)
      const url = buildInviteUrl(out.token)
      // Show ONCE — alert + prompt pair mirrors the API key path. The
      // prompt's auto-select lets the operator hit Ctrl/Cmd+C
      // immediately, no clicking around to highlight.
      window.prompt(
        t().idnInviteShowOnce(email),
        url,
      )
      setStatus(t().idnInviteCreated(email))
      form.reset()
      // Set the TTL input back to the default after reset (form.reset
      // clears even the default value attribute on type=number).
      const ttlInput = form.ttlHours
      if (ttlInput) ttlInput.value = '24'
      await refreshInvites()
    } catch (err) {
      setStatus(t().idnInviteCreateFailed(err.message), true)
    }
  }

  async function handleCreateSubmit(e) {
    e.preventDefault()
    const form = e.target
    const email = (form.email.value || '').trim()
    if (!email) {
      setStatus(t().idnEmailRequired, true)
      return
    }
    const body = { email: email, role: form.role.value || 'member' }
    // V4-AUDIT-09: creating a user directly as owner is the highest-
    // privilege operation here (skips the "promote later" gate). Force
    // a typed confirmation, same standard as the role-change path.
    if (body.role === 'owner') {
      const ok = confirmDanger(
        t().idnCreateOwnerTitle,
        t().idnCreateOwnerBody(email),
        'CREATE OWNER',
      )
      if (!ok) {
        setStatus(t().idnCreateOwnerCancelled, false)
        return
      }
    }
    const dn = (form.displayName.value || '').trim()
    if (dn) body.displayName = dn
    const pw = form.password.value || ''
    if (pw) body.password = pw
    try {
      const out = await api('POST', '/users', body)
      setStatus(t().idnUserCreated(out.user && out.user.email))
      form.reset()
      await refreshUsers()
    } catch (err) {
      setStatus(t().idnUserCreateFailed(err.message), true)
    }
  }

  function buildUi(root) {
    const roleOptions = ROLES.map(function (r) {
      const sel = r === 'member' ? ' selected' : ''
      return '<option value="' + r + '"' + sel + '>' + r + '</option>'
    }).join('')
    root.innerHTML =
      '<div style="padding:1rem;max-width:64rem;">' +
      '<h2 style="margin-top:0;">' + escHtml(t().idnHeading) + '</h2>' +
      '<div id="id-me" style="margin-bottom:0.75rem;color:#555;font-size:0.9rem;">…</div>' +
      '<div id="id-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">' + escHtml(t().idnNewUser) + '</summary>' +
      '<form id="id-create-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="email" type="email" placeholder="email" required autocomplete="off" />' +
      '<input name="displayName" type="text" placeholder="' + escHtml(t().idnPhDisplayName) + '" autocomplete="off" />' +
      '<input name="password" type="password" placeholder="' + escHtml(t().idnPhPassword) + '" minlength="8" autocomplete="new-password" />' +
      '<select name="role">' +
      roleOptions +
      '</select>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">' + escHtml(t().idnBtnCreateUser) + '</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">' + escHtml(t().idnUserList) + '</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">Email</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColDisplayName) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColRole) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColCreated) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColLastLogin) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColActions) + '</th>' +
      '</tr></thead>' +
      '<tbody id="id-users-tbody"></tbody>' +
      '</table>' +
      // Phase 3 — invitation panel. Open-by-default because "invite a
      // teammate" is the headline owner action on a fresh install.
      '<details open style="margin-top:2rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">' + escHtml(t().idnInvitations) + '</summary>' +
      '<form id="id-invite-form" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.5rem;margin:0.75rem 0;">' +
      '<input name="email" type="email" placeholder="email" required autocomplete="off" />' +
      '<input name="displayName" type="text" placeholder="' + escHtml(t().idnPhDisplayName) + '" autocomplete="off" />' +
      '<select name="role">' +
      INVITE_ROLES.map(function (r) {
        const sel = r === 'member' ? ' selected' : ''
        return '<option value="' + r + '"' + sel + '>' + r + '</option>'
      }).join('') +
      '</select>' +
      '<input name="ttlHours" type="number" min="1" max="720" value="24" title="' + escHtml(t().idnTtlTitle) + '" />' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">' + escHtml(t().idnBtnCreateInvite) + '</button>' +
      '</form>' +
      '<p style="font-size:0.8rem;color:#666;margin:0.25rem 0 0.75rem;">' +
      escHtml(t().idnInviteHint) +
      '</p>' +
      '<div style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap;margin:0.5rem 0;">' +
      '<label style="display:flex;flex-direction:column;font-size:0.8rem;color:#555;">status' +
      '<select id="id-invites-status" style="padding:0.25rem;">' +
      '<option value="">all</option>' +
      INVITE_STATUSES.map(function (s) {
        return '<option value="' + s + '">' + s + '</option>'
      }).join('') +
      '</select>' +
      '</label>' +
      '<button id="id-invites-refresh" type="button" style="padding:0.4rem 0.75rem;">' + escHtml(t().idnBtnRefresh) + '</button>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">Email</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColRole) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColStatus) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColCreated) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColExpires) + '</th>' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColActions) + '</th>' +
      '</tr></thead>' +
      '<tbody id="id-invites-tbody"></tbody>' +
      '</table>' +
      '</details>' +
      // V4-AUDIT-06: collapsed-by-default audit log panel. Owner-only
      // (the route is gated; the panel is hidden from UI when the host
      // didn't wire identity at all — the section never renders then).
      '<details style="margin-top:2rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">' + escHtml(t().idnAuditLog) + '</summary>' +
      '<div style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap;margin:0.75rem 0;">' +
      '<label style="display:flex;flex-direction:column;font-size:0.8rem;color:#555;">action' +
      '<input id="id-audit-action" type="text" placeholder="(any)" style="padding:0.25rem;font-family:monospace;" />' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;font-size:0.8rem;color:#555;">success' +
      '<select id="id-audit-success" style="padding:0.25rem;">' +
      '<option value="">all</option>' +
      '<option value="true">success only</option>' +
      '<option value="false">failure only</option>' +
      '</select>' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;font-size:0.8rem;color:#555;">limit' +
      '<input id="id-audit-limit" type="number" min="1" max="1000" value="100" style="padding:0.25rem;width:6rem;" />' +
      '</label>' +
      '<button id="id-audit-refresh" type="button" style="padding:0.4rem 0.75rem;">' + escHtml(t().idnBtnRefresh) + '</button>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">' + escHtml(t().idnColTime) + '</th>' +
      '<th style="padding:0.4rem;">ok</th>' +
      '<th style="padding:0.4rem;">action</th>' +
      '<th style="padding:0.4rem;">actor</th>' +
      '<th style="padding:0.4rem;">target</th>' +
      '<th style="padding:0.4rem;">metadata</th>' +
      '</tr></thead>' +
      '<tbody id="id-audit-tbody"></tbody>' +
      '</table>' +
      '</details>' +
      '</div>'
    const form = $('#id-create-form', root)
    if (form) form.addEventListener('submit', handleCreateSubmit)
    const inviteForm = $('#id-invite-form', root)
    if (inviteForm) inviteForm.addEventListener('submit', handleCreateInviteSubmit)
    const invitesBtn = $('#id-invites-refresh', root)
    if (invitesBtn) {
      invitesBtn.addEventListener('click', function () {
        refreshInvites().catch(function () { /* setStatus reported it */ })
      })
    }
    const auditBtn = $('#id-audit-refresh', root)
    if (auditBtn) {
      auditBtn.addEventListener('click', function () {
        refreshAudit().catch(function () { /* setStatus reported it */ })
      })
    }
  }

  function isUsersTabActive() {
    return document.body.dataset.activeTab === 'users'
  }

  async function maybeRefresh() {
    if (!isUsersTabActive()) return
    await refreshMe()
    await refreshUsers()
    await refreshInvites()
    await refreshAudit()
  }

  function init() {
    const root = document.querySelector('section[data-tab="users"]')
    if (!root) return
    buildUi(root)
    // Re-render when admin.js flips the active tab.
    new MutationObserver(function () {
      maybeRefresh().catch(function () {
        /* setStatus already reported it */
      })
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    // Re-render on language switch — relabel the static shell, and reload the
    // dynamic sections (me / users / invites / audit) when the tab is showing
    // so the live rows pick up the new dict too. maybeRefresh() self-gates on
    // the active tab, so it's a no-op when another tab is in front.
    AH.onLangChange(function () {
      buildUi(root)
      maybeRefresh().catch(function () { /* setStatus reported it */ })
    })
    // If the user deep-linked to #users, render immediately.
    if (isUsersTabActive()) {
      maybeRefresh().catch(function () {})
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
