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
      maModel: $('ma-model'),
      maSystem: $('ma-system'),
      maWeight: $('ma-weight'),
      maImportModal: $('ma-import-modal'),
      maImportFile: $('ma-import-file'),
      maImportText: $('ma-import-text'),
      maImportSubmit: $('ma-import-submit'),
      maImportMsg: $('ma-import-msg'),
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
        break
      case 'participant_left':
        state.participants = state.participants.filter((p) => p.id !== ev.data.id)
        refreshManagedAgents().catch(() => {})
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
      const meta = managed
        ? `<span class="ma-provider">${escapeHtml(managed.provider)}${managed.model ? ' · ' + escapeHtml(managed.model) : ''}</span>`
        : `<span class="ma-external">${escapeHtml(t.externalAgent)}</span>`
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
    // All three are valid in agents.json; greyed out if env doesn't support.
    const all = ['mock', 'anthropic', 'openai']
    const avail = new Set(ma.providers)
    dom.maProvider.innerHTML = all.map((p) => {
      const disabled = !avail.has(p)
      const suffix = disabled ? ` — ${t.providerDisabled}` : ''
      return `<option value="${p}"${disabled ? ' disabled' : ''}>${p}${suffix}</option>`
    }).join('')
    // Default to the first available
    const first = all.find((p) => avail.has(p))
    if (first) dom.maProvider.value = first
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
      }
      // Show "this agent has its own key" hint + a Clear button when applicable
      const hasOverride = !!ma.secrets.agents[agent.id]
      dom.maApiKey.value = ''
      dom.maApiKey.placeholder = hasOverride ? '••••••••' : ''
      dom.maApiKeyHint.textContent = hasOverride ? t.agentApiKeyHintEdit : t.agentApiKeyHint
      dom.maApiKeyClear.hidden = !hasOverride
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
    // Carry apiKey only when the user typed something OR (in edit mode)
    // they used the Clear button — clearing is represented as an explicit
    // empty string; "no apiKey field at all" means "leave it alone".
    const body = { id, displayName, capabilities, provider, model, system, weightDefault }
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

  document.addEventListener('DOMContentLoaded', async () => {
    resolveDom()
    updateDispatchVisibility()

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
    dom.maImportBtn?.addEventListener('click', openImportModal)
    dom.maKeysBtn?.addEventListener('click', openKeysModal)
    dom.maForm?.addEventListener('submit', submitAgentForm)
    dom.maImportSubmit?.addEventListener('click', submitImport)
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
        if (!dom.maKeysModal.hidden) closeKeysModal()
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
      }
    })
    // ESC closes any open modal
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!dom.maFormModal.hidden) closeAgentForm()
      if (!dom.maImportModal.hidden) closeImportModal()
      if (!dom.maKeysModal.hidden) closeKeysModal()
    })
    refreshManagedAgents().catch((err) => console.warn('initial agents refresh:', err))

    document.addEventListener('click', async (e) => {
      const target = e.target
      // Click a task_result row → autofill evaluation form
      if (target instanceof HTMLElement && target.dataset.taskid) {
        dom.eTask.value = target.dataset.taskid
        return
      }
      if (!(target instanceof HTMLElement)) return
      const act = target.dataset.act
      const id = target.dataset.id
      if (!act || !id) return
      // copy task id to the evaluation form on click
      if (act === 'copy-task-id') {
        dom.eTask.value = id
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

    try {
      await refresh()
    } catch (err) {
      console.error('initial refresh failed:', err)
    }
    connectStream(applyEvent)
  })
})()
