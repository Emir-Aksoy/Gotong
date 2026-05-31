/* AipeHub admin — Workflows tab (workflow list + YAML import + run history).
 *
 * Third ES-module split of the admin console (P3 admin.js split, Phase 2),
 * after services.js and managed-agents.js. Same shape as managed-agents:
 * the factory drives the shared `dom` cache that resolveDom() builds, so it
 * exposes `setDom(dom)`, called once by main.js right after resolveDom().
 *
 * Scope is deliberately the *self-contained* workflow surfaces: the panel
 * (refresh / render / remove), the import modal, and the run-history viewer.
 * It does NOT include the workflow-start form or the AI assistant wrappers —
 * those stay in main.js because they're entangled with shared infrastructure
 * (start-form fields share renderOneField / file-upload / multimodal block
 * renderers with the Tasks-tab detail view and the HITL agent-question form,
 * and the assistant wrapper closes over wfAssist + state). Untangling that
 * shared rendering layer is a separate refactor.
 *
 * Closes over the shared `wf` state object (available / workflows / runs).
 * Shared utilities (t / escapeHtml) come off window.AipeHub, same source as
 * the sibling modules.
 */

const { t, escapeHtml } = window.AipeHub

export function createWorkflows({ wf }) {
  // Injected once after resolveDom() — see module header.
  let dom = null
  function setDom(d) { dom = d }

  // --- workflows panel ---------------------------------------------------

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
      // Phase 15 — lifecycle state badge + current revision. list() only
      // returns *live* workflows (published / deprecated), so the gated
      // buttons below cover exactly those two states.
      const state = w.state || 'published'
      const stateBadge = `<span class="wf-state wf-state-${escapeHtml(state)}">${escapeHtml(t.workflowStateLabel(state))}</span>`
      const revTag = w.currentRevision
        ? `<span class="wf-rev-tag">${escapeHtml(t.workflowRevTag(w.currentRevision))}</span>`
        : ''
      // "开始" button: primary action — opens a payload-schema-driven
      // form modal so users don't have to write JSON by hand. For
      // workflows without a schema, the button opens the generic
      // dispatch form pre-filled with the trigger capability.
      return `<article class="ma-card">
        <header>
          <strong>${name}</strong>
          <code>${escapeHtml(w.participantId)}</code>
          ${stateBadge}${revTag}
          <button type="button" class="ma-btn"
                  data-act="start-workflow"
                  data-id="${escapeHtml(w.id)}">开始</button>
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="open-workflow-runs"
                  data-id="${escapeHtml(w.id)}">${escapeHtml(t.workflowRunsBtn)}</button>
          ${lifecycleButtons(w.id, state)}
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

  // --- lifecycle (Phase 15) ----------------------------------------------
  //
  // The card list only ever shows *live* workflows: `published` (the import
  // default) and `deprecated` (still runnable, hidden from /me). The gated
  // buttons cover the legal transitions out of each:
  //   published  → 弃用 (deprecate)
  //   deprecated → 重新发布 (publish, un-deprecate) + 归档 (archive)
  //   both       → 修订历史 (revision list + rollback)

  function lifecycleButtons(id, state) {
    const idAttr = escapeHtml(id)
    const btn = (act, label) =>
      `<button type="button" class="ma-btn ma-btn-secondary"
               data-act="${act}" data-id="${idAttr}">${escapeHtml(label)}</button>`
    const revisions = btn('open-workflow-revisions', t.workflowRevisionsBtn)
    if (state === 'deprecated') {
      return btn('republish-workflow', t.workflowRepublishBtn) +
        btn('archive-workflow', t.workflowArchiveBtn) + revisions
    }
    // published (the only other live state in the list)
    return btn('deprecate-workflow', t.workflowDeprecateBtn) + revisions
  }

  // POST /api/admin/workflows/:id/{deprecate|publish|archive}. `publish`
  // with no body re-publishes the head revision (un-deprecate). The card
  // re-renders from the refreshed list afterward.
  async function lifecycleAction(id, action) {
    const ask = {
      deprecate: t.confirmDeprecateWorkflow,
      publish: t.confirmRepublishWorkflow,
      archive: t.confirmArchiveWorkflow,
    }[action]
    if (ask && !confirm(ask(id))) return
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
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

  // --- revision history / rollback ---------------------------------------

  let revWorkflowId = null
  let revRows = []

  async function openWorkflowRevisionsModal(id) {
    revWorkflowId = id
    revRows = []
    if (dom.wfRevTarget) dom.wfRevTarget.textContent = id
    if (dom.wfRevMsg) {
      dom.wfRevMsg.textContent = ''
      dom.wfRevMsg.classList.remove('ok', 'err')
    }
    if (dom.wfRevEmpty) dom.wfRevEmpty.hidden = true
    if (dom.wfRevList) dom.wfRevList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    if (dom.wfRevModal) dom.wfRevModal.hidden = false
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/revisions`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.wfRevList) dom.wfRevList.innerHTML = ''
        if (dom.wfRevMsg) {
          dom.wfRevMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.wfRevMsg.classList.add('err')
        }
        return
      }
      const body = await r.json()
      revRows = body.revisions || []
      // Current revision comes off the already-loaded card summary — no
      // extra round-trip needed.
      const w = wf.workflows.find((x) => x.id === id)
      renderRevisions(w?.currentRevision ?? null)
    } catch (err) {
      if (dom.wfRevList) dom.wfRevList.innerHTML = ''
      if (dom.wfRevMsg) {
        dom.wfRevMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfRevMsg.classList.add('err')
      }
    }
  }

  function closeWorkflowRevisionsModal() {
    if (dom.wfRevModal) dom.wfRevModal.hidden = true
  }

  function renderRevisions(current) {
    if (!dom.wfRevList) return
    if (revRows.length === 0) {
      dom.wfRevList.innerHTML = ''
      if (dom.wfRevEmpty) dom.wfRevEmpty.hidden = false
      return
    }
    if (dom.wfRevEmpty) dom.wfRevEmpty.hidden = true
    // Newest revision first.
    const rows = [...revRows].sort((a, b) => b.revision - a.revision)
    dom.wfRevList.innerHTML = rows.map((rev) => {
      const isCurrent = rev.revision === current
      const when = rev.createdAt ? new Date(rev.createdAt).toLocaleString() : ''
      const rolledFrom = rev.rolledBackFrom ? ` ← rev ${rev.rolledBackFrom}` : ''
      const hash = rev.contentHash
        ? `<code>${escapeHtml(String(rev.contentHash).slice(0, 10))}</code>`
        : ''
      const right = isCurrent
        ? `<span class="wf-state wf-state-published">${escapeHtml(t.workflowRevCurrent)}</span>`
        : `<button type="button" class="ma-btn ma-btn-secondary"
                   data-act="rollback-revision" data-id="${escapeHtml(revWorkflowId)}"
                   data-rev="${rev.revision}">${escapeHtml(t.workflowRevRollbackBtn)}</button>`
      return `<div class="wf-rev-row${isCurrent ? ' wf-rev-current' : ''}">
        <span class="wf-rev-tag">${escapeHtml(t.workflowRevTag(rev.revision))}</span>
        <span>
          <span class="wf-rev-origin">${escapeHtml(t.workflowRevOrigin(rev.origin || ''))}${escapeHtml(rolledFrom)}</span>
          ${hash}
          <small class="hint">${escapeHtml(when)}</small>
        </span>
        ${right}
      </div>`
    }).join('')
  }

  // POST /api/admin/workflows/:id/rollback { targetRevision }. Append-only:
  // clones the target as a new head revision and re-points current to it.
  async function rollbackTo(id, rev) {
    if (!confirm(t.confirmRollback(id, rev))) return
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetRevision: rev }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.wfRevMsg) {
          dom.wfRevMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.wfRevMsg.classList.add('err')
        }
        return
      }
      await refreshWorkflows() // card now shows the new currentRevision
      await openWorkflowRevisionsModal(id) // re-render with the appended revision
    } catch (err) {
      if (dom.wfRevMsg) {
        dom.wfRevMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfRevMsg.classList.add('err')
      }
    }
  }

  // --- workflow import (YAML paste / file) -------------------------------

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

  return {
    setDom,
    refreshWorkflows,
    renderWorkflows,
    removeWorkflow,
    lifecycleAction,
    openWorkflowRevisionsModal,
    closeWorkflowRevisionsModal,
    rollbackTo,
    openWorkflowImportModal,
    closeWorkflowImportModal,
    submitWorkflowImport,
    openWorkflowRunsModal,
    closeWorkflowRunsModal,
    openWorkflowRunDetail,
  }
}
