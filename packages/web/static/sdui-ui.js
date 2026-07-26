/**
 * sdui-ui.js — SDUI-M2. The config-driven member panel renderer.
 *
 * MEMBER-VISIBLE (unlike the 11 admin `*-ui.js` panels this protocol comes
 * from): loaded by a plain `<script defer>` in app.html, activates on
 * `<body data-active-tab="panel">`, renders `GET /api/me/panel` into the
 * empty `#sdui-panel` section. Every tab flip RE-renders (fresh data + the
 * current language), matching the admin panels' refresh-on-flip contract.
 *
 * Renderer invariants (the client half of the SDUI plan's hard boundaries):
 *
 *  - CLOSED registry. A config can only PLACE components that ship in this
 *    file. Known-but-not-yet-implemented types render a "coming soon" card;
 *    unknown types render an "upgrade your client" card (version-negotiation
 *    honesty — never blank, never crash, never pretend).
 *  - RESERVED ZONE. `approval-inbox` ignores the config entry entirely (its
 *    render function takes no arguments) — semantics are hard-coded here, a
 *    config can only choose where it sits.
 *  - FIXED BADGE. The "N pending approvals" strip is rendered unconditionally
 *    by renderPanel itself — it is NOT a component, so no config can remove
 *    or occlude it. UI twin of the A1 probe.
 *  - Component CONTENT always comes from hub APIs (inbox / agents / chat),
 *    never from the config. The config chose layout; the hub says what's true.
 *
 * KNOWN_TYPES mirrors `PANEL_COMPONENT_TYPES` in
 * packages/personal-butler/src/panel-schema.ts — an anti-rot test asserts the
 * two lists stay identical (tests/sdui-ui-contract.test.ts).
 *
 * i18n: reads the live dict off window.Gotong.t at call time (app-core.js
 * loads first); `sdui*` keys, function-form for interpolation.
 */
;(function () {
  'use strict'

  var PANEL_TAB = 'panel'
  var HOST_ID = 'sdui-panel'

  function t(key) {
    var dict = (window.Gotong && window.Gotong.t) || {}
    var v = dict[key]
    if (typeof v === 'function') return v.apply(null, [].slice.call(arguments, 1))
    return v != null ? v : key
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function gotoHome() {
    if (window.Gotong && typeof window.Gotong.gotoTab === 'function') window.Gotong.gotoTab('home')
    else window.location.hash = '#home'
  }

  // Mirror of PANEL_COMPONENT_TYPES (personal-butler panel-schema.ts).
  var KNOWN_TYPES = [
    'divider',
    'chat',
    'approval-inbox',
    'card-feed',
    'markdown-card',
    'chart',
    'calendar',
    'list',
    'weather',
    'status-card',
    'schedule-list',
    'quick-actions',
    'image-card',
  ]

  // ---- NDJSON reader (verbatim semantics of app.js readNdjsonStream) ------
  async function readNdjson(r, onRaw) {
    var reader = r.body.getReader()
    var decoder = new TextDecoder()
    var buf = ''
    var raw = ''
    var result = null
    var handleLine = function (line) {
      if (!line.trim()) return
      var msg
      try {
        msg = JSON.parse(line)
      } catch (_e) {
        return
      }
      if (msg && msg.kind === 'chunk' && typeof msg.text === 'string') {
        raw += msg.text
        onRaw(raw)
      } else if (msg && msg.kind === 'result') result = msg
    }
    try {
      for (;;) {
        var step = await reader.read()
        if (step.done) break
        buf += decoder.decode(step.value, { stream: true })
        var nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf) handleLine(buf)
    } catch (_e) {
      /* dropped mid-stream — missing result is the error signal */
    }
    return result
  }

  // ---- chat component ------------------------------------------------------
  // Lazy agent discovery, shared across chat instances per render: first
  // chat-capable row from GET /api/me/agents (else the first row).
  var agentPromise = null
  function discoverAgent() {
    if (!agentPromise) {
      agentPromise = fetch('/api/me/agents')
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          var rows = j && Array.isArray(j.agents) ? j.agents : []
          for (var i = 0; i < rows.length; i++) {
            var caps = Array.isArray(rows[i].capabilities) ? rows[i].capabilities : []
            if (caps.indexOf('chat') >= 0) return rows[i]
          }
          return rows[0] || null
        })
        .catch(function () { return null })
    }
    return agentPromise
  }

  function renderChat(component) {
    var params = component && typeof component.params === 'object' ? component.params : {}
    var card = el('div', 'sdui-card sdui-chat')
    var log = el('div', 'sdui-chat-log')
    var row = el('div', 'sdui-chat-row')
    var input = el('input', 'sdui-chat-input')
    input.type = 'text'
    input.placeholder = typeof params.placeholder === 'string' ? params.placeholder : t('sduiChatPlaceholder')
    var btn = el('button', 'sdui-chat-send', t('sduiChatSend'))
    btn.type = 'button'
    row.appendChild(input)
    row.appendChild(btn)
    card.appendChild(log)
    card.appendChild(row)

    function bubble(kind, text) {
      var b = el('div', 'sdui-bubble sdui-bubble-' + kind, text)
      log.appendChild(b)
      log.scrollTop = log.scrollHeight
      return b
    }

    async function send() {
      var prompt = String(input.value || '').trim()
      if (!prompt) {
        bubble('error', t('sduiChatEmpty'))
        return
      }
      btn.disabled = true
      btn.textContent = t('sduiChatSending')
      input.value = ''
      bubble('user', prompt)
      var reply = bubble('assistant', '…')
      try {
        var agent = await discoverAgent()
        if (!agent || !agent.id) {
          reply.className = 'sdui-bubble sdui-bubble-error'
          reply.textContent = t('sduiChatNoAgent')
          return
        }
        var r = await fetch('/api/me/agents/' + encodeURIComponent(agent.id) + '/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: prompt, stream: true }),
        })
        var j
        if ((r.headers.get('content-type') || '').indexOf('application/x-ndjson') >= 0 && r.body) {
          j = await readNdjson(r, function (raw) { reply.textContent = raw })
        } else {
          j = await r.json().catch(function () { return null })
        }
        var result = j && j.result
        var out = result && result.output
        var errored = !r.ok || !result || result.kind !== 'ok' || (out && out.stopReason === 'error')
        if (errored) {
          reply.className = 'sdui-bubble sdui-bubble-error'
          reply.textContent = t('sduiChatFailed') + ((j && j.error) ? ': ' + j.error : '')
          return
        }
        reply.textContent = out && typeof out.text === 'string' ? out.text : JSON.stringify(out || {})
      } catch (err) {
        reply.className = 'sdui-bubble sdui-bubble-error'
        reply.textContent = t('sduiChatFailed') + ': ' + (err && err.message ? err.message : String(err))
      } finally {
        btn.disabled = false
        btn.textContent = t('sduiChatSend')
      }
    }

    btn.addEventListener('click', send)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send()
    })
    return card
  }

  // ---- approval-inbox (★ reserved zone) ------------------------------------
  // Takes NO config argument on purpose: nothing in the config can reach this
  // renderer. List content comes solely from GET /api/me/inbox.
  function renderApprovalInbox() {
    var card = el('div', 'sdui-card sdui-inbox')
    var list = el('div', 'sdui-inbox-list', t('sduiLoading'))
    card.appendChild(list)
    fetch('/api/me/inbox')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        var items = j && Array.isArray(j.items) ? j.items : []
        list.replaceChildren()
        if (items.length === 0) {
          list.appendChild(el('p', 'me-meta', t('sduiInboxEmpty')))
          return
        }
        items.forEach(function (item) {
          var row = el('div', 'sdui-inbox-item')
          row.appendChild(el('span', 'sdui-inbox-title', String(item.title || item.id || '')))
          var open = el('button', 'sdui-inbox-open', t('sduiInboxItemOpen'))
          open.type = 'button'
          open.addEventListener('click', gotoHome)
          row.appendChild(open)
          list.appendChild(row)
        })
      })
      .catch(function () {
        list.textContent = t('sduiLoadFailed')
      })
    return card
  }

  // ---- placeholder cards ---------------------------------------------------
  function placeholderCard(text) {
    return el('div', 'sdui-card sdui-placeholder', text)
  }

  // The CLOSED registry — M2 ships chat / approval-inbox / divider live.
  var REGISTRY = {
    divider: function () { return el('hr', 'sdui-divider') },
    chat: renderChat,
    'approval-inbox': function () { return renderApprovalInbox() },
  }

  function renderComponent(component) {
    var type = component && typeof component.type === 'string' ? component.type : ''
    var impl = Object.prototype.hasOwnProperty.call(REGISTRY, type) ? REGISTRY[type] : null
    if (impl) return impl(component)
    if (KNOWN_TYPES.indexOf(type) >= 0) return placeholderCard(t('sduiComingSoon', type))
    return placeholderCard(t('sduiUnknownComponent', type || '?'))
  }

  // ---- panel ---------------------------------------------------------------
  function renderBadge(host) {
    // Renderer FIXTURE, not a component: rendered before and outside any
    // config-driven content, so no panel.json can remove or occlude it.
    var strip = el('div', 'sdui-badge')
    strip.hidden = true
    host.appendChild(strip)
    fetch('/api/me/inbox')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        var n = j && Array.isArray(j.items) ? j.items.length : 0
        if (n <= 0) return
        strip.replaceChildren()
        strip.appendChild(el('span', 'sdui-badge-count', t('sduiBadgePending', n)))
        var open = el('button', 'sdui-badge-open', t('sduiBadgeOpen'))
        open.type = 'button'
        open.addEventListener('click', gotoHome)
        strip.appendChild(open)
        strip.hidden = false
      })
      .catch(function () { /* badge is best-effort; inbox errors surface in the component */ })
  }

  function renderPanel(host, data) {
    host.replaceChildren()
    renderBadge(host)
    if (data.source === 'fallback') {
      host.appendChild(el('div', 'sdui-notice', t('sduiDegraded')))
    }
    var config = data.config
    var sections = config && typeof config === 'object' ? config.sections : null
    if (!Array.isArray(sections)) {
      host.appendChild(el('p', 'me-meta', t('sduiLoadFailed')))
      return
    }
    if (typeof config.title === 'string' && config.title) {
      host.appendChild(el('h2', 'sdui-title', config.title))
    }
    sections.forEach(function (section) {
      if (!section || typeof section !== 'object') return
      var box = el('div', 'sdui-section')
      if (typeof section.heading === 'string' && section.heading) {
        box.appendChild(el('h3', 'sdui-heading', section.heading))
      }
      var components = Array.isArray(section.components) ? section.components : []
      components.forEach(function (component) {
        box.appendChild(renderComponent(component))
      })
      host.appendChild(box)
    })
  }

  var loading = false
  function loadPanel() {
    var host = document.getElementById(HOST_ID)
    if (!host || loading) return
    loading = true
    agentPromise = null // re-discover on each visit (agents may have changed)
    host.replaceChildren(el('p', 'me-meta', t('sduiLoading')))
    fetch('/api/me/panel')
      .then(function (r) {
        if (r.status === 503) {
          host.replaceChildren(el('p', 'me-meta', t('sduiUnavailable')))
          return null
        }
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (j) {
        if (j) renderPanel(host, j)
      })
      .catch(function () {
        host.replaceChildren(el('p', 'me-meta', t('sduiLoadFailed')))
      })
      .then(function () { loading = false })
  }

  function maybeActivate() {
    if (document.body && document.body.dataset.activeTab === PANEL_TAB) loadPanel()
  }

  function boot() {
    if (!document.getElementById(HOST_ID)) return
    new MutationObserver(maybeActivate).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-active-tab'],
    })
    maybeActivate()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
