/* Gotong admin — Managed Agents tab (local/cloud agent CRUD, provider
 * API keys, paste / file / GitHub import).
 *
 * Second ES-module split of the admin console (P3 admin.js split, Phase 2),
 * after services.js. Unlike services — which owns its own DOM ids and reads
 * only `ma.agents` — this module drives the shared `dom` cache that
 * resolveDom() builds. So the factory exposes `setDom(dom)`, called once by
 * main.js right after resolveDom(); the closure references that `dom`
 * thereafter, exactly as the inline code did.
 *
 * The empty-state onboarding button reaches into the bundle-import flow that
 * still lives in main.js, so `openBundleImportModal` is passed in as a
 * callback dependency. The shared `ma` state object is passed in too — the
 * maApiKeyClear handler in main.js sets `ma._clearKeyOnSubmit`, which
 * submitAgentForm reads here.
 *
 * Shared utilities (t / escapeHtml / fetchJson) come off window.Gotong,
 * same source as services.js / admin-wf-assist.js.
 */

const { t, escapeHtml, fetchJson } = window.Gotong

export function createManagedAgents({ ma, openBundleImportModal }) {
  // Injected once after resolveDom() — see module header.
  let dom = null
  function setDom(d) { dom = d }

  async function refreshManagedAgents() {
    if (!dom?.maList) return
    try {
      // EH-M2 — also pull the hub health snapshot so each agent row can carry a
      // per-agent「key 未配置」badge (the same missingKey signal the overview 体检
      // panel computes). `.catch(()=>null)` keeps it best-effort: a 503 (host
      // wired no health surface) or fetch fault must never break the agent list,
      // it just leaves ma.health empty → no badges. Static endpoint, zero LLM
      // cost, so piggy-backing it on the agents refresh is cheap.
      const [agentsResp, provResp, secretsResp, healthResp] = await Promise.all([
        fetchJson('/api/admin/agents'),
        fetchJson('/api/admin/agents/providers'),
        fetchJson('/api/admin/secrets'),
        fetchJson('/api/admin/health').catch(() => null),
      ])
      ma.agents = agentsResp.agents || []
      ma.providers = provResp.providers || []
      ma.secrets = {
        providers: secretsResp.providers || {},
        agents: secretsResp.agents || {},
        env: secretsResp.env || {},
      }
      // Map agentId → missingKey for the row badge. Only managed LLM agents
      // appear in the snapshot; everyone else is simply absent (no badge).
      ma.health = {}
      for (const row of healthResp?.agents || []) {
        ma.health[row.id] = { missingKey: !!row.missingKey }
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
      // wizard for non-technical users who just installed Gotong.
      dom.maList.innerHTML = `<div class="empty-state" style="padding: 1.2rem; line-height: 1.7;">
        <p style="margin: 0 0 0.6rem; font-weight: 600;">${escapeHtml(t.maEmpty)}</p>
        <p style="margin: 0 0 0.8rem; color: #555;">${escapeHtml(t.admOnboardPgPrompt)}</p>
        <p style="margin: 0;">
          <button type="button" id="onboarding-pg-btn" class="ma-btn">${escapeHtml(t.admOnboardPgBtn)}</button>
        </p>
        <small class="hint" style="display: block; margin-top: 0.6rem; color: #777;">
          ${t.admOnboardDeepseekHint('<a href="https://platform.deepseek.com" target="_blank" rel="noopener">platform.deepseek.com</a>')}
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
      // v5 E4-M2 — "管理访问" opens the resource-RBAC grants modal. Shown on
      // managed agents (the ones an admin owns/edits); the modal itself is
      // owner-gated server-side, so a non-owner admin gets a notice inside it.
      const actions = managed ? `
        <button class="ma-action" data-act="edit-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.edit)}</button>
        <button class="ma-action" data-act="manage-agent-access" data-id="${escapeHtml(a.id)}">${escapeHtml(t.agentAccessManage)}</button>
        <button class="ma-action" data-act="export-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.export_)}</button>
        <button class="ma-action ma-danger" data-act="remove-agent" data-id="${escapeHtml(a.id)}">${escapeHtml(t.remove)}</button>
      ` : ''
      // EH-M2 — per-row「key 未配置」warning, cross-referenced from the health
      // snapshot (ma.health, populated by refreshManagedAgents). Keys off
      // missingKey regardless of online status: a missing key is THE actionable
      // reason a managed agent fails to start, so surfacing it right on the row
      // (not just the overview 体检 panel) closes the「offline — why? → fix」loop.
      // The badge is itself the fix button (data-act=fix-agent-key opens the
      // keys modal). ma.health may be absent (direct render w/o refresh, or 503)
      // → optional-chained to no badge, never a crash.
      const keyWarn = (managed && ma.health?.[a.id]?.missingKey)
        ? `<button type="button" class="ma-keywarn" data-act="fix-agent-key" data-id="${escapeHtml(a.id)}" title="${escapeHtml(t.agentKeyWarnHint)}">${escapeHtml(t.agentKeyWarnBadge)}</button>`
        : ''
      return `
        <div class="ma-row ${onlineCls}">
          <div class="ma-head">
            <strong class="ma-id">${escapeHtml(a.displayName || a.id)}</strong>
            ${a.displayName ? `<code class="ma-realid">${escapeHtml(a.id)}</code>` : ''}
            <span class="ma-status">${escapeHtml(onlineLabel)}</span>
            ${keyWarn}
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

  /**
   * Populate the MCP opt-in checkboxes (#2-M4c) from the hub registry.
   * `selected` is the agent's current useMcpServers (pre-checked). Sets
   * `ma._mcpAvailable` so submit knows whether the checkbox set is the
   * source of truth — when the registry surface is absent (503 / fetch
   * fail) the fieldset hides and submit preserves the existing opt-in
   * instead of wiping it on the wholesale `managed` replace.
   */
  async function loadMcpOptIn(selected) {
    const fieldset = document.getElementById('ma-mcp-fieldset')
    const container = document.getElementById('ma-mcp-optin')
    const emptyEl = document.getElementById('ma-mcp-empty')
    if (!fieldset || !container) return
    container.innerHTML = ''
    ma._mcpAvailable = false
    let servers
    try {
      const r = await fetch('/api/admin/mcp-servers')
      if (r.status === 503) { fieldset.hidden = true; return }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      servers = (await r.json()).servers || []
    } catch (err) {
      console.warn('agent form: mcp list failed', err)
      fieldset.hidden = true
      return
    }
    ma._mcpAvailable = true
    fieldset.hidden = false
    const sel = new Set(selected || [])
    const rendered = new Set()

    // Build via createElement (not innerHTML) — server names / descriptions
    // / peer labels are all user-supplied and must never be interpolated
    // into markup.
    const addCheckbox = (value, text, checked, extraClass = '') => {
      const label = document.createElement('label')
      label.className = extraClass ? `ma-mcp-cb ${extraClass}` : 'ma-mcp-cb'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = value
      cb.checked = checked
      const span = document.createElement('span')
      span.textContent = text
      label.append(cb, span)
      container.appendChild(label)
      rendered.add(value)
    }
    const addHeading = (text, cls) => {
      const h = document.createElement('div')
      h.className = cls
      h.textContent = text
      container.appendChild(h)
    }

    // --- local hub registry servers (opt in by bare name) ---
    for (const rec of servers) {
      const name = rec.spec?.name
      if (!name) continue
      addCheckbox(name, rec.description ? `${name} — ${rec.description}` : name, sel.has(name))
    }

    // --- peer-shared servers (cross-hub federation, #2-M3.4b) ---
    // Opt in by `peer:server` ref. Discovery is best-effort: a 503 (peers
    // off) or any fetch error just means no federation section — the local
    // opt-in above still stands.
    let peers = []
    try {
      const r2 = await fetch('/api/admin/mcp-shared')
      if (r2.ok) peers = (await r2.json()).peers || []
    } catch (err) {
      console.warn('agent form: mcp-shared list failed', err)
    }
    const online = peers.filter((p) => p && p.online && Array.isArray(p.servers) && p.servers.length > 0)
    const discovered = new Set()
    for (const p of online) for (const s of p.servers) if (s?.name) discovered.add(`${p.peer}:${s.name}`)
    // Selected refs whose peer is offline / server vanished at edit time:
    // keep them checked so saving never silently drops a prior cross-hub
    // opt-in. (Local orphans are NOT preserved — the local registry is the
    // source of truth there, so a removed local server correctly drops.)
    const orphans = [...sel].filter((ref) => ref.includes(':') && !discovered.has(ref))

    if (online.length > 0 || orphans.length > 0) {
      addHeading(t.mcpAgentFedHeading, 'ma-mcp-group')
      for (const p of online) {
        addHeading(p.label || p.peer, 'ma-mcp-peer')
        for (const s of p.servers) {
          if (!s?.name) continue
          const ref = `${p.peer}:${s.name}`
          addCheckbox(ref, s.description ? `${s.name} — ${s.description}` : s.name, sel.has(ref), 'ma-mcp-cb-peer')
        }
      }
      for (const ref of orphans) {
        addCheckbox(ref, `${ref} ${t.mcpAgentOffline}`, true, 'ma-mcp-cb-peer ma-mcp-offline')
      }
    }

    // Empty only when neither a local server nor any peer section rendered.
    if (emptyEl) emptyEl.hidden = container.children.length > 0
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
        // v5 D-M4 — heartbeat. Wire is ms; the form edits minutes.
        const hb = agent.managed.heartbeat
        if (dom.maHeartbeatEnabled) dom.maHeartbeatEnabled.checked = !!hb?.enabled
        if (dom.maHeartbeatInterval) {
          dom.maHeartbeatInterval.value = hb?.intervalMs ? String(Math.round(hb.intervalMs / 60000)) : ''
        }
        if (dom.maHeartbeatChecklist) dom.maHeartbeatChecklist.value = hb?.checklist || ''
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
    // #2-M4c — capture the agent's current opt-in as the edit baseline,
    // then (async) populate the registry checkboxes. Fire-and-forget: the
    // modal opens now; the checkboxes fill a beat later.
    ma._editingMcpServers = (mode === 'edit' && Array.isArray(agent?.managed?.useMcpServers))
      ? [...agent.managed.useMcpServers]
      : []
    loadMcpOptIn(ma._editingMcpServers).catch(() => {})
    // ease-of-use ②TC — always open on the form, never a stale quick-chat
    // panel left over from a prior create (closeAgentForm also resets, but be
    // defensive so the entry point is self-sufficient).
    if (dom.maForm) dom.maForm.hidden = false
    if (dom.maQuickchat) dom.maQuickchat.hidden = true
    ma._quickChatAgentId = null
    dom.maFormModal.hidden = false
  }

  function closeAgentForm() {
    dom.maFormModal.hidden = true
    // ease-of-use ②TC — a create may have swapped the form out for the
    // quick-chat panel. Restore the form + clear quick-chat state so the
    // NEXT open shows a fresh form. Every dismissal path (×/backdrop/Escape/
    // the panel's own Done button) routes through here, so this covers them all.
    if (dom.maForm) dom.maForm.hidden = false
    if (dom.maQuickchat) dom.maQuickchat.hidden = true
    if (dom.maQcReply) { dom.maQcReply.hidden = true; dom.maQcReply.textContent = '' }
    if (dom.maQcStatus) { dom.maQcStatus.textContent = ''; dom.maQcStatus.classList.remove('ok', 'err') }
    ma._quickChatAgentId = null
  }

  // ease-of-use ②TC — a CREATE just succeeded. Instead of dead-ending on
  // "已保存", swap the form out for a zero-friction quick-chat so the user can
  // talk to their brand-new agent right now and SEE it respond. The agent
  // registered live on create, so it's immediately dispatchable.
  function openQuickChat(agentId) {
    if (!dom.maQuickchat) return
    ma._quickChatAgentId = agentId
    if (dom.maForm) dom.maForm.hidden = true
    dom.maQuickchat.hidden = false
    if (dom.maQcInput) dom.maQcInput.value = ''
    if (dom.maQcStatus) { dom.maQcStatus.textContent = ''; dom.maQcStatus.classList.remove('ok', 'err') }
    if (dom.maQcReply) { dom.maQcReply.hidden = true; dom.maQcReply.textContent = '' }
    if (dom.maQcInput) dom.maQcInput.focus()
  }

  // ease-of-use ❷-M2 — open the quick-chat box pointed at an ALREADY-SAVED
  // agent, as the per-agent manual「测连接」(connection test) for the hub-health
  // panel. The plan said reuse the testLlmKey route, but that route needs a
  // TYPED apiKey in the request body — a saved agent's key lives in the vault and
  // is never sent to the browser, so testLlmKey can't probe an existing agent.
  // Quick-chat is the honest substitute: it dispatches a real message to the
  // agent BY ID (explicit→to), exercising the real spawn + vault key resolution +
  // provider call. So a reply proves "this saved agent is reachable right now",
  // and any failure flows through the SAME describeError → human text +「去补 key」
  // path the post-create quick-chat already uses (no second error classifier).
  function openAgentChat(agentId) {
    if (!dom.maFormModal) return
    if (dom.maFormTitle) dom.maFormTitle.textContent = t.healthTestTitle(agentId)
    if (dom.maFormEditWarning) dom.maFormEditWarning.hidden = true
    if (dom.maFormMsg) { dom.maFormMsg.textContent = ''; dom.maFormMsg.classList.remove('ok', 'err') }
    dom.maFormModal.hidden = false
    openQuickChat(agentId) // hides the form, shows the quick-chat panel, focuses input
  }

  // ease-of-use ③TC-ADMIN — when a quick-chat failure is key/quota-related,
  // append a one-click「去补 key →」button that opens the「API Key 管理」keys modal
  // (openKeysModal), so the operator doesn't have to hunt for it. Whether a failure
  // is key-fixable is decided by describeError's `fixIsKey` flag — the SAME single
  // source the member /me quick-chat (③TC-ME) reads, so the two surfaces never drift.
  // textContent-first everywhere else means this real button node is dropped on the
  // next send (each new state resets maQcStatus.textContent, clearing children); no
  // innerHTML, nothing to escape.
  function appendKeyFixButton(d) {
    if (!d.fixIsKey || !dom.maQcStatus) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ma-chat-fix-btn'
    btn.textContent = t.meChatGoAddKey
    btn.addEventListener('click', openKeysModal)
    dom.maQcStatus.append(' ', btn)
  }

  // Send one message to the brand-new agent and render its reply inline.
  // Reuses the existing wait:true dispatch path (the same one the MCP server
  // uses) — explicit→to targets the agent by id, so no capability guessing.
  async function quickChat() {
    const agentId = ma._quickChatAgentId
    if (!agentId || !dom.maQcInput || !dom.maQcStatus) return
    const prompt = dom.maQcInput.value.trim()
    if (!prompt) {
      dom.maQcStatus.textContent = t.quickChatNeedMsg
      dom.maQcStatus.classList.remove('ok')
      dom.maQcStatus.classList.add('err')
      return
    }
    const btn = dom.maQcSend
    const prevLabel = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = t.quickChatSending }
    dom.maQcStatus.textContent = t.quickChatSending
    dom.maQcStatus.classList.remove('ok', 'err')
    if (dom.maQcReply) { dom.maQcReply.hidden = true; dom.maQcReply.textContent = '' }
    try {
      const r = await fetchJson('/api/admin/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: { kind: 'explicit', to: agentId },
          payload: { prompt },
          wait: true,
          timeoutMs: 60000,
        }),
      })
      renderQuickChatReply(r?.result)
    } catch (err) {
      // 504 (timeout) / 400 / network — fetchJson throws the server's error
      // string. Run it through the friendly-error classifier too so a timeout
      // or refused connection reads as plain words + a fix, not a raw stack.
      const d = window.Gotong.describeError(err && err.message ? err.message : String(err))
      dom.maQcStatus.textContent = t.quickChatFailed(d.fix ? `${d.text} ${d.fix}` : d.text)
      dom.maQcStatus.classList.remove('ok')
      dom.maQcStatus.classList.add('err')
      appendKeyFixButton(d)
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || t.quickChatSend }
    }
  }

  function renderQuickChatReply(result) {
    if (!dom.maQcStatus) return
    if (!result) {
      dom.maQcStatus.textContent = t.quickChatNoResult
      dom.maQcStatus.classList.remove('ok')
      dom.maQcStatus.classList.add('err')
      return
    }
    const out = result.output
    // ease-of-use ③TC — an LlmAgent that hits a provider auth/transport error
    // folds it into output.stopReason==='error' with the raw error text in
    // output.text, and STILL returns kind:'ok'. Rendering that as a green reply
    // would show the lowest-capability user "[auth_error] 401 …" as if the agent
    // had answered. So treat stopReason:'error' (and any non-ok kind) as a
    // failure and run it through the friendly-error classifier.
    const errored = result.kind !== 'ok' || (out && out.stopReason === 'error')
    if (!errored) {
      // Genuine reply. LlmAgent ok → output.text. Fall back to pretty JSON for
      // non-LLM agents whose output isn't a chat string.
      const text = out && typeof out.text === 'string'
        ? out.text
        : JSON.stringify(out ?? {}, null, 2)
      if (dom.maQcReply) {
        dom.maQcReply.textContent = text
        dom.maQcReply.hidden = false
      }
      dom.maQcStatus.textContent = t.quickChatOk
      dom.maQcStatus.classList.remove('err')
      dom.maQcStatus.classList.add('ok')
      return
    }
    // Failure. The raw provider error is either folded into output.text (the
    // stopReason:'error' case) or carried on a non-ok result. Classify it into
    // plain words + an actionable fix (often "go fix the key" — which ties back
    // to the 测试连接 button + API Key 管理 right above this panel).
    const raw = result.kind === 'ok'
      ? (out && typeof out.text === 'string' ? out.text : '')
      : (result.error || result.reason || result.kind || '')
    const d = window.Gotong.describeError(raw)
    const friendly = d.fix ? `${d.text} ${d.fix}` : d.text
    if (dom.maQcReply) { dom.maQcReply.hidden = true; dom.maQcReply.textContent = '' }
    dom.maQcStatus.textContent = t.quickChatAgentFailed(friendly)
    dom.maQcStatus.classList.remove('ok')
    dom.maQcStatus.classList.add('err')
    appendKeyFixButton(d)
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
    // #2-M4c — useMcpServers. PUT replaces `managed` wholesale, so the
    // body must carry the complete opt-in. When the registry checkboxes
    // loaded they ARE the truth (incl. [] to clear); when they couldn't
    // load (503 / fetch fail) we echo the captured baseline so an edit
    // doesn't silently wipe a prior opt-in. Omit entirely otherwise.
    if (ma._mcpAvailable) {
      body.useMcpServers = Array.from(
        document.querySelectorAll('#ma-mcp-optin input[type="checkbox"]:checked'),
      ).map((c) => c.value)
    } else if (Array.isArray(ma._editingMcpServers) && ma._editingMcpServers.length > 0) {
      body.useMcpServers = ma._editingMcpServers
    }
    // v5 D-M4 — heartbeat. Checked → persist { enabled, intervalMs (from the
    // minutes input), checklist? }. Unchecked → omit so a PUT (which replaces
    // `managed` wholesale) removes it and the host prunes the wake-up row.
    if (dom.maHeartbeatEnabled?.checked) {
      const minutes = Math.max(1, Math.round(Number(dom.maHeartbeatInterval?.value.trim()) || 30))
      const checklist = (dom.maHeartbeatChecklist?.value ?? '').trim()
      body.heartbeat = { enabled: true, intervalMs: minutes * 60000 }
      if (checklist) body.heartbeat.checklist = checklist
    }
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
      } else if (ma.formMode === 'edit') {
        dom.maFormMsg.textContent = t.saveOk
        dom.maFormMsg.classList.add('ok')
        setTimeout(closeAgentForm, 400)
      } else {
        // ease-of-use ②TC — a CREATE just succeeded. Don't dead-end on
        // "已保存": swap the form for a quick-chat box so the user can talk to
        // their brand-new agent right now (it registered live on create).
        openQuickChat(id)
      }
      await refreshManagedAgents()
    } catch (err) {
      dom.maFormMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maFormMsg.classList.add('err')
    }
  }

  // "Test connection" — probe the typed key ONCE before saving (ease-of-use ①).
  // Reads the same form fields as submitAgentForm so the verdict reflects
  // exactly what a save would persist. The key is sent to the host's probe
  // route, never logged; the host returns a structured verdict whose `code`
  // we map to localized words via the shared describeKeyTest helper (the same
  // mapping the first-run setup wizard uses — one place, honest labels).
  async function testConnection() {
    if (!dom?.maTestMsg) return
    dom.maTestMsg.textContent = ''
    dom.maTestMsg.classList.remove('ok', 'err')
    const provider = dom.maProvider.value
    const model = dom.maModel.value.trim() || undefined
    const apiKey = dom.maApiKey.value
    // openai-compatible-only — mirror submitAgentForm so a DeepSeek/Qwen key
    // hits its own baseURL instead of being mislabeled against api.openai.com.
    const baseURL = provider === 'openai-compatible'
      ? (dom.maBaseUrl?.value.trim() || undefined)
      : undefined
    if (!apiKey.trim()) {
      dom.maTestMsg.textContent = t.testConnNeedKey
      dom.maTestMsg.classList.add('err')
      return
    }
    const btn = dom.maTestConn
    const prevLabel = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = t.testConnTesting }
    dom.maTestMsg.textContent = t.testConnTesting
    try {
      const verdict = await fetchJson('/api/admin/test-llm-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, model, baseURL }),
      })
      const d = window.Gotong.describeKeyTest(verdict)
      dom.maTestMsg.textContent = d.text
      dom.maTestMsg.classList.add(d.level === 'ok' ? 'ok' : 'err')
    } catch (err) {
      // 503 (probe surface absent) / 400 (validation) / network — fetchJson
      // throws the server's error string; surface it without leaking the key.
      dom.maTestMsg.textContent = t.failedAlert(err.message || String(err))
      dom.maTestMsg.classList.add('err')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || t.testConnBtn }
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

  // --- access control / resource RBAC grants (v5 E4-M2) ------------------
  //
  // Mirror of the workflow grants panel (workflows.js). Backed by the
  // owner-gated /api/admin/agents/:id/grants routes: a non-owner admin gets
  // 403 → "owner only" notice; a host without an identity store gets 404 →
  // "not enabled" notice. Operators (org owner / v3 admin) manage by bypass.

  let grantsAgentId = null

  function setAgentGrantsNotice(key) {
    if (dom.maGrantsList) dom.maGrantsList.innerHTML = ''
    if (dom.maGrantsEmpty) dom.maGrantsEmpty.hidden = true
    if (dom.maGrantsAdd) dom.maGrantsAdd.hidden = true
    if (dom.maGrantsMsg) {
      dom.maGrantsMsg.textContent = t[key] || ''
      dom.maGrantsMsg.classList.remove('ok')
      dom.maGrantsMsg.classList.add('err')
    }
  }

  function openAccessModal(id) {
    grantsAgentId = id
    if (dom.maAccessTarget) dom.maAccessTarget.textContent = id
    if (dom.maGrantsMsg) {
      dom.maGrantsMsg.textContent = ''
      dom.maGrantsMsg.classList.remove('ok', 'err')
    }
    if (dom.maGrantsAdd) dom.maGrantsAdd.hidden = false
    if (dom.maGrantsEmpty) dom.maGrantsEmpty.hidden = true
    if (dom.maGrantsList) dom.maGrantsList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    if (dom.maAccessModal) dom.maAccessModal.hidden = false
    void fetchAgentGrants(id)
  }

  function closeAccessModal() {
    if (dom.maAccessModal) dom.maAccessModal.hidden = true
  }

  // Wired to the 刷新 button (data-act="refresh-agent-grants").
  async function refreshAgentGrants() {
    if (grantsAgentId) await fetchAgentGrants(grantsAgentId)
  }

  async function fetchAgentGrants(id) {
    try {
      const r = await fetch(`/api/admin/agents/${encodeURIComponent(id)}/grants`)
      if (!r.ok) {
        // 403 = non-owner admin; 404 = host without resource RBAC.
        setAgentGrantsNotice(r.status === 403 ? 'agentGrantsOwnerOnly' : 'workflowGrantsUnavailable')
        return
      }
      const body = await r.json()
      renderAgentGrants(body.grants || [])
    } catch (err) {
      if (dom.maGrantsList) dom.maGrantsList.innerHTML = ''
      if (dom.maGrantsMsg) {
        dom.maGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.maGrantsMsg.classList.add('err')
      }
    }
  }

  function renderAgentGrants(rows) {
    if (!dom.maGrantsList) return
    if (rows.length === 0) {
      dom.maGrantsList.innerHTML = ''
      if (dom.maGrantsEmpty) dom.maGrantsEmpty.hidden = false
      return
    }
    if (dom.maGrantsEmpty) dom.maGrantsEmpty.hidden = true
    dom.maGrantsList.innerHTML = rows
      .map((g) => {
        const user = escapeHtml(g.userId)
        const perm = escapeHtml(g.perm)
        return `<div class="wf-grant-row">
          <span class="wf-grant-user-id">${user}</span>
          <span class="wf-grant-perm-tag wf-grant-perm-${perm}">${perm}</span>
          <button type="button" class="ma-btn ma-btn-secondary ma-danger wf-grant-remove"
                  data-act="remove-agent-grant" data-user="${user}"
                  >${escapeHtml(t.workflowGrantsRemove)}</button>
        </div>`
      })
      .join('')
  }

  // Wired to the 授权 button (data-act="add-agent-grant").
  async function addAgentGrant() {
    if (!grantsAgentId) return
    const userId = dom.maGrantUser ? dom.maGrantUser.value.trim() : ''
    const perm = dom.maGrantPerm ? dom.maGrantPerm.value : 'viewer'
    if (dom.maGrantsMsg) {
      dom.maGrantsMsg.textContent = ''
      dom.maGrantsMsg.classList.remove('ok', 'err')
    }
    if (!userId) {
      if (dom.maGrantsMsg) {
        dom.maGrantsMsg.textContent = t.workflowGrantsNeedUser
        dom.maGrantsMsg.classList.add('err')
      }
      return
    }
    try {
      const r = await fetch(`/api/admin/agents/${encodeURIComponent(grantsAgentId)}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, perm }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.maGrantsMsg) {
          dom.maGrantsMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.maGrantsMsg.classList.add('err')
        }
        return
      }
      const body = await r.json()
      if (dom.maGrantUser) dom.maGrantUser.value = ''
      renderAgentGrants(body.grants || [])
    } catch (err) {
      if (dom.maGrantsMsg) {
        dom.maGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.maGrantsMsg.classList.add('err')
      }
    }
  }

  // Wired to per-row 撤销 buttons (data-act="remove-agent-grant").
  async function removeAgentGrant(userId) {
    if (!grantsAgentId || !userId) return
    try {
      const r = await fetch(
        `/api/admin/agents/${encodeURIComponent(grantsAgentId)}/grants/${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.maGrantsMsg) {
          dom.maGrantsMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.maGrantsMsg.classList.add('err')
        }
        return
      }
      await fetchAgentGrants(grantsAgentId)
    } catch (err) {
      if (dom.maGrantsMsg) {
        dom.maGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.maGrantsMsg.classList.add('err')
      }
    }
  }

  return {
    setDom,
    refreshManagedAgents,
    renderManagedAgents,
    syncProviderDependentFields,
    openAgentForm,
    closeAgentForm,
    submitAgentForm,
    testConnection,
    quickChat,
    openAgentChat,
    openImportModal,
    openKeysModal,
    closeKeysModal,
    setProviderKey,
    removeProviderKey,
    closeImportModal,
    submitImport,
    updateGhResolved,
    openGithubImportModal,
    closeGithubImportModal,
    submitGithubImport,
    exportAgent,
    removeAgent,
    openAccessModal,
    closeAccessModal,
    refreshAgentGrants,
    addAgentGrant,
    removeAgentGrant,
  }
}
