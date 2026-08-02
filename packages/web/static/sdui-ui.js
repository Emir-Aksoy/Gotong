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
 * SHELL-M4 — FREE-STANDING. This file used to reach into the SPA for its
 * strings, its host element, its language, and its navigation. It no longer
 * does: everything it needs arrives through `GotongPanel.mount(opts)`, and
 * the SPA is simply its first caller (see the autoboot block at the bottom).
 * Mount it in a bare HTML page with a <div> and this file's stylesheet and it
 * runs — that is the whole point, because a released shell has no app-core.js.
 *
 *   GotongPanel.mount({ host: document.getElementById('panel') })
 *
 * NOT a coupling: `fetch('/api/...')` stays root-relative on purpose. Which
 * hub those go to is decided in ONE place — hub-target.js (SHELL-M2) — and
 * duplicating that decision here is exactly what that milestone forbade.
 *
 * ONE PANEL PER PAGE, deliberately: mount() rebinds module-level state rather
 * than building a per-instance closure. Two live panels in one document is not
 * a thing the shell or the SPA needs, and paying for it would mean threading a
 * context through every one of the ~40 render functions below.
 */
;(function () {
  'use strict'

  var PANEL_TAB = 'panel'
  var HOST_ID = 'sdui-panel'

  // ---- strings (SHELL-M4) --------------------------------------------------
  // The renderer OWNS its copy. These 70 keys lived in app-core.js until
  // SHELL-M4; app-core was their only definer and this file their only
  // consumer, so moving them is a cut, not a duplication — and it makes the
  // failure that already bit once (a renderer shipping a key app-core never
  // defined, so the button rendered the raw key) structurally impossible.
  // A gate asserts every t() call here resolves in BOTH languages.
  var DEFAULT_LANG = 'zh'
  var STRINGS = {
    zh: {
      sduiBadgePending: (n) => `${n} 件待批`,
      sduiBadgeOpen: '去处理',
      sduiLoading: '加载中…',
      sduiLoadFailed: '面板加载失败',
      sduiUnavailable: '此 hub 未启用面板。',
      sduiDegraded: '你的面板配置读不出来,已临时显示默认面板。',
      sduiUnknownComponent: (t) => `组件「${t}」需要升级客户端才能显示。`,
      sduiComingSoon: (t) => `组件「${t}」即将上线。`,
      sduiClientOutdated: (s, c) =>
        `这台 hub 的面板格式是 v${s}，这个客户端只认到 v${c}，先不显示内容以免显示错。升级 app 后即可正常显示；也可以在下面换一个形态。`,
      sduiSourceMissing: '数据源未接入。',
      sduiChatPlaceholder: '和阿同说点什么…',
      sduiChatSend: '发送',
      sduiChatSending: '发送中…',
      sduiChatFailed: '发送失败',
      sduiChatEmpty: '先输入内容再发送。',
      sduiChatNoAgent: '这个 hub 还没有可对话的智能体——先在向导或管理面板创建一个。',
      sduiChatNoButler: '这个对话框固定连管家,但 hub 里还没有管家——先在向导或管理面板把一个可对话智能体设为管家。',
      sduiInboxEmpty: '没有等你处理的事项。',
      sduiInboxItemOpen: '去处理',
      // SDUI-M3 — 形态 picker (shape library / owner install)
      sduiShapeHeading: '面板形态',
      sduiShapeCurrentCustom: '当前是自定形态。',
      sduiShapeReset: '恢复默认',
      sduiShapeApply: '换上',
      sduiShapeApplying: '应用中…',
      sduiShapeApplied: '已换上,面板已刷新。',
      sduiShapeInstalled: '已为该成员装上。TA 下次打开面板即生效,也随时可以自己换回。',
      sduiShapeFailed: '操作失败',
      sduiShapeEmpty: '还没有可换的形态——在管理面板的模板画廊装一个带面板的模板(如「家庭面板三件套」)。',
      sduiShapeForMember: '给成员装形态(owner)',
      sduiShapeInstallBtn: '装上',
      sduiButlerChanged: '阿同调整了你的面板。',
      sduiButlerUndo: '撤销',
      sduiButlerUndone: '已撤销,面板已恢复。',
      sduiButlerAck: '知道了',
      // SDUI-C1a — data-driven components (schedules / tasks / status)
      sduiSchedulesEmpty: '你名下没有定时工作流。',
      sduiScheduleOff: '已停用',
      sduiScheduleInvalid: '配置有误,没在跑',
      sduiScheduleNever: '还没触发过',
      sduiScheduleLast: (m) => `上次:${m}`,
      sduiScheduleBadMark: '上次:(记录无法解析)',
      sduiCadenceDaily: (hh, tz) => `每天 ${hh}(${tz})`,
      sduiCadenceWeekly: (wd, hh, tz) => `每周${wd} ${hh}(${tz})`,
      sduiEveryMinutes: (n) => `每 ${n} 分钟`,
      sduiEveryHours: (n) => `每 ${n} 小时`,
      sduiWeekday: (d) => ['日', '一', '二', '三', '四', '五', '六'][d] ?? String(d),
      sduiTasksEmpty: '没有进行中的任务。',
      sduiTaskProgress: (a, b) => `${a}/${b} 步`,
      sduiStatusAllGood: '体检全绿,一切正常。',
      sduiCalendarMonthNote: '月视图暂以本周展示。',
      // SDUI-C1c — content:/connector: 中转卡(阿同整理,面板不直呼连接器)
      sduiContentByButler: '阿同写的',
      sduiContentCurated: '阿同整理',
      sduiContentUpdated: (w) => `更新于 ${w}`,
      sduiContentEmpty: '这里还没有内容——跟阿同说一句,让 TA 写上来。',
      sduiConnectorEmpty: (slot) => `「${slot}」还没有内容——跟阿同说一声,TA 整理好就会显示在这里。`,
      sduiCalendarRelayNote: '阿同整理的日历内容,按列表显示。',
      // SDUI-C1b — chart (usage.mine) + quick-actions
      sduiUsageEmpty: '这段时间还没有用量记录。',
      sduiUsageWeek: '近 7 天用量(按 UTC 日)',
      sduiUsageMonth: '近 30 天用量(按 UTC 日)',
      sduiUsageTotal: (n, cost) => `共 ${n} 次 · ${cost}`,
      sduiUsageCalls: (n) => `${n} 次`,
      sduiActionOpenChat: '找管家聊',
      sduiActionOpenInbox: '看待办',
      sduiActionComposeBrief: '来份简报',
      sduiActionStartWf: (id) => `启动 ${id}`,
      sduiActionStarting: '发起中…',
      sduiActionStarted: (id) => `已发起「${id}」,进展会出现在「我的」页。`,
      sduiActionNotAllowed: '这个工作流没有对你开放。',
      sduiActionFailed: '发起失败',
      sduiBriefPrefill: '给我来一份今天的简报吧。',
    },
    en: {
      sduiBadgePending: (n) => `${n} pending approval${n === 1 ? '' : 's'}`,
      sduiBadgeOpen: 'Review',
      sduiLoading: 'Loading…',
      sduiLoadFailed: 'Panel failed to load',
      sduiUnavailable: 'The panel is not enabled on this hub.',
      sduiDegraded: 'Your panel config could not be read; showing the default panel for now.',
      sduiUnknownComponent: (t) => `Component "${t}" needs a newer client to display.`,
      sduiComingSoon: (t) => `Component "${t}" is coming soon.`,
      sduiClientOutdated: (s, c) =>
        `This hub's panel format is v${s}; this client only understands v${c}, so the contents are held back rather than shown wrong. Update the app to see it — or switch to another shape below.`,
      sduiSourceMissing: 'Data source not connected.',
      sduiChatPlaceholder: 'Say something to Atong…',
      sduiChatSend: 'Send',
      sduiChatSending: 'Sending…',
      sduiChatFailed: 'Send failed',
      sduiChatEmpty: 'Type a message first.',
      sduiChatNoAgent: 'No chat-capable agent on this hub yet — create one in the wizard or admin console.',
      sduiChatNoButler: 'This chat is pinned to the butler, but this hub has no butler yet — enable one on a chat-capable agent in the wizard or admin console.',
      sduiInboxEmpty: 'Nothing waiting for you.',
      sduiInboxItemOpen: 'Review',
      // SDUI-M3 — 形态 picker (shape library / owner install)
      sduiShapeHeading: 'Panel shapes',
      sduiShapeCurrentCustom: 'You are on a custom shape.',
      sduiShapeReset: 'Restore default',
      sduiShapeApply: 'Use this',
      sduiShapeApplying: 'Applying…',
      sduiShapeApplied: 'Applied — panel refreshed.',
      sduiShapeInstalled: 'Installed for that member. It shows on their next panel visit; they can switch back anytime.',
      sduiShapeFailed: 'Action failed',
      sduiShapeEmpty: 'No shapes installed yet — install a panel-carrying template from the admin gallery (e.g. "family-panel-trio").',
      sduiShapeForMember: 'Install for a member (owner)',
      sduiShapeInstallBtn: 'Install',
      sduiButlerChanged: 'Atong adjusted your panel.',
      sduiButlerUndo: 'Undo',
      sduiButlerUndone: 'Undone — panel restored.',
      sduiButlerAck: 'Got it',
      // SDUI-C1a — data-driven components (schedules / tasks / status)
      sduiSchedulesEmpty: 'No scheduled workflows under your name.',
      sduiScheduleOff: 'off',
      sduiScheduleInvalid: 'misconfigured — not running',
      sduiScheduleNever: 'never fired',
      sduiScheduleLast: (m) => `last: ${m}`,
      sduiScheduleBadMark: 'last: (unreadable mark)',
      sduiCadenceDaily: (hh, tz) => `Daily ${hh} (${tz})`,
      sduiCadenceWeekly: (wd, hh, tz) => `Every ${wd} ${hh} (${tz})`,
      sduiEveryMinutes: (n) => `Every ${n} min`,
      sduiEveryHours: (n) => `Every ${n} h`,
      sduiWeekday: (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] ?? String(d),
      sduiTasksEmpty: 'No open tasks.',
      sduiTaskProgress: (a, b) => `${a}/${b} steps`,
      sduiStatusAllGood: 'All checks green.',
      sduiCalendarMonthNote: 'Month view currently shows this week.',
      // SDUI-C1c — content:/connector: relay cards (butler-curated; the panel never calls a connector)
      sduiContentByButler: 'Written by Atong',
      sduiContentCurated: 'Curated by Atong',
      sduiContentUpdated: (w) => `updated ${w}`,
      sduiContentEmpty: 'Nothing here yet — ask Atong to write it.',
      sduiConnectorEmpty: (slot) => `No "${slot}" content yet — ask Atong and it will show up here.`,
      sduiCalendarRelayNote: 'Butler-curated calendar notes, shown as a list.',
      // SDUI-C1b — chart (usage.mine) + quick-actions
      sduiUsageEmpty: 'No usage recorded in this window.',
      sduiUsageWeek: 'Last 7 days (UTC days)',
      sduiUsageMonth: 'Last 30 days (UTC days)',
      sduiUsageTotal: (n, cost) => `${n} calls · ${cost}`,
      sduiUsageCalls: (n) => `${n} calls`,
      sduiActionOpenChat: 'Open chat',
      sduiActionOpenInbox: 'Open inbox',
      sduiActionComposeBrief: 'Compose brief',
      sduiActionStartWf: (id) => `Run ${id}`,
      sduiActionStarting: 'Starting…',
      sduiActionStarted: (id) => `Started "${id}" — progress shows on your Home page.`,
      sduiActionNotAllowed: 'This workflow is not enabled for you.',
      sduiActionFailed: 'Failed to start',
      sduiBriefPrefill: "Give me today's brief, please.",
    },
  }

  // ---- host bindings (SHELL-M4) --------------------------------------------
  // Everything the renderer needs from its host, defaulted so a bare mount
  // works with `{ host }` alone. mount() overwrites; nothing else may.
  var CTX = {
    host: null,
    lang: function () { return DEFAULT_LANG },
    gotoHome: function () { window.location.hash = '#home' },
    ackKey: 'gotong-sdui-change-ack',
  }

  function t(key) {
    var dict = STRINGS[CTX.lang()] || STRINGS[DEFAULT_LANG]
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

  function gotoHome() { CTX.gotoHome() }

  // The schema version THIS renderer understands (SHELL-M3). In-repo it always
  // equals the hub's PANEL_SCHEMA_VERSION — they ship together and a gate pins
  // that. Inside a released shell it is frozen at build time while the hub
  // moves on, which is the whole reason it goes on the wire: the hub answers
  // with a verdict, and a config newer than this number is NOT rendered
  // best-effort (unknown fields could change the meaning of known ones) but
  // degraded whole-panel with a loud notice.
  var CLIENT_SCHEMA_VERSION = 1

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
  // Lazy agent discovery, shared across chat instances per render: one roster
  // fetch from GET /api/me/agents, then per-component pick. The BUTLER row
  // (server-computed isButler — never guessed client-side) wins over "first
  // chat-capable row": with several chat agents (双脑: 接待 + 专家) the first
  // row is return-order luck, and only the butler carries the member's session
  // window. No blind rows[0] fallback — a chat-less roster gets the honest
  // "no agent" state, not a random expert that may mishandle free-form chat.
  var agentPromise = null
  function discoverRoster() {
    if (!agentPromise) {
      agentPromise = fetch('/api/me/agents')
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          var rows = j && Array.isArray(j.agents) ? j.agents : []
          var butler = null
          var chat = null
          for (var i = 0; i < rows.length; i++) {
            var caps = Array.isArray(rows[i].capabilities) ? rows[i].capabilities : []
            if (caps.indexOf('chat') < 0) continue
            if (!chat) chat = rows[i]
            if (rows[i].isButler === true) { butler = rows[i]; break }
          }
          return { butler: butler, chat: chat }
        })
        .catch(function () { return { butler: null, chat: null } })
    }
    return agentPromise
  }
  // butlerOnly (source 'chat.butler') pins HARDER: butler or nothing — never
  // a fallback row, so a pinned chat cannot silently talk to the wrong agent.
  function discoverAgent(butlerOnly) {
    return discoverRoster().then(function (found) {
      return butlerOnly ? found.butler : (found.butler || found.chat)
    })
  }

  function renderChat(component) {
    var params = component && typeof component.params === 'object' ? component.params : {}
    // The one whitelisted chat source (panel-schema: sources ['chat.butler']).
    // Honoring it means butler-or-honest-placeholder, never a random row.
    var butlerOnly = !!(component && component.source === 'chat.butler')
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
    if (butlerOnly) {
      // Pinned chat on a butler-less hub: swap the box for the honest
      // placeholder up front (same cached roster fetch the send path shares).
      discoverAgent(true).then(function (agent) {
        if (agent && agent.id) return
        card.className = 'sdui-card sdui-placeholder'
        card.textContent = t('sduiChatNoButler')
      })
    }

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
        var agent = await discoverAgent(butlerOnly)
        if (!agent || !agent.id) {
          reply.className = 'sdui-bubble sdui-bubble-error'
          reply.textContent = t(butlerOnly ? 'sduiChatNoButler' : 'sduiChatNoAgent')
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
          list.appendChild(el('p', 'sdui-meta', t('sduiInboxEmpty')))
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

  // ---- C1a data-driven components ------------------------------------------
  // One fetch per named source per render (several components can share
  // `schedules.mine`); loadPanel resets the cache so every tab flip is fresh.
  // Three-state honesty mirrors the route: fetch failed → 加载失败;
  // { available:false } (source unwired on this host) → 数据源未接入;
  // { available:true } → real rows (empty state per component).
  var dataPromises = {}
  function fetchData(kind, qs) {
    // qs is a display param (e.g. chart's range=month) — part of the cache key
    // so a week chart and a month chart on one panel don't share a response.
    var key = kind + (qs ? '?' + qs : '')
    if (!dataPromises[key]) {
      dataPromises[key] = fetch('/api/me/panel/data/' + key)
        .then(function (r) { return r.ok ? r.json() : null })
        .catch(function () { return null })
    }
    return dataPromises[key]
  }

  function dataCard(cls, kind, onData, qs) {
    var card = el('div', 'sdui-card ' + cls)
    var body = el('div', 'sdui-data-body', t('sduiLoading'))
    card.appendChild(body)
    fetchData(kind, qs).then(function (j) {
      body.replaceChildren()
      if (!j) { body.appendChild(el('p', 'sdui-meta', t('sduiLoadFailed'))); return }
      if (j.available !== true) { body.appendChild(el('p', 'sdui-meta', t('sduiSourceMissing'))); return }
      onData(body, j)
    })
    return card
  }

  function componentParams(component) {
    return component && typeof component.params === 'object' && component.params ? component.params : {}
  }

  // Cadence rendering — JS port of the SEN-M4 tool-face helpers (same honest
  // encodings: hours are member-local per the schedule's own tz; daily/weekly
  // fired marks ARE local dates, interval marks are epoch-ms shown as UTC).
  function fmtTz(min) {
    if (min === 0) return 'UTC'
    var abs = Math.abs(min)
    var rem = abs % 60
    return 'UTC' + (min < 0 ? '-' : '+') + Math.floor(abs / 60) + (rem ? ':' + String(rem).padStart(2, '0') : '')
  }
  function hh(h) { return String(h).padStart(2, '0') + ':00' }
  function everyText(ms) {
    var min = Math.max(1, Math.round(ms / 60000))
    return min >= 60 && min % 60 === 0 ? t('sduiEveryHours', min / 60) : t('sduiEveryMinutes', min)
  }
  function cadenceText(c) {
    if (!c) return t('sduiScheduleInvalid')
    if (c.kind === 'daily') return t('sduiCadenceDaily', hh(c.hour), fmtTz(c.tzOffsetMinutes))
    if (c.kind === 'weekly') {
      return t('sduiCadenceWeekly', t('sduiWeekday', c.weekday), hh(c.hour), fmtTz(c.tzOffsetMinutes))
    }
    return everyText(c.everyMs)
  }
  function firedText(c, mark) {
    if (mark == null) return t('sduiScheduleNever')
    if (c && c.kind === 'interval') {
      var ms = Number(mark)
      return Number.isFinite(ms)
        ? t('sduiScheduleLast', new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
        : t('sduiScheduleBadMark')
    }
    return t('sduiScheduleLast', String(mark))
  }

  function renderScheduleList(component) {
    var params = componentParams(component)
    var limit = typeof params.limit === 'number' ? params.limit : 10
    return dataCard('sdui-schedules', 'schedules', function (body, j) {
      var rows = Array.isArray(j.schedules) ? j.schedules : []
      if (rows.length === 0) { body.appendChild(el('p', 'sdui-meta', t('sduiSchedulesEmpty'))); return }
      rows.slice(0, limit).forEach(function (r) {
        var row = el('div', 'sdui-sched-item')
        var head = el('div', 'sdui-sched-head')
        head.appendChild(el('strong', null, String(r.workflowId)))
        if (!r.valid) head.appendChild(el('span', 'sdui-chip sdui-chip-red', t('sduiScheduleInvalid')))
        else if (!r.enabled) head.appendChild(el('span', 'sdui-chip', t('sduiScheduleOff')))
        row.appendChild(head)
        var meta = r.valid
          ? cadenceText(r.cadence) + ' · ' + firedText(r.cadence, r.lastFiredMark)
          : firedText(r.cadence, r.lastFiredMark)
        row.appendChild(el('p', 'sdui-meta', meta))
        body.appendChild(row)
      })
    })
  }

  function renderCalendar(component) {
    var src = component && typeof component.source === 'string' ? component.source : ''
    // connector:* calendars read the butler-curated relay file (C1-c fork A) —
    // rendered as a labeled list card, never a fake grid.
    if (src.indexOf('connector:') === 0) return renderCalendarRelay(component)
    var params = componentParams(component)
    var view = params.view === 'day' || params.view === 'month' ? params.view : 'week'
    return dataCard('sdui-calendar', 'schedules', function (body, j) {
      var rows = Array.isArray(j.schedules) ? j.schedules : []
      var active = rows.filter(function (r) { return r.enabled && r.valid && r.cadence })
      if (active.length === 0) { body.appendChild(el('p', 'sdui-meta', t('sduiSchedulesEmpty'))); return }
      if (view === 'month') body.appendChild(el('p', 'sdui-meta sdui-cal-note', t('sduiCalendarMonthNote')))
      var browserTz = -new Date().getTimezoneOffset()
      var days = view === 'day' ? 1 : 7
      var grid = el('div', 'sdui-cal-grid' + (view === 'day' ? ' sdui-cal-one' : ''))
      var today = new Date()
      for (var i = 0; i < days; i++) {
        var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)
        var cell = el('div', 'sdui-cal-cell' + (i === 0 ? ' sdui-cal-today' : ''))
        cell.appendChild(el('div', 'sdui-cal-head',
          t('sduiWeekday', d.getDay()) + ' ' + (d.getMonth() + 1) + '/' + d.getDate()))
        active.forEach(function (r) {
          var c = r.cadence
          if (c.kind !== 'daily' && !(c.kind === 'weekly' && c.weekday === d.getDay())) return
          // The hour is member-local per the SCHEDULE's tz — flag it whenever
          // that differs from the browser's, so the grid never quietly lies.
          var tzNote = c.tzOffsetMinutes === browserTz ? '' : ' (' + fmtTz(c.tzOffsetMinutes) + ')'
          cell.appendChild(el('div', 'sdui-cal-item', hh(c.hour) + tzNote + ' ' + r.workflowId))
        })
        grid.appendChild(cell)
      }
      body.appendChild(grid)
      active.forEach(function (r) {
        if (r.cadence.kind !== 'interval') return
        body.appendChild(el('p', 'sdui-meta sdui-cal-interval', r.workflowId + ' · ' + everyText(r.cadence.everyMs)))
      })
    })
  }

  function renderTaskList(component) {
    var params = componentParams(component)
    var limit = typeof params.limit === 'number' ? params.limit : 20
    return dataCard('sdui-tasks', 'tasks', function (body, j) {
      var rows = Array.isArray(j.tasks) ? j.tasks : []
      if (rows.length === 0) { body.appendChild(el('p', 'sdui-meta', t('sduiTasksEmpty'))); return }
      rows.slice(0, limit).forEach(function (r) {
        var row = el('div', 'sdui-task-item')
        row.appendChild(el('span', 'sdui-task-title', String(r.title || r.id)))
        row.appendChild(el('span', 'sdui-meta sdui-task-progress', t('sduiTaskProgress', r.stepsDone, r.stepsTotal)))
        body.appendChild(row)
      })
    })
  }

  function renderStatusCard() {
    // Content is the SEN-M1 patrol card face verbatim — same red/yellow
    // authority the butler and the admin panel read; nothing here re-judges.
    return dataCard('sdui-status', 'status', function (body, j) {
      var cards = Array.isArray(j.cards) ? j.cards : []
      if (cards.length === 0) { body.appendChild(el('p', 'sdui-status-good', t('sduiStatusAllGood'))); return }
      cards.forEach(function (c) {
        var row = el('div', 'sdui-status-item sdui-status-' + (c.severity === 'red' ? 'red' : 'yellow'))
        row.appendChild(el('strong', null, String(c.label || c.id)))
        row.appendChild(el('p', 'sdui-meta', String(c.fact || '')))
        body.appendChild(row)
      })
    })
  }

  // ---- chart (usage.mine, C1-b) --------------------------------------------
  // Mirror of the BE-M1 fmtCost — one cost idiom, 4 dp keeps sub-cent visible.
  function fmtCost(micros) { return '$' + (micros / 1000000).toFixed(4) }

  function renderChart(component) {
    var params = componentParams(component)
    var range = params.range === 'month' ? 'month' : 'week'
    return dataCard('sdui-chart', 'usage', function (body, j) {
      var days = Array.isArray(j.days) ? j.days : []
      if (days.length === 0) { body.appendChild(el('p', 'sdui-meta', t('sduiUsageEmpty'))); return }
      var calls = 0
      var cost = 0
      var max = 1
      days.forEach(function (d) {
        calls += d.calls || 0
        cost += d.costMicros || 0
        if ((d.calls || 0) > max) max = d.calls
      })
      // Buckets are UTC calendar days (the ledger's own axis) — the heading
      // says so, so a UTC+8 member isn't surprised where midnight falls.
      body.appendChild(el('p', 'sdui-meta sdui-chart-head',
        t(range === 'month' ? 'sduiUsageMonth' : 'sduiUsageWeek') + ' · ' + t('sduiUsageTotal', calls, fmtCost(cost))))
      days.forEach(function (d) {
        var row = el('div', 'sdui-chart-row')
        var label = el('span', 'sdui-chart-day', String(d.day || '').slice(5))
        label.title = String(d.day || '')
        row.appendChild(label)
        var wrap = el('div', 'sdui-chart-bar-wrap')
        var bar = el('div', 'sdui-chart-bar')
        bar.style.width = Math.max(2, Math.round(((d.calls || 0) / max) * 100)) + '%'
        wrap.appendChild(bar)
        row.appendChild(wrap)
        row.appendChild(el('span', 'sdui-meta sdui-chart-meta',
          t('sduiUsageCalls', d.calls || 0) + ' · ' + fmtCost(d.costMicros || 0)))
        body.appendChild(row)
      })
    }, 'range=' + range)
  }

  // ---- quick-actions (C1-b) ------------------------------------------------
  // The config places WHITELISTED verbs only (panel-schema `actions` kind);
  // the renderer maps each verb to behavior hard-coded here. An unrecognized
  // verb renders nothing — never a dead button.
  function focusPanelChat(prefill) {
    var input = CTX.host && CTX.host.querySelector('.sdui-chat-input')
    if (!input) return false
    // compose_brief pre-fills but never auto-sends: the member sees exactly
    // what will be asked and presses send themselves (no surprise LLM spend).
    if (prefill && !input.value) input.value = prefill
    input.focus()
    if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'center' })
    return true
  }

  function startWorkflow(wfId, btn, status) {
    btn.disabled = true
    status.textContent = t('sduiActionStarting')
    fetch('/api/me/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: wfId, payload: {} }),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (out) {
        if (out.ok) { status.textContent = t('sduiActionStarted', wfId); return }
        status.textContent = out.j && out.j.code === 'workflow_not_allowed'
          ? t('sduiActionNotAllowed')
          : t('sduiActionFailed') + (out.j && out.j.error ? ': ' + out.j.error : '')
      })
      .catch(function (err) {
        status.textContent = t('sduiActionFailed') + ': ' + (err && err.message ? err.message : String(err))
      })
      .then(function () { btn.disabled = false })
  }

  function renderQuickActions(component) {
    var params = componentParams(component)
    var actions = Array.isArray(params.actions) ? params.actions : []
    var card = el('div', 'sdui-card sdui-qa')
    var wrap = el('div', 'sdui-qa-wrap')
    var status = el('p', 'sdui-meta sdui-qa-status', '')
    actions.slice(0, 6).forEach(function (a) {
      if (typeof a !== 'string') return
      var btn
      if (a === 'open_chat') {
        btn = el('button', 'sdui-qa-btn', t('sduiActionOpenChat'))
        btn.addEventListener('click', function () { if (!focusPanelChat()) gotoHome() })
      } else if (a === 'open_inbox') {
        btn = el('button', 'sdui-qa-btn', t('sduiActionOpenInbox'))
        btn.addEventListener('click', gotoHome)
      } else if (a === 'compose_brief') {
        btn = el('button', 'sdui-qa-btn', t('sduiActionComposeBrief'))
        btn.addEventListener('click', function () { if (!focusPanelChat(t('sduiBriefPrefill'))) gotoHome() })
      } else if (a.indexOf('start_workflow:') === 0) {
        var wfId = a.slice('start_workflow:'.length)
        if (!wfId) return
        btn = el('button', 'sdui-qa-btn', t('sduiActionStartWf', wfId))
        btn.addEventListener('click', function () { startWorkflow(wfId, btn, status) })
      } else {
        return
      }
      btn.type = 'button'
      wrap.appendChild(btn)
    })
    card.appendChild(wrap)
    card.appendChild(status)
    return card
  }

  // ---- content / connector relay cards (C1-c, fork A) ----------------------
  // The panel NEVER calls a connector. The butler curates (morning-brief
  // enrich, or the member just asks) and writes a per-member display file via
  // write_panel_content; `content:<id>` cards read that file, and a card bound
  // to `connector:<slot>` reads the relay file `connector.<slot>`. Every card
  // carries a FIXED provenance badge (「阿同写的/整理」 + updatedAt) — that
  // stamp is the honesty mechanism for butler-authored content, and freshness
  // is visibly the butler's cadence, never a pretend live feed.
  //
  // Markdown is rendered as a SAFE SUBSET built entirely with textContent:
  // #/##/### headings, - / * list items, **bold** — nothing else. Links stay
  // literal text on purpose (a compromised butler must not be able to plant
  // clickable phishing targets), raw HTML never parses, zero innerHTML.
  function appendInline(node, text) {
    var parts = String(text).split('**')
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue
      // Odd segments sit between a ** pair; an unmatched trailer stays plain.
      if (i % 2 === 1 && i < parts.length - (parts.length % 2 === 0 ? 1 : 0)) {
        node.appendChild(el('strong', null, parts[i]))
      } else {
        node.appendChild(document.createTextNode(parts[i]))
      }
    }
  }

  function renderMarkdownInto(body, markdown) {
    var lines = String(markdown).split('\n')
    var list = null
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var m = /^(#{1,3})\s+(.*)$/.exec(line)
      if (m) {
        list = null
        body.appendChild(el('div', 'sdui-md-h sdui-md-h' + m[1].length, m[2]))
        continue
      }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!list) { list = el('ul', 'sdui-md-list'); body.appendChild(list) }
        var li = el('li', 'sdui-md-li')
        appendInline(li, line.replace(/^\s*[-*]\s+/, ''))
        list.appendChild(li)
        continue
      }
      list = null
      if (!line.trim()) continue
      var p = el('p', 'sdui-md-p')
      appendInline(p, line)
      body.appendChild(p)
    }
  }

  function fmtWhen(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso)
    var p2 = function (n) { return String(n).padStart(2, '0') }
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  function contentSuffix(component, prefix) {
    var src = component && typeof component.source === 'string' ? component.source : ''
    return src.indexOf(prefix) === 0 ? src.slice(prefix.length) : ''
  }

  // Shared scaffold: fetch one content file, then badge + body. `provKey`
  // distinguishes 「阿同写的」 (authored) from 「阿同整理」 (connector relay).
  function relayCard(cls, fileId, provKey, emptyText, renderBody) {
    var card = el('div', 'sdui-card ' + cls)
    var body = el('div', 'sdui-data-body', t('sduiLoading'))
    card.appendChild(body)
    fetchData('content', 'id=' + encodeURIComponent(fileId)).then(function (j) {
      body.replaceChildren()
      if (!j) { body.appendChild(el('p', 'sdui-meta', t('sduiLoadFailed'))); return }
      if (j.available !== true) { body.appendChild(el('p', 'sdui-meta', t('sduiSourceMissing'))); return }
      if (j.exists !== true || typeof j.markdown !== 'string') {
        body.appendChild(el('p', 'sdui-meta', emptyText))
        return
      }
      // Fixed provenance stamp — rendered before any content, unconditionally.
      body.appendChild(el('p', 'sdui-meta sdui-md-provenance',
        t(provKey) + ' · ' + t('sduiContentUpdated', fmtWhen(j.updatedAt))))
      renderBody(body, j.markdown)
    })
    return card
  }

  function renderMarkdownCard(component) {
    var fileId = contentSuffix(component, 'content:')
    return relayCard('sdui-md', fileId, 'sduiContentByButler', t('sduiContentEmpty'), renderMarkdownInto)
  }

  function renderWeather(component) {
    var slot = contentSuffix(component, 'connector:')
    return relayCard('sdui-weather', 'connector.' + slot, 'sduiContentCurated',
      t('sduiConnectorEmpty', slot), renderMarkdownInto)
  }

  function renderCardFeed(component) {
    var params = componentParams(component)
    var limit = typeof params.limit === 'number' ? params.limit : 20
    var slot = contentSuffix(component, 'connector:')
    return relayCard('sdui-feed', 'connector.' + slot, 'sduiContentCurated',
      t('sduiConnectorEmpty', slot), function (body, markdown) {
        // Top-level list items become feed cards; anything else renders as one
        // prose card. Honest split, no pretend per-item metadata.
        var items = []
        String(markdown).split('\n').forEach(function (line) {
          if (/^\s*[-*]\s+/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ''))
        })
        if (items.length === 0) { renderMarkdownInto(body, markdown); return }
        items.slice(0, limit).forEach(function (item) {
          var row = el('div', 'sdui-feed-item')
          appendInline(row, item)
          body.appendChild(row)
        })
      })
  }

  function renderCalendarRelay(component) {
    var slot = contentSuffix(component, 'connector:')
    return relayCard('sdui-cal-relay', 'connector.' + slot, 'sduiContentCurated',
      t('sduiConnectorEmpty', slot), function (body, markdown) {
        // Relay content is butler-curated prose, not schedule rows — say so
        // instead of drawing a grid that would imply machine-read events.
        body.appendChild(el('p', 'sdui-meta sdui-cal-note', t('sduiCalendarRelayNote')))
        renderMarkdownInto(body, markdown)
      })
  }

  // The CLOSED registry — M2 shipped chat / approval-inbox / divider; C1a adds
  // the four hub-internal data components (schedules / tasks / status); C1-b
  // adds chart (usage.mine) + quick-actions; C1-c adds the content/relay trio
  // (markdown-card / weather / card-feed). SHELL-M3: every KNOWN_TYPE now has
  // an entry here, and a gate keeps it that way — a type listed as known with
  // no renderer is a promise the panel cannot keep.
  var REGISTRY = {
    divider: function () { return el('hr', 'sdui-divider') },
    chat: renderChat,
    'approval-inbox': function () { return renderApprovalInbox() },
    'schedule-list': renderScheduleList,
    calendar: renderCalendar,
    list: renderTaskList,
    'status-card': function () { return renderStatusCard() },
    chart: renderChart,
    'quick-actions': renderQuickActions,
    'markdown-card': renderMarkdownCard,
    weather: renderWeather,
    'card-feed': renderCardFeed,
  }

  function renderComponent(component) {
    var type = component && typeof component.type === 'string' ? component.type : ''
    var impl = Object.prototype.hasOwnProperty.call(REGISTRY, type) ? REGISTRY[type] : null
    if (impl) return impl(component)
    // Belt-and-braces: the KNOWN-but-unimplemented branch is unreachable while
    // the gate holds. It stays for the legitimate staging case (a type landing
    // in the roster one commit before its renderer) — the answer must never be
    // a crash or a blank.
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

  // ---- butler-change banner (SDUI-M4, the LOUD half of the safety net) -----
  // Shown whenever the LAST panel mutation was made by the butler — structural
  // honesty independent of whatever the model chose to say in chat. 撤销 hits
  // the one-slot restore; 知道了 acks THIS change only (keyed by timestamp in
  // localStorage) — the next butler change shows the banner again.
  // The key is CTX.ackKey (SHELL-M4): localStorage is one flat namespace per
  // origin, and a host embedding the panel beside its own state deserves a way
  // to say where the ack lives. Default is the SPA's historical key.
  function ackGet() {
    try { return window.localStorage.getItem(CTX.ackKey) } catch (_e) { return null }
  }
  function ackSet(at) {
    try { window.localStorage.setItem(CTX.ackKey, at) } catch (_e) { /* private mode — banner just reappears */ }
  }

  function renderButlerBanner(host, lastChange) {
    var strip = el('div', 'sdui-butler-banner')
    strip.appendChild(el('span', 'sdui-butler-banner-text', t('sduiButlerChanged')))
    var status = el('span', 'sdui-meta sdui-butler-banner-status', '')
    var undo = el('button', 'sdui-butler-undo', t('sduiButlerUndo'))
    undo.type = 'button'
    undo.addEventListener('click', function () {
      putPanel('/api/me/panel', { restore: true }, t('sduiButlerUndone'), status).then(function (ok) {
        if (ok) loadPanel()
      })
    })
    var ok = el('button', 'sdui-butler-ack', t('sduiButlerAck'))
    ok.type = 'button'
    ok.addEventListener('click', function () {
      ackSet(lastChange.at)
      strip.remove()
    })
    strip.appendChild(undo)
    strip.appendChild(ok)
    strip.appendChild(status)
    host.appendChild(strip)
  }

  function renderPanel(host, data) {
    host.replaceChildren()
    // POLISH-M1 — the renderer's own root hooks. The class scopes the design
    // tokens in sdui-ui.css; the scale attribute persists across renders (host
    // element attrs are not cleared by replaceChildren), so it is REMOVED here
    // and re-stamped only after the config is known readable — switching back
    // from a large shape must actually shrink, and the client_outdated branch
    // must not read a field from a schema it does not speak.
    host.classList.add('sdui-root')
    host.removeAttribute('data-sdui-scale')
    renderBadge(host)
    if (data.lastChange && data.lastChange.by === 'butler' && ackGet() !== data.lastChange.at) {
      renderButlerBanner(host, data.lastChange)
    }
    if (data.source === 'fallback') {
      host.appendChild(el('div', 'sdui-notice', t('sduiDegraded')))
    }
    // SHELL-M3 whole-panel downgrade. The hub says its schema is newer than
    // this build understands, so we stop BEFORE the config: a field we know by
    // name may not mean what it used to, and a half-understood panel is worse
    // than an honest blocked one. The badge above and the shape picker below
    // still render — the member keeps the pending strip and keeps a way out
    // (switch to another shape) even when the layout itself is unreadable.
    var contract = data.contract
    if (contract && contract.verdict === 'client_outdated') {
      host.appendChild(
        el('div', 'sdui-notice', t('sduiClientOutdated', contract.server, contract.client)),
      )
      renderShapeSection(host, data.source)
      return
    }
    var config = data.config
    var sections = config && typeof config === 'object' ? config.sections : null
    if (!Array.isArray(sections)) {
      host.appendChild(el('p', 'sdui-meta', t('sduiLoadFailed')))
      renderShapeSection(host, data.source)
      return
    }
    if (config.scale === 'large') host.setAttribute('data-sdui-scale', 'large')
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
    renderShapeSection(host, data.source)
  }

  // ---- 形态 (shape) picker — SDUI-M3 --------------------------------------
  // Installed presets come from the shape library (template installs); the
  // member switches with PUT {libraryId} and reverts with PUT {reset:true}.
  // The owner block is gated by CAPABILITY PROBING, not a role claim: the
  // member list endpoint is owner-only, so a non-owner's fetch 403s and the
  // block simply never appears (fail-closed UI).
  function putPanel(url, body, note, statusEl) {
    statusEl.textContent = t('sduiShapeApplying')
    return fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (out) {
        if (!out.ok) {
          statusEl.textContent = t('sduiShapeFailed') + (out.j && out.j.error ? ': ' + out.j.error : '')
          return false
        }
        statusEl.textContent = note
        return true
      })
      .catch(function (err) {
        statusEl.textContent = t('sduiShapeFailed') + ': ' + (err && err.message ? err.message : String(err))
        return false
      })
  }

  function renderShapeSection(host, source) {
    var details = document.createElement('details')
    details.className = 'sdui-shape'
    var summary = el('summary', 'sdui-shape-summary', t('sduiShapeHeading'))
    details.appendChild(summary)
    var body = el('div', 'sdui-shape-body')
    details.appendChild(body)
    host.appendChild(details)

    var status = el('p', 'sdui-meta sdui-shape-status', '')
    if (source === 'member') {
      var row = el('div', 'sdui-shape-current')
      row.appendChild(el('span', 'sdui-meta', t('sduiShapeCurrentCustom')))
      var resetBtn = el('button', 'sdui-shape-reset', t('sduiShapeReset'))
      resetBtn.type = 'button'
      resetBtn.addEventListener('click', function () {
        putPanel('/api/me/panel', { reset: true }, t('sduiShapeApplied'), status).then(function (ok) {
          if (ok) loadPanel()
        })
      })
      row.appendChild(resetBtn)
      body.appendChild(row)
    }

    var list = el('div', 'sdui-shape-list', t('sduiLoading'))
    body.appendChild(list)
    body.appendChild(status)
    fetch('/api/me/panel/library')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        var panels = j && Array.isArray(j.panels) ? j.panels : []
        list.replaceChildren()
        if (panels.length === 0) {
          list.appendChild(el('p', 'sdui-meta', t('sduiShapeEmpty')))
          return
        }
        panels.forEach(function (p) {
          var card = el('div', 'sdui-shape-item')
          var info = el('div', 'sdui-shape-info')
          info.appendChild(el('strong', null, String(p.title || p.id)))
          if (p.description) info.appendChild(el('p', 'sdui-meta', String(p.description)))
          card.appendChild(info)
          var apply = el('button', 'sdui-shape-apply', t('sduiShapeApply'))
          apply.type = 'button'
          apply.addEventListener('click', function () {
            putPanel('/api/me/panel', { libraryId: p.id }, t('sduiShapeApplied'), status).then(function (ok) {
              if (ok) loadPanel()
            })
          })
          card.appendChild(apply)
          list.appendChild(card)
        })
        renderOwnerInstall(body, panels, status)
      })
      .catch(function () {
        list.textContent = t('sduiLoadFailed')
      })
  }

  function renderOwnerInstall(body, panels, status) {
    if (panels.length === 0) return
    fetch('/api/admin/identity/users')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        // Rows are { user: {...}, role } (identity-routes joins membership).
        var rows = j && Array.isArray(j.users) ? j.users : []
        if (rows.length === 0) return
        var box = el('div', 'sdui-shape-owner')
        box.appendChild(el('h4', 'sdui-shape-owner-title', t('sduiShapeForMember')))
        var memberSel = document.createElement('select')
        rows.forEach(function (row) {
          var u = row && row.user ? row.user : row
          if (!u || !u.id) return
          var opt = document.createElement('option')
          opt.value = u.id
          opt.textContent = (u.displayName || u.email || u.id) + (row.role ? ' (' + row.role + ')' : '')
          memberSel.appendChild(opt)
        })
        if (memberSel.options.length === 0) return
        var shapeSel = document.createElement('select')
        panels.forEach(function (p) {
          var opt = document.createElement('option')
          opt.value = p.id
          opt.textContent = String(p.title || p.id)
          shapeSel.appendChild(opt)
        })
        var install = el('button', 'sdui-shape-install', t('sduiShapeInstallBtn'))
        install.type = 'button'
        install.addEventListener('click', function () {
          putPanel(
            '/api/admin/panel/users/' + encodeURIComponent(memberSel.value),
            { libraryId: shapeSel.value },
            t('sduiShapeInstalled'),
            status,
          )
        })
        box.appendChild(memberSel)
        box.appendChild(shapeSel)
        box.appendChild(install)
        body.appendChild(box)
      })
      .catch(function () { /* not an owner (403) — block never appears */ })
  }

  var loading = false
  function loadPanel() {
    var host = CTX.host
    if (!host || loading) return
    loading = true
    agentPromise = null // re-discover on each visit (agents may have changed)
    dataPromises = {} // C1a — every tab flip refetches the data sources too
    host.replaceChildren(el('p', 'sdui-meta', t('sduiLoading')))
    // Declare what this renderer speaks; the hub answers with the verdict.
    fetch('/api/me/panel?client=' + CLIENT_SCHEMA_VERSION)
      .then(function (r) {
        if (r.status === 503) {
          host.replaceChildren(el('p', 'sdui-meta', t('sduiUnavailable')))
          return null
        }
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (j) {
        if (j) renderPanel(host, j)
      })
      .catch(function () {
        host.replaceChildren(el('p', 'sdui-meta', t('sduiLoadFailed')))
      })
      .then(function () { loading = false })
  }

  // ---- public API (SHELL-M4) ----------------------------------------------
  // The renderer knows nothing about tabs. `render()` means "render now"; WHEN
  // that is belongs to the host, which is why the SPA's tab observer lives in
  // the autoboot block below rather than in here.
  function mount(opts) {
    var o = opts || {}
    if (!o.host || typeof o.host.appendChild !== 'function') {
      throw new Error('GotongPanel.mount: opts.host must be an element')
    }
    CTX.host = o.host
    // POLISH-M1 — root class at mount time too, so the pre-render loading text
    // already sits inside the token scope (renderPanel re-adds, harmlessly).
    // Theme is HOST chrome's decision, never the config's: dark is the default
    // (the native shell is dark chrome); light-chromed hosts — the SPA's white
    // content area, the standalone page — each opt in with { theme: 'light' }.
    if (typeof o.host.classList === 'object' && o.host.classList) o.host.classList.add('sdui-root')
    if (o.theme === 'light') o.host.setAttribute('data-sdui-theme', 'light')
    else o.host.removeAttribute('data-sdui-theme')
    if (typeof o.lang === 'function') CTX.lang = o.lang
    else if (typeof o.lang === 'string') CTX.lang = function () { return o.lang }
    if (typeof o.gotoHome === 'function') CTX.gotoHome = o.gotoHome
    if (typeof o.storageKey === 'string' && o.storageKey) CTX.ackKey = o.storageKey
    var handle = {
      host: o.host,
      render: loadPanel,
      // Only the SPA autoboot creates an observer, so only it has one to drop.
      destroy: function () { if (handle._stop) handle._stop() },
    }
    if (o.render !== false) loadPanel()
    return handle
  }

  window.GotongPanel = {
    mount: mount,
    SCHEMA_VERSION: CLIENT_SCHEMA_VERSION,
    // Exposed so a host can read the copy it is about to display (and so the
    // contract gate can check both languages) — not so it can be mutated.
    STRINGS: STRINGS,
  }

  // ---- SPA autoboot --------------------------------------------------------
  // The SPA is the FIRST CALLER of the API above, not a privileged side door:
  // every existing page load and every browser test exercises mount(). A host
  // without `#sdui-panel` (a bare page, the shell) gets nothing and calls
  // mount() itself.
  function boot() {
    var host = document.getElementById(HOST_ID)
    if (!host) return
    var handle = mount({
      host: host,
      // The SPA's content area is light-chromed (styles.css white body under a
      // dark site header) — dark-default tokens would paint invisible cards and
      // washed-out muted text there, so the SPA declares its chrome.
      theme: 'light',
      lang: function () { return (window.Gotong && window.Gotong.lang) || DEFAULT_LANG },
      gotoHome: function () {
        if (window.Gotong && typeof window.Gotong.gotoTab === 'function') window.Gotong.gotoTab('home')
        else window.location.hash = '#home'
      },
      render: false, // maybeActivate below decides — the panel tab may not be open
    })
    function maybeActivate() {
      if (document.body && document.body.dataset.activeTab === PANEL_TAB) handle.render()
    }
    var obs = new MutationObserver(maybeActivate)
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-active-tab'] })
    handle._stop = function () { obs.disconnect() }
    // The observer only sees tab flips — a language toggle while ON the panel
    // would otherwise leave stale-language content until the next flip.
    if (window.Gotong && typeof window.Gotong.onLangChange === 'function') {
      window.Gotong.onLangChange(maybeActivate)
    }
    maybeActivate()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
