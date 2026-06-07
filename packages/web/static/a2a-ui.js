/**
 * Route B P1-M11d — outbound A2A agent registry (tab "联邦" in app.html,
 * panel #a2a-outbound-panel, below the peer panels).
 *
 * Self-contained module; same activation pattern as peer-admin-ui.js /
 * saml-ui.js (owner-only, MutationObserver on <body data-active-tab>, targets
 * its own panel by id). CRUD over the M11c admin routes:
 *
 *   GET    /api/admin/a2a-agents       list (with runtime liveness)
 *   POST   /api/admin/a2a-agents       register one (id is the dispatch target)
 *   PATCH  /api/admin/a2a-agents/:id    enable/disable, rotate url/skill/caps
 *   DELETE /api/admin/a2a-agents/:id    remove + unregister from the hub
 *
 * An outbound A2A agent is a LOCAL participant that forwards a matching
 * capability dispatch to an external agent's A2A message/send. The bearer is
 * NEVER entered here: `tokenEnv` names the env var the host reads it from, so
 * the table shows the env-var name (non-secret) and an honest liveness badge —
 * a row whose env var isn't set reads "未激活·环境变量未设", not "在跑". After
 * the operator provisions that env var, toggling the row off→on (a PATCH) makes
 * the host re-read it and register the agent without a full restart.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render a form that can't save.
 */
;(function () {
  'use strict'

  const API = '/api/admin/a2a-agents'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // capabilities are entered comma/space separated; split + drop blanks.
  function parseCaps(s) {
    return String(s || '')
      .split(/[\s,]+/)
      .filter(Boolean)
  }

  function setStatus(root, msg, kind) {
    const el = $('#a2a-status', root)
    if (!el) return
    el.textContent = msg || ''
    el.style.color = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e7e34' : '#555'
  }

  // Honest liveness badge — green only when actually registered on the hub.
  function statusBadge(a) {
    const base =
      'display:inline-block;padding:0.1rem 0.45rem;border-radius:0.25rem;font-size:0.75rem;white-space:nowrap;'
    if (a.active) {
      return '<span style="' + base + 'background:#e6f4ea;color:#1e7e34;">在跑</span>'
    }
    const reason = a.inactiveReason
    const txt =
      reason === 'disabled'
        ? '已停用'
        : reason === 'token_env_unset'
          ? '未激活·环境变量未设'
          : reason === 'id_conflict'
            ? '未激活·id 冲突'
            : '未激活'
    return (
      '<span title="' + escHtml(reason || '') + '" style="' + base + 'background:#fdecea;color:#c0392b;">' +
      txt +
      '</span>'
    )
  }

  // Stream H2-OUT — dispatch mode. null lifecycle = blocking (remote must answer
  // in one turn); a lifecycle object = long-running (poll tasks/get while the
  // remote stays parked). `{}` opts in with the participant's defaults.
  function lifecycleText(a) {
    if (!a.lifecycle) return '<span style="color:#888;">阻塞</span>'
    const lc = a.lifecycle
    const parts = []
    if (lc.pollIntervalMs != null) parts.push(lc.pollIntervalMs + 'ms')
    if (lc.maxAttempts != null) parts.push('×' + lc.maxAttempts)
    const detail = parts.length ? ' (' + parts.join(' ') + ')' : ' (默认)'
    return (
      '<span title="远端返回挂起任务时轮询 tasks/get" style="color:#1e7e34;">长任务' + detail + '</span>'
    )
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
    return (await readJson(await fetch(API))).agents || []
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
      '<h2 style="margin-top:0;">出站 A2A 智能体</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">注册本 hub 对外转发的 A2A 智能体。' +
      '把某个本地能力 (capability) 派发出去时,会转成对外部智能体的 <code>message/send</code> 调用。' +
      '替代旧的 <code>AIPE_A2A_AGENTS</code> 环境变量,改为持久化 + 即时生效。</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;"><strong>令牌不在这里填</strong> —— ' +
      '「令牌环境变量」是 host 读取 bearer 的环境变量<strong>名</strong>,密钥本身永不进数据库或浏览器。' +
      '某行环境变量未设置时显示「未激活」;在主机设好后把该行停用→启用即可让 host 重新读取并上线 (无需重启)。</p>' +
      '<div id="a2a-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;color:#555;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">注册出站智能体</summary>' +
      '<form id="a2a-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="id" type="text" placeholder="本地 participant id (派发目标, 唯一)" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="显示名 (可选)" autocomplete="off" />' +
      '<input name="capabilities" type="text" placeholder="能力 capabilities (逗号分隔, 至少一个)" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="url" type="url" placeholder="远端 A2A message/send URL" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="tokenEnv" type="text" placeholder="令牌环境变量名 (如 WRITER_A2A_TOKEN)" required autocomplete="off" />' +
      '<input name="peerId" type="text" placeholder="X-Aipe-Peer-Id (AipeHub↔AipeHub 时, 可选)" autocomplete="off" />' +
      '<input name="targetSkill" type="text" placeholder="远端 skill (metadata.skill, 可选)" autocomplete="off" style="grid-column:1 / -1;" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="lifecycle" type="checkbox" /> 长任务模式 (远端返回挂起任务时轮询 <code>tasks/get</code>; 不勾=阻塞, 远端必须一轮回完)</label>' +
      '<input name="pollIntervalMs" type="number" min="250" placeholder="轮询间隔 ms (可选, 默认 3000)" autocomplete="off" />' +
      '<input name="maxAttempts" type="number" min="1" placeholder="最多轮询次数 (可选, 默认 20)" autocomplete="off" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> 启用 (令牌环境变量已设则立即上线)</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">注册</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">已注册出站智能体</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">id / 显示名</th>' +
      '<th style="padding:0.4rem;">能力</th>' +
      '<th style="padding:0.4rem;">URL</th>' +
      '<th style="padding:0.4rem;">令牌环境变量</th>' +
      '<th style="padding:0.4rem;">模式</th>' +
      '<th style="padding:0.4rem;">状态</th>' +
      '<th style="padding:0.4rem;">操作</th>' +
      '</tr></thead>' +
      '<tbody id="a2a-tbody"><tr><td colspan="7" style="padding:0.6rem;color:#888;">载入中…</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#a2a-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, agents) {
    const tbody = $('#a2a-tbody', root)
    if (!tbody) return
    if (!agents.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" style="padding:0.6rem;color:#888;">还没有注册出站 A2A 智能体。' +
        '在上面表单注册一个 —— 之后派发它声明的能力就会转发到远端。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const a of agents) {
      const idLabel = a.label
        ? escHtml(a.label) + ' <code style="color:#888;">' + escHtml(a.id) + '</code>'
        : '<code>' + escHtml(a.id) + '</code>'
      const caps = (a.capabilities || []).map(function (c) { return escHtml(c) }).join(', ')
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code style="color:#555;">' + caps + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.url) + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.tokenEnv) + '</code></td>' +
        '<td style="padding:0.4rem;">' + lifecycleText(a) + '</td>' +
        '<td style="padding:0.4rem;">' + statusBadge(a) + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="a2a-toggle" style="padding:0.25rem 0.5rem;">' +
        (a.enabled ? '停用' : '启用') + '</button> ' +
        '<button type="button" class="a2a-life" style="padding:0.25rem 0.5rem;">' +
        (a.lifecycle ? '改阻塞' : '改长任务') + '</button> ' +
        '<button type="button" class="a2a-del" style="padding:0.25rem 0.5rem;color:#c0392b;">删除</button>' +
        '</td>'
      tr.querySelector('.a2a-toggle').addEventListener('click', function () {
        doPatch(root, a.id, { enabled: !a.enabled }, a.enabled ? '已停用' : '已启用')
      })
      tr.querySelector('.a2a-life').addEventListener('click', function () {
        // Flip blocking <-> long-running (defaults). Precise poll tuning is via
        // re-registration, same as caps/url (the table has no inline field edit).
        doPatch(
          root,
          a.id,
          { lifecycle: a.lifecycle ? null : {} },
          a.lifecycle ? '已改为阻塞' : '已改为长任务',
        )
      })
      tr.querySelector('.a2a-del').addEventListener('click', function () {
        if (!window.confirm('删除出站智能体「' + (a.label || a.id) + '」? 派发它能力的工作流将不再转发到远端。')) return
        doDelete(root, a.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, '此主机未启用身份存储 (出站 A2A 不可用)', 'error')
      return true
    }
    return false
  }

  async function load(root) {
    setStatus(root, '载入…', 'loading')
    try {
      const agents = await apiList()
      renderRows(root, agents)
      const live = agents.filter(function (a) { return a.active }).length
      setStatus(root, '共 ' + agents.length + ' 个 (在跑 ' + live + ')', 'ok')
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
      id: str('id'),
      capabilities: parseCaps(str('capabilities')),
      url: str('url'),
      tokenEnv: str('tokenEnv'),
      enabled: fd.get('enabled') != null,
    }
    // Optional: only send when filled, so the store keeps its default (null).
    const peerId = str('peerId')
    if (peerId) body.peerId = peerId
    const targetSkill = str('targetSkill')
    if (targetSkill) body.targetSkill = targetSkill
    const label = str('label')
    if (label) body.label = label
    // Stream H2-OUT — long-running lifecycle. Unchecked → omit (blocking default).
    // Checked → send a lifecycle object; empty numbers stay out so `{}` opts in
    // with the participant's defaults, a number tunes that field.
    if (fd.get('lifecycle') != null) {
      const lc = {}
      const poll = parseInt(str('pollIntervalMs'), 10)
      if (poll > 0) lc.pollIntervalMs = poll
      const max = parseInt(str('maxAttempts'), 10)
      if (max > 0) lc.maxAttempts = max
      body.lifecycle = lc
    }
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

  // ---- activation (mirror peer-admin-ui.js) -----------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    // Target our own panel by id, not section[data-tab="federation"] — that
    // tab holds several panels (peer onboarding + manifest browse) and a bare
    // data-tab selector would grab whichever comes first.
    const root = document.querySelector('#a2a-outbound-panel')
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
