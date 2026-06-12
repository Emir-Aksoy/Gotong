/* AipeHub — admin console (v2.0, file-first).
 *
 * All admin endpoints require the cookie minted by /admin?token=…
 * (or `Authorization: Bearer …`). No browser caches.
 *
 * SOURCE MODULE — bundled into static/admin.js by
 * scripts/build-admin-ui.mjs (esbuild, IIFE format). Edit code here,
 * never the generated static/admin.js. Phase 2 (P3 admin.js split)
 * will break the sections below out into sibling ES modules that this
 * entry imports; for now it stays a single file so the bundler wiring
 * lands with zero behavior change.
 */
import { createServices } from './services.js'
import { createMcp } from './mcp.js'
import { createManagedAgents } from './managed-agents.js'
import { createWorkflows } from './workflows.js'

(() => {
  const { $, t, applyStaticI18n, onLangChange, escapeHtml, summarize, isBadResult,
          fetchJson, connectStream, syncLangFromConfig, formatBytes,
          fetchLeaderboard, renderLeaderboard, taskMetricsHtml, formatScore,
          attachContribToggle, applyContribToggleState, attachCapChips,
          gotoTab } = window.AipeHub

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
  // Hub Services tab lives in admin-src/services.js (P3 Phase 2, first
  // ES-module split). The factory closes over `ma` so it probes the same
  // managed-agent list the Agents tab populates. Created once; init and
  // applyEvent call the returned entry points (services.refreshServices etc).
  const services = createServices(ma)
  // MCP integration tab lives in admin-src/mcp.js (#2-M4). Self-contained
  // — list / install / uninstall against /api/admin/mcp-servers, no shared
  // state beyond window.AipeHub helpers. Lazy-loaded on first tab focus.
  const mcp = createMcp()
  // Managed Agents tab lives in admin-src/managed-agents.js (P3 Phase 2,
  // second ES-module split). It drives the shared `dom` cache, so we hand
  // it the resolved `dom` via setDom() right after resolveDom(); the
  // empty-state onboarding button reuses the bundle-import flow that still
  // lives here, so openBundleImportModal is passed in. (openBundleImportModal
  // is a hoisted function declaration, defined below — available here.)
  const managedAgents = createManagedAgents({ ma, openBundleImportModal })
  // Workflows tab lives in admin-src/workflows.js (P3 Phase 2, third
  // ES-module split). Self-contained panel + import + run-history; closes
  // over the shared `wf` state and gets the resolved `dom` via setDom()
  // after resolveDom(). The workflow-start form + AI-assistant wrappers
  // stay in main.js (entangled with shared field/multimodal renderers and
  // wfAssist) — see the module header.
  const workflows = createWorkflows({ wf })

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
      maHeartbeatEnabled: $('ma-heartbeat-enabled'),
      maHeartbeatInterval: $('ma-heartbeat-interval'),
      maHeartbeatChecklist: $('ma-heartbeat-checklist'),
      maImportModal: $('ma-import-modal'),
      maImportFile: $('ma-import-file'),
      maImportText: $('ma-import-text'),
      maImportSubmit: $('ma-import-submit'),
      maImportMsg: $('ma-import-msg'),
      // v5 E4-M2 — agent access-control (resource RBAC grants) modal.
      maAccessModal: $('ma-access-modal'),
      maAccessTarget: $('ma-access-target'),
      maGrantsList: $('ma-grants-list'),
      maGrantsEmpty: $('ma-grants-empty'),
      maGrantsAdd: $('ma-grants-add'),
      maGrantUser: $('ma-grant-user'),
      maGrantPerm: $('ma-grant-perm'),
      maGrantsMsg: $('ma-grants-msg'),
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
      // Revision history / rollback modal (Phase 15)
      wfRevModal: $('wf-rev-modal'),
      wfRevTarget: $('wf-rev-target'),
      wfRevList: $('wf-rev-list'),
      wfRevEmpty: $('wf-rev-empty'),
      wfRevMsg: $('wf-rev-msg'),
      // Governance audit sub-section inside the revision modal (Phase 19 P2-M4)
      wfAuditAction: $('wf-audit-action'),
      wfAuditList: $('wf-audit-list'),
      wfAuditEmpty: $('wf-audit-empty'),
      wfAuditMsg: $('wf-audit-msg'),
      wfAuditExport: $('wf-audit-export'),
      wfAuditCsv: $('wf-audit-csv'),
      wfAuditJsonl: $('wf-audit-jsonl'),
      // Access-control (resource RBAC) sub-section in the revision modal (P2-M5c)
      wfGrantsList: $('wf-grants-list'),
      wfGrantsEmpty: $('wf-grants-empty'),
      wfGrantsAdd: $('wf-grants-add'),
      wfGrantUser: $('wf-grant-user'),
      wfGrantPerm: $('wf-grant-perm'),
      wfGrantsMsg: $('wf-grants-msg'),
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
        managedAgents.refreshManagedAgents().catch(() => {})
        // Workflow runners use id prefix `workflow:`; pull when one appears.
        if (typeof ev.data.id === 'string' && ev.data.id.startsWith('workflow:')) {
          workflows.refreshWorkflows().catch(() => {})
        }
        break
      case 'participant_left':
        state.participants = state.participants.filter((p) => p.id !== ev.data.id)
        managedAgents.refreshManagedAgents().catch(() => {})
        if (typeof ev.data.id === 'string' && ev.data.id.startsWith('workflow:')) {
          workflows.refreshWorkflows().catch(() => {})
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
        services.showServicesToast(t.servicesToastTrashed)
        if (document.body.dataset.activeTab === 'services') {
          services.refreshServices().catch((err) => console.warn('services refresh failed:', err))
        }
        break
      case 'service_purged':
        if (document.body.dataset.activeTab === 'services') {
          services.refreshServices().catch(() => {})
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
    managedAgents.renderManagedAgents()
    if (wf.available) workflows.renderWorkflows()
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
      // Stream G day-2 / H — warn at launch when a step leaves this hub. Split by
      // destination kind: a mesh peer hub may pause for inbox approval (if gated);
      // an external A2A agent has no approval gate and fires immediately.
      const xhubSteps = Array.isArray(w.crossHubSteps) ? w.crossHubSteps : []
      const peerDests = Array.from(
        new Set(xhubSteps.filter((s) => s.kind !== 'a2a').map((s) => s.peerLabel || s.peer)),
      )
      const a2aDests = Array.from(
        new Set(xhubSteps.filter((s) => s.kind === 'a2a').map((s) => s.peerLabel || s.peer)),
      )
      const xhub = peerDests.length || a2aDests.length
        ? `<br/><small class="wf-xhub-note">${escapeHtml(t.workflowCrossHubNote(peerDests, a2aDests))}</small>`
        : ''
      dom.wfStartDesc.innerHTML =
        (w.description
          ? `${escapeHtml(w.description)}<br/><small>派发能力:${cap}</small>`
          : `派发能力:${cap}`) + xhub
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
      await managedAgents.refreshManagedAgents().catch(() => {})
      await workflows.refreshWorkflows().catch(() => {})
      setTimeout(closeBundleImportModal, 1200)
    } catch (err) {
      dom.bundleImportMsg.textContent = '失败:' + (err.message || String(err))
      dom.bundleImportMsg.classList.add('err')
    }
  }

  // --- workflow AI assistant (Phase 13 M3 + M4 + streaming follow-up) ----
  // Implementation lives in admin-wf-assist.js (extracted as part of the
  // P3 audit cleanup). The factory is wired into our closure scope here
  // so it has access to dom / state / ma / wf without us re-declaring
  // any shared mutable state. The returned bag (open/close/submit/save)
  // is consumed by the event-listener block further down.
  const wfAssist = (window.AipeHub && window.AipeHub.installWorkflowAssist)
    ? window.AipeHub.installWorkflowAssist({
        dom,
        state,
        ma,
        wf,
        refreshWorkflows: () => workflows.refreshWorkflows(),
      })
    : null
  function openWorkflowAssistModal() { wfAssist?.open() }
  function closeWorkflowAssistModal() { wfAssist?.close() }
  function submitWorkflowAssist() { return wfAssist?.submit() }
  function saveAssistedWorkflow() { return wfAssist?.save() }

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
  // R14b — the SOLE tab router now lives in app.js (the SPA orchestrator):
  // it wires the tabbar clicks + the single hashchange listener and drives
  // setActiveTab, which toggles `.tab-hidden` / `.active` / <body
  // data-active-tab> and dispatches `aipehub:tabchange`. We used to run a
  // duplicate setActiveTab + hashchange here; both fired on every change
  // and raced (admin.js, loading later, even stomped C1 tabs back to
  // overview). This bundle now only LISTENS (see boot) and reuses app.js's
  // gotoTab (destructured off window.AipeHub) for cross-tab jumps.
  //
  // All sections stay in the DOM at all times — tab switches just flip the
  // `tab-hidden` class — so cross-tab interactions (clicking a task_result
  // row in Activity auto-fills the eval form in Tasks) keep working.

  const boot = async () => {
    resolveDom()
    // Hand the resolved DOM cache to the managed-agents + workflows
    // modules — their closures reference this `dom` for every
    // render/mutate after init.
    managedAgents.setDom(dom)
    workflows.setDom(dom)
    updateDispatchVisibility()

    // R14b — app.js owns the tabbar clicks + hashchange + setActiveTab and
    // dispatches `aipehub:tabchange`. We just subscribe and run the admin-
    // only per-tab side effect: refresh the growth-reports panel (which
    // lives under the Workflows tab) whenever the user lands there mid-
    // session — e.g. after the synthesist uploads a report. The initial
    // population on first load is covered by the unconditional
    // refreshGrowthReports() later in boot, so no deep-link catch-up needed.
    window.addEventListener('aipehub:tabchange', (e) => {
      if (e.detail?.name === 'workflows') refreshGrowthReports().catch(() => {})
      // MCP tab (#2-M4): lazy-refresh the registry list on every focus so
      // installs/uninstalls from another window get picked up.
      if (e.detail?.name === 'mcp') mcp.refreshMcp().catch((err) => console.warn('mcp refresh failed:', err))
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
    dom.maNewBtn?.addEventListener('click', () => managedAgents.openAgentForm('create'))
    // Provider switch — show/hide the openai-compatible-only fields live.
    dom.maProvider?.addEventListener('change', managedAgents.syncProviderDependentFields)
    dom.maImportBtn?.addEventListener('click', () => {
      // Close the dropdown after the user picks an import method.
      if (dom.maImportDropdown) dom.maImportDropdown.open = false
      managedAgents.openImportModal()
    })
    dom.maGhImportBtn?.addEventListener('click', () => {
      if (dom.maImportDropdown) dom.maImportDropdown.open = false
      managedAgents.openGithubImportModal()
    })
    dom.maKeysBtn?.addEventListener('click', managedAgents.openKeysModal)
    dom.maForm?.addEventListener('submit', managedAgents.submitAgentForm)
    dom.maImportSubmit?.addEventListener('click', managedAgents.submitImport)
    dom.maGhImportSubmit?.addEventListener('click', managedAgents.submitGithubImport)
    // Live-preview the resolved download URL as the user types or
    // flips the mirror source — so they can see whether the parser
    // recognized their URL before clicking "import".
    dom.maGhUrl?.addEventListener('input', managedAgents.updateGhResolved)
    dom.maGhSource?.addEventListener('change', managedAgents.updateGhResolved)
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
    dom.wfImportBtn?.addEventListener('click', workflows.openWorkflowImportModal)
    dom.wfImportSubmit?.addEventListener('click', workflows.submitWorkflowImport)
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
        if (!dom.maFormModal.hidden) managedAgents.closeAgentForm()
        if (!dom.maImportModal.hidden) managedAgents.closeImportModal()
        if (dom.maGhImportModal && !dom.maGhImportModal.hidden) managedAgents.closeGithubImportModal()
        if (!dom.maKeysModal.hidden) managedAgents.closeKeysModal()
        if (dom.maAccessModal && !dom.maAccessModal.hidden) managedAgents.closeAccessModal()
        if (dom.wfImportModal && !dom.wfImportModal.hidden) workflows.closeWorkflowImportModal()
        if (dom.wfAssistModal && !dom.wfAssistModal.hidden) closeWorkflowAssistModal()
        if (dom.wfRunsModal && !dom.wfRunsModal.hidden) workflows.closeWorkflowRunsModal()
        if (dom.wfRevModal && !dom.wfRevModal.hidden) workflows.closeWorkflowRevisionsModal()
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
          if (input instanceof HTMLInputElement) managedAgents.setProviderKey(provider, input)
        } else {
          managedAgents.removeProviderKey(provider)
        }
        return
      }
      // v5 E4-M2 — agent access-control grant mutations carry no data-id
      // (refresh/add use the modal's held agent id; remove rides data-user),
      // so handle them before the `!id` guard below that drops id-less acts.
      if (act === 'refresh-agent-grants') { managedAgents.refreshAgentGrants(); return }
      if (act === 'add-agent-grant') { managedAgents.addAgentGrant(); return }
      if (act === 'remove-agent-grant') {
        const userId = target.dataset.user
        if (userId) managedAgents.removeAgentGrant(userId)
        return
      }
      // Stream G day-5 — a cross-hub run step's "view peer trace" button carries
      // data-run-id + data-step-id (no data-id), so handle it before the `!id`
      // guard below. The output div is the button's sibling .wf-peer-tx-out.
      if (act === 'view-peer-transcript') {
        const runId = target.dataset.runId
        const stepId = target.dataset.stepId
        // PB — a parallel branch's button also carries data-branch-id; pass it
        // through so the per-branch route variant is hit (undefined ⇒ step-level).
        const branchId = target.dataset.branchId
        const outEl = target.parentElement
          ? target.parentElement.querySelector('.wf-peer-tx-out')
          : null
        if (runId && stepId && outEl) {
          workflows.viewPeerTranscript(
            runId,
            stepId,
            outEl,
            target instanceof HTMLButtonElement ? target : null,
            branchId,
          )
        }
        return
      }
      // Audit 2026-06 — these five acts carry no data-id (grants ride
      // data-user, the audit/grant refresh buttons use modal-held state,
      // growth reports ride data-path), so they must run before the `!id`
      // guard below. They previously sat after it and were unreachable.
      if (act === 'refresh-workflow-audit') { workflows.refreshWorkflowAudit(); return }
      if (act === 'refresh-workflow-grants') { workflows.refreshWorkflowGrants(); return }
      if (act === 'add-workflow-grant') { workflows.addWorkflowGrant(); return }
      if (act === 'remove-workflow-grant') {
        const userId = target.dataset.user
        if (userId) workflows.removeWorkflowGrant(userId)
        return
      }
      if (act === 'view-growth-report') {
        const reportPath = target.dataset.path
        const when = target.dataset.when || ''
        if (reportPath) openGrowthReport(reportPath, when)
        return
      }
      const id = target.dataset.id
      if (!act || !id) return
      if (act === 'edit-agent') {
        const a = ma.agents.find((x) => x.id === id)
        if (a) managedAgents.openAgentForm('edit', a)
      } else if (act === 'export-agent') {
        managedAgents.exportAgent(id)
      } else if (act === 'manage-agent-access') {
        managedAgents.openAccessModal(id)
      } else if (act === 'remove-agent') {
        managedAgents.removeAgent(id)
      } else if (act === 'remove-workflow') {
        workflows.removeWorkflow(id)
      } else if (act === 'open-workflow-runs') {
        workflows.openWorkflowRunsModal(id)
      } else if (act === 'open-workflow-run') {
        const runId = target.dataset.runId
        if (runId) workflows.openWorkflowRunDetail(runId)
      } else if (act === 'deprecate-workflow') {
        workflows.lifecycleAction(id, 'deprecate')
      } else if (act === 'republish-workflow') {
        workflows.lifecycleAction(id, 'publish')
      } else if (act === 'publish-workflow') {
        workflows.lifecycleAction(id, 'publish')
      } else if (act === 'submit-review-workflow') {
        workflows.lifecycleAction(id, 'review')
      } else if (act === 'back-to-draft-workflow') {
        workflows.lifecycleAction(id, 'draft')
      } else if (act === 'archive-workflow') {
        workflows.lifecycleAction(id, 'archive')
      } else if (act === 'open-workflow-revisions') {
        workflows.openWorkflowRevisionsModal(id)
      } else if (act === 'rollback-revision') {
        const rev = Number(target.dataset.rev)
        if (Number.isInteger(rev)) workflows.rollbackTo(id, rev)
      } else if (act === 'start-workflow') {
        openWorkflowStart(id)
      }
    })
    // ESC closes any open modal
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!dom.maFormModal.hidden) managedAgents.closeAgentForm()
      if (!dom.maImportModal.hidden) managedAgents.closeImportModal()
      if (dom.maGhImportModal && !dom.maGhImportModal.hidden) managedAgents.closeGithubImportModal()
      if (!dom.maKeysModal.hidden) managedAgents.closeKeysModal()
      if (dom.maAccessModal && !dom.maAccessModal.hidden) managedAgents.closeAccessModal()
      if (dom.wfImportModal && !dom.wfImportModal.hidden) workflows.closeWorkflowImportModal()
      if (dom.wfRunsModal && !dom.wfRunsModal.hidden) workflows.closeWorkflowRunsModal()
      if (dom.wfRevModal && !dom.wfRevModal.hidden) workflows.closeWorkflowRevisionsModal()
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

    managedAgents.refreshManagedAgents().catch((err) => console.warn('initial agents refresh:', err))
    workflows.refreshWorkflows().catch((err) => console.warn('initial workflows refresh:', err))
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
        services.refreshServices().catch((err) => console.warn('services tab load failed:', err))
      })
    })
    if (document.body.dataset.activeTab === 'services') {
      services.refreshServices().catch((err) => console.warn('services initial load failed:', err))
    }

    // MCP integration tab (#2-M4). Per-focus refresh rides the canonical
    // aipehub:tabchange listener above; here we wire the install form + the
    // stdio/remote field toggle once, set the initial field visibility, and
    // populate on a deep link straight into #mcp.
    const mcpForm = document.getElementById('mcp-form')
    if (mcpForm) mcpForm.addEventListener('submit', (e) => mcp.submitMcpForm(e))
    const mcpTransport = document.getElementById('mcp-transport')
    if (mcpTransport) mcpTransport.addEventListener('change', () => mcp.syncMcpTransportFields())
    mcp.syncMcpTransportFields()
    if (document.body.dataset.activeTab === 'mcp') {
      mcp.refreshMcp().catch((err) => console.warn('mcp initial load failed:', err))
    }

    const sweepBtn = document.getElementById('services-sweep-btn')
    if (sweepBtn) {
      sweepBtn.addEventListener('click', async () => {
        sweepBtn.disabled = true
        try {
          const r = await fetchJson('/api/admin/services/sweep', { method: 'POST' })
          services.showServicesToast(t.servicesSweepResult(r.scanned, r.purged))
          await services.refreshServices()
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
          services.renderServicesAudit()
        } catch (err) {
          console.warn('services audit refresh failed:', err)
        } finally {
          auditRefreshBtn.disabled = false
        }
      })
    }

    const detailClose = document.getElementById('services-detail-close')
    const detailBackdrop = document.getElementById('services-detail-modal')
    if (detailClose) detailClose.addEventListener('click', () => services.closeServicesDetail())
    if (detailBackdrop) {
      detailBackdrop.addEventListener('click', (e) => {
        if (e.target === detailBackdrop) services.closeServicesDetail()
      })
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && detailBackdrop && !detailBackdrop.hidden) services.closeServicesDetail()
    })

    connectStream(applyEvent)
  }

  // admin.js is injected dynamically by app.js (loadAdminBundles), which
  // runs from app.js's OWN DOMContentLoaded handler — i.e. AFTER the
  // document has already finished parsing. A bare
  // addEventListener('DOMContentLoaded', …) here registers a listener
  // for an event that already fired, so boot() would never run and the
  // whole admin console would stay non-interactive. Guard on readyState:
  // run immediately when the document is already parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot() })
  } else {
    void boot()
  }

})()
