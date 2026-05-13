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
      card.innerHTML =
        `<div class="t-head"><span class="t-title">${agents}</span></div>` +
        `<div class="pending-meta">${metaBits.join(' · ')}</div>` +
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
      const div = document.createElement('div')
      div.className = `task-card task-${v.status}`
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
      div.innerHTML =
        `<div class="task-head">` +
          `<span class="task-status task-status-${v.status}">${escapeHtml(statusLabel)}</span>` +
          `<span class="task-title">${escapeHtml(title)}</span>` +
          `<span class="task-strategy">${escapeHtml(s.kind)} · ${escapeHtml(target)}</span>` +
        `</div>` +
        `<div class="task-metrics">${taskMetricsHtml(v)}</div>` +
        `<div class="task-meta">` +
          `<code class="task-id" data-act="copy-task-id" data-id="${escapeHtml(v.id)}" title="click to fill the evaluation form">${escapeHtml(v.id.slice(0, 8))}…</code>` +
          (v.result ? ` · ${escapeHtml(resultSummary(v.result))}` : '') +
        `</div>` +
        (canRetry
          ? `<div class="task-actions"><button data-act="retry" data-id="${escapeHtml(v.id)}">${escapeHtml(t.retry)}</button></div>`
          : '')
      root.appendChild(div)
    }
  }

  function resultSummary(r) {
    if (r.kind === 'ok') return t.sumOk(r.by)
    if (r.kind === 'failed') return t.sumFailed(r.by, r.error)
    if (r.kind === 'cancelled') return t.sumCancelled(r.reason)
    return t.sumNoParticipant(r.reason)
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
  const TABS = ['overview', 'agents', 'workflows', 'tasks', 'activity']

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
      // Click a task_result row → autofill evaluation form + jump to
      // the Tasks tab (the eval form lives there now after the tab
      // split, otherwise the autofill would be invisible).
      if (target instanceof HTMLElement && target.dataset.taskid) {
        dom.eTask.value = target.dataset.taskid
        gotoTab('tasks')
        return
      }
      if (!(target instanceof HTMLElement)) return
      const act = target.dataset.act
      const id = target.dataset.id
      if (!act || !id) return
      // copy task id to the evaluation form on click — same cross-tab
      // jump as the transcript-row case above so the autofill is
      // actually visible in the Tasks tab.
      if (act === 'copy-task-id') {
        dom.eTask.value = id
        gotoTab('tasks')
        return
      }
      if (target instanceof HTMLButtonElement) target.disabled = true
      try {
        if (act === 'approve-app') {
          await approveApp(id)
        } else if (act === 'reject-app') {
          const card = target.closest('.pending-app-card')
          const reasonInput = card?.querySelector('.reject-reason')
          const reason = reasonInput?.value?.trim() || ''
          await rejectApp(id, reason)
        } else if (act === 'retry') {
          await retryTask(id)
        }
      } catch (err) {
        alert(t.failedAlert(err.message || String(err)))
        if (target instanceof HTMLButtonElement) target.disabled = false
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
    connectStream(applyEvent)
  })
})()
