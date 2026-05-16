/* AipeHub — admin console (v2.0, file-first).
 *
 * All admin endpoints require the cookie minted by /admin?token=…
 * (or `Authorization: Bearer …`). No browser caches.
 */
(() => {
  const { $, t, applyStaticI18n, onLangChange, escapeHtml, summarize, isBadResult,
          fetchJson, connectStream, syncLangFromConfig,
          fetchLeaderboard, renderLeaderboard, taskMetricsHtml, formatScore,
          attachContribToggle, applyContribToggleState, attachCapChips } = window.AipeHub

  // Managed-agent state: list, providers available, secrets status, form mode.
  const ma = {
    agents: [],
    providers: [],
    // Mirrors GET /api/admin/secrets — used to decorate the "API key" panel
    // and to figure out whether a given agent has its own override key.
    secrets: { providers: {}, agents: {}, env: {} },
    formMode: 'create',   // 'create' | 'edit'
    editingId: null,
  }

  // Workflow state. `available` is `null` until we've probed the API:
  //   null    → unknown (initial)
  //   false   → host has no WorkflowSurface (API returned 404) — keep section hidden
  //   true    → host supports workflows; render the panel
  const wf = {
    available: null,
    workflows: [],
    // Run history modal state. `workflowId` is set when an admin clicks
    // "view history" on a card; `runs` is the most-recent N rows we
    // fetched; `selectedRunId` is whichever row the admin opened.
    runs: {
      workflowId: null,
      rows: [],
      selectedRunId: null,
    },
  }

  const state = {
    participants: [],
    transcript: [],
    pendingApplications: [],
    tasks: [],
    known: { admins: [], workers: [] },
    // Task cards remember their expanded/collapsed state across re-renders.
    // Plain `Set<TaskId>` — wiped on reload (no localStorage), restored by
    // clicking transcript rows or the card head again. Memory-only.
    expandedTasks: new Set(),
  }

  // Per-tab filter on the task panel; cleared on reload (no browser storage)
  let taskFilter = 'all'
  // Per-tab leaderboard window; defaults to "all time". No persistence.
  let lbWindow = 'all'

  let dom = null
  function resolveDom() {
    dom = {
      participantsList: $('participants-list'),
      transcriptList: $('transcript-list'),
      transcriptCount: $('transcript-count'),
      pendingAppsSection: $('pending-apps'),
      pendingAppsList: $('pending-apps-list'),
      dispatchForm: $('dispatch-form'),
      dispatchMsg: $('dispatch-msg'),
      dStrategy: $('d-strategy'),
      dTo: $('d-to'),
      dToLabel: $('d-to-label'),
      dCaps: $('d-caps'),
      dCapsLabel: $('d-caps-label'),
      dTitle: $('d-title'),
      dPayload: $('d-payload'),
      dPriority: $('d-priority'),
      dWeight: $('d-weight'),
      evaluateForm: $('evaluate-form'),
      evaluateMsg: $('evaluate-msg'),
      eTask: $('e-task'),
      eRating: $('e-rating'),
      eComment: $('e-comment'),
      tasksFilters: $('tasks-filters'),
      tasksList: $('tasks-list'),
      knownAdminsList: $('known-admins-list'),
      knownWorkersList: $('known-workers-list'),
      logoutBtn: $('logout-btn'),
      lbWindow: $('lb-window'),
      lbList: $('leaderboard-list'),
      lbSummary: $('lb-summary'),
      contribToggle: $('contrib-toggle'),
      contribToggleInput: $('contrib-toggle-input'),
      // Managed agents (v2.1)
      maList: $('managed-agents-list'),
      maSummary: $('ma-summary'),
      maNewBtn: $('ma-new-btn'),
      maImportBtn: $('ma-import-btn'),
      maKeysBtn: $('ma-keys-btn'),
      maKeysModal: $('ma-keys-modal'),
      maKeysList: $('ma-keys-list'),
      maKeysMsg: $('ma-keys-msg'),
      maApiKey: $('ma-api-key'),
      maApiKeyHint: $('ma-api-key-hint'),
      maApiKeyClear: $('ma-api-key-clear'),
      maFormModal: $('ma-form-modal'),
      maForm: $('ma-form'),
      maFormTitle: $('ma-form-title'),
      maFormEditWarning: $('ma-form-edit-warning'),
      maFormMsg: $('ma-form-msg'),
      maId: $('ma-id'),
      maDisplayName: $('ma-display-name'),
      maCaps: $('ma-caps'),
      maProvider: $('ma-provider'),
      maBaseUrl: $('ma-base-url'),
      maProviderLabel: $('ma-provider-label'),
      maModel: $('ma-model'),
      maSystem: $('ma-system'),
      maWeight: $('ma-weight'),
      maImportModal: $('ma-import-modal'),
      maImportFile: $('ma-import-file'),
      maImportText: $('ma-import-text'),
      maImportSubmit: $('ma-import-submit'),
      maImportMsg: $('ma-import-msg'),
      maGhImportBtn: $('ma-gh-import-btn'),
      maGhImportModal: $('ma-gh-import-modal'),
      maGhUrl: $('ma-gh-url'),
      maGhSource: $('ma-gh-source'),
      maGhResolved: $('ma-gh-resolved'),
      maGhImportSubmit: $('ma-gh-import-submit'),
      maGhImportMsg: $('ma-gh-import-msg'),
      maImportDropdown: document.querySelector('.ma-import-dropdown'),
      // Workflows (v2.1)
      wfSection: $('workflows'),
      wfList: $('workflows-list'),
      wfSummary: $('wf-summary'),
      wfImportBtn: $('wf-import-btn'),
      wfImportModal: $('wf-import-modal'),
      wfImportFile: $('wf-import-file'),
      wfImportText: $('wf-import-text'),
      wfImportSubmit: $('wf-import-submit'),
      wfImportMsg: $('wf-import-msg'),
      // Run history modal (v0.3)
      wfRunsModal: $('wf-runs-modal'),
      wfRunsTarget: $('wf-runs-target'),
      wfRunsList: $('wf-runs-list'),
      wfRunsEmpty: $('wf-runs-empty'),
      wfRunDetail: $('wf-run-detail'),
      wfRunsMsg: $('wf-runs-msg'),
      // Room health banner (v2.1+)
      hToday: $('health-today-tasks'),
      hOnline: $('health-online'),
      hOnlineSub: $('health-online-sub'),
      hUnrated: $('health-unrated'),
      hTop3: $('health-top3'),
    }
  }

  async function refresh() {
    const snap = await fetchJson('/api/state')
    state.participants = snap.participants
    state.transcript = snap.transcript
    state.pendingApplications = snap.pendingApplications || []
    state.tasks = snap.tasks || []
    state.known = snap.known || { admins: [], workers: [] }
    if (snap.config?.defaultLang) syncLangFromConfig(snap.config.defaultLang)
    renderAll()
  }

  function applyEvent(ev) {
    state.transcript.push(ev)
    switch (ev.kind) {
      case 'participant_joined':
        if (!state.participants.find((p) => p.id === ev.data.id)) {
          state.participants.push({
            id: ev.data.id,
            kind: ev.data.participantKind,
            capabilities: ev.data.capabilities,
            load: 0,
          })
        }
        // A managed agent just registered (or re-registered after edit);
        // its online flag flips. Cheap to re-pull.
        refreshManagedAgents().catch(() => {})
        // Workflow runners use id prefix `workflow:`; pull when one appears.
        if (typeof ev.data.id === 'string' && ev.data.id.startsWith('workflow:')) {
          refreshWorkflows().catch(() => {})
        }
        break
      case 'participant_left':
        state.participants = state.participants.filter((p) => p.id !== ev.data.id)
        refreshManagedAgents().catch(() => {})
        if (typeof ev.data.id === 'string' && ev.data.id.startsWith('workflow:')) {
          refreshWorkflows().catch(() => {})
        }
        break
      case 'agent_pending':
        state.pendingApplications.push(ev.data)
        break
      case 'agent_approved':
      case 'agent_rejected':
        state.pendingApplications = state.pendingApplications.filter(
          (a) => a.id !== ev.data.applicationId,
        )
        break
      case 'task':
      case 'task_result':
      case 'evaluation':
        // Tasks are derived from the transcript; rather than reimplement
        // the merge here, just re-pull state. Small, fine for v2.
        refresh().catch((err) => console.error('task refresh failed:', err))
        return
      case 'service_trashed':
        // Toast notification + refresh the services tab if it's
        // currently visible. RFC Q3=A wants the user to know data
        // moved to trash with a 30-day window.
        showServicesToast(t.servicesToastTrashed)
        if (document.body.dataset.activeTab === 'services') {
          refreshServices().catch((err) => console.warn('services refresh failed:', err))
        }
        break
      case 'service_purged':
        if (document.body.dataset.activeTab === 'services') {
          refreshServices().catch(() => {})
        }
        break
    }
    renderAll()
  }

  function renderAll() {
    if (!dom) return
    renderPendingApps()
    renderParticipants()
    renderTranscript()
    renderTasks()
    renderKnownRoster()
    renderManagedAgents()
    if (wf.available) renderWorkflows()
    // The leaderboard is its own async pull — re-fetch on every full
    // render so a fresh task_result / evaluation immediately re-ranks.
    // Cheap (one /api/leaderboard call), but we swallow failures so a
    // transient hiccup doesn't disable the rest of the page.
    refreshLeaderboard().catch((err) => console.warn('leaderboard refresh failed:', err))
    refreshHealth().catch((err) => console.warn('health refresh failed:', err))
  }

  // Room health banner — counts derived from /api/leaderboard?from=<7d> +
  // local state (participants, transcript). No new endpoint; the
  // expensive piece is a single leaderboard fetch that's already cheap.
  async function refreshHealth() {
    if (!dom?.hToday) return

    // (1) today's dispatched tasks — count straight from the in-memory
    // transcript so this stays correct across SSE events without
    // round-tripping.
    const today0 = new Date()
    today0.setHours(0, 0, 0, 0)
    const todayStart = today0.getTime()
    let todayTasks = 0
    for (const e of state.transcript) {
      if (e.kind === 'task' && e.ts >= todayStart) todayTasks++
    }

    // (2) online split — agents vs humans, from the live participants array.
    let onlineAgents = 0
    let onlineHumans = 0
    for (const p of state.participants) {
      if (p.kind === 'agent') onlineAgents++
      else if (p.kind === 'human') onlineHumans++
    }

    // (3) last-7d leaderboard — gives us Top 3 + unratedTaskCount.
    const now = Date.now()
    const weekStart = now - 7 * 24 * 60 * 60 * 1000
    let lb = null
    try {
      lb = await fetchJson(`/api/leaderboard?from=${weekStart}&to=${now}`)
    } catch (err) {
      console.warn('refreshHealth leaderboard fetch failed:', err)
    }

    // Render
    dom.hToday.textContent = String(todayTasks)
    dom.hOnline.textContent = String(onlineAgents + onlineHumans)
    const subFn = t.healthOnlineSub
    dom.hOnlineSub.textContent = typeof subFn === 'function'
      ? subFn(onlineAgents, onlineHumans)
      : `${onlineAgents} · ${onlineHumans}`
    dom.hUnrated.textContent = lb ? String(lb.unratedTaskCount) : '—'

    const top3 = lb?.rows?.slice(0, 3) ?? []
    if (top3.length === 0) {
      dom.hTop3.classList.add('empty')
      dom.hTop3.textContent = t.healthTop3Empty ?? '—'
    } else {
      dom.hTop3.classList.remove('empty')
      dom.hTop3.innerHTML = top3
        .map(
          (row) =>
            `<li><span class="top-id">${escapeHtml(row.participantId)}</span>` +
            `<span class="top-score">${formatScore(row.totalContribution)}</span></li>`,
        )
        .join('')
    }
  }

  async function refreshLeaderboard() {
    if (!dom?.lbList) return
    const lb = await fetchLeaderboard(lbWindow)
    renderLeaderboard(dom.lbList, lb, dom.lbSummary)
  }

  function renderPendingApps() {
    const root = dom.pendingAppsList
    root.innerHTML = ''
    if (state.pendingApplications.length === 0) {
      root.innerHTML = `<p class="empty">${escapeHtml(t.noPendingAgents)}</p>`
      dom.pendingAppsSection.classList.remove('has-pending')
      return
    }
    dom.pendingAppsSection.classList.add('has-pending')
    for (const app of state.pendingApplications) {
      const card = document.createElement('div')
      card.className = 'pending-app-card'
      const agents = app.agents
        .map((a) => `<span class="cap">${escapeHtml(a.id)}${a.capabilities && a.capabilities.length ? ' · ' + escapeHtml(a.capabilities.join(',')) : ''}</span>`)
        .join('')
      const meta = app.meta || {}
      const metaBits = []
      if (meta.clientName) metaBits.push(`${escapeHtml(t.clientLabel)}: ${escapeHtml(meta.clientName)}${meta.clientVersion ? ' ' + escapeHtml(meta.clientVersion) : ''}`)
      if (meta.remoteAddress) metaBits.push(`${escapeHtml(t.remoteAddress)}: ${escapeHtml(meta.remoteAddress)}`)
      metaBits.push(`${escapeHtml(t.pendingSince)}: ${new Date(app.pendingSince).toLocaleString()}`)
      // v1.1: HELLO.services declarations. Surface them inline so admins
      // explicitly see the ACL the client requested before clicking Approve.
      // No services declared (or v1.0 client) → block stays absent.
      let servicesBlock = ''
      const services = Array.isArray(app.services) ? app.services : []
      if (services.length > 0) {
        const items = services.map((s) => {
          const owner = `${escapeHtml(s.owner.kind)}/${escapeHtml(s.owner.id)}`
          // v1.2: surface per-decl method ACL narrowing so admins know
          // BEFORE approving whether the client is asking for read-only
          // access (`methods: ['recall']`) vs full access (no narrowing).
          // No methods narrowing → "(any method)" placeholder.
          const methodsArr = Array.isArray(s.methods) ? s.methods : []
          const methodsLabel = (t.appServicesMethodsAny) || '(any method)'
          const methodsTxt = methodsArr.length > 0
            ? methodsArr.map((m) => `<code>${escapeHtml(String(m))}</code>`).join(', ')
            : `<span class="muted">${escapeHtml(methodsLabel)}</span>`
          return `<li><code>${escapeHtml(s.type)}:${escapeHtml(s.impl)}</code> <span class="muted">@</span> <code>${owner}</code> <span class="muted">·</span> ${methodsTxt}</li>`
        }).join('')
        const label = (t.appServicesRequested) || 'Services requested'
        servicesBlock = `<div class="pending-services"><div class="pending-services-label">${escapeHtml(label)}</div><ul class="pending-services-list">${items}</ul></div>`
      }
      card.innerHTML =
        `<div class="t-head"><span class="t-title">${agents}</span></div>` +
        `<div class="pending-meta">${metaBits.join(' · ')}</div>` +
        servicesBlock +
        `<div class="pending-actions">` +
          `<input class="reject-reason" placeholder="${escapeHtml(t.rejectReason)}" data-id="${escapeHtml(app.id)}" />` +
          `<button class="btn-approve" data-act="approve-app" data-id="${escapeHtml(app.id)}">${escapeHtml(t.approve)}</button>` +
          `<button class="btn-reject" data-act="reject-app" data-id="${escapeHtml(app.id)}">${escapeHtml(t.reject)}</button>` +
        `</div>`
      root.appendChild(card)
    }
  }

  function renderParticipants() {
    const root = dom.participantsList
    root.innerHTML = ''
    if (state.participants.length === 0) {
      root.innerHTML = `<p class="empty">${escapeHtml(t.noParticipants)}</p>`
      return
    }
    for (const p of state.participants) {
      const div = document.createElement('div')
      div.className = `participant participant-${p.kind}`
      const caps = (p.capabilities || [])
        .map((c) => `<span class="cap">${escapeHtml(c)}</span>`)
        .join('') || `<em class="empty">${escapeHtml(t.noCaps)}</em>`
      const kindLabel = t.pKind[p.kind] || p.kind
      div.innerHTML =
        `<div class="p-head">` +
          `<span class="p-kind">${escapeHtml(kindLabel)}</span>` +
          `<span class="p-id">${escapeHtml(p.id)}</span>` +
          `<span class="p-load">${escapeHtml(t.load)} ${p.load}</span>` +
        `</div>` +
        `<div class="p-caps">${caps}</div>`
      root.appendChild(div)
    }
  }

  function renderTranscript() {
    const root = dom.transcriptList
    dom.transcriptCount.textContent = String(state.transcript.length)
    root.innerHTML = ''
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      const e = state.transcript[i]
      const li = document.createElement('li')
      const taskIdAttr = e.kind === 'task_result'
        ? ` data-taskid="${escapeHtml(e.data.taskId)}"`
        : ''
      const clickableCls = e.kind === 'task_result' ? ' entry-clickable' : ''
      li.className = `entry entry-${e.kind}${clickableCls}` + (isBadResult(e) ? ' bad' : '')
      li.innerHTML =
        `<span class="seq">${e.seq}</span>` +
        `<span class="kind">${e.kind}</span>` +
        `<span class="body"${taskIdAttr}>${escapeHtml(summarize(e))}</span>`
      root.appendChild(li)
    }
  }

  function renderTasks() {
    const root = dom.tasksList
    if (!root) return
    // refresh filter UI active state
    if (dom.tasksFilters) {
      for (const btn of dom.tasksFilters.querySelectorAll('button[data-filter]')) {
        btn.classList.toggle('active', btn.dataset.filter === taskFilter)
      }
    }
    const filtered = state.tasks
      .filter((task) => taskFilter === 'all' ? true : task.status === taskFilter)
      .slice().reverse() // newest first
    root.innerHTML = ''
    if (filtered.length === 0) {
      root.innerHTML = `<p class="empty">${escapeHtml(t.noTasks)}</p>`
      return
    }
    for (const v of filtered) {
      const isOpen = state.expandedTasks.has(v.id)
      const div = document.createElement('div')
      div.className = `task-card task-${v.status}` + (isOpen ? ' expanded' : '')
      div.dataset.taskId = v.id
      const statusLabel =
        v.status === 'pending'   ? t.taskStatusPending
      : v.status === 'done'      ? t.taskStatusDone
      : v.status === 'failed'    ? t.taskStatusFailed
      :                            t.taskStatusCancelled
      const title = v.task.title || t.untitled
      const s = v.task.strategy
      const target =
        s.kind === 'explicit'   ? `to=${s.to}`
      : s.kind === 'capability' ? `caps=[${s.capabilities.join(',')}]`
      :                            'broadcast'
      const canRetry = v.status === 'failed' || v.status === 'cancelled'
      const caret = isOpen ? '▾' : '▸'
      const headHtml =
        `<div class="task-head" data-act="toggle-task" data-id="${escapeHtml(v.id)}" role="button" tabindex="0" aria-expanded="${isOpen ? 'true' : 'false'}">` +
          `<span class="task-caret">${caret}</span>` +
          `<span class="task-status task-status-${v.status}">${escapeHtml(statusLabel)}</span>` +
          `<span class="task-title">${escapeHtml(title)}</span>` +
          `<span class="task-strategy">${escapeHtml(s.kind)} · ${escapeHtml(target)}</span>` +
        `</div>`
      const metaHtml =
        `<div class="task-metrics">${taskMetricsHtml(v)}</div>` +
        `<div class="task-meta">` +
          `<code class="task-id" data-act="copy-task-id" data-id="${escapeHtml(v.id)}" title="${escapeHtml(t.taskIdHint)}">${escapeHtml(v.id.slice(0, 8))}…</code>` +
          (v.result ? ` · ${escapeHtml(resultSummary(v.result))}` : '') +
        `</div>`
      const retryHtml = canRetry
        ? `<div class="task-actions"><button data-act="retry" data-id="${escapeHtml(v.id)}">${escapeHtml(t.retry)}</button></div>`
        : ''
      const detailHtml = isOpen ? renderTaskDetail(v) : ''
      div.innerHTML = headHtml + metaHtml + retryHtml + detailHtml
      root.appendChild(div)
    }
  }

  function resultSummary(r) {
    if (r.kind === 'ok') return t.sumOk(r.by)
    if (r.kind === 'failed') return t.sumFailed(r.by, r.error)
    if (r.kind === 'cancelled') return t.sumCancelled(r.reason)
    return t.sumNoParticipant(r.reason)
  }

  // ── Task detail panel ─────────────────────────────────────────────────
  //
  // Rendered inline inside an expanded `.task-card`. Shows:
  //   • timing summary (created → completed, duration)
  //   • payload (JSON pretty-printed, collapsed-by-default <details>)
  //   • output (LLM-shape gets the prose unwrapped; everything else falls
  //     back to JSON. Token usage / stop reason show as a meta line.)
  //   • existing evaluations (rating + comment + timestamp)
  //   • inline evaluation form (re-uses POST /api/admin/evaluate)
  //
  // All data comes from the snapshot's `state.tasks` view — no extra HTTP
  // round-trip is needed to open a card.

  function renderTaskDetail(v) {
    const sections = []

    // timing
    const created = new Date(v.createdAt).toLocaleString()
    const completed = v.completedAt ? new Date(v.completedAt).toLocaleString() : '—'
    const dur = v.completedAt ? formatDuration(v.completedAt - v.createdAt) : '—'
    sections.push(
      `<div class="task-detail-section task-detail-timing">` +
        `<span><strong>${escapeHtml(t.detailCreated)}</strong> ${escapeHtml(created)}</span>` +
        `<span><strong>${escapeHtml(t.detailCompleted)}</strong> ${escapeHtml(completed)}</span>` +
        `<span><strong>${escapeHtml(t.detailDuration)}</strong> ${escapeHtml(dur)}</span>` +
      `</div>`
    )

    // payload
    sections.push(
      `<details class="task-detail-section" open>` +
        `<summary>${escapeHtml(t.detailPayload)}</summary>` +
        `<pre class="task-detail-pre">${escapeHtml(formatJsonPretty(v.task.payload))}</pre>` +
      `</details>`
    )

    // output (only when there's a result)
    if (v.result) {
      sections.push(renderResultBlock(v.result))
    }

    // existing evaluations
    if (Array.isArray(v.evaluations) && v.evaluations.length > 0) {
      const rows = v.evaluations.map((ev) => {
        const when = ev.ts ? new Date(ev.ts).toLocaleString() : ''
        const rating = typeof ev.rating === 'number' ? `★ ${formatScore(ev.rating)}/5` : t.detailCommentOnly
        const comment = ev.comment ? escapeHtml(ev.comment) : ''
        const author = ev.from ? `<code>${escapeHtml(ev.from)}</code>` : ''
        return `<li>` +
          `<span class="ev-rating">${escapeHtml(rating)}</span>` +
          (author ? ` <span class="ev-from">${author}</span>` : '') +
          (when ? ` <span class="ev-ts">${escapeHtml(when)}</span>` : '') +
          (comment ? `<div class="ev-comment">${comment}</div>` : '') +
          `</li>`
      }).join('')
      sections.push(
        `<details class="task-detail-section" open>` +
          `<summary>${escapeHtml(t.detailEvaluations)} (${v.evaluations.length})</summary>` +
          `<ul class="task-detail-evals">${rows}</ul>` +
        `</details>`
      )
    }

    // inline eval form (only meaningful once the task has a result)
    if (v.status === 'done' || v.status === 'failed') {
      sections.push(renderInlineEvalForm(v.id))
    }

    return `<div class="task-detail">${sections.join('')}</div>`
  }

  function renderResultBlock(r) {
    // LLM-shape: { text, stopReason, usage, by }. Unwrap the prose so it's
    // readable; show meta on a second line. Everything else falls back to
    // pretty-printed JSON.
    if (r.kind === 'ok') {
      const out = r.output
      if (out && typeof out === 'object' && typeof out.text === 'string') {
        const meta = []
        if (out.by) meta.push(`${escapeHtml(t.detailBy)} <code>${escapeHtml(out.by)}</code>`)
        if (out.stopReason) meta.push(`${escapeHtml(t.detailStopReason)} ${escapeHtml(out.stopReason)}`)
        if (out.usage) {
          const u = out.usage
          const tokens = []
          if (typeof u.inputTokens === 'number') tokens.push(`in ${u.inputTokens}`)
          if (typeof u.outputTokens === 'number') tokens.push(`out ${u.outputTokens}`)
          if (tokens.length) meta.push(`${escapeHtml(t.detailUsage)} ${escapeHtml(tokens.join(' / '))}`)
        }
        return (
          `<details class="task-detail-section" open>` +
            `<summary>${escapeHtml(t.detailOutput)}</summary>` +
            (meta.length ? `<div class="task-detail-meta">${meta.join(' · ')}</div>` : '') +
            `<pre class="task-detail-pre task-detail-text">${escapeHtml(out.text)}</pre>` +
          `</details>`
        )
      }
      return (
        `<details class="task-detail-section" open>` +
          `<summary>${escapeHtml(t.detailOutput)}</summary>` +
          `<div class="task-detail-meta">${escapeHtml(t.detailBy)} <code>${escapeHtml(r.by)}</code></div>` +
          `<pre class="task-detail-pre">${escapeHtml(formatJsonPretty(out))}</pre>` +
        `</details>`
      )
    }
    // failed / cancelled / no-participant → show the reason / error
    const summary = resultSummary(r)
    return (
      `<div class="task-detail-section task-detail-error">` +
        `<strong>${escapeHtml(t.detailOutput)}</strong> ${escapeHtml(summary)}` +
      `</div>`
    )
  }

  function renderInlineEvalForm(taskId) {
    // No <form> element — submit is a button click handler (data-act). Keeps
    // us out of nested-form trouble and lets the same global click delegator
    // pick it up.
    return (
      `<div class="task-detail-section task-detail-eval">` +
        `<strong>${escapeHtml(t.detailEvaluate)}</strong>` +
        `<div class="inline-eval-row">` +
          `<label>${escapeHtml(t.evaluateRating)}` +
            `<input type="number" min="0" max="5" step="0.1" data-inline-eval-rating="${escapeHtml(taskId)}" />` +
          `</label>` +
          `<label class="inline-eval-comment-label">${escapeHtml(t.evaluateComment)}` +
            `<textarea rows="2" data-inline-eval-comment="${escapeHtml(taskId)}"></textarea>` +
          `</label>` +
        `</div>` +
        `<div class="inline-eval-actions">` +
          `<button data-act="inline-eval-submit" data-id="${escapeHtml(taskId)}">${escapeHtml(t.evaluateButton)}</button>` +
          `<span class="inline-eval-msg" data-inline-eval-msg="${escapeHtml(taskId)}"></span>` +
        `</div>` +
      `</div>`
    )
  }

  function formatJsonPretty(value) {
    try {
      return JSON.stringify(value, null, 2)
    } catch (err) {
      return String(value)
    }
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${ms} ms`
    const s = Math.round(ms / 100) / 10
    if (s < 60) return `${s.toFixed(1)} s`
    const m = Math.floor(s / 60)
    const rem = Math.round(s - m * 60)
    return `${m}m ${rem}s`
  }

  async function submitInlineEval(taskId, btn) {
    const card = btn.closest('.task-card')
    if (!card) return
    const ratingEl = card.querySelector(`[data-inline-eval-rating="${CSS.escape(taskId)}"]`)
    const commentEl = card.querySelector(`[data-inline-eval-comment="${CSS.escape(taskId)}"]`)
    const msgEl = card.querySelector(`[data-inline-eval-msg="${CSS.escape(taskId)}"]`)
    if (msgEl) {
      msgEl.textContent = ''
      msgEl.classList.remove('ok', 'err')
    }
    const ratingStr = (ratingEl?.value ?? '').trim()
    const rating = ratingStr ? Number(ratingStr) : undefined
    const comment = (commentEl?.value ?? '').trim() || undefined
    if (rating == null && !comment) {
      if (msgEl) {
        msgEl.textContent = t.evaluateEmpty
        msgEl.classList.add('err')
      }
      return
    }
    btn.disabled = true
    try {
      await fetchJson('/api/admin/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, rating, comment }),
      })
      if (msgEl) {
        msgEl.textContent = t.evaluateSuccess
        msgEl.classList.add('ok')
      }
      if (commentEl) commentEl.value = ''
      // Re-render happens automatically when the `evaluation` SSE event
      // hits — the new row appears in the list above.
    } catch (err) {
      if (msgEl) {
        msgEl.textContent = t.failedAlert(err.message || String(err))
        msgEl.classList.add('err')
      }
    } finally {
      btn.disabled = false
    }
  }

  function expandTaskAndScroll(taskId) {
    state.expandedTasks.add(taskId)
    renderTasks()
    requestAnimationFrame(() => {
      const sel = `.task-card[data-task-id="${CSS.escape(taskId)}"]`
      const card = document.querySelector(sel)
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  // --- managed agents (v2.1) ---------------------------------------------

  async function refreshManagedAgents() {
    if (!dom?.maList) return
    try {
      const [agentsResp, provResp, secretsResp] = await Promise.all([
        fetchJson('/api/admin/agents'),
        fetchJson('/api/admin/agents/providers'),
        fetchJson('/api/admin/secrets'),
      ])
      ma.agents = agentsResp.agents || []
      ma.providers = provResp.providers || []
      ma.secrets = {
        providers: secretsResp.providers || {},
        agents: secretsResp.agents || {},
        env: secretsResp.env || {},
      }
      renderManagedAgents()
      syncProviderSelect()
    } catch (err) {
      console.warn('refreshManagedAgents:', err)
    }
  }

  function renderManagedAgents() {
    if (!dom?.maList) return
    const list = ma.agents
    const managedCount = list.filter((a) => !!a.managed).length
    const onlineManaged = list.filter((a) => !!a.managed && a.online).length
    dom.maSummary.textContent = list.length === 0
      ? t.maEmpty
      : t.maSummary(managedCount, onlineManaged, list.length - managedCount)
    if (list.length === 0) {
      dom.maList.innerHTML = `<p class="empty">${escapeHtml(t.maEmpty)}</p>`
      return
    }
    const html = list.map((a) => {
      const managed = a.managed
      const onlineCls = a.online ? 'agent-online' : 'agent-offline'
      const onlineLabel = a.online ? t.online : t.offline
      const caps = (a.allowedCapabilities || []).map((c) => `<span class="cap">${escapeHtml(c)}</span>`).join('')
      const kindBadge = managed
        ? `<span class="agent-kind-badge agent-kind-local">${escapeHtml(t.localAgentBadge)}</span>`
        : `<span class="agent-kind-badge agent-kind-cloud">${escapeHtml(t.cloudAgentBadge)}</span>`
      // For openai-compatible agents, show the friendly label (or
      // baseURL host) instead of the literal "openai-compatible" string
      // so the card communicates the actual vendor at a glance.
      let providerText = managed?.provider || ''
      if (managed?.provider === 'openai-compatible') {
        let host = managed.providerLabel
        if (!host && managed.baseURL) {
          try { host = new URL(managed.baseURL).host } catch { /* ignore */ }
        }
        providerText = host ? `openai-compat · ${host}` : 'openai-compat'
      }
      const meta = managed
        ? `${kindBadge}<span class="ma-provider">${escapeHtml(providerText)}${managed.model ? ' · ' + escapeHtml(managed.model) : ''}</span>`
        : `${kindBadge}<span class="ma-external">${escapeHtml(t.externalAgent)}</span>`
      const actions = managed ? `
        <button class="ma-action" data-act="edit-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.edit)}</button>
        <button class="ma-action" data-act="export-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.export_)}</button>
        <button class="ma-action ma-danger" data-act="remove-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.remove)}</button>
      ` : ''
      return `
        <div class="ma-row ${onlineCls}">
          <div class="ma-head">
            <strong class="ma-id">${escapeHtml(a.displayName || a.id)}</strong>
            ${a.displayName ? `<code class="ma-realid">${escapeHtml(a.id)}</code>` : ''}
            <span class="ma-status">${escapeHtml(onlineLabel)}</span>
          </div>
          <div class="ma-meta">${meta}</div>
          <div class="ma-caps">${caps}</div>
          <div class="ma-actions">${actions}</div>
        </div>
      `
    }).join('')
    dom.maList.innerHTML = html
  }

  function syncProviderSelect() {
    if (!dom?.maProvider) return
    // All four are valid in agents.json; greyed out if env doesn't supply a key.
    // openai-compatible is always available — its key MUST be per-agent.
    const all = ['mock', 'anthropic', 'openai', 'openai-compatible']
    const avail = new Set(ma.providers)
    dom.maProvider.innerHTML = all.map((p) => {
      const disabled = !avail.has(p)
      const suffix = disabled ? ` — ${t.providerDisabled}` : ''
      // Friendlier label for openai-compatible — the raw string would
      // be opaque to non-developers picking from the dropdown.
      const display = p === 'openai-compatible'
        ? `openai-compatible · ${t.openaiCompatHint}`
        : p
      return `<option value="${p}"${disabled ? ' disabled' : ''}>${display}${suffix}</option>`
    }).join('')
    // Default to the first available
    const first = all.find((p) => avail.has(p))
    if (first) dom.maProvider.value = first
    syncProviderDependentFields()
  }

  /**
   * Show / hide the `openai-compatible`-only fields (baseURL,
   * providerLabel) based on the current provider selection, and update
   * the API-key hint to flag that the key is REQUIRED for that path.
   */
  function syncProviderDependentFields() {
    if (!dom?.maProvider) return
    const isCompat = dom.maProvider.value === 'openai-compatible'
    document.querySelectorAll('.ma-compat-only').forEach((el) => {
      el.hidden = !isCompat
    })
    // Make baseURL native-required when shown so the browser blocks
    // an empty submit before our server-side check fires.
    if (dom.maBaseUrl) dom.maBaseUrl.required = isCompat
    // Hint copy + visual emphasis depending on provider.
    if (dom.maApiKeyHint && !ma._clearKeyOnSubmit) {
      // Only swap the hint when we're not mid-clear (which sets its own message).
      if (ma.formMode === 'edit') {
        // Edit mode is handled by openAgentForm; don't override it here.
      } else {
        dom.maApiKeyHint.textContent = isCompat
          ? t.agentApiKeyHintCompat
          : t.agentApiKeyHint
      }
    }
  }

  function openAgentForm(mode, agent) {
    ma.formMode = mode
    ma.editingId = mode === 'edit' ? agent?.id ?? null : null
    dom.maFormTitle.textContent = mode === 'edit' ? t.editAgent : t.newAgent
    dom.maFormEditWarning.hidden = mode !== 'edit'
    dom.maFormMsg.textContent = ''
    dom.maFormMsg.classList.remove('ok', 'err')

    if (mode === 'edit' && agent) {
      dom.maId.value = agent.id
      dom.maId.disabled = true
      dom.maDisplayName.value = agent.displayName || ''
      dom.maCaps.value = (agent.allowedCapabilities || []).join(', ')
      if (agent.managed) {
        dom.maProvider.value = agent.managed.provider
        dom.maModel.value = agent.managed.model || ''
        dom.maSystem.value = agent.managed.system || ''
        dom.maWeight.value = agent.managed.weightDefault != null ? String(agent.managed.weightDefault) : ''
        // openai-compatible-specific fields. Echo them back into the
        // form so the user can edit them without retyping.
        if (dom.maBaseUrl) dom.maBaseUrl.value = agent.managed.baseURL || ''
        if (dom.maProviderLabel) dom.maProviderLabel.value = agent.managed.providerLabel || ''
      }
      // Show "this agent has its own key" hint + a Clear button when applicable
      const hasOverride = !!ma.secrets.agents[agent.id]
      dom.maApiKey.value = ''
      dom.maApiKey.placeholder = hasOverride ? '••••••••' : ''
      dom.maApiKeyHint.textContent = hasOverride ? t.agentApiKeyHintEdit : t.agentApiKeyHint
      dom.maApiKeyClear.hidden = !hasOverride
      // Toggle baseURL row visibility based on the loaded provider.
      syncProviderDependentFields()
    } else {
      dom.maForm.reset()
      dom.maId.disabled = false
      dom.maApiKey.placeholder = ''
      dom.maApiKeyHint.textContent = t.agentApiKeyHint
      dom.maApiKeyClear.hidden = true
      syncProviderSelect()
    }
    dom.maFormModal.hidden = false
  }

  function closeAgentForm() {
    dom.maFormModal.hidden = true
  }

  async function submitAgentForm(e) {
    e.preventDefault()
    dom.maFormMsg.textContent = ''
    dom.maFormMsg.classList.remove('ok', 'err')
    const id = dom.maId.value.trim()
    const displayName = dom.maDisplayName.value.trim() || undefined
    const capabilities = dom.maCaps.value.split(',').map((s) => s.trim()).filter(Boolean)
    const provider = dom.maProvider.value
    const model = dom.maModel.value.trim() || undefined
    const system = dom.maSystem.value
    const weightStr = dom.maWeight.value.trim()
    const weightDefault = weightStr ? Number(weightStr) : undefined
    const apiKey = dom.maApiKey.value
    // openai-compatible-only payload pieces. Only attached when the
    // provider actually uses them so we don't pollute agents.json for
    // OpenAI / Anthropic agents that happen to have the inputs in the
    // DOM. Server-side validation rejects empty baseURL on this path.
    const baseURL = provider === 'openai-compatible'
      ? (dom.maBaseUrl?.value.trim() || undefined)
      : undefined
    const providerLabel = provider === 'openai-compatible'
      ? (dom.maProviderLabel?.value.trim() || undefined)
      : undefined
    // Carry apiKey only when the user typed something OR (in edit mode)
    // they used the Clear button — clearing is represented as an explicit
    // empty string; "no apiKey field at all" means "leave it alone".
    const body = { id, displayName, capabilities, provider, model, system, weightDefault, baseURL, providerLabel }
    if (apiKey.length > 0) body.apiKey = apiKey
    if (ma._clearKeyOnSubmit) { body.apiKey = ''; ma._clearKeyOnSubmit = false }
    try {
      const url = ma.formMode === 'edit'
        ? `/api/admin/agents/${encodeURIComponent(ma.editingId)}`
        : '/api/admin/agents'
      const method = ma.formMode === 'edit' ? 'PUT' : 'POST'
      const r = await fetchJson(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r?.warning) {
        dom.maFormMsg.textContent = t.savedWithWarning(r.error || r.warning)
        dom.maFormMsg.classList.add('err')
      } else {
        dom.maFormMsg.textContent = t.saveOk
        dom.maFormMsg.classList.add('ok')
        setTimeout(closeAgentForm, 400)
      }
      await refreshManagedAgents()
    } catch (err) {
      dom.maFormMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maFormMsg.classList.add('err')
    }
  }

  function openImportModal() {
    dom.maImportText.value = ''
    dom.maImportFile.value = ''
    dom.maImportMsg.textContent = ''
    dom.maImportMsg.classList.remove('ok', 'err')
    dom.maImportModal.hidden = false
  }

  // --- API key manager modal -------------------------------------------

  function openKeysModal() {
    renderKeysList()
    dom.maKeysMsg.textContent = ''
    dom.maKeysMsg.classList.remove('ok', 'err')
    dom.maKeysModal.hidden = false
  }

  function closeKeysModal() {
    dom.maKeysModal.hidden = true
  }

  function renderKeysList() {
    const providers = ['anthropic', 'openai']
    const html = providers.map((p) => {
      const wsConfigured = !!ma.secrets.providers[p]
      const envConfigured = !!ma.secrets.env[p]
      const ts = ma.secrets.providers[p]
      let statusHtml
      if (wsConfigured) {
        statusHtml = `<span class="key-status ok">${escapeHtml(t.apiKeySet)}</span><span class="key-ts">${escapeHtml(t.apiKeyUpdated(ts))}</span>`
      } else if (envConfigured) {
        statusHtml = `<span class="key-status env">${escapeHtml(t.apiKeyEnv)}</span>`
      } else {
        statusHtml = `<span class="key-status missing">${escapeHtml(t.apiKeyMissing)}</span>`
      }
      return `
        <div class="key-row" data-provider="${p}">
          <div class="key-head">
            <strong>${p}</strong>
            ${statusHtml}
          </div>
          <div class="key-controls">
            <input type="password" class="key-input" placeholder="${escapeHtml(t.keyEnterHere)}" autocomplete="off" />
            <button type="button" class="ma-btn" data-act="set-provider-key" data-provider="${p}">${escapeHtml(wsConfigured ? t.updateKey : t.setKey)}</button>
            ${wsConfigured ? `<button type="button" class="ma-btn ma-btn-secondary ma-danger" data-act="remove-provider-key" data-provider="${p}">${escapeHtml(t.clearKey)}</button>` : ''}
          </div>
        </div>
      `
    }).join('')
    dom.maKeysList.innerHTML = html
  }

  async function setProviderKey(provider, input) {
    const key = input.value.trim()
    if (!key) {
      dom.maKeysMsg.textContent = t.failedAlert(t.keyEnterHere)
      dom.maKeysMsg.classList.add('err')
      return
    }
    try {
      const r = await fetchJson(`/api/admin/secrets/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
      input.value = ''
      dom.maKeysMsg.textContent = r?.note ? t.keyWarnRestart : t.keySetOk
      dom.maKeysMsg.classList.remove('err')
      dom.maKeysMsg.classList.add('ok')
      await refreshManagedAgents()
      renderKeysList()
    } catch (err) {
      dom.maKeysMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maKeysMsg.classList.add('err')
    }
  }

  async function removeProviderKey(provider) {
    if (!confirm(t.failedAlert?.length ? `${provider}: ${t.clearKey}?` : `${provider}: remove?`)) return
    try {
      await fetchJson(`/api/admin/secrets/${encodeURIComponent(provider)}`, { method: 'DELETE' })
      dom.maKeysMsg.textContent = t.keyRemoved
      dom.maKeysMsg.classList.remove('err')
      dom.maKeysMsg.classList.add('ok')
      await refreshManagedAgents()
      renderKeysList()
    } catch (err) {
      dom.maKeysMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maKeysMsg.classList.add('err')
    }
  }

  function closeImportModal() {
    dom.maImportModal.hidden = true
  }

  async function submitImport() {
    dom.maImportMsg.textContent = ''
    dom.maImportMsg.classList.remove('ok', 'err')
    let text = dom.maImportText.value
    const file = dom.maImportFile.files?.[0]
    if (file && !text) {
      text = await file.text()
    }
    if (!text || !text.trim()) {
      dom.maImportMsg.textContent = t.importEmpty
      dom.maImportMsg.classList.add('err')
      return
    }
    try {
      const r = await fetch('/api/admin/agents/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: text,
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.maImportMsg.textContent = t.failedAlert(body.error || `${r.status}`)
        dom.maImportMsg.classList.add('err')
        return
      }
      const createdCount = (body.created || []).length
      const skippedCount = (body.skipped || []).length
      const spawnErrCount = (body.spawnErrors || []).length
      dom.maImportMsg.textContent = t.importDone(createdCount, skippedCount, spawnErrCount)
      dom.maImportMsg.classList.add(spawnErrCount > 0 ? 'err' : 'ok')
      await refreshManagedAgents()
      if (createdCount > 0 && spawnErrCount === 0) {
        setTimeout(closeImportModal, 700)
      }
    } catch (err) {
      dom.maImportMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maImportMsg.classList.add('err')
    }
  }

  // --- GitHub import (with optional China-friendly mirror) -------------
  //
  // Accept any of:
  //   https://github.com/<o>/<r>/blob/<ref>/<path...>
  //   https://github.com/<o>/<r>/raw/<ref>/<path...>
  //   https://raw.githubusercontent.com/<o>/<r>/<ref>/<path...>
  //
  // and rewrite to one of three download sources picked in the UI:
  //   - github   : raw.githubusercontent.com (default upstream)
  //   - jsdelivr : cdn.jsdelivr.net/gh/<o>/<r>@<ref>/<path>  (CDN, China-OK)
  //   - ghproxy  : mirror.ghproxy.com/<raw_url>             (transparent proxy)
  //
  // The actual download URL is shown live in the modal so users can sanity-
  // check before hitting "import". On submit we fetch the text client-side
  // and feed it to the existing POST /api/admin/agents/import — no new
  // server endpoint, no CORS dance for the host.

  function parseGithubUrl(rawInput) {
    const u = (rawInput || '').trim()
    if (!u) return null
    // raw.githubusercontent.com/<o>/<r>/<ref>/<path>
    let m = u.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i)
    if (m) return { owner: m[1], repo: m[2], ref: m[3], path: m[4] }
    // github.com/<o>/<r>/(blob|raw)/<ref>/<path>
    m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i)
    if (m) return { owner: m[1], repo: m[2], ref: m[3], path: m[4] }
    return null
  }

  function buildDownloadUrl(parts, source) {
    const { owner, repo, ref, path } = parts
    if (source === 'jsdelivr') {
      return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`
    }
    if (source === 'ghproxy') {
      return `https://mirror.ghproxy.com/https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
  }

  function updateGhResolved() {
    if (!dom.maGhResolved) return
    const parts = parseGithubUrl(dom.maGhUrl.value)
    if (!parts) {
      dom.maGhResolved.textContent = '—'
      return
    }
    dom.maGhResolved.textContent = buildDownloadUrl(parts, dom.maGhSource.value)
  }

  function openGithubImportModal() {
    dom.maGhUrl.value = ''
    dom.maGhResolved.textContent = '—'
    dom.maGhImportMsg.textContent = ''
    dom.maGhImportMsg.classList.remove('ok', 'err')
    dom.maGhImportModal.hidden = false
  }

  function closeGithubImportModal() {
    dom.maGhImportModal.hidden = true
  }

  async function submitGithubImport() {
    dom.maGhImportMsg.textContent = ''
    dom.maGhImportMsg.classList.remove('ok', 'err')
    const parts = parseGithubUrl(dom.maGhUrl.value)
    if (!parts) {
      dom.maGhImportMsg.textContent = t.ghImportBadUrl
      dom.maGhImportMsg.classList.add('err')
      return
    }
    const dlUrl = buildDownloadUrl(parts, dom.maGhSource.value)
    // Step 1 — fetch the YAML/JSON text from the chosen mirror.
    let text = ''
    try {
      const r = await fetch(dlUrl, { mode: 'cors' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      text = await r.text()
      if (!text.trim()) throw new Error('empty response')
    } catch (err) {
      dom.maGhImportMsg.textContent = t.ghFetchFailed(err.message || String(err))
      dom.maGhImportMsg.classList.add('err')
      return
    }
    // Step 2 — feed the text to the existing import endpoint. Same path
    // as the paste/upload flow, so the server treats it identically.
    try {
      const r = await fetch('/api/admin/agents/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: text,
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.maGhImportMsg.textContent = t.failedAlert(body.error || `${r.status}`)
        dom.maGhImportMsg.classList.add('err')
        return
      }
      const createdCount = (body.created || []).length
      const skippedCount = (body.skipped || []).length
      const spawnErrCount = (body.spawnErrors || []).length
      dom.maGhImportMsg.textContent = t.importDone(createdCount, skippedCount, spawnErrCount)
      dom.maGhImportMsg.classList.add(spawnErrCount > 0 ? 'err' : 'ok')
      await refreshManagedAgents()
      if (createdCount > 0 && spawnErrCount === 0) {
        setTimeout(closeGithubImportModal, 700)
      }
    } catch (err) {
      dom.maGhImportMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maGhImportMsg.classList.add('err')
    }
  }

  // --- workflows (v2.1) --------------------------------------------------

  async function refreshWorkflows() {
    if (!dom?.wfSection) return
    try {
      const r = await fetch('/api/admin/workflows')
      if (r.status === 404) {
        // Host has no workflow surface (embedded mode / older host).
        wf.available = false
        dom.wfSection.hidden = true
        return
      }
      if (!r.ok) {
        // Unexpected — log and leave the section as it was.
        console.warn('refreshWorkflows: HTTP', r.status)
        return
      }
      const body = await r.json()
      wf.available = true
      wf.workflows = body.workflows || []
      dom.wfSection.hidden = false
      renderWorkflows()
    } catch (err) {
      console.warn('refreshWorkflows:', err)
    }
  }

  function renderWorkflows() {
    if (!dom.wfList) return
    if (dom.wfSummary) {
      dom.wfSummary.textContent =
        wf.workflows.length === 0 ? '' : t.workflowsSummary(wf.workflows.length)
    }
    if (wf.workflows.length === 0) {
      dom.wfList.innerHTML = `<p class="empty">${escapeHtml(t.workflowsEmpty)}</p>`
      return
    }
    dom.wfList.innerHTML = wf.workflows.map((w) => {
      const name = w.name ? escapeHtml(w.name) : escapeHtml(w.id)
      const desc = w.description ? `<p class="hint">${escapeHtml(w.description)}</p>` : ''
      const file = w.file ? `<small class="hint">${escapeHtml(w.file)}</small>` : ''
      return `<article class="ma-card">
        <header>
          <strong>${name}</strong>
          <code>${escapeHtml(w.participantId)}</code>
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="open-workflow-runs"
                  data-id="${escapeHtml(w.id)}">${escapeHtml(t.workflowRunsBtn)}</button>
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="remove-workflow"
                  data-id="${escapeHtml(w.id)}">${escapeHtml(t.workflowRemoveBtn)}</button>
        </header>
        ${desc}
        <ul class="ma-meta">
          <li><span class="ma-label">${escapeHtml(t.workflowTriggerLabel)}:</span> <code>${escapeHtml(w.triggerCapability)}</code></li>
          <li>${escapeHtml(t.workflowStepsLabel(w.stepCount))}</li>
        </ul>
        ${file}
      </article>`
    }).join('')
  }

  async function removeWorkflow(id) {
    if (!confirm(t.confirmRemoveWorkflow(id))) return
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        alert(t.failedAlert(body.error || `${r.status}`))
        return
      }
      await refreshWorkflows()
    } catch (err) {
      alert(t.failedAlert(err.message || String(err)))
    }
  }

  function openWorkflowImportModal() {
    dom.wfImportText.value = ''
    dom.wfImportFile.value = ''
    dom.wfImportMsg.textContent = ''
    dom.wfImportMsg.classList.remove('ok', 'err')
    dom.wfImportModal.hidden = false
  }

  function closeWorkflowImportModal() {
    dom.wfImportModal.hidden = true
  }

  async function submitWorkflowImport() {
    dom.wfImportMsg.textContent = ''
    dom.wfImportMsg.classList.remove('ok', 'err')
    let text = dom.wfImportText.value
    const file = dom.wfImportFile.files?.[0]
    if (file && !text) {
      text = await file.text()
    }
    if (!text || !text.trim()) {
      dom.wfImportMsg.textContent = t.importEmpty
      dom.wfImportMsg.classList.add('err')
      return
    }
    try {
      const r = await fetch('/api/admin/workflows/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: text,
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.wfImportMsg.textContent = t.failedAlert(body.error || `${r.status}`)
        dom.wfImportMsg.classList.add('err')
        return
      }
      const id = body.workflow?.id || '?'
      dom.wfImportMsg.textContent = t.workflowImportDone(id)
      dom.wfImportMsg.classList.add('ok')
      await refreshWorkflows()
      setTimeout(closeWorkflowImportModal, 700)
    } catch (err) {
      dom.wfImportMsg.textContent = t.failedAlert(err.message || String(err))
      dom.wfImportMsg.classList.add('err')
    }
  }

  // --- workflow run history ---------------------------------------------
  //
  // The runs modal is two panes: a left-side list of recent runs (sorted
  // newest-first) and a right-side detail view. Clicking a row pulls the
  // full `RunState` from /api/admin/workflows/runs/:id; the detail
  // renders each step with its status + timing + sub-task ids.

  async function openWorkflowRunsModal(workflowId) {
    wf.runs.workflowId = workflowId
    wf.runs.selectedRunId = null
    wf.runs.rows = []
    if (dom.wfRunsTarget) dom.wfRunsTarget.textContent = workflowId
    if (dom.wfRunsMsg) dom.wfRunsMsg.textContent = ''
    if (dom.wfRunsList) dom.wfRunsList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    if (dom.wfRunsEmpty) dom.wfRunsEmpty.hidden = true
    if (dom.wfRunDetail) dom.wfRunDetail.innerHTML = `<p class="hint">${escapeHtml(t.workflowRunsPickHint)}</p>`
    if (dom.wfRunsModal) dom.wfRunsModal.hidden = false
    try {
      const url = `/api/admin/workflows/runs?workflowId=${encodeURIComponent(workflowId)}&limit=100`
      const r = await fetch(url)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        dom.wfRunsList.innerHTML = ''
        dom.wfRunsMsg.textContent = t.failedAlert(body.error || `${r.status}`)
        dom.wfRunsMsg.classList.add('err')
        return
      }
      const body = await r.json()
      wf.runs.rows = body.runs || []
      renderWorkflowRunsList()
    } catch (err) {
      dom.wfRunsList.innerHTML = ''
      dom.wfRunsMsg.textContent = t.failedAlert(err.message || String(err))
      dom.wfRunsMsg.classList.add('err')
    }
  }

  function closeWorkflowRunsModal() {
    if (dom.wfRunsModal) dom.wfRunsModal.hidden = true
  }

  function renderWorkflowRunsList() {
    if (!dom.wfRunsList) return
    if (wf.runs.rows.length === 0) {
      dom.wfRunsList.innerHTML = ''
      if (dom.wfRunsEmpty) dom.wfRunsEmpty.hidden = false
      return
    }
    if (dom.wfRunsEmpty) dom.wfRunsEmpty.hidden = true
    dom.wfRunsList.innerHTML = wf.runs.rows.map((row) => {
      const dur = row.endedAt ? `${row.endedAt - row.startedAt}ms` : '—'
      const selected = row.runId === wf.runs.selectedRunId ? ' wf-run-row-active' : ''
      return `<button type="button" class="wf-run-row${selected}"
                      data-act="open-workflow-run"
                      data-run-id="${escapeHtml(row.runId)}">
        <span class="wf-run-status wf-run-${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>
        <span class="wf-run-time">${escapeHtml(new Date(row.startedAt).toLocaleString())}</span>
        <span class="wf-run-meta">${escapeHtml(t.workflowRunStepCount(row.stepCount))} · ${escapeHtml(dur)}</span>
        <code class="wf-run-id">${escapeHtml(row.runId)}</code>
      </button>`
    }).join('')
  }

  async function openWorkflowRunDetail(runId) {
    wf.runs.selectedRunId = runId
    renderWorkflowRunsList()
    if (!dom.wfRunDetail) return
    dom.wfRunDetail.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    try {
      const r = await fetch(`/api/admin/workflows/runs/${encodeURIComponent(runId)}`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        dom.wfRunDetail.innerHTML = `<p class="form-msg err">${escapeHtml(body.error || `${r.status}`)}</p>`
        return
      }
      const body = await r.json()
      renderWorkflowRunDetail(body.run)
    } catch (err) {
      dom.wfRunDetail.innerHTML = `<p class="form-msg err">${escapeHtml(err.message || String(err))}</p>`
    }
  }

  function renderWorkflowRunDetail(run) {
    if (!dom.wfRunDetail) return
    const dur = run.endedAt ? `${run.endedAt - run.startedAt}ms` : t.workflowRunStillRunning
    const finalBlock =
      run.status === 'failed'
        ? `<p class="form-msg err">${escapeHtml(run.error || '')}</p>`
        : run.finalOutput !== undefined
          ? `<details open><summary>${escapeHtml(t.workflowRunFinal)}</summary><pre class="wf-pre">${escapeHtml(JSON.stringify(run.finalOutput, null, 2))}</pre></details>`
          : ''
    const steps = (run.steps || []).map((s) => {
      const sDur = s.endedAt ? `${s.endedAt - s.startedAt}ms` : '—'
      const subtasks = (s.subTaskIds || []).length
        ? `<small class="hint">${escapeHtml(t.workflowRunSubTasks)}: ${s.subTaskIds.map(escapeHtml).join(', ')}</small>`
        : ''
      const out = s.output !== undefined
        ? `<details><summary>${escapeHtml(t.workflowRunOutput)}</summary><pre class="wf-pre">${escapeHtml(JSON.stringify(s.output, null, 2))}</pre></details>`
        : ''
      const err = s.error
        ? `<p class="form-msg err">${escapeHtml(s.error)}</p>`
        : ''
      return `<article class="wf-step">
        <header>
          <span class="wf-run-status wf-run-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
          <strong>${escapeHtml(s.stepId)}</strong>
          <span class="wf-step-meta">${escapeHtml(sDur)} · ${escapeHtml(t.workflowRunAttempts(s.attempts || 1))}</span>
        </header>
        ${err}
        ${subtasks}
        ${out}
      </article>`
    }).join('')
    const payloadBlock = run.triggerPayload !== undefined
      ? `<details><summary>${escapeHtml(t.workflowRunTriggerPayload)}</summary><pre class="wf-pre">${escapeHtml(JSON.stringify(run.triggerPayload, null, 2))}</pre></details>`
      : ''
    dom.wfRunDetail.innerHTML = `
      <h4>
        <span class="wf-run-status wf-run-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <code>${escapeHtml(run.runId)}</code>
      </h4>
      <p class="hint">${escapeHtml(t.workflowRunDuration)}: ${escapeHtml(dur)} · ${escapeHtml(t.workflowRunTriggeredBy)}: <code>${escapeHtml(run.triggeredByTaskId)}</code></p>
      ${payloadBlock}
      ${steps || `<p class="empty">${escapeHtml(t.workflowRunNoSteps)}</p>`}
      ${finalBlock}
    `
  }

  async function exportAgent(id) {
    // GET with browser-driven download (content-disposition on server side)
    window.location.href = `/api/admin/agents/${encodeURIComponent(id)}/export`
  }

  async function removeAgent(id) {
    if (!confirm(t.confirmRemoveAgent(id))) return
    try {
      await fetchJson(`/api/admin/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await refreshManagedAgents()
    } catch (err) {
      alert(t.failedAlert(err.message || String(err)))
    }
  }

  function renderKnownRoster() {
    if (!dom.knownAdminsList || !dom.knownWorkersList) return
    dom.knownAdminsList.innerHTML = state.known.admins.map((a) =>
      `<li><strong>${escapeHtml(a.id)}</strong> · ${escapeHtml(a.displayName)}</li>`,
    ).join('') || `<li class="empty">${escapeHtml(t.noParticipants)}</li>`
    dom.knownWorkersList.innerHTML = state.known.workers.map((w) =>
      `<li><strong>${escapeHtml(w.id)}</strong>${w.capabilities.length ? ' · ' + w.capabilities.map(escapeHtml).join(', ') : ''}${w.lastSeen ? ` · ${new Date(w.lastSeen).toLocaleString()}` : ''}</li>`,
    ).join('') || `<li class="empty">${escapeHtml(t.noParticipants)}</li>`
  }

  // --- dispatch form -----------------------------------------------------

  function updateDispatchVisibility() {
    const v = dom.dStrategy.value
    dom.dToLabel.style.display = v === 'explicit' ? '' : 'none'
    dom.dCapsLabel.style.display = (v === 'capability' || v === 'broadcast') ? '' : 'none'
  }

  async function submitDispatch(e) {
    e.preventDefault()
    dom.dispatchMsg.textContent = ''
    dom.dispatchMsg.classList.remove('ok', 'err')
    const kind = dom.dStrategy.value
    let strategy = null
    if (kind === 'explicit') {
      strategy = { kind, to: dom.dTo.value.trim() }
      if (!strategy.to) { dom.dispatchMsg.textContent = t.failedAlert('id required'); dom.dispatchMsg.classList.add('err'); return }
    } else if (kind === 'capability') {
      const caps = dom.dCaps.value.split(',').map((s) => s.trim()).filter(Boolean)
      if (caps.length === 0) { dom.dispatchMsg.textContent = t.failedAlert('capabilities required'); dom.dispatchMsg.classList.add('err'); return }
      strategy = { kind, capabilities: caps }
    } else if (kind === 'broadcast') {
      const caps = dom.dCaps.value.split(',').map((s) => s.trim()).filter(Boolean)
      strategy = caps.length ? { kind, capabilities: caps } : { kind }
    }
    let payload = {}
    try { payload = dom.dPayload.value.trim() ? JSON.parse(dom.dPayload.value) : {} }
    catch (err) {
      dom.dispatchMsg.textContent = t.failedAlert('payload is not valid JSON')
      dom.dispatchMsg.classList.add('err')
      return
    }
    const title = dom.dTitle.value.trim() || undefined
    const priorityStr = dom.dPriority.value.trim()
    const priority = priorityStr ? Number(priorityStr) : undefined
    const weightStr = dom.dWeight?.value?.trim?.() ?? ''
    // Empty input → omit weight; the Hub will default it to 1.0. Sending
    // an out-of-range number is fine — the Hub clamps + rounds.
    const weight = weightStr ? Number(weightStr) : undefined
    try {
      await fetchJson('/api/admin/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy, payload, title, priority, weight }),
      })
      dom.dispatchMsg.textContent = t.dispatchSuccess
      dom.dispatchMsg.classList.add('ok')
    } catch (err) {
      dom.dispatchMsg.textContent = t.failedAlert(err.message || String(err))
      dom.dispatchMsg.classList.add('err')
    }
  }

  async function submitEvaluate(e) {
    e.preventDefault()
    dom.evaluateMsg.textContent = ''
    dom.evaluateMsg.classList.remove('ok', 'err')
    const taskId = dom.eTask.value.trim()
    if (!taskId) return
    const ratingStr = dom.eRating.value.trim()
    const rating = ratingStr ? Number(ratingStr) : undefined
    const comment = dom.eComment.value.trim() || undefined
    try {
      await fetchJson('/api/admin/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, rating, comment }),
      })
      dom.evaluateMsg.textContent = t.evaluateSuccess
      dom.evaluateMsg.classList.add('ok')
      dom.eComment.value = ''
    } catch (err) {
      dom.evaluateMsg.textContent = t.failedAlert(err.message || String(err))
      dom.evaluateMsg.classList.add('err')
    }
  }

  async function approveApp(appId) {
    await fetchJson(`/api/admin/applications/${encodeURIComponent(appId)}/approve`, { method: 'POST' })
  }
  async function rejectApp(appId, reason) {
    await fetchJson(`/api/admin/applications/${encodeURIComponent(appId)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'rejected by admin' }),
    })
  }
  async function retryTask(taskId) {
    await fetchJson(`/api/admin/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' })
  }
  async function logout() {
    try { await fetchJson('/api/admin/logout', { method: 'POST' }) } catch { /* ignore */ }
    window.location.href = '/admin'
  }

  // ── Tab navigation ───────────────────────────────────────────────────
  //
  // The admin console used to be a tall single-page scroll of every
  // section. With managed agents + workflows + tasks + transcript +
  // leaderboard + pending applications all on one page, finding the
  // thing you wanted got expensive. We split sections into 5 tabs:
  // overview / agents / workflows / tasks / activity.
  //
  // Active tab lives in the URL hash (`/admin#agents`) so refreshes
  // remember the user's position without touching localStorage — same
  // "browser stays state-less except for the HttpOnly cookie" rule the
  // rest of the app follows.
  //
  // All sections stay in the DOM at all times; tab switches just flip
  // a `tab-hidden` class. Keeping them in the DOM means cross-tab
  // interactions (e.g. clicking a task_result row in Activity auto-
  // fills the eval form in Tasks) keep working without rewiring.
  const TABS = ['overview', 'agents', 'workflows', 'tasks', 'activity', 'services']

  function activeTabFromHash() {
    const h = (location.hash || '').replace(/^#/, '')
    return TABS.includes(h) ? h : 'overview'
  }

  function setActiveTab(name) {
    if (!TABS.includes(name)) name = 'overview'
    document.querySelectorAll('.tabbar-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === name)
    })
    document.querySelectorAll('section[data-tab]').forEach((sec) => {
      sec.classList.toggle('tab-hidden', sec.dataset.tab !== name)
    })
    // Mirror the active tab onto `<body>` so CSS can flatten the
    // 3-col admin grid for tabs that don't fill all three columns
    // (Tasks would otherwise hug the right edge; Activity would
    // leave an empty third column). Overview keeps the original
    // 3-col layout.
    document.body.dataset.activeTab = name
  }

  function gotoTab(name) {
    if (!TABS.includes(name)) name = 'overview'
    // Use replace so the back button doesn't pile up tab clicks; users
    // who land here from a deep link still get URL-based persistence.
    if (location.hash.replace(/^#/, '') !== name) {
      // setting hash fires hashchange → setActiveTab via the listener
      location.hash = name
    } else {
      setActiveTab(name)
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    resolveDom()
    updateDispatchVisibility()

    // Tabbar wiring. Initial tab comes from URL hash; clicks update
    // both the DOM and the hash so deep-linking just works.
    setActiveTab(activeTabFromHash())
    document.querySelectorAll('.tabbar-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab
        if (tab) gotoTab(tab)
      })
    })
    window.addEventListener('hashchange', () => {
      setActiveTab(activeTabFromHash())
    })

    dom.dStrategy.addEventListener('change', updateDispatchVisibility)
    dom.dispatchForm.addEventListener('submit', submitDispatch)
    dom.evaluateForm.addEventListener('submit', submitEvaluate)
    dom.logoutBtn.addEventListener('click', logout)

    if (dom.tasksFilters) {
      dom.tasksFilters.addEventListener('click', (e) => {
        const btn = e.target
        if (!(btn instanceof HTMLButtonElement)) return
        const f = btn.dataset.filter
        if (!f) return
        taskFilter = f
        renderTasks()
      })
    }

    if (dom.lbWindow) {
      dom.lbWindow.addEventListener('change', () => {
        lbWindow = dom.lbWindow.value
        refreshLeaderboard().catch((err) => console.warn('leaderboard switch failed:', err))
      })
    }

    attachContribToggle(dom.contribToggle, dom.contribToggleInput)
    // Initial state: ask the server what my opt-out is.
    try {
      const me = await fetchJson('/api/whoami')
      applyContribToggleState(dom.contribToggle, dom.contribToggleInput, me?.contributionOptOut === true)
    } catch (err) {
      console.warn('whoami failed:', err)
    }

    // Capability suggestion chips — dispatch form's caps field + the
    // create/edit managed-agent form. Each call also wires this input
    // to the shared `cap-datalist` for native autocomplete.
    attachCapChips(dom.dCaps)
    attachCapChips(dom.maCaps)

    // Managed-agent panel events
    dom.maNewBtn?.addEventListener('click', () => openAgentForm('create'))
    // Provider switch — show/hide the openai-compatible-only fields live.
    dom.maProvider?.addEventListener('change', syncProviderDependentFields)
    dom.maImportBtn?.addEventListener('click', () => {
      // Close the dropdown after the user picks an import method.
      if (dom.maImportDropdown) dom.maImportDropdown.open = false
      openImportModal()
    })
    dom.maGhImportBtn?.addEventListener('click', () => {
      if (dom.maImportDropdown) dom.maImportDropdown.open = false
      openGithubImportModal()
    })
    dom.maKeysBtn?.addEventListener('click', openKeysModal)
    dom.maForm?.addEventListener('submit', submitAgentForm)
    dom.maImportSubmit?.addEventListener('click', submitImport)
    dom.maGhImportSubmit?.addEventListener('click', submitGithubImport)
    // Live-preview the resolved download URL as the user types or
    // flips the mirror source — so they can see whether the parser
    // recognized their URL before clicking "import".
    dom.maGhUrl?.addEventListener('input', updateGhResolved)
    dom.maGhSource?.addEventListener('change', updateGhResolved)
    // Click outside the dropdown closes it (click on the summary
    // toggles it natively, so we only handle the "click elsewhere" path).
    document.addEventListener('click', (e) => {
      if (!dom.maImportDropdown || !dom.maImportDropdown.open) return
      if (!(e.target instanceof Node)) return
      if (!dom.maImportDropdown.contains(e.target)) {
        dom.maImportDropdown.open = false
      }
    })

    // Workflow panel events
    dom.wfImportBtn?.addEventListener('click', openWorkflowImportModal)
    dom.wfImportSubmit?.addEventListener('click', submitWorkflowImport)
    dom.maApiKeyClear?.addEventListener('click', () => {
      // Trigger an explicit-empty apiKey on the next submit. We don't
      // wipe the persisted key here — that happens on Save so the user
      // can still back out by cancelling.
      ma._clearKeyOnSubmit = true
      dom.maApiKey.value = ''
      dom.maApiKey.placeholder = '(将清空)'
      dom.maApiKeyHint.textContent = `${t.clearKey}: 保存后该 agent 的私有 key 会被移除`
    })
    document.addEventListener('click', (e) => {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      if (target.dataset.act === 'close-modal') {
        if (!dom.maFormModal.hidden) closeAgentForm()
        if (!dom.maImportModal.hidden) closeImportModal()
        if (dom.maGhImportModal && !dom.maGhImportModal.hidden) closeGithubImportModal()
        if (!dom.maKeysModal.hidden) closeKeysModal()
        if (dom.wfImportModal && !dom.wfImportModal.hidden) closeWorkflowImportModal()
        if (dom.wfRunsModal && !dom.wfRunsModal.hidden) closeWorkflowRunsModal()
      }
      const act = target.dataset.act
      // Provider key actions live in the keys modal — they take a
      // `data-provider` attr instead of `data-id`.
      if (act === 'set-provider-key' || act === 'remove-provider-key') {
        const provider = target.dataset.provider
        if (!provider) return
        if (act === 'set-provider-key') {
          const row = target.closest('.key-row')
          const input = row?.querySelector('.key-input')
          if (input instanceof HTMLInputElement) setProviderKey(provider, input)
        } else {
          removeProviderKey(provider)
        }
        return
      }
      const id = target.dataset.id
      if (!act || !id) return
      if (act === 'edit-agent') {
        const a = ma.agents.find((x) => x.id === id)
        if (a) openAgentForm('edit', a)
      } else if (act === 'export-agent') {
        exportAgent(id)
      } else if (act === 'remove-agent') {
        removeAgent(id)
      } else if (act === 'remove-workflow') {
        removeWorkflow(id)
      } else if (act === 'open-workflow-runs') {
        openWorkflowRunsModal(id)
      } else if (act === 'open-workflow-run') {
        const runId = target.dataset.runId
        if (runId) openWorkflowRunDetail(runId)
      }
    })
    // ESC closes any open modal
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!dom.maFormModal.hidden) closeAgentForm()
      if (!dom.maImportModal.hidden) closeImportModal()
      if (dom.maGhImportModal && !dom.maGhImportModal.hidden) closeGithubImportModal()
      if (!dom.maKeysModal.hidden) closeKeysModal()
      if (dom.wfImportModal && !dom.wfImportModal.hidden) closeWorkflowImportModal()
      if (dom.wfRunsModal && !dom.wfRunsModal.hidden) closeWorkflowRunsModal()
    })
    refreshManagedAgents().catch((err) => console.warn('initial agents refresh:', err))
    refreshWorkflows().catch((err) => console.warn('initial workflows refresh:', err))

    document.addEventListener('click', async (e) => {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      // Walk up from the click target to find an actionable ancestor —
      // lets clicks on inner spans (e.g. .task-caret, .task-title) hit
      // the .task-head handler instead of falling through.
      const actEl = target.closest('[data-act]')
      const act = actEl instanceof HTMLElement ? actEl.dataset.act : undefined
      const id = actEl instanceof HTMLElement ? actEl.dataset.id : undefined
      // Click a task_result row in the transcript → jump to the Tasks
      // tab, expand that task's card, and scroll it into view. Also
      // autofill the global eval form (kept as a fallback for power
      // users who prefer typing IDs).
      const taskRowEl = target.closest('[data-taskid]')
      if (taskRowEl instanceof HTMLElement && taskRowEl.dataset.taskid) {
        const tid = taskRowEl.dataset.taskid
        if (dom.eTask) dom.eTask.value = tid
        gotoTab('tasks')
        expandTaskAndScroll(tid)
        return
      }
      if (!act) return
      // Toggle a task card's expanded state. Targets a row with
      // data-act="toggle-task" data-id="<taskId>".
      if (act === 'toggle-task' && id) {
        if (state.expandedTasks.has(id)) state.expandedTasks.delete(id)
        else state.expandedTasks.add(id)
        renderTasks()
        return
      }
      if (act === 'inline-eval-submit' && id && actEl instanceof HTMLButtonElement) {
        await submitInlineEval(id, actEl)
        return
      }
      if (!id) return
      // copy task id to the (global) evaluation form on click — same
      // cross-tab jump as the transcript-row case above.
      if (act === 'copy-task-id') {
        if (dom.eTask) dom.eTask.value = id
        gotoTab('tasks')
        return
      }
      if (actEl instanceof HTMLButtonElement) actEl.disabled = true
      try {
        if (act === 'approve-app') {
          await approveApp(id)
        } else if (act === 'reject-app') {
          const card = actEl.closest('.pending-app-card')
          const reasonInput = card?.querySelector('.reject-reason')
          const reason = reasonInput?.value?.trim() || ''
          await rejectApp(id, reason)
        } else if (act === 'retry') {
          await retryTask(id)
        }
      } catch (err) {
        alert(t.failedAlert(err.message || String(err)))
        if (actEl instanceof HTMLButtonElement) actEl.disabled = false
      }
    })

    onLangChange(() => {
      applyStaticI18n()
      renderAll()
    })

    // View switcher — jump to the worker (`/`) view. Both views share
    // identity through HttpOnly cookies (`aipehub_admin` + `aipehub_worker`),
    // so a person who is both admin and worker keeps both sessions across
    // the switch. No client-side state is saved here — server is the
    // source of truth and the new page re-fetches everything.
    const switchToWorkerBtn = document.getElementById('switch-to-worker-btn')
    if (switchToWorkerBtn) {
      switchToWorkerBtn.addEventListener('click', () => {
        window.location.href = '/'
      })
    }

    try {
      await refresh()
    } catch (err) {
      console.error('initial refresh failed:', err)
    }

    // Services tab: lazy-load on first activation; refresh on every
    // tab focus thereafter so trash/sweep operations from another
    // window get picked up. We deliberately don't poll — the SSE
    // stream pushes `service_trashed` / `service_purged`.
    document.querySelectorAll('.tabbar-btn[data-tab="services"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        refreshServices().catch((err) => console.warn('services tab load failed:', err))
      })
    })
    if (document.body.dataset.activeTab === 'services') {
      refreshServices().catch((err) => console.warn('services initial load failed:', err))
    }

    const sweepBtn = document.getElementById('services-sweep-btn')
    if (sweepBtn) {
      sweepBtn.addEventListener('click', async () => {
        sweepBtn.disabled = true
        try {
          const r = await fetchJson('/api/admin/services/sweep', { method: 'POST' })
          showServicesToast(t.servicesSweepResult(r.scanned, r.purged))
          await refreshServices()
        } catch (err) {
          alert(t.failedAlert(err?.message || String(err)))
        } finally {
          sweepBtn.disabled = false
        }
      })
    }

    // SERVICE_CALL audit refresh — just re-pulls /api/admin/transcript/service-calls.
    const auditRefreshBtn = document.getElementById('services-audit-refresh')
    if (auditRefreshBtn) {
      auditRefreshBtn.addEventListener('click', async () => {
        auditRefreshBtn.disabled = true
        try {
          const r = await fetchJson('/api/admin/transcript/service-calls?limit=200')
          svc.audit = r.calls || []
          renderServicesAudit()
        } catch (err) {
          console.warn('services audit refresh failed:', err)
        } finally {
          auditRefreshBtn.disabled = false
        }
      })
    }

    const detailClose = document.getElementById('services-detail-close')
    const detailBackdrop = document.getElementById('services-detail-modal')
    if (detailClose) detailClose.addEventListener('click', () => closeServicesDetail())
    if (detailBackdrop) {
      detailBackdrop.addEventListener('click', (e) => {
        if (e.target === detailBackdrop) closeServicesDetail()
      })
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && detailBackdrop && !detailBackdrop.hidden) closeServicesDetail()
    })

    connectStream(applyEvent)
  })

  // ─── Services tab (v2.2) ──────────────────────────────────────────────
  //
  // The tab walks every registered plugin and, for every managed
  // agent, asks for a per-(plugin, owner) snapshot. Agents that don't
  // use a given service contribute null snapshots and are filtered
  // out. The trash sub-view is a flat list across plugins so admins
  // can see "what's recently been deleted" in one place.

  const svc = {
    plugins: [],     // [{type, impl, version, description?}]
    rows: [],        // [{type, impl, owner: {kind,id}, snapshot}]
    trash: [],       // ServiceTrashRef[]
    audit: [],       // [{ts, from, type, impl, ownerKind, ownerId, method, outcome, durationMs}]
    disabled: false, // host didn't supply services
  }

  async function refreshServices() {
    const tableEl = document.getElementById('services-table')
    const tbodyEl = document.getElementById('services-tbody')
    const emptyEl = document.getElementById('services-plugins-empty')
    const disabledEl = document.getElementById('services-disabled')
    const trashTableEl = document.getElementById('services-trash-table')
    const trashTbodyEl = document.getElementById('services-trash-tbody')
    const trashEmptyEl = document.getElementById('services-trash-empty')
    if (!tableEl || !tbodyEl) return

    // Plugin list (or 503 → disabled).
    let plugins
    try {
      const r = await fetch('/api/admin/services/plugins')
      if (r.status === 503) {
        svc.disabled = true
        disabledEl.hidden = false
        tableEl.hidden = true
        emptyEl.hidden = true
        trashTableEl.hidden = true
        trashEmptyEl.hidden = true
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      plugins = j.plugins || []
    } catch (err) {
      console.warn('services: plugins fetch failed', err)
      return
    }
    svc.disabled = false
    disabledEl.hidden = true
    svc.plugins = plugins
    if (plugins.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
    } else {
      emptyEl.hidden = true
      tableEl.hidden = false
    }

    // Per-agent snapshots. We use the cached `ma.agents` list to know
    // which owners to ask about — same agents the "Agents" tab uses.
    const rows = []
    for (const plugin of plugins) {
      for (const agent of ma.agents || []) {
        try {
          const url = `/api/admin/services/owners/${encodeURIComponent(plugin.type)}/${encodeURIComponent(plugin.impl)}/agent/${encodeURIComponent(agent.id)}`
          const r = await fetchJson(url)
          if (r.snapshot) {
            rows.push({
              type: plugin.type, impl: plugin.impl,
              owner: { kind: 'agent', id: agent.id },
              snapshot: r.snapshot,
            })
          }
        } catch (err) {
          // 404 / 500 — skip and keep going. The user sees the
          // rows that DID resolve; partial-success beats nothing.
        }
      }
    }
    svc.rows = rows
    renderServicesTable()

    // Trash list.
    try {
      const r = await fetchJson('/api/admin/services/trash')
      svc.trash = r.trash || []
      renderServicesTrash()
    } catch (err) {
      console.warn('services: trash fetch failed', err)
    }

    // SERVICE_CALL audit (v1.1 services-over-ws). Best-effort; if the
    // endpoint 503s on a v1.0-only host the table just stays hidden.
    try {
      const r = await fetchJson('/api/admin/transcript/service-calls?limit=200')
      svc.audit = r.calls || []
      renderServicesAudit()
    } catch (err) {
      console.warn('services: audit fetch failed', err)
    }
  }

  function renderServicesAudit() {
    const tableEl = document.getElementById('services-audit-table')
    const tbodyEl = document.getElementById('services-audit-tbody')
    const emptyEl = document.getElementById('services-audit-empty')
    if (!tableEl || !tbodyEl) return
    tbodyEl.innerHTML = ''
    const calls = svc.audit || []
    if (calls.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
      return
    }
    emptyEl.hidden = true
    tableEl.hidden = false
    // calls already arrive newest-first from the API.
    for (const c of calls) {
      const tr = document.createElement('tr')
      const okClass = c.outcome === 'ok' ? '' : ' bad'
      tr.className = `audit-row${okClass}`
      tr.innerHTML = `
        <td>${new Date(c.ts).toLocaleString()}</td>
        <td><code>${escapeHtml(c.from)}</code></td>
        <td><code>${escapeHtml(c.type)}:${escapeHtml(c.impl)}</code></td>
        <td>${escapeHtml(c.ownerKind)}/${escapeHtml(c.ownerId)}</td>
        <td><code>${escapeHtml(c.method)}</code></td>
        <td>${escapeHtml(c.outcome)}</td>
        <td>${c.durationMs}ms</td>
      `
      tbodyEl.appendChild(tr)
    }
  }

  function renderServicesTable() {
    const tbodyEl = document.getElementById('services-tbody')
    if (!tbodyEl) return
    tbodyEl.innerHTML = ''
    for (const row of svc.rows) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><code>${escapeHtml(row.type)}:${escapeHtml(row.impl)}</code></td>
        <td>${escapeHtml(row.owner.kind)}/${escapeHtml(row.owner.id)}</td>
        <td>${formatBytes(row.snapshot.sizeBytes)}</td>
        <td>${row.snapshot.itemCount ?? ''}</td>
        <td>${row.snapshot.lastAccess ? new Date(row.snapshot.lastAccess).toLocaleString() : ''}</td>
        <td>
          <button type="button" class="secondary-btn" data-action="detail">${escapeHtml(t.servicesDetail)}</button>
          <button type="button" class="danger-btn" data-action="delete">${escapeHtml(t.servicesDelete)}</button>
        </td>
      `
      tr.querySelector('[data-action="detail"]').addEventListener('click', () => openServicesDetail(row))
      tr.querySelector('[data-action="delete"]').addEventListener('click', () => softDeleteRow(row))
      tbodyEl.appendChild(tr)
    }
  }

  function renderServicesTrash() {
    const tableEl = document.getElementById('services-trash-table')
    const tbodyEl = document.getElementById('services-trash-tbody')
    const emptyEl = document.getElementById('services-trash-empty')
    if (!tableEl || !tbodyEl) return
    tbodyEl.innerHTML = ''
    if (svc.trash.length === 0) {
      tableEl.hidden = true
      emptyEl.hidden = false
      return
    }
    emptyEl.hidden = true
    tableEl.hidden = false
    for (const ref of svc.trash) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><code>${escapeHtml(ref.type)}:${escapeHtml(ref.impl)}</code></td>
        <td>${escapeHtml(ref.ownerKind)}/${escapeHtml(ref.ownerId)}</td>
        <td>${new Date(ref.deletedAt).toLocaleString()}</td>
        <td>${new Date(ref.expiresAt).toLocaleString()}</td>
        <td>${escapeHtml(ref.reason || '')}</td>
        <td>
          <button type="button" class="secondary-btn" data-action="restore">${escapeHtml(t.servicesTrashRestore)}</button>
          <button type="button" class="danger-btn" data-action="hard">${escapeHtml(t.servicesTrashHardDelete)}</button>
        </td>
      `
      tr.querySelector('[data-action="restore"]').addEventListener('click', () => restoreTrash(ref))
      tr.querySelector('[data-action="hard"]').addEventListener('click', () => hardDeleteTrash(ref))
      tbodyEl.appendChild(tr)
    }
  }

  async function softDeleteRow(row) {
    try {
      await fetchJson(`/api/admin/services/owners/${encodeURIComponent(row.type)}/${encodeURIComponent(row.impl)}/agent/${encodeURIComponent(row.owner.id)}`, {
        method: 'DELETE',
      })
      // Toast comes from the SSE event handler so we don't double-fire.
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  async function restoreTrash(ref) {
    try {
      await fetchJson(`/api/admin/services/trash/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.impl)}/${encodeURIComponent(ref.id)}/restore`, {
        method: 'POST',
      })
      showServicesToast(t.servicesToastRestored)
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  async function hardDeleteTrash(ref) {
    if (!confirm(t.servicesConfirmHardDelete)) return
    try {
      await fetchJson(`/api/admin/services/trash/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.impl)}/${encodeURIComponent(ref.id)}`, {
        method: 'DELETE',
      })
      showServicesToast(t.servicesToastHardDeleted)
      await refreshServices()
    } catch (err) {
      alert(t.failedAlert(err?.message || String(err)))
    }
  }

  function openServicesDetail(row) {
    const modal = document.getElementById('services-detail-modal')
    const title = document.getElementById('services-detail-title')
    const body = document.getElementById('services-detail-body')
    const img = document.getElementById('services-detail-image')
    if (!modal || !title || !body) return
    title.textContent = `${row.type}:${row.impl} — ${row.owner.kind}/${row.owner.id}`
    const p = row.snapshot.preview
    if (p && p.base64) {
      img.src = `data:${p.mime};base64,${p.base64}`
      img.alt = title.textContent
      img.hidden = false
      body.textContent = ''
    } else if (p && p.text) {
      img.hidden = true
      body.textContent = p.text + (p.truncated ? '\n… (truncated)' : '')
    } else {
      img.hidden = true
      body.textContent = `${formatBytes(row.snapshot.sizeBytes)} • ${row.snapshot.itemCount ?? 0} items`
    }
    modal.hidden = false
  }

  function closeServicesDetail() {
    const modal = document.getElementById('services-detail-modal')
    if (modal) modal.hidden = true
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  /**
   * Tiny ephemeral toast. Lives 4 seconds, then fades. The container
   * is lazy-created on first use so a page that never touches the
   * Services tab pays no DOM cost.
   */
  function showServicesToast(msg) {
    let container = document.getElementById('services-toast-container')
    if (!container) {
      container = document.createElement('div')
      container.id = 'services-toast-container'
      container.className = 'toast-container'
      document.body.appendChild(container)
    }
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = msg
    container.appendChild(el)
    setTimeout(() => el.classList.add('fade'), 3000)
    setTimeout(() => el.remove(), 4000)
  }
})()
