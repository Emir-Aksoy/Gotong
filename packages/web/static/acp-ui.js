/**
 * ACP-OUT-M5 — outbound ACP agent registry (tab "联邦" in app.html,
 * panel #acp-outbound-panel, below the A2A panel).
 *
 * Self-contained module; same activation pattern as a2a-ui.js / peer-admin-ui.js
 * (owner-only, MutationObserver on <body data-active-tab>, targets its own panel
 * by id). CRUD over the M3 admin routes:
 *
 *   GET    /api/admin/acp-agents       list (with runtime liveness)
 *   POST   /api/admin/acp-agents       register one (id is the dispatch target)
 *   PATCH  /api/admin/acp-agents/:id    enable/disable, edit command/args/cwd/caps
 *   DELETE /api/admin/acp-agents/:id    remove + unregister from the hub
 *
 * An outbound ACP agent is a LOCAL participant that drives a coding agent
 * (Claude Code / Codex) over a LONG-LIVED ACP session — spawn once, hold the
 * session, dispatch many tasks. Unlike A2A there is NOTHING secret to enter, not
 * even an env-var pointer: an ACP bridge rides the underlying agent's OWN login
 * (`claude` / `codex` already logged in on this machine), so the whole record
 * (command/args/cwd) is non-secret config shown in full. The badge stays honest —
 * a disabled row reads "已停用", not "在跑"; toggle it on (a PATCH) and the host
 * registers it on the running hub without a restart.
 * When the host didn't wire identity the routes 503 and we say so rather than
 * render a form that can't save.
 */
;(function () {
  'use strict'

  const API = '/api/admin/acp-agents'

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
  // args are whitespace-separated argv tokens; NOT comma-split (a comma can be a
  // legitimate character inside an argument). Quoting/embedded-space argv is an
  // edge case the MVP form doesn't model — edit the stored record directly for that.
  function parseArgs(s) {
    return String(s || '')
      .split(/\s+/)
      .filter(Boolean)
  }

  function setStatus(root, msg, kind) {
    const el = $('#acp-status', root)
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
        : reason === 'id_conflict'
          ? '未激活·id 冲突'
          : reason === 'not_found'
            ? '未激活·未找到'
            : '未激活'
    return (
      '<span title="' + escHtml(reason || '') + '" style="' + base + 'background:#fdecea;color:#c0392b;">' +
      txt +
      '</span>'
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
      '<h2 style="margin-top:0;">出站 ACP 编码智能体</h2>' +
      '<p style="color:#555;font-size:0.9rem;margin:0 0 0.5rem;">注册本 hub 经 ACP 长连接驱动的编码智能体 ' +
      '(Claude Code / Codex)。派发某个本地能力 (capability) 时,会把它<strong>启动一次→保持 session→反复派任务</strong>' +
      '(任务间上下文保留),由它在子进程里跑编码工作。替代旧的 example 胶水,改为持久化 + 即时生效。</p>' +
      '<p style="color:#555;font-size:0.85rem;margin:0 0 1rem;"><strong>这里无需任何密钥</strong> —— ' +
      'ACP 桥接复用底层 agent <strong>自己的登录态</strong> (本机已 <code>claude</code> / <code>codex</code> 登录),' +
      '所以命令 / 参数 / 工作目录都是非密配置,完整存储。某行停用时显示「已停用」;启用后 host 立即在运行的 hub 上注册 (无需重启)。' +
      '破坏性动作 (改文件/删/push…) 默认 fail-closed 当场拒绝。</p>' +
      '<div id="acp-status" style="margin-bottom:1rem;min-height:1.2em;font-size:0.9rem;color:#555;"></div>' +
      '<details open style="margin-bottom:1.5rem;">' +
      '<summary style="cursor:pointer;font-weight:bold;">注册出站编码智能体</summary>' +
      '<form id="acp-add-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.5rem;margin-top:0.75rem;">' +
      '<input name="id" type="text" placeholder="本地 participant id (派发目标, 唯一)" required autocomplete="off" />' +
      '<input name="label" type="text" placeholder="显示名 (可选)" autocomplete="off" />' +
      '<input name="capabilities" type="text" placeholder="能力 capabilities (逗号分隔, 至少一个)" required autocomplete="off" style="grid-column:1 / -1;" />' +
      '<input name="command" type="text" placeholder="命令 command (如 npx 或 codex-acp)" required autocomplete="off" />' +
      '<input name="args" type="text" placeholder="参数 args (空格分隔, 如 @zed-industries/claude-code-acp)" autocomplete="off" />' +
      '<input name="cwd" type="text" placeholder="工作目录 cwd (可选, 默认 host 进程目录)" autocomplete="off" style="grid-column:1 / -1;" />' +
      '<label style="grid-column:1 / -1;font-size:0.85rem;color:#555;display:flex;gap:0.4rem;align-items:center;">' +
      '<input name="enabled" type="checkbox" checked /> 启用 (立即在 hub 上注册, 首个派发时才真正 spawn 子进程)</label>' +
      '<button type="submit" style="grid-column:1 / -1;padding:0.5rem;">注册</button>' +
      '</form>' +
      '</details>' +
      '<h3 style="margin-bottom:0.5rem;">已注册出站编码智能体</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">' +
      '<thead><tr style="text-align:left;border-bottom:1px solid #ccc;background:#fafafa;">' +
      '<th style="padding:0.4rem;">id / 显示名</th>' +
      '<th style="padding:0.4rem;">能力</th>' +
      '<th style="padding:0.4rem;">命令 + 参数</th>' +
      '<th style="padding:0.4rem;">工作目录</th>' +
      '<th style="padding:0.4rem;">状态</th>' +
      '<th style="padding:0.4rem;">操作</th>' +
      '</tr></thead>' +
      '<tbody id="acp-tbody"><tr><td colspan="6" style="padding:0.6rem;color:#888;">载入中…</td></tr></tbody>' +
      '</table>' +
      '</div>'

    const form = $('#acp-add-form', root)
    if (form) form.addEventListener('submit', function (e) { handleAdd(root, e) })
  }

  function renderRows(root, agents) {
    const tbody = $('#acp-tbody', root)
    if (!tbody) return
    if (!agents.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="padding:0.6rem;color:#888;">还没有注册出站 ACP 编码智能体。' +
        '在上面表单注册一个 —— 之后派发它声明的能力就会启动并驱动 Claude Code / Codex。</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const a of agents) {
      const idLabel = a.label
        ? escHtml(a.label) + ' <code style="color:#888;">' + escHtml(a.id) + '</code>'
        : '<code>' + escHtml(a.id) + '</code>'
      const caps = (a.capabilities || []).map(function (c) { return escHtml(c) }).join(', ')
      const cmdLine = escHtml([a.command].concat(a.args || []).join(' '))
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #eee'
      tr.innerHTML =
        '<td style="padding:0.4rem;">' + idLabel + '</td>' +
        '<td style="padding:0.4rem;"><code style="color:#555;">' + caps + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + cmdLine + '</code></td>' +
        '<td style="padding:0.4rem;"><code style="color:#888;">' + escHtml(a.cwd || '—') + '</code></td>' +
        '<td style="padding:0.4rem;">' + statusBadge(a) + '</td>' +
        '<td style="padding:0.4rem;white-space:nowrap;">' +
        '<button type="button" class="acp-toggle" style="padding:0.25rem 0.5rem;">' +
        (a.enabled ? '停用' : '启用') + '</button> ' +
        '<button type="button" class="acp-del" style="padding:0.25rem 0.5rem;color:#c0392b;">删除</button>' +
        '</td>'
      tr.querySelector('.acp-toggle').addEventListener('click', function () {
        doPatch(root, a.id, { enabled: !a.enabled }, a.enabled ? '已停用' : '已启用')
      })
      tr.querySelector('.acp-del').addEventListener('click', function () {
        if (!window.confirm('删除出站编码智能体「' + (a.label || a.id) + '」? 派发它能力的工作流将不再驱动该 agent。')) return
        doDelete(root, a.id)
      })
      tbody.appendChild(tr)
    }
  }

  // ---- load / mutate ----------------------------------------------------

  function unwired(root, err) {
    if (err && err.status === 503) {
      renderRows(root, [])
      setStatus(root, '此主机未启用身份存储 (出站 ACP 不可用)', 'error')
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
      command: str('command'),
      args: parseArgs(str('args')),
      enabled: fd.get('enabled') != null,
    }
    // Optional: only send when filled, so the store keeps its default (null).
    const cwd = str('cwd')
    if (cwd) body.cwd = cwd
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

  // ---- activation (mirror a2a-ui.js) ------------------------------------

  function isActive() {
    return document.body.dataset.activeTab === 'federation'
  }
  function maybeLoad(root) {
    if (!isActive()) return Promise.resolve()
    return load(root)
  }
  function init() {
    // Target our own panel by id, not section[data-tab="federation"] — that
    // tab holds several panels (peer onboarding + manifest + A2A) and a bare
    // data-tab selector would grab whichever comes first.
    const root = document.querySelector('#acp-outbound-panel')
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
