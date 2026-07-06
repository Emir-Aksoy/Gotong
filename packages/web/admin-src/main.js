/* Gotong — admin console (v2.0, file-first).
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
          gotoTab } = window.Gotong

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
  // state beyond window.Gotong helpers. Lazy-loaded on first tab focus.
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
      maTestConn: $('ma-test-conn'),
      maTestMsg: $('ma-test-msg'),
      // ease-of-use ②TC — post-create quick-chat panel (lives in the agent modal)
      maQuickchat: $('ma-quickchat'),
      maQcInput: $('ma-qc-input'),
      maQcSend: $('ma-qc-send'),
      maQcDone: $('ma-qc-done'),
      maQcStatus: $('ma-qc-status'),
      maQcReply: $('ma-qc-reply'),
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
      // Workflow schedules (LIFE-L1-M3 —「定时」card)
      wfSchedCard: $('wf-sched-card'),
      wfSchedSummary: $('wf-sched-summary'),
      wfSchedList: $('wf-sched-list'),
      wfSchedSuggest: $('wf-sched-suggest'),
      wfSchedForm: $('wf-sched-form'),
      wfSchedWorkflow: $('wf-sched-workflow'),
      wfSchedUser: $('wf-sched-user'),
      wfSchedUserOptions: $('wf-sched-user-options'),
      wfSchedKind: $('wf-sched-kind'),
      wfSchedWeekday: $('wf-sched-weekday'),
      wfSchedWeekdayWrap: $('wf-sched-weekday-wrap'),
      wfSchedHourWrap: $('wf-sched-hour-wrap'),
      wfSchedMinutesWrap: $('wf-sched-minutes-wrap'),
      wfSchedHour: $('wf-sched-hour'),
      wfSchedMinutes: $('wf-sched-minutes'),
      wfSchedMsg: $('wf-sched-msg'),
      // Template acceptance (FDE-M2 —「验收」card)
      wfAcceptCard: $('wf-accept-card'),
      wfAcceptSummary: $('wf-accept-summary'),
      wfAcceptList: $('wf-accept-list'),
      wfAcceptMsg: $('wf-accept-msg'),
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
      // Template gallery — one-click install of shipped templates (G-M3)
      templateGalleryBtn: $('template-gallery-btn'),
      templateGalleryModal: $('template-gallery-modal'),
      templateGalleryList: $('template-gallery-list'),
      templateGalleryMsg: $('template-gallery-msg'),
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
      // workflow-architect ARCH-M4 — depth selector + inline diagram + explain
      // mode (the architect dialog: depth-adjustable prose + bound graph,
      // and "explain this workflow" from a card → explain mode).
      wfAssistTitle: $('wf-assist-title'),
      wfAssistHint: $('wf-assist-hint'),
      wfAssistDescRow: $('wf-assist-desc-row'),
      wfAssistDepthRow: $('wf-assist-depth-row'),
      wfAssistGraphWrap: $('wf-assist-graph-wrap'),
      wfAssistGraphBody: $('wf-assist-graph-body'),
      wfAssistGraphDownload: $('wf-assist-graph-download'),
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
      // Read-only flow chart (graph) modal (DAG-M4)
      wfGraphModal: $('wf-graph-modal'),
      wfGraphTarget: $('wf-graph-target'),
      wfGraphBody: $('wf-graph-body'),
      wfGraphMsg: $('wf-graph-msg'),
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
    badge.title = t.admAgentsWaiting(n)
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

  // ease-of-use ⑦-M1 — first-run "start here" coaching card (overview tab).
  //
  // Shown ONLY on a FRESH hub — no managed agents AND no workflows — and until
  // the operator dismisses it (localStorage). Its three CTAs OPEN THE SAME
  // modals the Agents / Workflows tabs already expose (the prefilled create-
  // agent form, the template gallery, the keys modal), so the card adds NO new
  // capability or route — pure launcher-layer nudge. The primary CTA opens the
  // REAL create-agent form (prefilled) rather than blind-POSTing a guessed
  // provider: openAgentForm('create') runs syncProviderSelect() which already
  // defaults the provider to a key-backed one, so the operator reviews + clicks
  // Save (= POST /api/admin/agents). Faithful to "框架只提议、人点一下执行" —
  // no auto-generated disk state, no "deleted but respawns on restart" trap.
  const START_HERE_DISMISS_KEY = 'gotong_start_here_dismissed'
  // Latches once the card is hidden for good (dismissed OR hub no longer fresh)
  // so we stop re-probing the three endpoints on every overview focus / lang
  // switch. A fresh, undismissed hub keeps re-rendering (cheap, rare) until it
  // gains its first agent/workflow or the operator dismisses.
  let startHereSettled = false

  function startHereDismissed() {
    try { return localStorage.getItem(START_HERE_DISMISS_KEY) === '1' } catch { return false }
  }

  async function renderStartHere() {
    const host = document.getElementById('start-here')
    if (!host) return
    if (startHereSettled) return
    if (startHereDismissed()) { host.hidden = true; startHereSettled = true; return }

    // Fresh = no managed agents AND no workflows. Probe both; if the agents
    // probe fails (e.g. a member who somehow ran this) we can't prove fresh →
    // leave hidden (better to under-show a nudge than nag an established hub).
    let managedCount = 0
    let workflowCount = 0
    try {
      const agentsResp = await fetchJson('/api/admin/agents')
      managedCount = (agentsResp?.agents || []).filter((a) => !!a.managed).length
    } catch { host.hidden = true; return }
    try {
      const r = await fetch('/api/admin/workflows')
      if (r.ok) {
        const body = await r.json()
        workflowCount = (body?.workflows || []).length
      }
      // 404/503 (host has no WorkflowSurface) → treat as 0 workflows.
    } catch { /* network error — treat as 0 */ }

    if (managedCount > 0 || workflowCount > 0) { host.hidden = true; startHereSettled = true; return }

    // Fresh hub. Is a model key configured? (Decorates step ③.) Best-effort —
    // any error just leaves the "configure key" button showing.
    let hasModelKey = false
    try {
      const s = await fetchJson('/api/admin/secrets')
      hasModelKey = Object.keys(s?.providers || {}).length > 0 ||
        Object.values(s?.env || {}).some(Boolean)
    } catch { /* leave hasModelKey false */ }

    // ⑨-M3 value-before-key: when no model key is configured, show two
    // zero-cloud-key paths UNDER the "configure key" button — (a) one-click
    // local Ollama (a real assistant, no key), injected async iff Ollama is
    // running, and (b) an honest scripted steward demo (always available).
    const step3 = hasModelKey
      ? `<span class="sh-done">${escapeHtml(t.startHereKeyDone)}</span>`
      : `<button type="button" class="sh-btn sh-btn-secondary" data-sh="key">${escapeHtml(t.startHereStep3Btn)}</button>
         <div class="sh-tryfree">
           <span class="sh-tryfree-label">${escapeHtml(t.startHereTryFreeLabel)}</span>
           <div id="sh-ollama-slot"></div>
           <button type="button" class="sh-btn sh-btn-ghost" data-sh="demo">${escapeHtml(t.startHereDemoBtn)}</button>
           <p class="sh-tryfree-help">${escapeHtml(t.startHereNoKeyHelp)}</p>
         </div>`

    host.innerHTML = `
      <div class="sh-head">
        <h2 class="sh-title">${escapeHtml(t.startHereTitle)}</h2>
        <button type="button" class="sh-dismiss" data-sh="dismiss">${escapeHtml(t.startHereDismiss)}</button>
      </div>
      <p class="sh-intro">${escapeHtml(t.startHereIntro)}</p>
      <div class="sh-steps">
        <div class="sh-step sh-step-primary">
          <h3>${escapeHtml(t.startHereStep1Title)}</h3>
          <p>${escapeHtml(t.startHereStep1Desc)}</p>
          <button type="button" class="sh-btn sh-btn-primary" data-sh="assistant">${escapeHtml(t.startHereStep1Btn)}</button>
        </div>
        <div class="sh-step">
          <h3>${escapeHtml(t.startHereStep2Title)}</h3>
          <p>${escapeHtml(t.startHereStep2Desc)}</p>
          <button type="button" class="sh-btn sh-btn-secondary" data-sh="template">${escapeHtml(t.startHereStep2Btn)}</button>
        </div>
        <div class="sh-step">
          <h3>${escapeHtml(t.startHereStep3Title)}</h3>
          <p>${escapeHtml(t.startHereStep3Desc)}</p>
          ${step3}
        </div>
      </div>`
    host.hidden = false
    if (!hasModelKey) injectOllamaOption(host).catch(() => {})
  }

  // ⑨-M3 value-before-key: probe a LOCALLY-installed Ollama straight from the
  // browser. Ollama's default CORS allows localhost/127.0.0.1 origins, and it
  // exposes an OpenAI-compatible endpoint at /v1 — so a fresh user with Ollama
  // can run a REAL assistant with zero cloud key. Best-effort: any failure
  // (not installed / blocked / slow) just leaves the scripted demo showing.
  let ollamaModel = ''
  async function probeOllama() {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1200)
    try {
      const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal })
      if (!r.ok) return { available: false, models: [] }
      const body = await r.json()
      const models = (body?.models || []).map((m) => m?.name).filter(Boolean)
      return { available: models.length > 0, models }
    } catch {
      return { available: false, models: [] }
    } finally {
      clearTimeout(timer)
    }
  }

  async function injectOllamaOption(host) {
    const slot = host.querySelector('#sh-ollama-slot')
    if (!slot) return
    const probe = await probeOllama()
    if (!probe.available) { ollamaModel = ''; return }
    ollamaModel = probe.models[0]
    slot.innerHTML =
      `<button type="button" class="sh-btn sh-btn-ollama" data-sh="ollama">${escapeHtml(t.startHereOllamaBtn)}</button>` +
      `<span class="sh-ollama-hint">${escapeHtml(t.startHereOllamaDetected(ollamaModel))}</span>`
  }

  // ⑨-M3 honest scripted demo: replays the steward (plain-language hub
  // management) flow WITHOUT any LLM call. The banner makes clear it's a
  // canned replay, not real AI output — value-before-key, honestly framed.
  function openDemoModal() {
    document.getElementById('sh-demo-overlay')?.remove()
    const overlay = document.createElement('div')
    overlay.id = 'sh-demo-overlay'
    overlay.className = 'sh-demo-overlay'
    overlay.innerHTML = `
      <div class="sh-demo-card" role="dialog" aria-modal="true">
        <div class="sh-demo-banner">${escapeHtml(t.startHereDemoBanner)}</div>
        <h3 class="sh-demo-title">${escapeHtml(t.startHereDemoTitle)}</h3>
        <div class="sh-demo-thread">
          <div class="sh-demo-msg sh-demo-user">${escapeHtml(t.startHereDemoUser)}</div>
          <div class="sh-demo-msg sh-demo-steward">
            <span class="sh-demo-tier">${escapeHtml(t.startHereDemoTier)}</span>
            <span>${escapeHtml(t.startHereDemoProposal)}</span>
          </div>
          <div class="sh-demo-done" hidden>${escapeHtml(t.startHereDemoDone)}</div>
        </div>
        <p class="sh-demo-cta" hidden>${escapeHtml(t.startHereDemoCta)}</p>
        <div class="sh-demo-actions">
          <button type="button" class="sh-btn sh-btn-primary" data-demo="approve">${escapeHtml(t.startHereDemoApprove)}</button>
          <button type="button" class="sh-btn sh-btn-ghost" data-demo="close">${escapeHtml(t.startHereDemoClose)}</button>
        </div>
      </div>`
    overlay.addEventListener('click', (ev) => {
      const tgt = ev.target instanceof HTMLElement ? ev.target : null
      if (!tgt) return
      if (tgt === overlay) { overlay.remove(); return } // click backdrop
      const act = tgt.closest('[data-demo]')?.getAttribute('data-demo')
      if (act === 'close') {
        overlay.remove()
      } else if (act === 'approve') {
        overlay.querySelector('.sh-demo-done')?.removeAttribute('hidden')
        overlay.querySelector('.sh-demo-cta')?.removeAttribute('hidden')
        overlay.querySelector('[data-demo="approve"]')?.remove()
      }
    })
    document.body.appendChild(overlay)
  }

  function onStartHereClick(e) {
    const btn = e.target instanceof HTMLElement ? e.target.closest('[data-sh]') : null
    if (!btn) return
    const action = btn.dataset.sh
    if (action === 'assistant') {
      // Open the REAL create-agent form, prefilled. openAgentForm('create')
      // runs dom.maForm.reset() + syncProviderSelect() synchronously, so we
      // can set field values right after — the provider dropdown is already
      // defaulted to a key-backed provider (zero provider/key drift). The user
      // reviews + clicks Save; nothing is written until then.
      managedAgents.openAgentForm('create')
      if (dom.maId) dom.maId.value = 'assistant'
      if (dom.maDisplayName) dom.maDisplayName.value = t.startHereAssistantName
      if (dom.maCaps) dom.maCaps.value = 'chat'
      if (dom.maSystem) dom.maSystem.value = t.startHereAssistantSystem
      dom.maDisplayName?.focus()
    } else if (action === 'template') {
      dom.templateGalleryBtn?.click()
    } else if (action === 'key') {
      dom.maKeysBtn?.click()
    } else if (action === 'ollama') {
      // Local Ollama detected — prefill the REAL create-agent form for an
      // openai-compatible agent pointed at Ollama's /v1 endpoint. Ollama
      // ignores the bearer, so a dummy apiKey satisfies the per-agent key
      // gate (agents-routes requires a non-empty key for openai-compatible).
      // Zero cloud key, zero host change. User reviews + clicks Save.
      managedAgents.openAgentForm('create')
      if (dom.maProvider) dom.maProvider.value = 'openai-compatible'
      managedAgents.syncProviderDependentFields() // reveal baseURL + label fields
      if (dom.maBaseUrl) dom.maBaseUrl.value = 'http://127.0.0.1:11434/v1'
      if (dom.maProviderLabel) dom.maProviderLabel.value = 'Ollama'
      if (dom.maModel) dom.maModel.value = ollamaModel || 'llama3'
      if (dom.maApiKey) dom.maApiKey.value = 'ollama'
      if (dom.maId) dom.maId.value = 'local-assistant'
      if (dom.maDisplayName) dom.maDisplayName.value = t.startHereOllamaName
      if (dom.maCaps) dom.maCaps.value = 'chat'
      if (dom.maSystem) dom.maSystem.value = t.startHereAssistantSystem
      dom.maDisplayName?.focus()
    } else if (action === 'demo') {
      openDemoModal()
    } else if (action === 'dismiss') {
      try { localStorage.setItem(START_HERE_DISMISS_KEY, '1') } catch {}
      renderStartHere().catch(() => {})
    }
  }

  // ===== ease-of-use ❷-M2 — "hub 体检" (health-check) overview panel =====
  // Complements #start-here: start-here shows on a FRESH hub (no agents/workflows)
  // to bootstrap the first one; once the hub HAS managed agents, THIS panel takes
  // over the same overview slot and answers "where is my hub red right now?"
  // without the admin hunting across the agents / MCP / setup tabs. It fetches the
  // read-only /api/admin/health snapshot (host-side STATIC aggregation — zero LLM
  // ping, never spends tokens on open) and renders red/yellow signal rows, each
  // with a jump-to-fix entry. The one ON-DEMAND live probe is the per-agent
  // 「测连接」button (reuses quick-chat via managedAgents.openAgentChat).
  let hubHealthBusy = false
  let lastHealthSnap = null
  // RES-M4 — live resource-adaptation proposals for the CURRENT agents, cached
  // alongside the health snapshot so a lang-change re-render (useCache) redraws
  // them without a second round-trip. null = not fetched / none.
  let lastAdaptations = null

  function hubHealthSignalRow(level, text, btnHtml) {
    return `<li class="hh-signal hh-${level}">
      <span class="hh-dot" aria-hidden="true"></span>
      <span class="hh-text">${escapeHtml(text)}</span>
      ${btnHtml || ''}
    </li>`
  }

  // EH-M1 — the single most-relevant "what should I configure next" suggestion.
  // Distinct from the red/yellow signals above (those are "something is wrong");
  // this is forward guidance (green/neutral) that fills the gap #start-here left
  // when it hid itself after the first agent. Returns ONE rung of the config
  // ladder, not a list — answers "next?" with a single clear action.
  //
  // workflowCount等 are OPTIONAL: absent = host didn't wire the workflow counts
  // (honest "unknown"), so we skip the whole workflow ladder rather than wrongly
  // suggest "build a workflow" when we simply can't see them.
  function hubHealthNextStep(snap) {
    if (typeof snap.workflowCount === 'number') {
      if (snap.workflowCount === 0) {
        return { text: t.healthNextNoWorkflow, cta: t.healthGoWorkflows, action: 'workflows' }
      }
      if ((snap.publishedWorkflowCount || 0) === 0) {
        return { text: t.healthNextNoPublished, cta: t.healthGoPublish, action: 'workflows' }
      }
      // Only assert "never run" when runCount is actually known.
      if (typeof snap.runCount === 'number' && snap.runCount === 0) {
        return { text: t.healthNextNoRun, cta: t.healthGoRun, action: 'workflows' }
      }
    }
    // Workflow ladder satisfied (or unseen) + zero MCP connectors → gently
    // suggest hooking a knowledge base. Lowest priority so it never crowds out
    // the workflow progression.
    if ((snap.mcpServers || []).length === 0) {
      return { text: t.healthNextNoMcp, cta: t.healthGoMcp, action: 'mcp' }
    }
    return null
  }

  function renderHubHealthHtml(snap) {
    const agents = snap.agents || []
    const mcp = snap.mcpServers || []
    const signals = []
    // RED — managed agents whose key does not resolve (the headline signal).
    for (const a of agents) {
      if (a.missingKey) {
        signals.push(hubHealthSignalRow('red',
          t.healthAgentMissingKey(a.id, a.provider),
          `<button type="button" class="hh-btn" data-hh="key">${escapeHtml(t.healthGoAddKey)}</button>`))
      }
    }
    // YELLOW — MCP servers configured but referenced by no agent ("installed,
    // unused"). Advisory, not an error — it just means a connector is idle.
    for (const m of mcp) {
      if (!m.wired) {
        signals.push(hubHealthSignalRow('yellow',
          t.healthMcpUnwired(m.name),
          `<button type="button" class="hh-btn" data-hh="mcp">${escapeHtml(t.healthGoMcp)}</button>`))
      }
    }
    // FDE-M1b — connector slots declared by installed packs that no MCP server
    // currently fulfils. Always YELLOW, even for required slots: red rows are
    // reserved for host-VERIFIED facts (a key that doesn't resolve, an
    // unwritable dir), while a slot is third-party template intent the hub
    // never verifies semantically — an imported manifest must not be able to
    // escalate the panel to red. Filled slots render nothing. Absent field
    // (host didn't wire the registry) → loop over [] → nothing, honestly.
    for (const s of snap.connectorSlots || []) {
      if (s.filled) continue
      const tag = s.optional ? ` (${t.healthSlotOptionalTag})` : ''
      signals.push(hubHealthSignalRow('yellow',
        t.healthSlotUnfilled(s.pack, s.id) + tag + (s.hint ? ` — ${s.hint}` : ''),
        `<button type="button" class="hh-btn" data-hh="mcp">${escapeHtml(t.healthGoMcp)}</button>`))
    }
    // RED (rare) — the host can no longer WRITE to its space dir (disk-full /
    // permission-drift early warning). Informational: the fix is host-side.
    if (snap.spaceWritable === false) {
      signals.push(hubHealthSignalRow('red', t.healthSpaceUnwritable(snap.spacePath || ''), ''))
    }

    const allGreen = signals.length === 0
    const head = `
      <div class="hh-head">
        <h2 class="hh-title">${escapeHtml(t.healthTitle)}</h2>
        <button type="button" class="hh-refresh" data-hh="refresh">${escapeHtml(t.healthRefresh)}</button>
      </div>
      <p class="hh-sub ${allGreen ? 'hh-ok' : 'hh-warn'}">${escapeHtml(allGreen ? t.healthAllGreen : t.healthHasIssues(signals.length))}</p>`
    const signalList = allGreen ? '' : `<ul class="hh-signals">${signals.join('')}</ul>`

    // EH-M1 — forward "what should I configure next" guidance. Shows
    // independently of the red/yellow signals (green/neutral styling), so even
    // an all-clear hub still gets nudged toward its next config rung.
    const next = hubHealthNextStep(snap)
    const nextHtml = next
      ? `<div class="hh-next">
          <span class="hh-next-label">${escapeHtml(t.healthNextLabel)}</span>
          <span class="hh-next-text">${escapeHtml(next.text)}</span>
          <button type="button" class="hh-btn hh-next-btn" data-hh="${escapeHtml(next.action)}">${escapeHtml(next.cta)}</button>
        </div>`
      : ''

    // Agent roster with a per-agent manual「测连接」. Online agents only — an
    // offline one isn't registered, so there's nothing to reach (its reason,
    // usually a missing key, is already a red signal above).
    const roster = `
      <div class="hh-roster">
        <h3 class="hh-roster-title">${escapeHtml(t.healthRosterTitle(snap.onlineCount || 0, snap.managedCount || 0))}</h3>
        <ul class="hh-agents">
          ${agents.map((a) => `
            <li class="hh-agent">
              <span class="hh-agent-dot ${a.online ? 'on' : 'off'}" aria-hidden="true"></span>
              <span class="hh-agent-id">${escapeHtml(a.id)}</span>
              <span class="hh-agent-provider">${escapeHtml(a.provider)}</span>
              ${a.online
                ? `<button type="button" class="hh-btn hh-test" data-hh="test" data-agent="${escapeHtml(a.id)}">${escapeHtml(t.healthTest)}</button>`
                : `<span class="hh-agent-offline">${escapeHtml(t.healthOffline)}</span>`}
            </li>`).join('')}
        </ul>
      </div>`
    return head + signalList + nextHtml + roster + renderHealthAdaptationsHtml(lastAdaptations)
  }

  // RES-M4 — the always-on plain-language entrance for resource adaptation. The
  // health panel already flags "agent X can't run (missing key)"; right here we
  // ALSO surface the one-click fixes RES-M2 proposes from THIS machine's probed
  // resources (a local Ollama/LM Studio endpoint, a keyed sibling provider), so
  // the operator fixes it exactly where the problem is shown. Only `applicable`
  // proposals get a button — advisory ones are already implied by the missing-
  // key signal + its 「去配密钥」 jump. Every apply still POSTs the human-approved
  // /api/admin/resources/adapt (server re-checks `applicable`; never silent).
  function renderHealthAdaptationsHtml(proposals) {
    const applicable = (proposals || []).filter((p) => p && p.applicable === true)
    if (!applicable.length) return ''
    const rows = applicable.map((p) => {
      const payload = encodeURIComponent(JSON.stringify(p))
      return `<li class="hh-adapt-row">
        <span class="hh-adapt-text">${escapeHtml(p.title || p.id || '')}</span>
        <button type="button" class="hh-btn" data-act="apply-adaptation" data-adapt="${payload}">${escapeHtml(t.resAdaptApply)}</button>
        <span class="tg-adapt-result" role="status"></span>
      </li>`
    }).join('')
    return `<div class="hh-adapt">
      <h3 class="hh-adapt-title">${escapeHtml(t.resAdaptPanelTitle)}</h3>
      <p class="hh-adapt-hint">${escapeHtml(t.resAdaptPanelHint)}</p>
      <ul class="hh-adapt-list">${rows}</ul>
    </div>`
  }

  // DEPLOY-B3 — the "IM 通道" status block on the admin 设置 page. Fed by the
  // SAME /api/admin/health snapshot the 体检 panel fetches (its optional
  // `imBridges` rows), but rendered into its own #im-status element so its
  // visibility is NOT tied to the 体检 panel's managedCount>0 gate — IM is
  // deployment state, meaningful even on a hub with zero agents. Honesty
  // ladder: snapshot has no imBridges field (host didn't wire the IM dep) →
  // hidden; `[]` → "未配置" hint; rows → platform + credential-source badges.
  function renderImStatus(snap) {
    const el = document.getElementById('im-status')
    if (!el) return
    const rows = snap?.imBridges
    if (!Array.isArray(rows)) { el.hidden = true; return }
    if (rows.length === 0) {
      el.innerHTML = `<h3 class="im-status-title">${escapeHtml(t.imStatusTitle)}</h3>
        <p class="im-status-none">${escapeHtml(t.imStatusNone)}</p>`
      el.hidden = false
      return
    }
    const items = rows.map((r) => {
      const src = r.source === 'vault' ? t.imSourceVault : r.source === 'env' ? t.imSourceEnv : ''
      return `<li class="im-status-row">
        <span class="im-status-dot" aria-hidden="true"></span>
        <span class="im-status-platform">${escapeHtml(r.platform || '')}</span>
        ${src ? `<span class="im-status-source">${escapeHtml(src)}</span>` : ''}
      </li>`
    }).join('')
    el.innerHTML = `<h3 class="im-status-title">${escapeHtml(t.imStatusTitle)}</h3>
      <ul class="im-status-list">${items}</ul>
      <p class="im-status-hint">${escapeHtml(t.imStatusHint)}</p>`
    el.hidden = false
  }

  async function renderHubHealth(opts = {}) {
    const host = document.getElementById('hub-health')
    if (!host) return
    if (hubHealthBusy) return
    // Lang change: re-render the cached snapshot with the new i18n strings — no
    // network round-trip. Falls through to a fetch if we have no cache yet.
    if (opts.useCache && lastHealthSnap) {
      renderImStatus(lastHealthSnap)
      if ((lastHealthSnap.managedCount || 0) === 0) { host.hidden = true; return }
      host.innerHTML = renderHubHealthHtml(lastHealthSnap)
      host.hidden = false
      return
    }
    hubHealthBusy = true
    try {
      let snap
      try {
        snap = await fetchJson('/api/admin/health')
      } catch {
        // 503 (host wired no health surface) / network — hide, never error the
        // page. The panel is advisory; its absence is silent. The IM block
        // rides the same surface, so it hides with it.
        host.hidden = true
        renderImStatus(null)
        return
      }
      lastHealthSnap = snap
      // DEPLOY-B3 — IM status renders from every successful snapshot, BEFORE
      // the fresh-hub gate below: a wizard-configured telegram bridge on a
      // zero-agent hub is exactly what the settings page must show.
      renderImStatus(snap)
      // A fresh hub (no managed agents) is #start-here's domain — stay hidden
      // there so the two cards never both show.
      if (!snap || (snap.managedCount || 0) === 0) { host.hidden = true; return }
      // RES-M4 — best-effort live adaptation proposals for the current agents
      // (read-only). 503 (surface unwired) / network → no adaptations section;
      // the health panel renders regardless.
      try {
        const a = await fetchJson('/api/admin/resources/adaptations')
        lastAdaptations = Array.isArray(a?.proposals) ? a.proposals : null
      } catch {
        lastAdaptations = null
      }
      host.innerHTML = renderHubHealthHtml(snap)
      host.hidden = false
    } finally {
      hubHealthBusy = false
    }
  }

  function onHubHealthClick(e) {
    const btn = e.target instanceof HTMLElement ? e.target.closest('[data-hh]') : null
    if (!btn) return
    const action = btn.dataset.hh
    if (action === 'key') {
      dom.maKeysBtn?.click() // same proven "API Key 管理" entry as #start-here
    } else if (action === 'mcp') {
      gotoTab('mcp')
    } else if (action === 'workflows') {
      gotoTab('workflows') // EH-M1 next-step CTAs (build / publish / run a workflow)
    } else if (action === 'test') {
      const id = btn.dataset.agent
      if (id) managedAgents.openAgentChat(id)
    } else if (action === 'refresh') {
      renderHubHealth().catch(() => {})
    }
  }

  function renderGrowthReports(reports) {
    if (!dom.grTbody) return
    if (dom.grSummary) {
      dom.grSummary.textContent = reports.length === 0
        ? ''
        : t.admReportsCount(reports.length)
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
                  data-when="${escapeHtml(when)}">${t.admView}</button>
          <a class="ma-btn ma-btn-secondary" href="${escapeHtml(dlHref)}" download>${t.admDownload}</a>
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
    dom.grReportTitle.textContent = t.admGrowthReportTitle(when)
    dom.grReportDownload.href = '/api/admin/growth-reports/download?path=' + encodeURIComponent(path)
    dom.grReportBody.innerHTML = `<p class="hint">${escapeHtml(t.admLoading)}</p>`
    dom.grReportModal.hidden = false
    try {
      const r = await fetch('/api/admin/growth-reports/download?path=' + encodeURIComponent(path))
      if (!r.ok) {
        dom.grReportBody.innerHTML = `<p class="hint">${escapeHtml(t.admLoadFailedHttp(r.status))}</p>`
        return
      }
      const text = await r.text()
      dom.grReportBody.innerHTML = renderMarkdown(text)
    } catch (err) {
      dom.grReportBody.innerHTML = `<p class="hint">${escapeHtml(t.admLoadFailedErr(err.message || String(err)))}</p>`
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
          ? `${escapeHtml(w.description)}<br/><small>${t.admDispatchCap(cap)}</small>`
          : t.admDispatchCap(cap)) + xhub
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
        <small class="hint">${escapeHtml(t.admNoPayloadSchema)}</small>
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
          `<strong>${escapeHtml(t.admAgentAsksMore(fromAgent, qs.length))}</strong>` +
          (ctx ? `<p class="aq-context">${escapeHtml(ctx)}</p>` : '') +
        `</div>` +
        `<div class="aq-fields">${fields}</div>` +
        `<div class="aq-actions">` +
          `<button class="primary" data-act="submit-agent-question" data-id="${escapeHtml(v.id)}">${escapeHtml(t.admSubmitAnswer)}</button>` +
          `<button class="secondary" data-act="skip-agent-question" data-id="${escapeHtml(v.id)}" title="${escapeHtml(t.admSkipTitle)}">${escapeHtml(t.admSkip)}</button>` +
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
    setMsg(t.admSubmitting)

    const view = state.tasks.find((x) => x.id === taskId)
    const qs = view?.task?.payload?.questions || []
    const answers = {}
    for (const q of qs) {
      const el = card.querySelector(`[data-aq-fid="${cssEscape(q.id)}"]`)
      if (!el) continue
      const v = el.value
      if (q.required && (v == null || String(v).trim() === '')) {
        setMsg(t.admFieldRequired(q.label), 'err')
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
      setMsg(t.admSubmittedAgent, 'ok')
    } catch (err) {
      setMsg(t.admSubmitFailedErr(err.message || String(err)), 'err')
    }
  }

  async function skipAgentQuestion(taskId) {
    // Skip = reject the task. The agent's nested dispatch resolves
    // with kind='failed', the agent's HITL branch sees the failure
    // and falls back to its first-round output.
    const card = document.querySelector(`.agent-question-form[data-aq-id="${cssEscape(taskId)}"]`)
    const msg = card?.querySelector(`[data-aq-msg="${cssEscape(taskId)}"]`)
    if (msg) { msg.textContent = t.admSkipping; msg.className = 'aq-msg' }
    try {
      await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'admin skipped' }),
      })
      if (msg) { msg.textContent = t.admSkipped; msg.className = 'aq-msg ok' }
    } catch (err) {
      if (msg) { msg.textContent = t.admSkipFailedErr(err.message || String(err)); msg.className = 'aq-msg err' }
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
  // structural (no schema dep on @gotong/llm here) — we look for
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
      <small>${escapeHtml(t.admUnknownBlock(String(b && b.type) || 'unknown'))}</small>
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
      // `data-gotong-file` lets the submit handler find file inputs
      // without re-walking the schema. `gotong-file-status` shows
      // "上传中…" / "已上传 (123 KB)" inline so the admin gets feedback
      // before the workflow dispatch fires.
      const accept = Array.isArray(f.accept) && f.accept.length > 0
        ? ` accept="${escapeHtml(f.accept.join(','))}"`
        : ''
      const sizeHint = typeof f.maxSizeMb === 'number'
        ? `<small class="hint">${escapeHtml(t.admMaxSize(f.maxSizeMb))}</small>`
        : ''
      control = `<input type="file" id="${id}" data-gotong-file="1"${accept} />
        <span class="gotong-file-status" data-gotong-file-status="${id}" style="font-size:0.85em;color:#666;margin-left:0.5em;"></span>
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
              dom.wfStartMsg.textContent = t.admFieldRequired(f.label)
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
            dom.wfStartMsg.textContent = t.admFileTooLarge(f.label, capMb)
            dom.wfStartMsg.classList.add('err')
            return
          }
          const statusEl = document.querySelector(
            `[data-gotong-file-status="wf-start-field-${cssEscape(f.id)}"]`,
          )
          if (statusEl) statusEl.textContent = t.admUploading
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
                  `<span>${escapeHtml(t.admUploaded(formatBytes(ref.size)))}</span> ` +
                  `<img src="${escapeHtml(url)}" alt="preview" ` +
                  `style="max-height:32px;max-width:80px;vertical-align:middle;border-radius:2px;margin-left:0.4em;" />`
              } else if (ref.mime && ref.mime.startsWith('audio/')) {
                const url = `/api/admin/uploads?id=${encodeURIComponent(ref.artifactId)}`
                statusEl.innerHTML =
                  `<span>${escapeHtml(t.admUploaded(formatBytes(ref.size)))}</span> ` +
                  `<audio controls src="${escapeHtml(url)}" ` +
                  `style="height:24px;max-width:140px;vertical-align:middle;margin-left:0.4em;"></audio>`
              } else {
                statusEl.textContent = t.admUploaded(formatBytes(ref.size))
              }
            }
            payload[f.id] = { type: 'file_ref', artifactId: ref.artifactId, mime: ref.mime }
          } catch (err) {
            const msg = err && err.message ? err.message : String(err)
            if (statusEl) {
              statusEl.textContent = t.admUploadFailedMsg(msg)
              statusEl.style.color = '#c33'
            }
            dom.wfStartMsg.textContent = t.admFieldUploadFailed(f.label, msg)
            dom.wfStartMsg.classList.add('err')
            return
          }
          continue
        }
        let v = el.value
        if (f.required && (v == null || v.trim() === '')) {
          dom.wfStartMsg.textContent = t.admFieldRequired(f.label)
          dom.wfStartMsg.classList.add('err')
          return
        }
        if (v === '') continue  // skip empty optional fields
        if (f.type === 'number') {
          const n = Number(v)
          if (!Number.isFinite(n)) {
            dom.wfStartMsg.textContent = t.admFieldMustBeNumber(f.label)
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
        dom.wfStartMsg.textContent = t.admPayloadJsonInvalid(err.message || String(err))
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
        dom.wfStartMsg.textContent = t.admFailedReason(body.error || t.admHttp(r.status))
        dom.wfStartMsg.classList.add('err')
        return
      }
      dom.wfStartMsg.textContent = t.admDispatched
      dom.wfStartMsg.classList.add('ok')
      setTimeout(closeWorkflowStart, 1500)
    } catch (err) {
      dom.wfStartMsg.textContent = t.admFailedReason(err.message || String(err))
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
      dom.bundleImportMsg.textContent = t.admBundleNeeded
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
        dom.bundleImportMsg.textContent = t.admFailedReason(body.error || t.admHttp(r.status))
        dom.bundleImportMsg.classList.add('err')
        return
      }
      // Build a human summary: N created, M skipped, workflow id if loaded
      const createdN = body.team?.created?.length ?? 0
      const skippedN = body.team?.skipped?.length ?? 0
      const wfId = body.workflow?.id
      const parts = []
      if (createdN > 0) parts.push(t.admCreatedAgents(createdN))
      if (skippedN > 0) parts.push(t.admSkippedAgents(skippedN))
      if (wfId) parts.push(t.admWorkflowRegistered(wfId))
      if (body.workflowError) parts.push(t.admWorkflowWarning(body.workflowError))
      if (body.team?.spawnErrors?.length) {
        parts.push(t.admSpawnFailed(body.team.spawnErrors.length))
      }
      dom.bundleImportMsg.textContent = t.admImportDone + parts.join(t.admListSep)
      dom.bundleImportMsg.classList.add('ok')
      await managedAgents.refreshManagedAgents().catch(() => {})
      await workflows.refreshWorkflows().catch(() => {})
      setTimeout(closeBundleImportModal, 1200)
    } catch (err) {
      dom.bundleImportMsg.textContent = t.admFailedReason(err.message || String(err))
      dom.bundleImportMsg.classList.add('err')
    }
  }

  // --- template gallery (G-M3) -------------------------------------------
  // One-click install of the templates the host embeds. The gallery fetches
  // lean install previews from GET /api/admin/templates/catalog (projected
  // server-side through the SAME parseTemplate the install runs, so the
  // preview can't drift from what lands), and on "install" pulls the raw
  // yaml from GET .../catalog/:id and POSTs it to /api/admin/templates/import
  // — the exact route the bundle/manual import already uses. Knowledge
  // CONTENT never rides along (decision #4): the importer wires their own KB
  // to each reported slot afterwards.

  // The embedded catalog is static, so we load it once and keep whatever was
  // rendered (incl. per-card install results) across re-opens.
  let galleryLoaded = false

  async function openTemplateGalleryModal() {
    if (!dom?.templateGalleryModal) return
    if (dom.templateGalleryMsg) {
      dom.templateGalleryMsg.textContent = ''
      dom.templateGalleryMsg.classList.remove('ok', 'err')
    }
    dom.templateGalleryModal.hidden = false
    if (galleryLoaded) return
    if (dom.templateGalleryList) {
      dom.templateGalleryList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    }
    try {
      const r = await fetch('/api/admin/templates/catalog')
      if (!r.ok) {
        if (dom.templateGalleryList) dom.templateGalleryList.innerHTML = ''
        if (dom.templateGalleryMsg) {
          dom.templateGalleryMsg.textContent = t.admFailedReason(t.admHttp(r.status))
          dom.templateGalleryMsg.classList.add('err')
        }
        return
      }
      const body = await r.json()
      renderTemplateGallery(body.templates || [])
      galleryLoaded = true
    } catch (err) {
      if (dom.templateGalleryList) dom.templateGalleryList.innerHTML = ''
      if (dom.templateGalleryMsg) {
        dom.templateGalleryMsg.textContent = t.admFailedReason(err.message || String(err))
        dom.templateGalleryMsg.classList.add('err')
      }
    }
  }

  function closeTemplateGalleryModal() {
    if (dom?.templateGalleryModal) dom.templateGalleryModal.hidden = true
  }

  function renderTemplateGallery(templates) {
    if (!dom?.templateGalleryList) return
    if (!templates.length) {
      dom.templateGalleryList.innerHTML = `<p class="hint">${escapeHtml(t.templateGalleryEmpty)}</p>`
      return
    }
    dom.templateGalleryList.innerHTML = templates
      .map((tpl) => {
        const counts = [
          t.templateGalleryCountAgents(tpl.agents?.length || 0),
          t.templateGalleryCountWorkflows(tpl.workflows?.length || 0),
          t.templateGalleryCountKbs(tpl.knowledgeBases?.length || 0),
        ]
        const apiHint = tpl.apiKeyPrompt
          ? `<span class="tg-chip tg-chip-api">${escapeHtml(t.templateGalleryNeedsKey(tpl.apiKeyPrompt.label || tpl.apiKeyPrompt.provider))}</span>`
          : ''
        return (
          `<div class="tg-card">` +
            `<div class="tg-card-head">` +
              `<h4 class="tg-card-name">${escapeHtml(tpl.name)}</h4>` +
              `<button class="ma-btn tg-install-btn" data-act="install-template" data-id="${escapeHtml(tpl.id)}">${escapeHtml(t.templateGalleryInstall)}</button>` +
            `</div>` +
            (tpl.description ? `<p class="tg-card-desc">${escapeHtml(tpl.description)}</p>` : '') +
            `<div class="tg-card-counts">${counts.map((c) => `<span class="tg-chip">${escapeHtml(c)}</span>`).join('')}${apiHint}</div>` +
            `<div class="tg-card-result" data-tg-result="${escapeHtml(tpl.id)}"></div>` +
          `</div>`
        )
      })
      .join('')
  }

  async function installTemplate(id) {
    const card = dom.templateGalleryList?.querySelector(`[data-tg-result="${cssEscape(id)}"]`)
    const btn = dom.templateGalleryList?.querySelector(
      `[data-act="install-template"][data-id="${cssEscape(id)}"]`,
    )
    const setResult = (msg, kind) => {
      if (!card) return
      card.textContent = msg
      card.classList.remove('ok', 'err')
      if (kind) card.classList.add(kind)
    }
    if (btn instanceof HTMLButtonElement) btn.disabled = true
    setResult(t.templateGalleryInstalling, null)
    try {
      // 1. pull the raw yaml for this catalog entry…
      const cr = await fetch(`/api/admin/templates/catalog/${encodeURIComponent(id)}`)
      if (!cr.ok) {
        setResult(t.admFailedReason(t.admHttp(cr.status)), 'err')
        return
      }
      const { yaml } = await cr.json()
      // 2. …and POST it to the existing template-import route.
      const ir = await fetch('/api/admin/templates/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: yaml }),
      })
      const ib = await ir.json().catch(() => ({}))
      if (!ir.ok) {
        setResult(t.admFailedReason(ib.error || t.admHttp(ir.status)), 'err')
        return
      }
      // Human summary: N created / M skipped / W workflows / K KB slots.
      const createdN = ib.team?.created?.length ?? 0
      const skippedN = ib.team?.skipped?.length ?? 0
      const wfOk = (ib.workflows || []).filter((w) => w.ok).length
      const kbN = ib.knowledgeBases?.length ?? 0
      const parts = []
      if (createdN > 0) parts.push(t.admCreatedAgents(createdN))
      if (skippedN > 0) parts.push(t.admSkippedAgents(skippedN))
      if (wfOk > 0) parts.push(t.templateGalleryWorkflowsLanded(wfOk))
      if (kbN > 0) parts.push(t.templateGalleryKbSlots(kbN))
      if (ib.team?.spawnErrors?.length) parts.push(t.admSpawnFailed(ib.team.spawnErrors.length))
      const summary = t.admImportDone + parts.join(t.admListSep)
      // Last-mile checklist (ease-of-use ③-M1): KB slots still need wiring (we
      // never auto-wire — decision #4) and any created agent whose provider key
      // does not resolve yet. Render as a collapsible list below the summary.
      const checklist = ib.postInstallChecklist || {}
      const kbTodos = Array.isArray(checklist.kbSlotsToWire) ? checklist.kbSlotsToWire : []
      const keyTodos = Array.isArray(checklist.agentsMissingKey) ? checklist.agentsMissingKey : []
      // RES-M2/M3 — adaptation proposals: how to make a keyless agent run on THIS
      // machine's resources. `applicable` ones get a one-click apply button (the
      // click IS the human approval — nothing is applied silently); advisory ones
      // show a hint only (the fix is a human action outside the hub).
      const adaptTodos = Array.isArray(checklist.adaptations) ? checklist.adaptations : []
      if (card && (kbTodos.length || keyTodos.length || adaptTodos.length)) {
        // ⑧ — make each checklist row actionable: render a deep-link button next
        // to the text so the operator jumps straight to the panel that resolves
        // it (KB slot → MCP tab; missing key → API-key modal) instead of hunting
        // for it. The buttons carry data-act + no data-id, so the delegated click
        // handler dispatches them before its `!id` guard (see goto-mcp/goto-key).
        const rows = []
        for (const kb of kbTodos) {
          const text = kb.useMcpServer
            ? t.templateGalleryKbSlotTodoRef(kb.name, kb.useMcpServer)
            : t.templateGalleryKbSlotTodo(kb.name)
          rows.push(
            `<li>${escapeHtml(text)} ` +
              `<button type="button" class="tg-todo-fix" data-act="goto-mcp">${escapeHtml(t.templateGalleryTodoGotoMcp)}</button></li>`,
          )
        }
        for (const a of keyTodos) {
          rows.push(
            `<li>${escapeHtml(t.templateGalleryAgentNoKey(a.id, a.provider))} ` +
              `<button type="button" class="tg-todo-fix" data-act="goto-key">${escapeHtml(t.templateGalleryTodoGotoKey)}</button></li>`,
          )
        }
        // RES-M3 — one applicable adaptation → one apply button. The proposal
        // rides the button as a URI-encoded JSON payload (no data-id, so it
        // dispatches before the `!id` guard, like goto-mcp/goto-key). Advisory
        // proposals render as a hint with no button (never one-click, per the
        // human-approval invariant — they need a human action outside the hub).
        for (const p of adaptTodos) {
          if (!p || typeof p !== 'object') continue
          const title = escapeHtml(String(p.title || ''))
          if (p.applicable === true) {
            const payload = encodeURIComponent(JSON.stringify(p))
            rows.push(
              `<li>${title} ` +
                `<button type="button" class="tg-todo-fix" data-act="apply-adaptation" data-adapt="${payload}">${escapeHtml(t.resAdaptApply)}</button>` +
                `<span class="tg-adapt-result" role="status"></span></li>`,
            )
          } else {
            rows.push(`<li>${title} <em class="tg-adapt-manual">(${escapeHtml(t.resAdaptManual)})</em></li>`)
          }
        }
        card.className = 'tg-card-result ok'
        card.innerHTML =
          `<div class="tg-result-summary">${escapeHtml(summary)}</div>` +
          `<details class="tg-checklist" open>` +
          `<summary>${escapeHtml(t.templateGalleryChecklistTitle)}</summary>` +
          `<ul>${rows.join('')}</ul>` +
          `</details>`
      } else {
        setResult(summary, 'ok')
      }
      // Refresh the agents + workflows lists so the new arrivals show up.
      await managedAgents.refreshManagedAgents().catch(() => {})
      await workflows.refreshWorkflows().catch(() => {})
    } catch (err) {
      setResult(t.admFailedReason(err.message || String(err)), 'err')
    } finally {
      if (btn instanceof HTMLButtonElement) btn.disabled = false
    }
  }

  // RES-M3 — apply ONE adaptation proposal from a post-install checklist button.
  // The operator clicking this specific button IS the human approval; the write
  // funnels through POST /api/admin/resources/adapt (server re-checks applicable
  // and never applies silently). On success we disable the button so the same
  // proposal can't be double-applied and refresh the agents list.
  async function applyAdaptation(btn) {
    if (!(btn instanceof HTMLElement)) return
    let proposal
    try {
      proposal = JSON.parse(decodeURIComponent(btn.dataset.adapt || ''))
    } catch {
      return
    }
    const out = btn.parentElement?.querySelector('.tg-adapt-result')
    const say = (msg) => { if (out) out.textContent = ' ' + msg }
    if (btn instanceof HTMLButtonElement) btn.disabled = true
    say(t.resAdaptApplying)
    try {
      const r = await fetch('/api/admin/resources/adapt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposal }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        say(t.resAdaptFailed(j.error || t.admHttp(r.status)))
        if (btn instanceof HTMLButtonElement) btn.disabled = false
        return
      }
      say(t.resAdaptApplied(j.applied?.agentId || proposal.agentId || ''))
      await managedAgents.refreshManagedAgents().catch(() => {})
      // RES-M4 — when applied from the hub-health panel, refresh it too so the
      // resolved "agent can't run" signal clears in place (renderHubHealth is a
      // hoisted decl; no-op on a fresh hub / when the panel isn't mounted).
      renderHubHealth({}).catch(() => {})
    } catch (err) {
      say(t.resAdaptFailed(err.message || String(err)))
      if (btn instanceof HTMLButtonElement) btn.disabled = false
    }
  }

  // --- workflow AI assistant (Phase 13 M3 + M4 + streaming follow-up) ----
  // Implementation lives in admin-wf-assist.js (extracted as part of the
  // P3 audit cleanup). The factory is wired into our closure scope here
  // so it has access to dom / state / ma / wf without us re-declaring
  // any shared mutable state. The returned bag (open/close/submit/save)
  // is consumed by the event-listener block further down.
  // wfAssist is constructed in boot() AFTER resolveDom(), NOT here at module
  // init. The factory captures `dom` BY VALUE (admin-wf-assist.js does
  // `const { dom } = deps`) and dereferences it synchronously to wire the
  // depth-row click. At module-init `dom` is still null (resolveDom runs in
  // boot at ~2382), so constructing here would (a) crash on the null deref —
  // ARCH-M4b regression that killed the whole admin boot — and (b) freeze a
  // null dom into the modal's closures. Mirrors managedAgents/workflows
  // .setDom(dom), which likewise receive the resolved dom in boot. The
  // wrappers below tolerate wfAssist===null via optional chaining until then.
  let wfAssist = null
  function openWorkflowAssistModal() { wfAssist?.open() }
  function closeWorkflowAssistModal() { wfAssist?.close() }
  function submitWorkflowAssist() { return wfAssist?.submit() }
  function saveAssistedWorkflow() { return wfAssist?.save() }

  // workflow-architect ARCH-M4 — open the architect dialog in "explain" mode
  // for an EXISTING workflow: fetch its YAML, then let the user pick a depth
  // and have the architect narrate it (+ inline diagram). The architect never
  // regenerates the YAML in explain mode — it's the fixed subject.
  async function openWorkflowAssistExplain(id) {
    if (!wfAssist) return
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/source`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok || typeof j.yaml !== 'string') {
        alert((window.Gotong?.t?.wfaArchExplainLoadFailed || 'Failed to load workflow') + (j.error ? `: ${j.error}` : ''))
        return
      }
      wfAssist.open({ mode: 'explain', subjectYaml: j.yaml, subjectId: id })
    } catch (err) {
      alert((window.Gotong?.t?.wfaArchExplainLoadFailed || 'Failed to load workflow') + `: ${err.message || err}`)
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
  // R14b — the SOLE tab router now lives in app.js (the SPA orchestrator):
  // it wires the tabbar clicks + the single hashchange listener and drives
  // setActiveTab, which toggles `.tab-hidden` / `.active` / <body
  // data-active-tab> and dispatches `gotong:tabchange`. We used to run a
  // duplicate setActiveTab + hashchange here; both fired on every change
  // and raced (admin.js, loading later, even stomped C1 tabs back to
  // overview). This bundle now only LISTENS (see boot) and reuses app.js's
  // gotoTab (destructured off window.Gotong) for cross-tab jumps.
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
    // Construct the workflow-AI-assistant factory now that `dom` is resolved.
    // It captures dom by value + wires the depth-row click synchronously, so
    // it must run AFTER resolveDom() (see the `let wfAssist = null` note above).
    wfAssist = (window.Gotong && window.Gotong.installWorkflowAssist)
      ? window.Gotong.installWorkflowAssist({
          dom,
          state,
          ma,
          wf,
          // MCD-M4 — the assistant prefers already-installed MCP backends when
          // the directory has any. Pass the mcp module so it can read the live
          // installed-server list (mcp.state.servers) into contextHints.
          mcp,
          refreshWorkflows: () => workflows.refreshWorkflows(),
        })
      : null
    updateDispatchVisibility()

    // R14b — app.js owns the tabbar clicks + hashchange + setActiveTab and
    // dispatches `gotong:tabchange`. We just subscribe and run the admin-
    // only per-tab side effect: refresh the growth-reports panel (which
    // lives under the Workflows tab) whenever the user lands there mid-
    // session — e.g. after the synthesist uploads a report. The initial
    // population on first load is covered by the unconditional
    // refreshGrowthReports() later in boot, so no deep-link catch-up needed.
    window.addEventListener('gotong:tabchange', (e) => {
      if (e.detail?.name === 'workflows') refreshGrowthReports().catch(() => {})
      // MCP tab (#2-M4): lazy-refresh the registry list on every focus so
      // installs/uninstalls from another window get picked up.
      if (e.detail?.name === 'mcp') mcp.refreshMcp().catch((err) => console.warn('mcp refresh failed:', err))
      // ⑦-M1 — re-probe the "start here" card whenever the user lands on
      // overview (it self-hides once the hub gains an agent/workflow or the
      // card is dismissed; the guard inside makes this a no-op after that).
      if (e.detail?.name === 'overview') {
        renderStartHere().catch(() => {})
      }
      // ❷-M2 / DEPLOY-B3 — the 体检 panel (+ its IM-status sibling) now lives
      // on the admin 设置 page, so its focus-refresh follows it there.
      if (e.detail?.name === 'settings') {
        renderHubHealth().catch(() => {})
      }
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
    // "Test connection" — probe the typed key once, before saving (ease-of-use ①).
    dom.maTestConn?.addEventListener('click', managedAgents.testConnection)
    // ease-of-use ②TC — post-create quick-chat: Send dispatches to the new
    // agent; Done routes through closeAgentForm (which resets the panel).
    dom.maQcSend?.addEventListener('click', managedAgents.quickChat)
    dom.maQcDone?.addEventListener('click', managedAgents.closeAgentForm)
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
    // LIFE-L1-M3 —「定时」card: create form + cadence-kind field visibility
    dom.wfSchedForm?.addEventListener('submit', (e) => {
      e.preventDefault()
      void workflows.createSchedule()
    })
    dom.wfSchedKind?.addEventListener('change', workflows.onScheduleKindChange)
    dom.bundleImportBtn?.addEventListener('click', openBundleImportModal)
    dom.bundleImportSubmit?.addEventListener('click', submitBundleImport)
    // Template gallery — one-click install of shipped templates (G-M3)
    dom.templateGalleryBtn?.addEventListener('click', openTemplateGalleryModal)
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
          dom.bundleImportMsg.textContent = t.admTemplateLoadFailedHttp(r.status)
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
        dom.bundleImportMsg.textContent = t.admGrowthBundleLoaded
        dom.bundleImportMsg.classList.remove('err')
        dom.bundleImportMsg.classList.add('ok')
      } catch (err) {
        dom.bundleImportMsg.textContent = t.admTemplateLoadFailedErr(err.message || String(err))
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
      dom.maApiKey.placeholder = t.admWillClear
      dom.maApiKeyHint.textContent = t.clearKey + t.admApiKeyClearHintSuffix
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
        if (dom.wfGraphModal && !dom.wfGraphModal.hidden) workflows.closeWorkflowGraphModal()
        if (dom.bundleImportModal && !dom.bundleImportModal.hidden) closeBundleImportModal()
        if (dom.templateGalleryModal && !dom.templateGalleryModal.hidden) closeTemplateGalleryModal()
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
      // ⑧ — post-install checklist deep-links carry no data-id, so dispatch them
      // before the `!id` guard. Close the gallery modal first (otherwise the
      // target tab/modal opens behind it), then jump to where the operator fixes
      // the item: KB slot → MCP integrations tab; missing key → API-key modal.
      if (act === 'goto-mcp') {
        closeTemplateGalleryModal()
        gotoTab('mcp')
        return
      }
      if (act === 'goto-key') {
        closeTemplateGalleryModal()
        dom.maKeysBtn?.click()
        return
      }
      // RES-M3 — an adaptation apply button carries its proposal on data-adapt
      // (no data-id), so dispatch it before the `!id` guard. The click IS the
      // human approval; applyAdaptation POSTs it to the server, which re-checks.
      if (act === 'apply-adaptation') {
        applyAdaptation(target.closest('[data-act="apply-adaptation"]') || target)
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
      } else if (act === 'fix-agent-key') {
        // EH-M2 — the per-row「key 未配置」badge IS the fix button: route to the
        // same proven "API Key 管理" entry as #start-here / the 体检 panel.
        dom.maKeysBtn?.click()
      } else if (act === 'remove-workflow') {
        workflows.removeWorkflow(id)
      } else if (act === 'open-workflow-runs') {
        workflows.openWorkflowRunsModal(id)
      } else if (act === 'open-workflow-graph') {
        workflows.openWorkflowGraphModal(id)
      } else if (act === 'explain-workflow') {
        openWorkflowAssistExplain(id)
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
      } else if (act === 'fire-schedule') {
        workflows.fireSchedule(id)
      } else if (act === 'toggle-schedule') {
        workflows.toggleSchedule(id)
      } else if (act === 'remove-schedule') {
        workflows.removeSchedule(id)
      } else if (act === 'enable-suggestion') {
        workflows.enableSuggestion(id, Number(target.dataset.idx))
      } else if (act === 'run-acceptance') {
        workflows.runAcceptance(id)
      } else if (act === 'open-workflow-revisions') {
        workflows.openWorkflowRevisionsModal(id)
      } else if (act === 'rollback-revision') {
        const rev = Number(target.dataset.rev)
        if (Number.isInteger(rev)) workflows.rollbackTo(id, rev)
      } else if (act === 'start-workflow') {
        openWorkflowStart(id)
      } else if (act === 'install-template') {
        installTemplate(id)
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
      if (dom.wfGraphModal && !dom.wfGraphModal.hidden) workflows.closeWorkflowGraphModal()
      if (dom.bundleImportModal && !dom.bundleImportModal.hidden) closeBundleImportModal()
      if (dom.templateGalleryModal && !dom.templateGalleryModal.hidden) closeTemplateGalleryModal()
      if (dom.wfStartModal && !dom.wfStartModal.hidden) closeWorkflowStart()
      if (dom.grReportModal && !dom.grReportModal.hidden) closeGrowthReport()
    })
    // First-visit disclaimer. localStorage flag is per-browser, so a
    // user who clears storage or visits from a different machine sees
    // it again — intentional. Failures (private browsing without
    // storage permission) just skip the modal silently.
    try {
      if (dom.disclaimerModal && !localStorage.getItem('gotong_disclaimer_v1')) {
        dom.disclaimerModal.hidden = false
      }
    } catch (err) {
      console.debug('disclaimer storage check failed:', err)
    }
    dom.disclaimerAccept?.addEventListener('click', () => {
      try { localStorage.setItem('gotong_disclaimer_v1', String(Date.now())) } catch {}
      if (dom.disclaimerModal) dom.disclaimerModal.hidden = true
    })

    managedAgents.refreshManagedAgents().catch((err) => console.warn('initial agents refresh:', err))
    workflows.refreshWorkflows().catch((err) => console.warn('initial workflows refresh:', err))
    refreshGrowthReports().catch((err) => console.warn('initial growth-reports refresh:', err))
    // ⑦-M1 — first-run "start here" coaching card (self-hides on a non-fresh
    // or dismissed hub). Its CTAs are delegated through onStartHereClick.
    renderStartHere().catch(() => {})
    document.getElementById('start-here')?.addEventListener('click', onStartHereClick)
    // ❷-M2 — the hub-health panel shares the overview slot: it self-hides on a
    // fresh hub (start-here's domain) and renders once the hub has agents. The
    // delegated click survives innerHTML re-renders (host element is stable).
    renderHubHealth().catch(() => {})
    document.getElementById('hub-health')?.addEventListener('click', onHubHealthClick)
    // DEPLOY-B3 — the settings page's standing 凭证 entry: same proven modal
    // the agents tab / start-here / 体检 signals open.
    document.getElementById('ops-keys-btn')?.addEventListener('click', () => dom.maKeysBtn?.click())
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
      // ⑦-M1 — re-render the start-here card in the new language while it's
      // still showing (no-op once settled, i.e. dismissed / non-fresh).
      renderStartHere().catch(() => {})
      // ❷-M2 — re-render the hub-health panel from cache in the new language
      // (useCache → no network round-trip on a mere lang toggle).
      renderHubHealth({ useCache: true }).catch(() => {})
    })

    // View switcher — jump to the worker (`/`) view. Both views share
    // identity through HttpOnly cookies (`gotong_admin` + `gotong_worker`),
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
    // gotong:tabchange listener above; here we wire the install form + the
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
