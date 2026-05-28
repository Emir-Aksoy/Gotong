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
    // Phase 8 M7 — per-task accumulator for in-flight LLM stream output.
    // Keyed by taskId. Wiped when the matching task_result arrives.
    // Memory-only (deliberately not persisted) — operators wanting the
    // final text use task_result.output; this is just for "watching the
    // model type" in the admin UI.
    //
    //   Map<taskId, {
    //     agentId: ParticipantId,
    //     text: string,         // concatenated text chunks
    //     toolUses: number,     // count of tool_use chunks observed
    //     isDone: boolean,      // an `end` or `error` chunk arrived
    //     lastTs: number,
    //   }>
    liveStreams: new Map(),
    // Phase 13 follow-up — workflow-assist streaming subscription. Set
    // by submitWorkflowAssist while a /api/admin/workflows/assist call
    // is in flight; null otherwise. The shape:
    //
    //   {
    //     taskId: TaskId | null,     // locked from the matching `task` SSE event
    //     onTask: (taskId) => void,  // called once when taskId resolves
    //     onChunk: (text) => void,   // called on each cumulative text update
    //     onEnd: () => void,         // called on matching task_result
    //   }
    //
    // The modal installs/clears this; applyEvent + handleStreamChunk
    // call into it when matching events flow through the SSE feed.
    assistWatcher: null,
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
      // Growth reports (v2.4 personal-growth)
      grSection: $('growth-reports'),
      grTable: $('growth-reports-table'),
      grTbody: $('growth-reports-tbody'),
      grEmpty: $('growth-reports-empty'),
      grSummary: $('growth-reports-summary'),
      grRefreshBtn: $('growth-reports-refresh'),
      // One-time disclaimer (v2.4)
      disclaimerModal: $('disclaimer-modal'),
      disclaimerAccept: $('disclaimer-accept'),
      // Growth report inline-viewer modal (v2.4)
      grReportModal: $('growth-report-modal'),
      grReportTitle: $('growth-report-title'),
      grReportBody: $('growth-report-body'),
      grReportDownload: $('growth-report-download'),
      // Workflows (v2.1)
      wfSection: $('workflows'),
      wfList: $('workflows-list'),
      wfSummary: $('wf-summary'),
      wfImportBtn: $('wf-import-btn'),
      // Workflow start (v2.4) — payload-schema-driven dispatch form
      wfStartModal: $('wf-start-modal'),
      wfStartTitle: $('wf-start-title'),
      wfStartDesc: $('wf-start-desc'),
      wfStartFields: $('wf-start-fields'),
      wfStartSubmit: $('wf-start-submit'),
      wfStartMsg: $('wf-start-msg'),
      // Bundle import (v2.4) — team + workflow + apiKey in one upload
      bundleImportBtn: $('bundle-import-btn'),
      bundleImportModal: $('bundle-import-modal'),
      bundleImportFile: $('bundle-import-file'),
      bundleImportText: $('bundle-import-text'),
      bundleImportKey: $('bundle-import-key'),
      bundleKeyLabel: $('bundle-key-label'),
      bundleImportSubmit: $('bundle-import-submit'),
      bundleImportMsg: $('bundle-import-msg'),
      bundleBuiltinPgBtn: $('bundle-builtin-pg-btn'),
      wfImportModal: $('wf-import-modal'),
      wfImportFile: $('wf-import-file'),
      wfImportText: $('wf-import-text'),
      wfImportSubmit: $('wf-import-submit'),
      wfImportMsg: $('wf-import-msg'),
      // Phase 13 M3 — AI assistant dialog
      wfAssistBtn: $('wf-assist-btn'),
      wfAssistModal: $('wf-assist-modal'),
      wfAssistDescription: $('wf-assist-description'),
      wfAssistGenerate: $('wf-assist-generate'),
      wfAssistMsg: $('wf-assist-msg'),
      wfAssistResult: $('wf-assist-result'),
      wfAssistStatusChip: $('wf-assist-status-chip'),
      wfAssistExplanation: $('wf-assist-explanation'),
      wfAssistYaml: $('wf-assist-yaml'),
      wfAssistErrorDetails: $('wf-assist-error-details'),
      wfAssistValidationError: $('wf-assist-validation-error'),
      // Phase 13 M4 — deep-check warnings panel.
      wfAssistDeepcheckDetails: $('wf-assist-deepcheck-details'),
      wfAssistDeepcheckSummary: $('wf-assist-deepcheck-summary'),
      wfAssistDeepcheckList: $('wf-assist-deepcheck-list'),
      // Phase 13 follow-up — live streaming preview.
      wfAssistStreaming: $('wf-assist-streaming'),
      wfAssistStreamingText: $('wf-assist-streaming-text'),
      wfAssistStreamingMeta: $('wf-assist-streaming-meta'),
      wfAssistSave: $('wf-assist-save'),
      wfAssistRegenerate: $('wf-assist-regenerate'),
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

  /**
   * Phase 8 M7 — fold a single llm_stream_chunk transcript event into
   * state.liveStreams. Idempotent in the sense that out-of-order
   * chunks (very rare under SSE in-order delivery, but possible
   * during reconnect) won't break invariants — the accumulator just
   * stops being meaningful until task_result clears it.
   */
  function handleStreamChunk(ev) {
    const { taskId, agentId, chunk } = ev.data || {}
    if (!taskId || !chunk || typeof chunk !== 'object') return
    let live = state.liveStreams.get(taskId)
    if (!live) {
      live = { agentId, text: '', toolUses: 0, isDone: false, lastTs: ev.ts || Date.now() }
      state.liveStreams.set(taskId, live)
    }
    live.lastTs = ev.ts || Date.now()
    switch (chunk.type) {
      case 'text':
        if (typeof chunk.text === 'string') live.text += chunk.text
        break
      case 'tool_use':
        live.toolUses += 1
        break
      case 'end':
      case 'error':
        live.isDone = true
        break
    }
    // Phase 13 follow-up — if this chunk belongs to a workflow-assist
    // dispatch the modal is watching, push the running text into the
    // streaming preview. The modal renders it character-by-character
    // as the LLM types instead of waiting 30-40s for the final result.
    const w = state.assistWatcher
    if (w && w.taskId === taskId && typeof w.onChunk === 'function') {
      w.onChunk(live.text, { isDone: live.isDone, toolUses: live.toolUses })
    }
  }

  /**
   * Phase 8 M7 — render a compact live-stream indicator for a single
   * task. Returns the HTML string (caller injects). Empty string when
   * the task has no in-flight stream.
   *
   * The text preview is truncated to keep the task card row from
   * jumping around as chunks arrive. Done streams collapse to a
   * checkmark — the final text lives in task_result.output.
   */
  function renderLiveStreamIndicator(taskId) {
    const live = state.liveStreams.get(taskId)
    if (!live) return ''
    const PREVIEW_MAX = 120
    const truncated = live.text.length > PREVIEW_MAX
      ? live.text.slice(0, PREVIEW_MAX) + '…'
      : live.text
    const escaped = escapeHtml(truncated || '(no text yet)')
    const tools = live.toolUses > 0
      ? `<span class="live-stream-tools" title="tool_use chunks">🔧 ${live.toolUses}</span>`
      : ''
    if (live.isDone) {
      return `<div class="live-stream-indicator live-stream-done" title="stream ended">✓ ${tools}</div>`
    }
    return `<div class="live-stream-indicator live-stream-active">
      <span class="live-stream-dot">●</span>
      <span class="live-stream-by">${escapeHtml(live.agentId)}</span>
      ${tools}
      <span class="live-stream-text">${escaped}</span>
    </div>`
  }

  function applyEvent(ev) {
    // Phase 8 M7 — LLM stream chunks DON'T get pushed to state.transcript.
    // A typical task emits ~30+ chunks; pushing each would bloat the
    // transcript view by 30x and overwhelm renderAll. Instead, accumulate
    // into state.liveStreams and let renderTasks() show a live indicator.
    if (ev.kind === 'llm_stream_chunk') {
      handleStreamChunk(ev)
      // Re-render tasks only — the rest of the UI hasn't changed.
      renderTasks()
      return
    }
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
        // Phase 8 M7 — task_result terminates any in-flight live stream
        // for this task. Clean up the accumulator so the indicator
        // disappears as soon as the final answer is known.
        if (ev.kind === 'task_result' && ev.data?.taskId) {
          state.liveStreams.delete(ev.data.taskId)
        }
        // Phase 13 follow-up — workflow-assist streaming hooks. Lock
        // the watcher onto the first matching `task` event so we
        // know which taskId's chunks belong to this modal session,
        // and fire onEnd on the matching task_result so the modal
        // can swap from "live" to "final" rendering. Title matching
        // is best-effort (host's surface sets title='workflow:assist')
        // and there's no harm if it misses — the fetch resolve path
        // still renders the final result.
        if (state.assistWatcher) {
          const w = state.assistWatcher
          if (
            ev.kind === 'task'
            && !w.taskId
            && typeof ev.data?.title === 'string'
            && ev.data.title.includes('workflow:assist')
            && typeof ev.data.taskId === 'string'
          ) {
            w.taskId = ev.data.taskId
            if (typeof w.onTask === 'function') w.onTask(ev.data.taskId)
          } else if (
            ev.kind === 'task_result'
            && w.taskId
            && ev.data?.taskId === w.taskId
            && typeof w.onEnd === 'function'
          ) {
            w.onEnd()
          }
        }
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
    // v2.5 HITL — re-decorate the Tasks tab with a count of pending
    // agent-question tasks so the badge is right after every snapshot.
    renderAgentQuestionBadge()
    // The leaderboard is its own async pull — re-fetch on every full
    // render so a fresh task_result / evaluation immediately re-ranks.
    // Cheap (one /api/leaderboard call), but we swallow failures so a
    // transient hiccup doesn't disable the rest of the page.
    refreshLeaderboard().catch((err) => console.warn('leaderboard refresh failed:', err))
    refreshHealth().catch((err) => console.warn('health refresh failed:', err))
  }

  // v2.5 — count pending agent-question tasks and stick a red badge
  // on the Tasks tab so the admin notices when an agent is paused
  // waiting for them. Idempotent; safe to call from renderAll on
  // every snapshot.
  function renderAgentQuestionBadge() {
    const btn = document.querySelector('.tabbar-btn[data-tab="tasks"]')
    if (!btn) return
    const n = (state.tasks || []).filter(
      (v) => v.status === 'pending' && isAgentQuestionPayload(v.task && v.task.payload),
    ).length
    let badge = btn.querySelector('.tab-badge')
    if (n === 0) {
      if (badge) badge.remove()
      return
    }
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'tab-badge'
      btn.appendChild(badge)
    }
    badge.textContent = String(n)
    badge.title = `${n} 个 agent 正在等你回答`
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
      // Phase 8 M7 — live LLM stream indicator (empty string when no
      // in-flight stream for this task). Rendered between meta and
      // retry so an active task draws the eye but completed tasks
      // collapse cleanly back to the normal layout.
      const liveHtml = renderLiveStreamIndicator(v.id)
      const detailHtml = isOpen ? renderTaskDetail(v) : ''
      div.innerHTML = headHtml + metaHtml + liveHtml + retryHtml + detailHtml
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

    // v2.5 HITL — agent-question form. When a pending task carries
    // payload.kind === 'agent-question' (interviewer asked a follow-
    // up) we render the questions as a form right at the top of the
    // detail panel, before timing/payload/etc. Submitting POSTs
    // /api/tasks/<id>/complete with { output: { answers } } which
    // resolves the parked HumanParticipant promise and unblocks the
    // agent's nested dispatch.
    if (v.status === 'pending' && isAgentQuestionPayload(v.task.payload)) {
      sections.push(renderAgentQuestionForm(v))
    }

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

    // Phase 10 M4 — dispatch ancestry chain. Only rendered when the
    // task has a non-empty `ancestry[]` (root tasks omit). Each entry
    // shows the executor agent (`by`) of an ancestor and a truncated
    // task id so admins can trace A → B → C → this-task. Click-to-
    // copy the full id stays out of scope for M4; admin can read it
    // from the raw payload section if they need it.
    if (Array.isArray(v.task.ancestry) && v.task.ancestry.length > 0) {
      const chain = v.task.ancestry
        .map((node) => {
          const id = String(node.taskId || '')
          const idShort = id ? id.slice(0, 8) + '…' : '?'
          const by = escapeHtml(String(node.by || '?'))
          return `<li><code>${by}</code> <span class="anc-tid" title="${escapeHtml(id)}">${escapeHtml(idShort)}</span></li>`
        })
        .join(' <span class="anc-arrow">→</span> ')
      sections.push(
        `<div class="task-detail-section task-detail-ancestry">` +
          `<strong>↰ dispatch chain (${v.task.ancestry.length}):</strong> ` +
          `<ol class="anc-chain">${chain}</ol>` +
        `</div>`
      )
    }

    // payload — Phase 9 M5: walk for multimodal blocks first, render
    // them inline (img / audio / download link), then keep the raw
    // JSON view below so an admin can still inspect the structure.
    const mm = extractMultimodalBlocks(v.task.payload)
    const mmHtml = mm.length > 0
      ? `<div class="task-detail-multimodal">${mm.map(renderMultimodalBlock).join('')}</div>`
      : ''
    sections.push(
      `<details class="task-detail-section" open>` +
        `<summary>${escapeHtml(t.detailPayload)}</summary>` +
        mmHtml +
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
      // Empty space — offer the one-click onboarding bundle alongside
      // the bare "no agents yet" message. Acts as the "is this thing on?"
      // wizard for non-technical users who just installed AipeHub.
      dom.maList.innerHTML = `<div class="empty-state" style="padding: 1.2rem; line-height: 1.7;">
        <p style="margin: 0 0 0.6rem; font-weight: 600;">${escapeHtml(t.maEmpty)}</p>
        <p style="margin: 0 0 0.8rem; color: #555;">第一次用?试试 5 分钟出一份"12 周个人成长计划":</p>
        <p style="margin: 0;">
          <button type="button" id="onboarding-pg-btn" class="ma-btn">🎁 装个人成长团队 (7 教练 · DeepSeek)</button>
        </p>
        <small class="hint" style="display: block; margin-top: 0.6rem; color: #777;">
          先去 <a href="https://platform.deepseek.com" target="_blank" rel="noopener">platform.deepseek.com</a> 申请 API key (新用户送 10 元额度 ≈ 几十次跑工作流)。
        </small>
      </div>`
      // Wire the button right after innerHTML — it's destroyed and
      // recreated on every refresh so we re-bind each time.
      const btn = document.getElementById('onboarding-pg-btn')
      btn?.addEventListener('click', async () => {
        // 1. open the bundle import modal
        openBundleImportModal()
        // 2. auto-click "use built-in template" so the user lands with
        //    the yaml pre-loaded — they only need to paste the key.
        await new Promise((r) => setTimeout(r, 50))
        dom.bundleBuiltinPgBtn?.click()
        // 3. focus the key input so they can paste-and-go.
        await new Promise((r) => setTimeout(r, 100))
        dom.bundleImportKey?.focus()
      })
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
      // "开始" button: primary action — opens a payload-schema-driven
      // form modal so users don't have to write JSON by hand. For
      // workflows without a schema, the button opens the generic
      // dispatch form pre-filled with the trigger capability.
      return `<article class="ma-card">
        <header>
          <strong>${name}</strong>
          <code>${escapeHtml(w.participantId)}</code>
          <button type="button" class="ma-btn"
                  data-act="start-workflow"
                  data-id="${escapeHtml(w.id)}">开始</button>
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

  // --- growth reports (v2.4 personal-growth) -----------------------------
  // Sibling of the workflows panel — only present when the host wired
  // a GrowthReportsAdminSurface (i.e. loaded the personal-growth team).
  // 503 → hide; 200 with empty list → empty-state.

  async function refreshGrowthReports() {
    if (!dom?.grSection) return
    try {
      const r = await fetch('/api/admin/growth-reports')
      if (r.status === 503) {
        dom.grSection.hidden = true
        return
      }
      if (!r.ok) {
        console.warn('refreshGrowthReports: HTTP', r.status)
        return
      }
      const body = await r.json()
      const reports = Array.isArray(body.reports) ? body.reports : []
      dom.grSection.hidden = false
      renderGrowthReports(reports)
    } catch (err) {
      console.warn('refreshGrowthReports:', err)
    }
  }

  function renderGrowthReports(reports) {
    if (!dom.grTbody) return
    if (dom.grSummary) {
      dom.grSummary.textContent = reports.length === 0
        ? ''
        : `共 ${reports.length} 份`
    }
    if (reports.length === 0) {
      dom.grTable.hidden = true
      dom.grEmpty.hidden = false
      dom.grTbody.innerHTML = ''
      return
    }
    dom.grEmpty.hidden = true
    dom.grTable.hidden = false
    dom.grTbody.innerHTML = reports.map((rep) => {
      const when = new Date(rep.ts).toLocaleString('zh-CN', { hour12: false })
      const sizeKb = (rep.sizeBytes / 1024).toFixed(1) + ' KB'
      const dlHref = '/api/admin/growth-reports/download?path=' + encodeURIComponent(rep.path)
      return `<tr>
        <td>${escapeHtml(when)}</td>
        <td><code>${escapeHtml(rep.caseId)}</code></td>
        <td>${escapeHtml(sizeKb)}</td>
        <td>
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="view-growth-report"
                  data-path="${escapeHtml(rep.path)}"
                  data-when="${escapeHtml(when)}">查看</button>
          <a class="ma-btn ma-btn-secondary" href="${escapeHtml(dlHref)}" download>下载</a>
        </td>
      </tr>`
    }).join('')
  }

  // --- markdown viewer (v2.4) --------------------------------------------
  // Tiny subset converter — handles the structured markdown the
  // synthesist emits (headers, lists, bold, italic, blockquote, hr, code,
  // line breaks). Escapes HTML first to neutralize any injection from
  // synthesist output. Lives inline (no CDN) because CSP allows only
  // 'self' scripts.

  function renderMarkdown(md) {
    if (!md) return ''
    // 1. escape HTML
    let text = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    // 2. headers (#, ##, ###, ####)
    text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>')
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // 3. horizontal rule
    text = text.replace(/^---+\s*$/gm, '<hr>')
    // 4. blockquote (single-line, the synthesist uses them as examples)
    text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    // 5. simple table — pipe-separated rows. Detect by '|' at line start
    //    and a separator line (|---|---|) right after.
    //    For v1, just leave them as preformatted text since the
    //    synthesist's 12-week plan uses a list-style layout, not real tables.
    // 6. ordered + unordered lists
    text = text.replace(/^(?:\s*[-*] .+(?:\n|$))+/gm, (block) => {
      const items = block.trim().split(/\n/).map((l) =>
        '<li>' + l.replace(/^\s*[-*] /, '') + '</li>'
      ).join('')
      return '<ul>' + items + '</ul>'
    })
    text = text.replace(/^(?:\s*\d+\. .+(?:\n|$))+/gm, (block) => {
      const items = block.trim().split(/\n/).map((l) =>
        '<li>' + l.replace(/^\s*\d+\. /, '') + '</li>'
      ).join('')
      return '<ol>' + items + '</ol>'
    })
    // 7. bold + italic + inline code
    //    bold first so the **x** doesn't get partially consumed by italic.
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
    // 8. paragraph + line breaks — every double-newline ends a paragraph,
    //    single-newline becomes <br>. Skip wrapping for block-level
    //    elements (h1..h4, ul, ol, blockquote, hr).
    const blocks = text.split(/\n{2,}/).map((para) => {
      const trimmed = para.trim()
      if (!trimmed) return ''
      if (/^<(?:h[1-4]|ul|ol|blockquote|hr|pre|table)/.test(trimmed)) {
        return trimmed
      }
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>'
    })
    return blocks.join('\n')
  }

  async function openGrowthReport(path, when) {
    if (!dom.grReportModal) return
    dom.grReportTitle.textContent = `成长报告 · ${when}`
    dom.grReportDownload.href = '/api/admin/growth-reports/download?path=' + encodeURIComponent(path)
    dom.grReportBody.innerHTML = '<p class="hint">加载中...</p>'
    dom.grReportModal.hidden = false
    try {
      const r = await fetch('/api/admin/growth-reports/download?path=' + encodeURIComponent(path))
      if (!r.ok) {
        dom.grReportBody.innerHTML = `<p class="hint">加载失败:HTTP ${r.status}</p>`
        return
      }
      const text = await r.text()
      dom.grReportBody.innerHTML = renderMarkdown(text)
    } catch (err) {
      dom.grReportBody.innerHTML = `<p class="hint">加载失败:${escapeHtml(err.message || String(err))}</p>`
    }
  }

  function closeGrowthReport() {
    if (dom.grReportModal) dom.grReportModal.hidden = true
  }

  // --- start workflow (v2.4 payload-schema-driven form) -------------------
  // Each workflow card has an "开始" button that opens this modal.
  // If the workflow's WorkflowSummary carries a `payloadSchema`, we
  // render one input per field (text / textarea / number / select).
  // Otherwise we fall back to a single JSON textarea (legacy parity
  // with the generic dispatch form).

  let wfStartCurrent = null

  function openWorkflowStart(workflowId) {
    const w = wf.workflows.find((x) => x.id === workflowId)
    if (!w) { alert(`unknown workflow '${workflowId}'`); return }
    wfStartCurrent = w
    if (dom.wfStartTitle) {
      dom.wfStartTitle.textContent = w.name || w.id
    }
    if (dom.wfStartDesc) {
      const cap = `<code>${escapeHtml(w.triggerCapability)}</code>`
      dom.wfStartDesc.innerHTML = w.description
        ? `${escapeHtml(w.description)}<br/><small>派发能力:${cap}</small>`
        : `派发能力:${cap}`
    }
    renderWorkflowStartFields(w.payloadSchema)
    if (dom.wfStartMsg) {
      dom.wfStartMsg.textContent = ''
      dom.wfStartMsg.classList.remove('ok', 'err')
    }
    if (dom.wfStartModal) dom.wfStartModal.hidden = false
  }

  function closeWorkflowStart() {
    if (dom.wfStartModal) dom.wfStartModal.hidden = true
    wfStartCurrent = null
  }

  function renderWorkflowStartFields(schema) {
    if (!dom.wfStartFields) return
    const fields = Array.isArray(schema) ? schema : null
    if (!fields || fields.length === 0) {
      // No schema → fall back to one JSON textarea, like the generic
      // dispatch form. Lets a non-PG workflow still be triggered from
      // its card.
      dom.wfStartFields.innerHTML = `<label>
        <span>Payload (JSON)</span>
        <textarea id="wf-start-json" rows="8" placeholder='{ "key": "value" }'>{}</textarea>
        <small class="hint">这条工作流没声明 payload_schema,要手填 JSON。看 workflow.yaml 的 trigger 段了解需要哪些字段。</small>
      </label>`
      return
    }
    dom.wfStartFields.innerHTML = fields.map(renderOneField).join('')
  }

  // ── HITL: agent-question payload shape + form rendering ─────────────
  //
  // The interviewer (and any future HITL-capable agent) can pause its
  // step by dispatching a task at the originating admin with this
  // payload:
  //
  //   { kind: 'agent-question',
  //     fromAgent: 'growth-interviewer',
  //     context: '(optional one-line explainer to show above the form)',
  //     questions: [{ id, label, hint?, type, rows?, required? }, ...] }
  //
  // The admin fills in answers, this UI POSTs them as the task result
  // payload, the parked agent resumes with the merged answers.

  function isAgentQuestionPayload(p) {
    return (
      p && typeof p === 'object' &&
      p.kind === 'agent-question' &&
      Array.isArray(p.questions) &&
      p.questions.length > 0
    )
  }

  function renderAgentQuestionForm(v) {
    const payload = v.task.payload
    const qs = payload.questions || []
    const ctx = typeof payload.context === 'string' ? payload.context : ''
    const fromAgent = typeof payload.fromAgent === 'string' ? payload.fromAgent : '(agent)'

    // Use task-scoped field ids so multiple expanded agent-question
    // cards can coexist on the page without colliding form state.
    const fields = qs.map((q, i) => renderAgentQuestionField(v.id, q, i)).join('')

    return (
      `<div class="task-detail-section agent-question-form" data-aq-id="${escapeHtml(v.id)}">` +
        `<div class="aq-header">` +
          `<strong>🤖 ${escapeHtml(fromAgent)} 想再问你 ${qs.length} 件事</strong>` +
          (ctx ? `<p class="aq-context">${escapeHtml(ctx)}</p>` : '') +
        `</div>` +
        `<div class="aq-fields">${fields}</div>` +
        `<div class="aq-actions">` +
          `<button class="primary" data-act="submit-agent-question" data-id="${escapeHtml(v.id)}">提交回答 (agent 会接着跑)</button>` +
          `<button class="secondary" data-act="skip-agent-question" data-id="${escapeHtml(v.id)}" title="跳过 — agent 会按它第一轮的判断继续">跳过</button>` +
          `<span class="aq-msg" data-aq-msg="${escapeHtml(v.id)}"></span>` +
        `</div>` +
      `</div>`
    )
  }

  function renderAgentQuestionField(taskId, q, idx) {
    const fid = q && typeof q.id === 'string' ? q.id : `q${idx}`
    const fieldDomId = `aq-${taskId}-${fid}`
    const label = q && typeof q.label === 'string' ? q.label : `Q${idx + 1}`
    const hint = q && typeof q.hint === 'string'
      ? `<small class="hint">${escapeHtml(q.hint)}</small>`
      : ''
    const required = q && q.required ? ' <span style="color:#c33">*</span>' : ''
    let control
    if (q && q.type === 'text') {
      control = `<input type="text" id="${escapeHtml(fieldDomId)}" data-aq-fid="${escapeHtml(fid)}" />`
    } else if (q && q.type === 'number') {
      control = `<input type="number" id="${escapeHtml(fieldDomId)}" data-aq-fid="${escapeHtml(fid)}" />`
    } else {
      // textarea is the default. Rows defaults to 4; the parser
      // clamps to [1, 20] before sending so we trust it here.
      const rows = q && typeof q.rows === 'number' && q.rows > 0 ? q.rows : 4
      control = `<textarea id="${escapeHtml(fieldDomId)}" data-aq-fid="${escapeHtml(fid)}" rows="${rows}"></textarea>`
    }
    return (
      `<label class="aq-field">` +
        `<span>${escapeHtml(label)}${required}</span>` +
        control +
        hint +
      `</label>`
    )
  }

  async function submitAgentQuestion(taskId) {
    const card = document.querySelector(`.agent-question-form[data-aq-id="${cssEscape(taskId)}"]`)
    if (!card) return
    const msg = card.querySelector(`[data-aq-msg="${cssEscape(taskId)}"]`)
    const setMsg = (text, kind) => {
      if (!msg) return
      msg.textContent = text
      msg.className = 'aq-msg' + (kind ? ' ' + kind : '')
    }
    setMsg('提交中…')

    const view = state.tasks.find((x) => x.id === taskId)
    const qs = view?.task?.payload?.questions || []
    const answers = {}
    for (const q of qs) {
      const el = card.querySelector(`[data-aq-fid="${cssEscape(q.id)}"]`)
      if (!el) continue
      const v = el.value
      if (q.required && (v == null || String(v).trim() === '')) {
        setMsg(`${q.label} 必填`, 'err')
        return
      }
      if (v != null && String(v).length > 0) answers[q.id] = String(v)
    }

    try {
      await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ output: { answers } }),
      })
      setMsg('已提交 — agent 收到了,正在继续', 'ok')
    } catch (err) {
      setMsg('提交失败: ' + (err.message || String(err)), 'err')
    }
  }

  async function skipAgentQuestion(taskId) {
    // Skip = reject the task. The agent's nested dispatch resolves
    // with kind='failed', the agent's HITL branch sees the failure
    // and falls back to its first-round output.
    const card = document.querySelector(`.agent-question-form[data-aq-id="${cssEscape(taskId)}"]`)
    const msg = card?.querySelector(`[data-aq-msg="${cssEscape(taskId)}"]`)
    if (msg) { msg.textContent = '跳过中…'; msg.className = 'aq-msg' }
    try {
      await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'admin skipped' }),
      })
      if (msg) { msg.textContent = '已跳过 — agent 用了第一轮的判断'; msg.className = 'aq-msg ok' }
    } catch (err) {
      if (msg) { msg.textContent = '跳过失败: ' + (err.message || String(err)); msg.className = 'aq-msg err' }
    }
  }

  // CSS.escape polyfill for older browsers — used to inject task ids
  // into selectors. Cookie-style escape would be heavier; this covers
  // anything the dispatcher might emit.
  function cssEscape(s) {
    return typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(String(s))
      : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }

  // --- Phase 9 M4: file upload helpers ----------------------------------
  // `uploadOneFile` POSTs to /api/admin/uploads with the raw bytes; the
  // host returns { artifactId, mime, size } which the workflow-start
  // submit handler stamps into a LlmFileRefBlock-shaped payload entry.
  //
  // We use the browser's native File object as the fetch body — undici /
  // browser fetch streams it without buffering the whole file in JS heap,
  // and the server's `readRawBody` accumulates Buffer chunks. The mime
  // query param uses File.type (HTML5 file picker derives it from
  // extension/sniffing); the server treats it as advisory.
  async function uploadOneFile(file) {
    const params = new URLSearchParams()
    params.set('filename', file.name)
    if (file.type) params.set('mime', file.type)
    const url = `/api/admin/uploads?${params.toString()}`
    const r = await fetch(url, {
      method: 'POST',
      // Don't set content-type explicitly — let the browser pick one
      // up from File.type (or default to application/octet-stream).
      // Setting it manually would override File.type and confuse the
      // mime fallback chain.
      credentials: 'same-origin',
      body: file,
    })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try {
        const j = await r.json()
        if (j && j.error) msg = j.error
      } catch { /* keep status as msg */ }
      throw new Error(msg)
    }
    return await r.json()
  }

  // Compact byte-count formatter for upload status text.
  // 1234 → "1.2 KB"; 1234567 → "1.2 MB". No internationalisation —
  // these are operator-facing log-style strings.
  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  // --- Phase 9 M5: multimodal block helpers -----------------------------
  // Walk an arbitrary JSON tree and collect every LlmFileRefBlock /
  // LlmImageBlock / LlmAudioBlock-shaped node. The shape check is
  // structural (no schema dep on @aipehub/llm here) — we look for
  // the `type` discriminator and the per-kind required fields. Same
  // shapes the providers expect on the LlmRequest side, so any
  // payload that's been authored via the workflow `type: 'file'` flow
  // (or that an agent emitted into its task output) matches cleanly.
  //
  // Order: visits arrays before object values; preserves visit order
  // in the returned list so the admin sees blocks in the same order
  // they appeared in the payload tree (helps when a single payload
  // carries multiple images / a mix of image+audio).
  function extractMultimodalBlocks(node) {
    const out = []
    visit(node)
    return out
    function visit(v) {
      if (!v) return
      if (Array.isArray(v)) {
        for (const item of v) visit(item)
        return
      }
      if (typeof v !== 'object') return
      // file_ref: { type:'file_ref', artifactId, mime }
      if (v.type === 'file_ref'
          && typeof v.artifactId === 'string' && v.artifactId.length > 0
          && typeof v.mime === 'string') {
        out.push(v)
        return  // don't recurse into siblings of a block
      }
      // image: { type:'image', source:{kind,...} }
      if (v.type === 'image' && v.source && typeof v.source === 'object') {
        out.push(v)
        return
      }
      // audio: { type:'audio', source:{kind,...}, format? }
      if (v.type === 'audio' && v.source && typeof v.source === 'object') {
        out.push(v)
        return
      }
      // not a block — keep walking
      for (const key of Object.keys(v)) visit(v[key])
    }
  }

  // Render one multimodal block as HTML. Returns a small "card" with:
  //   - file_ref + mime image/* → <img> preview + filename + size hint
  //   - file_ref + mime audio/* → <audio controls> + filename
  //   - file_ref + other mime  → download link + mime + filename
  //   - image source=base64    → <img src="data:..."> inline
  //   - image source=url       → <img src="..."> external
  //   - image source=artifact_ref → <img> via /api/admin/uploads?id=...
  //   - audio source=base64    → <audio src="data:..."> inline
  //   - audio source=url       → <audio src="..."> external
  //   - audio source=artifact_ref → <audio> via /api/admin/uploads
  function renderMultimodalBlock(b) {
    if (b.type === 'file_ref') {
      const url = `/api/admin/uploads?id=${encodeURIComponent(b.artifactId)}`
      const tail = b.artifactId.split('/').pop() || b.artifactId
      const meta = `<div class="mm-meta"><code>${escapeHtml(b.mime)}</code> · ${escapeHtml(tail)}</div>`
      if (b.mime.startsWith('image/')) {
        return `<div class="mm-block mm-image">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(url)}" alt="${escapeHtml(tail)}" loading="lazy" />
          </a>
          ${meta}
        </div>`
      }
      if (b.mime.startsWith('audio/')) {
        return `<div class="mm-block mm-audio">
          <audio controls src="${escapeHtml(url)}"></audio>
          ${meta}
        </div>`
      }
      // Generic file — render as download link with mime tag.
      return `<div class="mm-block mm-file">
        <a href="${escapeHtml(url)}" download="${escapeHtml(tail)}">📎 ${escapeHtml(tail)}</a>
        ${meta}
      </div>`
    }
    if (b.type === 'image') {
      const src = imageOrAudioSourceToSrc(b.source)
      if (!src) return renderUnknownBlock(b)
      return `<div class="mm-block mm-image">
        <a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(src.url)}" alt="image" loading="lazy" />
        </a>
        <div class="mm-meta"><code>${escapeHtml(src.label)}</code></div>
      </div>`
    }
    if (b.type === 'audio') {
      const src = imageOrAudioSourceToSrc(b.source)
      if (!src) return renderUnknownBlock(b)
      const fmt = b.format ? ` · ${escapeHtml(b.format)}` : ''
      return `<div class="mm-block mm-audio">
        <audio controls src="${escapeHtml(src.url)}"></audio>
        <div class="mm-meta"><code>${escapeHtml(src.label)}</code>${fmt}</div>
      </div>`
    }
    return renderUnknownBlock(b)
  }

  function imageOrAudioSourceToSrc(source) {
    if (!source || typeof source !== 'object') return null
    if (source.kind === 'base64'
        && typeof source.data === 'string'
        && typeof source.mime === 'string') {
      return {
        url: `data:${source.mime};base64,${source.data}`,
        label: `${source.mime} (inline base64)`,
      }
    }
    if (source.kind === 'url' && typeof source.url === 'string') {
      return { url: source.url, label: source.url }
    }
    if (source.kind === 'artifact_ref'
        && typeof source.artifactId === 'string'
        && typeof source.mime === 'string') {
      return {
        url: `/api/admin/uploads?id=${encodeURIComponent(source.artifactId)}`,
        label: `${source.mime} · ${source.artifactId}`,
      }
    }
    return null
  }

  function renderUnknownBlock(b) {
    return `<div class="mm-block mm-unknown">
      <small>未识别的 ${escapeHtml(String(b && b.type) || 'unknown')} 块</small>
    </div>`
  }

  function renderOneField(f) {
    const id = `wf-start-field-${escapeHtml(f.id)}`
    const required = f.required ? ' <span style="color:#c33">*</span>' : ''
    const hint = f.hint ? `<small class="hint">${escapeHtml(f.hint)}</small>` : ''
    const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : ''
    const defaultV = f.defaultValue != null ? escapeHtml(String(f.defaultValue)) : ''
    let control
    if (f.type === 'textarea') {
      const rows = typeof f.rows === 'number' ? f.rows : 4
      control = `<textarea id="${id}" rows="${rows}"${ph}>${defaultV}</textarea>`
    } else if (f.type === 'select') {
      const opts = (f.options || [])
        .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === f.defaultValue ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('')
      control = `<select id="${id}">${opts}</select>`
    } else if (f.type === 'number') {
      control = `<input type="number" id="${id}"${ph} value="${defaultV}" />`
    } else if (f.type === 'file') {
      // Phase 9 M4 — file upload. The `accept` attr is a UI hint
      // only (the upload endpoint also enforces server-side caps).
      // `data-aipe-file` lets the submit handler find file inputs
      // without re-walking the schema. `aipe-file-status` shows
      // "上传中…" / "已上传 (123 KB)" inline so the admin gets feedback
      // before the workflow dispatch fires.
      const accept = Array.isArray(f.accept) && f.accept.length > 0
        ? ` accept="${escapeHtml(f.accept.join(','))}"`
        : ''
      const sizeHint = typeof f.maxSizeMb === 'number'
        ? `<small class="hint">最大 ${f.maxSizeMb} MB</small>`
        : ''
      control = `<input type="file" id="${id}" data-aipe-file="1"${accept} />
        <span class="aipe-file-status" data-aipe-file-status="${id}" style="font-size:0.85em;color:#666;margin-left:0.5em;"></span>
        ${sizeHint}`
    } else {
      control = `<input type="text" id="${id}"${ph} value="${defaultV}" />`
    }
    return `<label>
      <span>${escapeHtml(f.label)}${required}</span>
      ${control}
      ${hint}
    </label>`
  }

  async function submitWorkflowStart() {
    if (!wfStartCurrent) return
    if (dom.wfStartMsg) {
      dom.wfStartMsg.textContent = ''
      dom.wfStartMsg.classList.remove('ok', 'err')
    }
    const w = wfStartCurrent
    let payload
    const schema = Array.isArray(w.payloadSchema) ? w.payloadSchema : null
    if (schema) {
      payload = {}
      for (const f of schema) {
        const el = document.getElementById(`wf-start-field-${f.id}`)
        if (!el) continue
        // Phase 9 M4 — file field: upload first, inject file_ref block.
        if (f.type === 'file') {
          const files = el.files
          if (!files || files.length === 0) {
            if (f.required) {
              dom.wfStartMsg.textContent = `${f.label} 必填`
              dom.wfStartMsg.classList.add('err')
              return
            }
            continue
          }
          const file = files[0]
          // UI-side size check — server enforces its own ceiling
          // but a clean inline error beats waiting for a 413.
          const capMb = typeof f.maxSizeMb === 'number' ? f.maxSizeMb : 10
          if (file.size > capMb * 1024 * 1024) {
            dom.wfStartMsg.textContent = `${f.label} 文件超过 ${capMb} MB 上限`
            dom.wfStartMsg.classList.add('err')
            return
          }
          const statusEl = document.querySelector(
            `[data-aipe-file-status="wf-start-field-${cssEscape(f.id)}"]`,
          )
          if (statusEl) statusEl.textContent = '上传中…'
          try {
            const ref = await uploadOneFile(file)
            if (statusEl) {
              // For image uploads, show an inline thumbnail next to
              // the size hint so the admin sees what they're about
              // to dispatch. Audio gets a `<audio controls>` mini
              // player. Other mimes stay text-only (a generic file
              // icon would just be noise).
              statusEl.style.color = '#080'
              if (ref.mime && ref.mime.startsWith('image/')) {
                const url = `/api/admin/uploads?id=${encodeURIComponent(ref.artifactId)}`
                statusEl.innerHTML =
                  `<span>已上传 (${escapeHtml(formatBytes(ref.size))})</span> ` +
                  `<img src="${escapeHtml(url)}" alt="preview" ` +
                  `style="max-height:32px;max-width:80px;vertical-align:middle;border-radius:2px;margin-left:0.4em;" />`
              } else if (ref.mime && ref.mime.startsWith('audio/')) {
                const url = `/api/admin/uploads?id=${encodeURIComponent(ref.artifactId)}`
                statusEl.innerHTML =
                  `<span>已上传 (${escapeHtml(formatBytes(ref.size))})</span> ` +
                  `<audio controls src="${escapeHtml(url)}" ` +
                  `style="height:24px;max-width:140px;vertical-align:middle;margin-left:0.4em;"></audio>`
              } else {
                statusEl.textContent = `已上传 (${formatBytes(ref.size)})`
              }
            }
            payload[f.id] = { type: 'file_ref', artifactId: ref.artifactId, mime: ref.mime }
          } catch (err) {
            const msg = err && err.message ? err.message : String(err)
            if (statusEl) {
              statusEl.textContent = `上传失败: ${msg}`
              statusEl.style.color = '#c33'
            }
            dom.wfStartMsg.textContent = `${f.label} 上传失败: ${msg}`
            dom.wfStartMsg.classList.add('err')
            return
          }
          continue
        }
        let v = el.value
        if (f.required && (v == null || v.trim() === '')) {
          dom.wfStartMsg.textContent = `${f.label} 必填`
          dom.wfStartMsg.classList.add('err')
          return
        }
        if (v === '') continue  // skip empty optional fields
        if (f.type === 'number') {
          const n = Number(v)
          if (!Number.isFinite(n)) {
            dom.wfStartMsg.textContent = `${f.label} 必须是数字`
            dom.wfStartMsg.classList.add('err')
            return
          }
          payload[f.id] = n
        } else {
          payload[f.id] = v
        }
      }
    } else {
      const jsonEl = document.getElementById('wf-start-json')
      try {
        payload = JSON.parse(jsonEl?.value || '{}')
      } catch (err) {
        dom.wfStartMsg.textContent = 'Payload JSON 不合法:' + (err.message || String(err))
        dom.wfStartMsg.classList.add('err')
        return
      }
    }
    try {
      const r = await fetch('/api/admin/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: { kind: 'capability', capabilities: [w.triggerCapability] },
          title: `${w.name || w.id}`,
          payload,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.wfStartMsg.textContent = '失败:' + (body.error || `HTTP ${r.status}`)
        dom.wfStartMsg.classList.add('err')
        return
      }
      dom.wfStartMsg.textContent = '已派发 — 在「运行历史」面板看进度。'
      dom.wfStartMsg.classList.add('ok')
      setTimeout(closeWorkflowStart, 1500)
    } catch (err) {
      dom.wfStartMsg.textContent = '失败:' + (err.message || String(err))
      dom.wfStartMsg.classList.add('err')
    }
  }

  // --- bundle import (v2.4) ----------------------------------------------
  // Bundles let a non-technical user upload one yaml and get N agents +
  // 1 workflow + a one-shot apiKey in a single round-trip. POSTs to
  // /api/admin/bundles/import which the host wired in P0 #1.
  //
  // The key field is optional in the schema; the bundle yaml may carry
  // an `apiKeyPrompt` hint (label/baseURL) that tells us what to ask
  // for. We sniff the pasted/uploaded text for that hint and update
  // the key field's label on the fly.

  function openBundleImportModal() {
    if (!dom?.bundleImportModal) return
    dom.bundleImportText.value = ''
    dom.bundleImportFile.value = ''
    dom.bundleImportKey.value = ''
    dom.bundleKeyLabel.textContent = 'API key (optional)'
    dom.bundleImportMsg.textContent = ''
    dom.bundleImportMsg.classList.remove('ok', 'err')
    dom.bundleImportModal.hidden = false
  }

  function closeBundleImportModal() {
    if (dom?.bundleImportModal) dom.bundleImportModal.hidden = true
  }

  /**
   * Pluck a one-line "apiKeyPrompt.label" hint out of pasted/uploaded
   * yaml so we can localise the key input label ("DeepSeek API key"
   * instead of just "API key"). We do a regex sniff rather than full
   * yaml parse — the modal stays decoupled from any yaml lib.
   */
  function sniffApiKeyLabel(text) {
    const m = text.match(/apiKeyPrompt[\s\S]{0,200}?label:\s*"?([^"\n\r]+)/)
    if (!m) return null
    return m[1].trim()
  }

  async function submitBundleImport() {
    dom.bundleImportMsg.textContent = ''
    dom.bundleImportMsg.classList.remove('ok', 'err')
    let text = dom.bundleImportText.value
    const file = dom.bundleImportFile.files?.[0]
    if (file && !text) {
      text = await file.text()
    }
    if (!text || !text.trim()) {
      dom.bundleImportMsg.textContent = '请上传或粘贴 bundle yaml'
      dom.bundleImportMsg.classList.add('err')
      return
    }
    const apiKey = dom.bundleImportKey.value.trim() || undefined
    const payload = apiKey ? { yaml: text, apiKey } : { yaml: text }
    try {
      const r = await fetch('/api/admin/bundles/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.bundleImportMsg.textContent = '失败:' + (body.error || `HTTP ${r.status}`)
        dom.bundleImportMsg.classList.add('err')
        return
      }
      // Build a human summary: N created, M skipped, workflow id if loaded
      const createdN = body.team?.created?.length ?? 0
      const skippedN = body.team?.skipped?.length ?? 0
      const wfId = body.workflow?.id
      const parts = []
      if (createdN > 0) parts.push(`新增 ${createdN} 个 agent`)
      if (skippedN > 0) parts.push(`跳过 ${skippedN} 个(已存在)`)
      if (wfId) parts.push(`workflow ${wfId} 已注册`)
      if (body.workflowError) parts.push(`(workflow 警告:${body.workflowError})`)
      if (body.team?.spawnErrors?.length) {
        parts.push(`(${body.team.spawnErrors.length} 个 spawn 失败:看 agent tab)`)
      }
      dom.bundleImportMsg.textContent = '导入完成 — ' + parts.join('、')
      dom.bundleImportMsg.classList.add('ok')
      await refreshManagedAgents().catch(() => {})
      await refreshWorkflows().catch(() => {})
      setTimeout(closeBundleImportModal, 1200)
    } catch (err) {
      dom.bundleImportMsg.textContent = '失败:' + (err.message || String(err))
      dom.bundleImportMsg.classList.add('err')
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

  // --- workflow AI assistant (Phase 13 M3) -------------------------------
  // 自然语言 → workflow YAML 草稿。
  //   - 输入: textarea 描述
  //   - 调 POST /api/admin/workflows/assist (走 host 注册的 WorkflowAssistantAgent)
  //   - 回 { yaml, explanation, draftStatus, validationError?, ... }
  //   - 渲染: status chip + explanation + YAML preview + 校验错误
  //   - 仅当 draftStatus === 'valid' 才启用"保存为工作流"按钮 (走 /import)

  function openWorkflowAssistModal() {
    dom.wfAssistDescription.value = ''
    dom.wfAssistMsg.textContent = ''
    dom.wfAssistMsg.classList.remove('ok', 'err')
    dom.wfAssistResult.hidden = true
    dom.wfAssistSave.disabled = true
    // Reset the deep-check panel so a previous run's warnings don't
    // bleed into this session — renderAssistResult will repopulate it.
    if (dom.wfAssistDeepcheckDetails) dom.wfAssistDeepcheckDetails.hidden = true
    if (dom.wfAssistDeepcheckList) dom.wfAssistDeepcheckList.innerHTML = ''
    // Phase 13 follow-up — reset streaming preview pane.
    if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
    if (dom.wfAssistStreamingText) dom.wfAssistStreamingText.textContent = ''
    if (dom.wfAssistStreamingMeta) dom.wfAssistStreamingMeta.textContent = ''
    // Defensive: if a previous run's watcher leaked (modal closed
    // before fetch resolved), clear it so it can't taint this run.
    state.assistWatcher = null
    dom.wfAssistModal.hidden = false
    setTimeout(() => dom.wfAssistDescription?.focus(), 0)
  }

  function closeWorkflowAssistModal() {
    dom.wfAssistModal.hidden = true
    // If the user closes mid-stream the fetch is still in flight, but
    // the modal is gone — drop the watcher so its callbacks don't poke
    // hidden DOM nodes. The fetch resolve path also clears it, so this
    // is just belt-and-suspenders.
    state.assistWatcher = null
    if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
  }

  function renderAssistStatusChip(status, deepCheck) {
    const chip = dom.wfAssistStatusChip
    chip.textContent = ''
    chip.classList.remove('ok', 'err')
    chip.style.padding = '0.15rem 0.5rem'
    chip.style.borderRadius = '0.25rem'
    chip.style.fontSize = '0.85em'
    if (status === 'valid') {
      // M4: valid + deep-check failed → yellow "warnings" state instead
      // of green. YAML still parses, but it references things this hub
      // doesn't actually have, so it'd fail at runtime.
      if (deepCheck && deepCheck.ok === false) {
        const n = (deepCheck.violations || []).length
        chip.textContent = `⚠ schema 通过，但有 ${n} 项深度警告`
        chip.style.background = '#fef3c7'
        chip.style.color = '#92400e'
      } else {
        chip.textContent = '✓ 校验通过 (可保存)'
        chip.style.background = '#d1fae5'
        chip.style.color = '#065f46'
      }
    } else if (status === 'invalid') {
      chip.textContent = '✗ YAML 不合 v1 schema'
      chip.style.background = '#fee2e2'
      chip.style.color = '#991b1b'
    } else if (status === 'no_yaml') {
      chip.textContent = '— LLM 没生成 YAML'
      chip.style.background = '#e5e7eb'
      chip.style.color = '#374151'
    } else {
      chip.textContent = status || '(未知)'
      chip.style.background = '#e5e7eb'
      chip.style.color = '#374151'
    }
  }

  // Phase 13 M4 — short human label for each deep-check violation kind.
  // Comes from `WorkflowStructureViolationKind` in @aipehub/evals.
  function deepCheckKindLabel(kind) {
    switch (kind) {
      case 'unknown_agent':
        return '指向不存在的 agent'
      case 'unknown_capability':
        return '当前 hub 没 agent 提供该 capability'
      case 'bad_ref':
        return '$ref 指向不存在的 step'
      case 'forward_ref':
        return '$ref 指向更晚执行的 step'
      case 'self_trigger_cycle':
        return '会触发自己 — 死循环'
      case 'id_collision':
        return 'workflow.id 已存在'
      default:
        return kind || '(unknown)'
    }
  }

  function renderAssistDeepCheck(deepCheck) {
    const details = dom.wfAssistDeepcheckDetails
    const summary = dom.wfAssistDeepcheckSummary
    const list = dom.wfAssistDeepcheckList
    if (!details || !summary || !list) return
    list.innerHTML = ''
    // No deepCheck attached → hide panel entirely. Caller didn't pass
    // contextHints, or the YAML wasn't even valid.
    if (!deepCheck) {
      details.hidden = true
      return
    }
    if (deepCheck.ok) {
      // Quietly tell the admin everything passed; collapsed by default
      // so it doesn't compete with the YAML preview for attention.
      details.hidden = false
      details.open = false
      summary.textContent = '深度检查通过 (0 项警告)'
      summary.style.color = '#065f46'
      return
    }
    const violations = deepCheck.violations || []
    details.hidden = false
    details.open = true
    summary.textContent = `深度检查警告 — ${violations.length} 项 (workflow 可保存，但运行时可能失败)`
    summary.style.color = '#92400e'
    for (const v of violations) {
      const li = document.createElement('li')
      li.style.margin = '0.2rem 0'
      const label = document.createElement('strong')
      label.textContent = deepCheckKindLabel(v.kind) + ' — '
      li.appendChild(label)
      li.appendChild(document.createTextNode(v.message || ''))
      if (v.path) {
        const path = document.createElement('code')
        path.textContent = ' (' + v.path + ')'
        path.style.color = '#6b7280'
        path.style.fontSize = '0.9em'
        li.appendChild(path)
      }
      list.appendChild(li)
    }
  }

  async function submitWorkflowAssist() {
    const description = (dom.wfAssistDescription.value || '').trim()
    dom.wfAssistMsg.textContent = ''
    dom.wfAssistMsg.classList.remove('ok', 'err')
    if (!description) {
      dom.wfAssistMsg.textContent = '请先填一句描述'
      dom.wfAssistMsg.classList.add('err')
      return
    }
    dom.wfAssistGenerate.disabled = true
    dom.wfAssistGenerate.textContent = '生成中…'
    dom.wfAssistMsg.textContent = '正在生成,通常 5-20 秒…'

    // Phase 13 follow-up — open the streaming preview pane and install
    // a watcher that listens on the existing SSE feed for matching
    // task / chunk / task_result events. The watcher narrows onto the
    // first `task` event with title='workflow:assist', then renders
    // each cumulative text update into the preview pane until the
    // POST resolves (or the user closes the modal).
    if (dom.wfAssistStreaming) {
      dom.wfAssistStreaming.hidden = false
      dom.wfAssistStreamingText.textContent = ''
      dom.wfAssistStreamingMeta.textContent = '等待 LLM 第一个 chunk…'
    }
    state.assistWatcher = {
      taskId: null,
      onTask: (taskId) => {
        if (dom.wfAssistStreamingMeta) {
          dom.wfAssistStreamingMeta.textContent = `task=${String(taskId).slice(0, 8)}…`
        }
      },
      onChunk: (text, meta) => {
        if (!dom.wfAssistStreamingText) return
        dom.wfAssistStreamingText.textContent = text
        // Keep the latest characters in view as text grows.
        dom.wfAssistStreamingText.scrollTop = dom.wfAssistStreamingText.scrollHeight
        if (dom.wfAssistStreamingMeta && meta) {
          const tools = meta.toolUses ? ` · 🔧 ${meta.toolUses}` : ''
          dom.wfAssistStreamingMeta.textContent =
            (meta.isDone ? '✓ 流结束' : '● 生成中') + ` · ${text.length} chars${tools}`
        }
      },
      onEnd: () => {
        if (dom.wfAssistStreamingMeta) {
          dom.wfAssistStreamingMeta.textContent = '✓ 流结束 — 等待 schema 校验 + 深度检查…'
        }
      },
    }

    try {
      // 把当前 hub 已有的 agents + workflow ids 当 contextHints — 让 LLM
      // 用真名而不是编名字。MCP servers 暂不喂(admin UI 没有 /api 暴露)。
      const contextHints = {}
      if (Array.isArray(ma?.agents) && ma.agents.length > 0) {
        contextHints.agents = ma.agents.map((a) => {
          const entry = { id: a.id, capabilities: a.capabilities || [] }
          if (a.description) entry.description = a.description
          return entry
        })
      }
      if (Array.isArray(wf?.workflows) && wf.workflows.length > 0) {
        contextHints.existingWorkflowIds = wf.workflows.map((w) => w.id)
      }

      const body = { description }
      if (Object.keys(contextHints).length > 0) body.contextHints = contextHints

      const r = await fetch('/api/admin/workflows/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await r.json().catch(() => ({}))
      if (r.status === 503) {
        dom.wfAssistMsg.textContent =
          'AI 助手未启用 — 设置 AIPE_ASSISTANT_PROVIDER + 对应 API key 后重启 host'
        dom.wfAssistMsg.classList.add('err')
        return
      }
      if (!r.ok) {
        dom.wfAssistMsg.textContent = '生成失败:' + (json.error || `HTTP ${r.status}`)
        dom.wfAssistMsg.classList.add('err')
        return
      }
      dom.wfAssistMsg.textContent = ''
      renderAssistResult(json)
    } catch (err) {
      dom.wfAssistMsg.textContent = '生成失败:' + (err.message || String(err))
      dom.wfAssistMsg.classList.add('err')
    } finally {
      dom.wfAssistGenerate.disabled = false
      dom.wfAssistGenerate.textContent = '生成草稿'
      // Tear down the streaming watcher + collapse the live preview.
      // The result panel (with final yaml + deep-check) is now the
      // canonical view — the streaming pane was only useful while
      // the LLM was producing chunks.
      state.assistWatcher = null
      if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
    }
  }

  function renderAssistResult(result) {
    dom.wfAssistResult.hidden = false
    renderAssistStatusChip(result.draftStatus, result.deepCheck)
    dom.wfAssistExplanation.textContent = result.explanation || ''
    dom.wfAssistYaml.textContent = result.yaml || '(空 — LLM 没生成 YAML fence)'
    if (result.draftStatus === 'invalid' && result.validationError) {
      dom.wfAssistErrorDetails.hidden = false
      dom.wfAssistValidationError.textContent = result.validationError
    } else {
      dom.wfAssistErrorDetails.hidden = true
      dom.wfAssistValidationError.textContent = ''
    }
    // Phase 13 M4 — render deep-check warnings (or pass note) below the
    // YAML preview. Save is still allowed when deepCheck.ok=false (admin
    // decides), so we only gate the save button on draftStatus.
    renderAssistDeepCheck(result.deepCheck)
    // 仅当 schema 合法时才允许 "保存为工作流" — 把 yaml 缓存在 button
    // 的 dataset 上,save 时直接读。
    if (result.draftStatus === 'valid' && result.yaml) {
      dom.wfAssistSave.disabled = false
      dom.wfAssistSave.dataset.yaml = result.yaml
    } else {
      dom.wfAssistSave.disabled = true
      delete dom.wfAssistSave.dataset.yaml
    }
  }

  async function saveAssistedWorkflow() {
    const yaml = dom.wfAssistSave.dataset.yaml
    if (!yaml) return
    dom.wfAssistMsg.textContent = '保存中…'
    dom.wfAssistMsg.classList.remove('ok', 'err')
    try {
      // 走现有 /import route — 同一段 schema 验证 + 落盘 + register
      // 在 hub。导入失败(例如 id 冲突)会把错误回显在同一个 msg 区。
      const r = await fetch('/api/admin/workflows/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: yaml,
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        dom.wfAssistMsg.textContent = '保存失败:' + (body.error || `HTTP ${r.status}`)
        dom.wfAssistMsg.classList.add('err')
        return
      }
      const id = body.workflow?.id || '?'
      dom.wfAssistMsg.textContent = `已保存 workflow ${id}`
      dom.wfAssistMsg.classList.add('ok')
      await refreshWorkflows()
      setTimeout(closeWorkflowAssistModal, 900)
    } catch (err) {
      dom.wfAssistMsg.textContent = '保存失败:' + (err.message || String(err))
      dom.wfAssistMsg.classList.add('err')
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
  const TABS = ['overview', 'agents', 'workflows', 'tasks', 'activity', 'services', 'users']

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
    // Workflows tab carries the growth-reports panel too — refresh
    // when the user lands on the tab so an upload from the
    // synthesist mid-session shows up without needing the manual
    // refresh button.
    if (name === 'workflows') {
      refreshGrowthReports().catch(() => {})
    }
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
    dom.wfStartSubmit?.addEventListener('click', submitWorkflowStart)
    dom.bundleImportBtn?.addEventListener('click', openBundleImportModal)
    dom.bundleImportSubmit?.addEventListener('click', submitBundleImport)
    // Phase 13 M3 — AI assistant dialog
    dom.wfAssistBtn?.addEventListener('click', openWorkflowAssistModal)
    dom.wfAssistGenerate?.addEventListener('click', submitWorkflowAssist)
    dom.wfAssistRegenerate?.addEventListener('click', submitWorkflowAssist)
    dom.wfAssistSave?.addEventListener('click', saveAssistedWorkflow)
    // "Use built-in template" button — fetches the embedded
    // personal-growth bundle yaml from the static-asset path
    // (web build embeds it under /builtin-bundles/). Pre-populates
    // the textarea so the user can review before submitting.
    dom.bundleBuiltinPgBtn?.addEventListener('click', async () => {
      try {
        const r = await fetch('/builtin-bundles/personal-growth.yaml')
        if (!r.ok) {
          dom.bundleImportMsg.textContent = `加载内置模板失败:HTTP ${r.status}`
          dom.bundleImportMsg.classList.add('err')
          return
        }
        const text = await r.text()
        dom.bundleImportText.value = text
        dom.bundleImportFile.value = ''
        // Trigger the same sniff that the input handler does, so the
        // key label updates to "DeepSeek API key".
        const label = sniffApiKeyLabel(text)
        if (label && dom.bundleKeyLabel) {
          dom.bundleKeyLabel.textContent = `${label} API key (optional)`
        }
        dom.bundleImportMsg.textContent = '已加载个人成长 bundle。粘贴 DeepSeek key 后点"导入"。'
        dom.bundleImportMsg.classList.remove('err')
        dom.bundleImportMsg.classList.add('ok')
      } catch (err) {
        dom.bundleImportMsg.textContent = '加载内置模板失败:' + (err.message || String(err))
        dom.bundleImportMsg.classList.add('err')
      }
    })
    // Sniff the pasted/uploaded bundle for an `apiKeyPrompt.label` and
    // relabel the key input — "DeepSeek API key" reads less generic
    // than just "API key" and helps confirm the right key.
    const onBundleTextChange = () => {
      const label = sniffApiKeyLabel(dom.bundleImportText?.value || '')
      if (label && dom.bundleKeyLabel) {
        dom.bundleKeyLabel.textContent = `${label} API key (optional)`
      } else if (dom.bundleKeyLabel) {
        dom.bundleKeyLabel.textContent = 'API key (optional)'
      }
    }
    dom.bundleImportText?.addEventListener('input', onBundleTextChange)
    dom.bundleImportFile?.addEventListener('change', async () => {
      const f = dom.bundleImportFile.files?.[0]
      if (!f) return
      // Preload the textarea so the user can review before submitting.
      dom.bundleImportText.value = await f.text()
      onBundleTextChange()
    })
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
        if (dom.wfAssistModal && !dom.wfAssistModal.hidden) closeWorkflowAssistModal()
        if (dom.wfRunsModal && !dom.wfRunsModal.hidden) closeWorkflowRunsModal()
        if (dom.bundleImportModal && !dom.bundleImportModal.hidden) closeBundleImportModal()
        if (dom.wfStartModal && !dom.wfStartModal.hidden) closeWorkflowStart()
        if (dom.grReportModal && !dom.grReportModal.hidden) closeGrowthReport()
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
      } else if (act === 'start-workflow') {
        openWorkflowStart(id)
      } else if (act === 'view-growth-report') {
        const reportPath = actEl?.dataset?.path
        const when = actEl?.dataset?.when || ''
        if (reportPath) openGrowthReport(reportPath, when)
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
      if (dom.bundleImportModal && !dom.bundleImportModal.hidden) closeBundleImportModal()
      if (dom.wfStartModal && !dom.wfStartModal.hidden) closeWorkflowStart()
      if (dom.grReportModal && !dom.grReportModal.hidden) closeGrowthReport()
    })
    // First-visit disclaimer. localStorage flag is per-browser, so a
    // user who clears storage or visits from a different machine sees
    // it again — intentional. Failures (private browsing without
    // storage permission) just skip the modal silently.
    try {
      if (dom.disclaimerModal && !localStorage.getItem('aipehub_disclaimer_v1')) {
        dom.disclaimerModal.hidden = false
      }
    } catch (err) {
      console.debug('disclaimer storage check failed:', err)
    }
    dom.disclaimerAccept?.addEventListener('click', () => {
      try { localStorage.setItem('aipehub_disclaimer_v1', String(Date.now())) } catch {}
      if (dom.disclaimerModal) dom.disclaimerModal.hidden = true
    })

    refreshManagedAgents().catch((err) => console.warn('initial agents refresh:', err))
    refreshWorkflows().catch((err) => console.warn('initial workflows refresh:', err))
    refreshGrowthReports().catch((err) => console.warn('initial growth-reports refresh:', err))
    if (dom.grRefreshBtn) {
      dom.grRefreshBtn.addEventListener('click', () => {
        refreshGrowthReports().catch((err) => console.warn('manual growth-reports refresh:', err))
      })
    }

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
        } else if (act === 'submit-agent-question') {
          await submitAgentQuestion(id)
        } else if (act === 'skip-agent-question') {
          await skipAgentQuestion(id)
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
