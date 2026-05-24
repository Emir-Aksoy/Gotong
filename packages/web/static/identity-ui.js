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

  const API_BASE = '/api/admin/identity'
  const ROLES = ['owner', 'admin', 'member', 'viewer']

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
      const who = me.user ? me.user.email : '(v3 admin · 无 v4 user 绑定)'
      const display = me.user && me.user.displayName ? ' / ' + me.user.displayName : ''
      meEl.textContent = '当前: ' + who + display + ' · 角色 ' + me.role + ' · 来源 ' + me.authSource
    } catch (err) {
      meEl.textContent = '无法读取当前用户: ' + err.message
    }
  }

  async function refreshUsers() {
    const tbody = $('#id-users-tbody')
    if (!tbody) return
    tbody.innerHTML = '<tr><td colspan="6">载入中…</td></tr>'
    try {
      const data = await api('GET', '/users')
      renderUserRows(tbody, data.users || [])
    } catch (err) {
      tbody.innerHTML = ''
      setStatus('用户列表加载失败: ' + err.message, true)
    }
  }

  function renderUserRows(tbody, items) {
    tbody.innerHTML = ''
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:1rem;">还没有用户</td></tr>'
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
        '<button type="button" data-act="creds" title="查看 / 撤销凭证">凭证</button>' +
        '<button type="button" data-act="pw" title="改密码">改密码</button>' +
        '<button type="button" data-act="key" title="发放 API key">发 API key</button>' +
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
        sel.addEventListener('change', async function () {
          try {
            await api('PATCH', '/users/' + encodeURIComponent(userId), {
              role: sel.value,
            })
            setStatus('角色已更新为 ' + sel.value)
          } catch (err) {
            setStatus('改角色失败: ' + err.message, true)
          }
        })
      }
      const pwBtn = $('button[data-act="pw"]', tr)
      if (pwBtn) {
        pwBtn.addEventListener('click', async function () {
          const pw = prompt('新密码 (至少 8 个字符):')
          if (pw == null) return
          try {
            await api('PATCH', '/users/' + encodeURIComponent(userId), { password: pw })
            setStatus('密码已更新')
          } catch (err) {
            setStatus('改密码失败: ' + err.message, true)
          }
        })
      }
      const keyBtn = $('button[data-act="key"]', tr)
      if (keyBtn) {
        keyBtn.addEventListener('click', async function () {
          const label = prompt('API key 标签 (可选,便于以后识别):')
          if (label === null) return
          try {
            const body = label ? { label: label } : {}
            const out = await api('POST', '/users/' + encodeURIComponent(userId) + '/api-key', body)
            // Show ONCE in a separate window — alert() is intentional;
            // a fancy modal would risk getting dismissed by an accidental
            // background click and the key would be irrecoverable.
            window.prompt(
              'API key 仅显示一次,请立即复制保存 (Ctrl/Cmd+C):',
              out.key,
            )
            setStatus('已发放 API key, credentialId=' + out.credentialId)
          } catch (err) {
            setStatus('发 API key 失败: ' + err.message, true)
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
              alert('该用户没有任何凭证')
              return
            }
            const lines = creds.map(function (c) {
              const label =
                c.label ||
                (c.kind === 'password' ? c.identifier : '(' + c.kind + ' 凭证)') ||
                c.id
              return c.id + ' · ' + c.kind + ' · ' + label + ' · created ' + fmtTime(c.createdAt)
            })
            const toRevoke = prompt(
              '凭证列表 (输入要撤销的 credential id, 留空取消):\n\n' + lines.join('\n'),
            )
            if (!toRevoke) return
            if (!creds.find(function (c) { return c.id === toRevoke })) {
              setStatus('未找到匹配的 credential id', true)
              return
            }
            if (!confirm('确认撤销 credential ' + toRevoke + '?')) return
            await api('DELETE', '/credentials/' + encodeURIComponent(toRevoke))
            setStatus('credential 已撤销')
          } catch (err) {
            setStatus('凭证操作失败: ' + err.message, true)
          }
        })
      }
    })
  }

  async function handleCreateSubmit(e) {
    e.preventDefault()
    const form = e.target
    const email = (form.email.value || '').trim()
    if (!email) {
      setStatus('email 必填', true)
      return
    }
    const body = { email: email, role: form.role.value || 'member' }
    const dn = (form.displayName.value || '').trim()
    if (dn) body.displayName = dn
    const pw = form.password.value || ''
    if (pw) body.password = pw
    try {
      const out = await api('POST', '/users', body)
      setStatus('用户 ' + (out.user && out.user.email) + ' 已创建')
      form.reset()
      await refreshUsers()
    } catch (err) {
      setStatus('创建用户失败: ' + err.message, true)
    }
  }

  function buildUi(root) {
    const roleOptions = ROLES.map(function (r) {
      const sel = r === 'member' ? ' selected' : ''
      return '<option value="' + r + '"' + sel + '>' + r + '</option>'
    }).join('')
    root.innerHTML =
      '<div style="padding:1rem;max-width:64rem;">' +
      '<h2 style="margin-top:0;">用户管理 / Users</h2>' +
      '<div id="id-me" style="margin-bottom:0.75rem;color:#555;font-size:0.9rem;">…</div>' +
      '<div id="id-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">新建用户</summary>' +
      '<form id="id-create-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="email" type="email" placeholder="email" required autocomplete="off" />' +
      '<input name="displayName" type="text" placeholder="显示名 (可选)" autocomplete="off" />' +
      '<input name="password" type="password" placeholder="密码 (可选, 8+ 字符)" minlength="8" autocomplete="new-password" />' +
      '<select name="role">' +
      roleOptions +
      '</select>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">创建用户</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">用户列表</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">Email</th>' +
      '<th style="padding:0.4rem;">显示名</th>' +
      '<th style="padding:0.4rem;">角色</th>' +
      '<th style="padding:0.4rem;">创建</th>' +
      '<th style="padding:0.4rem;">上次登录</th>' +
      '<th style="padding:0.4rem;">操作</th>' +
      '</tr></thead>' +
      '<tbody id="id-users-tbody"></tbody>' +
      '</table>' +
      '</div>'
    const form = $('#id-create-form', root)
    if (form) form.addEventListener('submit', handleCreateSubmit)
  }

  function isUsersTabActive() {
    return document.body.dataset.activeTab === 'users'
  }

  async function maybeRefresh() {
    if (!isUsersTabActive()) return
    await refreshMe()
    await refreshUsers()
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
