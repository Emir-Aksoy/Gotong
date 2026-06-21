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
      // Phase 15 — lifecycle state badge + current revision. The list now
      // includes non-live workflows too (draft / review / archived), so the
      // gated buttons + the "开始" run button below switch on `state`.
      const state = w.state || 'published'
      const isLive = state === 'published' || state === 'deprecated'
      const stateBadge = `<span class="wf-state wf-state-${escapeHtml(state)}">${escapeHtml(t.workflowStateLabel(state))}</span>`
      const revTag = w.currentRevision
        ? `<span class="wf-rev-tag">${escapeHtml(t.workflowRevTag(w.currentRevision))}</span>`
        : ''
      // "开始" runs the workflow — only meaningful for a live (registered)
      // workflow. A draft / review / archived one has no runner on the Hub,
      // so the run button is hidden; publishing it first is the path to a run.
      const startBtn = isLive
        ? `<button type="button" class="ma-btn" data-act="start-workflow" data-id="${escapeHtml(w.id)}">${escapeHtml(t.admStart)}</button>`
        : ''
      return `<article class="ma-card">
        <header>
          <strong>${name}</strong>
          <code>${escapeHtml(w.participantId)}</code>
          ${stateBadge}${revTag}
          ${startBtn}
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="open-workflow-runs"
                  data-id="${escapeHtml(w.id)}">${escapeHtml(t.workflowRunsBtn)}</button>
          <button type="button" class="ma-btn ma-btn-secondary"
                  data-act="open-workflow-graph"
                  data-id="${escapeHtml(w.id)}">${escapeHtml(t.workflowGraphBtn)}</button>
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
        ${crossHubPanel(w.crossHubSteps)}
        ${governancePanel(w.governance)}
        ${file}
      </article>`
    }).join('')
  }

  // Stream G day-2 — cross-hub steps panel. A step whose capability is served
  // by a connected PEER hub (not locally) routes across the federation boundary
  // through the outbound-approval gate; if that peer requires approval,
  // launching will park an item in your inbox. Surfaced on the card so "this
  // leaves the hub, and to whom" is visible at the launch decision — not buried
  // in the YAML. Pure visibility; gates nothing.
  function crossHubPanel(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return ''
    const rows = steps.map((s) => {
      const dest = s.peerLabel || s.peer
      // Stream H — distinguish the destination: an external A2A agent fires
      // immediately (no approval gate), a mesh peer may gate for inbox approval.
      const label =
        s.kind === 'a2a' ? t.workflowCrossHubA2a(String(dest)) : t.workflowCrossHubPeer(String(dest))
      return (
        `<li><code>${escapeHtml(String(s.stepId))}</code> → ` +
        `<code>${escapeHtml(String(s.capability))}</code> ` +
        `<span class="wf-xhub-peer">${escapeHtml(label)}</span></li>`
      )
    })
    return (
      `<details class="wf-xhub"><summary>${escapeHtml(t.workflowCrossHubSummary(steps.length))}</summary>` +
      `<ul class="ma-meta">${rows.join('')}</ul></details>`
    )
  }

  // Phase 19 P5-M8b — risk summary panel from the workflow's `governance`
  // block. Rendered on the card so the risk ("touches PII, needs this key,
  // costs ~$X, needs a human sign-off") is visible at review/publish decision
  // time — not buried in the YAML. Declarative only; it gates nothing.
  function govChips(arr) {
    return arr.map((x) => `<span class="wf-gov-chip">${escapeHtml(String(x))}</span>`).join(' ')
  }
  function governancePanel(g) {
    if (!g || typeof g !== 'object') return ''
    const rows = []
    if (g.dataSensitivity) {
      rows.push(
        `<li><span class="ma-label">${escapeHtml(t.workflowGovSensitivity)}:</span> ` +
          `<span class="wf-gov-sens wf-gov-sens-${escapeHtml(g.dataSensitivity)}">` +
          `${escapeHtml(t.workflowGovSensitivityLabel(g.dataSensitivity))}</span></li>`,
      )
    }
    if (Array.isArray(g.requiredCredentials) && g.requiredCredentials.length) {
      rows.push(`<li><span class="ma-label">${escapeHtml(t.workflowGovCredentials)}:</span> ${govChips(g.requiredCredentials)}</li>`)
    }
    if (typeof g.expectedCostUsd === 'number') {
      rows.push(`<li><span class="ma-label">${escapeHtml(t.workflowGovCost)}:</span> <code>$${escapeHtml(String(g.expectedCostUsd))}</code></li>`)
    }
    if (Array.isArray(g.requiredHumanRoles) && g.requiredHumanRoles.length) {
      rows.push(`<li><span class="ma-label">${escapeHtml(t.workflowGovHumanRoles)}:</span> ${govChips(g.requiredHumanRoles)}</li>`)
    }
    if (Array.isArray(g.externalSystems) && g.externalSystems.length) {
      rows.push(`<li><span class="ma-label">${escapeHtml(t.workflowGovExternal)}:</span> ${govChips(g.externalSystems)}</li>`)
    }
    if (g.notes) rows.push(`<li class="wf-gov-notes">${escapeHtml(g.notes)}</li>`)
    if (!rows.length) return ''
    return (
      `<details class="wf-gov"><summary>${escapeHtml(t.workflowGovSummary)}</summary>` +
      `<ul class="ma-meta">${rows.join('')}</ul></details>`
    )
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
  // The list shows every state now. Each card's buttons are exactly the legal
  // transitions out of its state (mirrors the host lifecycle state machine):
  //   draft      → 提交审核 (review) + 发布 (publish)
  //   review     → 发布 (publish) + 退回草稿 (backToDraft)
  //   published  → 弃用 (deprecate)
  //   deprecated → 重新发布 (publish, un-deprecate) + 归档 (archive)
  //   archived   → (terminal — revision history only)
  //   all        → 修订历史 (revision list + rollback)

  function lifecycleButtons(id, state) {
    const idAttr = escapeHtml(id)
    const btn = (act, label) =>
      `<button type="button" class="ma-btn ma-btn-secondary"
               data-act="${act}" data-id="${idAttr}">${escapeHtml(label)}</button>`
    const revisions = btn('open-workflow-revisions', t.workflowRevisionsBtn)
    if (state === 'draft') {
      return btn('submit-review-workflow', t.workflowSubmitReviewBtn) +
        btn('publish-workflow', t.workflowPublishBtn) + revisions
    }
    if (state === 'review') {
      return btn('publish-workflow', t.workflowPublishBtn) +
        btn('back-to-draft-workflow', t.workflowBackToDraftBtn) + revisions
    }
    if (state === 'archived') {
      // Terminal: only the revision history stays inspectable.
      return revisions
    }
    if (state === 'deprecated') {
      return btn('republish-workflow', t.workflowRepublishBtn) +
        btn('archive-workflow', t.workflowArchiveBtn) + revisions
    }
    // published (the import default)
    return btn('deprecate-workflow', t.workflowDeprecateBtn) + revisions
  }

  // POST /api/admin/workflows/:id/{review|draft|publish|deprecate|archive}.
  // `publish` with no body promotes the head revision (a draft/review goes
  // live, or a deprecated one un-deprecates). The card re-renders from the
  // refreshed list afterward.
  async function lifecycleAction(id, action) {
    const ask = {
      review: t.confirmSubmitReview,
      draft: t.confirmBackToDraft,
      deprecate: t.confirmDeprecateWorkflow,
      publish: t.confirmPublishWorkflow,
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
    // P2-M4 — the governance audit sub-section loads independently of the
    // revision fetch (separate endpoint, separate gate), so fire it here and
    // don't let a revision-fetch error path skip it.
    void loadWorkflowAudit(id)
    // P2-M5c — access-control sub-section is likewise independent + owner-gated.
    void loadWorkflowGrants(id)
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

  // --- DAG-M4 — read-only flow chart (graph) viewer ----------------------
  //
  // A WorkflowDefinition is ALREADY a DAG (trigger → steps → parallel
  // branches → output). The host's `GET /:id/graph` returns a PURE
  // { nodes, edges } projection (and stamps cross-hub marks from its
  // federation view); this lays it out and hand-draws SVG (no chart library,
  // mirroring the peer-summary sparkline). Pure visibility — it never touches
  // the YAML, which stays the governance / version-control root.

  async function openWorkflowGraphModal(id) {
    if (dom.wfGraphTarget) dom.wfGraphTarget.textContent = id
    if (dom.wfGraphMsg) {
      dom.wfGraphMsg.textContent = ''
      dom.wfGraphMsg.classList.remove('ok', 'err')
    }
    if (dom.wfGraphBody) dom.wfGraphBody.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    if (dom.wfGraphModal) dom.wfGraphModal.hidden = false
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/graph`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.wfGraphBody) dom.wfGraphBody.innerHTML = ''
        if (dom.wfGraphMsg) {
          dom.wfGraphMsg.textContent = t.workflowGraphError(body.error || `${r.status}`)
          dom.wfGraphMsg.classList.add('err')
        }
        return
      }
      const graph = (await r.json()).graph
      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        if (dom.wfGraphBody) dom.wfGraphBody.innerHTML = `<p class="hint">${escapeHtml(t.workflowGraphEmpty)}</p>`
        return
      }
      if (dom.wfGraphBody) {
        dom.wfGraphBody.innerHTML =
          `<div class="wf-graph-scroll">${renderWorkflowGraphSvg(graph)}</div>` + graphLegend()
      }
    } catch (err) {
      if (dom.wfGraphBody) dom.wfGraphBody.innerHTML = ''
      if (dom.wfGraphMsg) {
        dom.wfGraphMsg.textContent = t.workflowGraphError(err.message || String(err))
        dom.wfGraphMsg.classList.add('err')
      }
    }
  }

  function closeWorkflowGraphModal() {
    if (dom.wfGraphModal) dom.wfGraphModal.hidden = true
  }

  function graphLegend() {
    return (
      `<div class="wf-graph-legend">` +
      `<span class="wf-graph-legend-seq">${escapeHtml(t.workflowGraphLegendSeq)}</span>` +
      `<span class="wf-graph-legend-data">${escapeHtml(t.workflowGraphLegendData)}</span>` +
      `</div>`
    )
  }

  // Pure: a { nodes, edges } graph → a hand-drawn SVG string. The node array
  // out of projectWorkflowGraph is already a renderable vertical stack
  // (trigger, [parallel container, its branches...], step, ..., output): every
  // node gets its own row; backbone nodes sit in column 0 and a parallel step's
  // branch nodes indent to column 1.
  function renderWorkflowGraphSvg(graph) {
    const MARGIN_X = 92, MARGIN_Y = 30, ROW_H = 100, COL_W = 250
    const BOX_W = 224, BRANCH_W = 198, BOX_H = 62, RIGHT_PAD = 56
    const boxW = (node) => (node.kind === 'branch' ? BRANCH_W : BOX_W)

    const pos = new Map()
    let row = 0, maxCol = 0
    for (const node of graph.nodes) {
      const col = node.kind === 'branch' ? 1 : 0
      if (col > maxCol) maxCol = col
      pos.set(node.id, { col, row, node })
      row++
    }
    const left = (p) => MARGIN_X + p.col * COL_W
    const cx = (p) => left(p) + boxW(p.node) / 2
    const top = (p) => MARGIN_Y + p.row * ROW_H
    const bottom = (p) => top(p) + BOX_H
    const midY = (p) => top(p) + BOX_H / 2
    const width = MARGIN_X + maxCol * COL_W + BOX_W + RIGHT_PAD
    const height = MARGIN_Y * 2 + row * ROW_H

    const clip = (s, n) => {
      s = String(s == null ? '' : s)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    const destText = (node) => {
      const d = node.destination
      if (!d) return ''
      if (d.kind === 'explicit') return t.workflowGraphDestExplicit(d.to || '')
      if (d.kind === 'broadcast') return t.workflowGraphDestBroadcast((d.capabilities || []).join(', '))
      return t.workflowGraphDestCapability((d.capabilities || []).join(', '))
    }

    // Edges. Data edges draw FIRST (under the boxes — boxes are opaque, so a
    // data edge passing behind an intervening box is occluded, reading as a
    // clean connector). Sequence (backbone + fan-out) draws on top of them;
    // boxes draw last.
    const dataEdges = [], seqEdges = []
    for (const e of graph.edges || []) {
      const a = pos.get(e.from), b = pos.get(e.to)
      if (!a || !b) continue
      if (e.kind === 'data') {
        // Dashed bow into the LEFT gutter, anchored on both boxes' left edge —
        // off the solid backbone (which runs down the box centers).
        const x1 = left(a), y1 = midY(a), x2 = left(b), y2 = midY(b)
        const apex = Math.min(x1, x2) - 30
        const my = (y1 + y2) / 2
        dataEdges.push(
          `<path d="M ${x1} ${y1} Q ${apex} ${my}, ${x2} ${y2}" class="wf-graph-edge-data" marker-end="url(#wf-graph-arrow-data)" />`,
        )
      } else if (b.node.kind === 'branch') {
        // Container (col 0) → branch (col 1): bottom-center of the container,
        // elbow into the LEFT-center of the branch box.
        const x1 = cx(a), y1 = bottom(a), x2 = left(b), y2 = midY(b)
        seqEdges.push(
          `<path d="M ${x1} ${y1} C ${x1} ${y1 + 26}, ${x2 - 40} ${y2}, ${x2} ${y2}" class="wf-graph-edge-seq" marker-end="url(#wf-graph-arrow)" />`,
        )
      } else {
        // Backbone vertical (col 0 → col 0): straight down (may visually skip
        // the rows a parallel step's branches occupy in column 1).
        seqEdges.push(
          `<path d="M ${cx(a)} ${bottom(a)} L ${cx(b)} ${top(b)}" class="wf-graph-edge-seq" marker-end="url(#wf-graph-arrow)" />`,
        )
      }
    }

    const boxes = graph.nodes
      .map((node) => {
        const p = pos.get(node.id)
        const w = boxW(node), x = left(p), y = top(p)
        const cls = 'wf-graph-box wf-graph-box-' + node.kind + (node.crossHub ? ' wf-graph-box-xhub' : '')
        const title = node.kind === 'output' ? t.workflowGraphOutput : node.label
        const tag =
          node.kind === 'parallel' ? t.workflowGraphParallel
          : node.kind === 'branch' ? t.workflowGraphBranch
          : node.kind === 'trigger' ? t.workflowGraphTrigger
          : ''
        const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${BOX_H}" rx="8" class="${cls}" />`]
        if (tag) {
          parts.push(`<text x="${x + w - 8}" y="${y + 15}" text-anchor="end" class="wf-graph-tag">${escapeHtml(tag)}</text>`)
        }
        parts.push(`<text x="${x + 12}" y="${y + 25}" class="wf-graph-title">${escapeHtml(clip(title, 26))}</text>`)
        if (node.kind === 'step' || node.kind === 'branch') {
          let sub = destText(node)
          const extras = []
          if (node.readsTrigger) extras.push(t.workflowGraphReadsTrigger)
          if (Array.isArray(node.dataClasses) && node.dataClasses.length) extras.push(node.dataClasses.join('/'))
          if (extras.length) sub = sub ? sub + ' · ' + extras.join(' · ') : extras.join(' · ')
          if (sub) parts.push(`<text x="${x + 12}" y="${y + 43}" class="wf-graph-sub">${escapeHtml(clip(sub, 36))}</text>`)
        }
        let ay = bottom(p) + 14
        if (node.when) {
          parts.push(`<text x="${x + 2}" y="${ay}" class="wf-graph-when">${escapeHtml(clip(t.workflowGraphWhen(node.when), 42))}</text>`)
          ay += 14
        }
        if (node.crossHub) {
          const dest = node.crossHub.peerLabel || node.crossHub.peer
          parts.push(`<text x="${x + 2}" y="${ay}" class="wf-graph-xhub-tag">${escapeHtml(clip(t.workflowGraphCrossHub(dest), 42))}</text>`)
        }
        return parts.join('')
      })
      .join('')

    const defs =
      `<defs>` +
      `<marker id="wf-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-graph-arrowhead" /></marker>` +
      `<marker id="wf-graph-arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-graph-arrowhead-data" /></marker>` +
      `</defs>`

    return (
      `<svg class="wf-graph-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="workflow graph">` +
      defs + dataEdges.join('') + seqEdges.join('') + boxes +
      `</svg>`
    )
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

  // --- governance audit (Phase 19 P2-M4) ---------------------------------
  //
  // Co-located in the revision modal: "this workflow's history" = revisions
  // (WHAT changed) + audit (WHO changed it, WHEN). Backed by the owner-gated
  // /api/admin/identity/audit/workflows route, so a non-owner admin gets a
  // graceful "owner only" notice rather than rows. The action <select> +
  // 查询 button re-query; the export links carry the same filters.

  let auditWorkflowId = null

  function setAuditExportLinks(id, action) {
    if (!dom.wfAuditCsv || !dom.wfAuditJsonl) return
    const base = `/api/admin/identity/audit/workflows/export?workflowId=${encodeURIComponent(id)}`
    const actionQs = action ? `&action=${encodeURIComponent(action)}` : ''
    dom.wfAuditCsv.href = `${base}&format=csv${actionQs}`
    dom.wfAuditJsonl.href = `${base}&format=jsonl${actionQs}`
  }

  async function loadWorkflowAudit(id) {
    auditWorkflowId = id
    if (dom.wfAuditAction) dom.wfAuditAction.value = '' // reset filter on open
    if (dom.wfAuditMsg) {
      dom.wfAuditMsg.textContent = ''
      dom.wfAuditMsg.classList.remove('ok', 'err')
    }
    if (dom.wfAuditEmpty) dom.wfAuditEmpty.hidden = true
    if (dom.wfAuditExport) dom.wfAuditExport.hidden = true
    if (dom.wfAuditList) dom.wfAuditList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    await fetchWorkflowAudit(id, '')
  }

  // Wired to the 查询 button (data-act="refresh-workflow-audit") — re-pulls
  // with whatever the action <select> currently holds.
  async function refreshWorkflowAudit() {
    if (!auditWorkflowId) return
    if (dom.wfAuditMsg) {
      dom.wfAuditMsg.textContent = ''
      dom.wfAuditMsg.classList.remove('ok', 'err')
    }
    if (dom.wfAuditList) dom.wfAuditList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    await fetchWorkflowAudit(auditWorkflowId, dom.wfAuditAction ? dom.wfAuditAction.value : '')
  }

  async function fetchWorkflowAudit(id, action) {
    const qs = action ? `&action=${encodeURIComponent(action)}` : ''
    try {
      const r = await fetch(
        `/api/admin/identity/audit/workflows?workflowId=${encodeURIComponent(id)}${qs}`,
      )
      if (!r.ok) {
        // 403 = non-owner admin; 503 = host without an identity store. Either
        // way the revisions above still work — degrade this section only.
        if (dom.wfAuditList) dom.wfAuditList.innerHTML = ''
        if (dom.wfAuditExport) dom.wfAuditExport.hidden = true
        if (dom.wfAuditMsg) {
          dom.wfAuditMsg.textContent =
            r.status === 403 ? t.workflowAuditOwnerOnly : t.workflowAuditUnavailable
          dom.wfAuditMsg.classList.add('err')
        }
        return
      }
      const body = await r.json()
      const entries = body.entries || []
      renderWorkflowAudit(entries)
      setAuditExportLinks(id, action)
      if (dom.wfAuditExport) dom.wfAuditExport.hidden = entries.length === 0
    } catch (err) {
      if (dom.wfAuditList) dom.wfAuditList.innerHTML = ''
      if (dom.wfAuditMsg) {
        dom.wfAuditMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfAuditMsg.classList.add('err')
      }
    }
  }

  function renderWorkflowAudit(rows) {
    if (!dom.wfAuditList) return
    if (rows.length === 0) {
      dom.wfAuditList.innerHTML = ''
      if (dom.wfAuditEmpty) dom.wfAuditEmpty.hidden = false
      return
    }
    if (dom.wfAuditEmpty) dom.wfAuditEmpty.hidden = true
    dom.wfAuditList.innerHTML = rows
      .map((e) => {
        const when = e.ts ? new Date(e.ts).toLocaleString() : ''
        const actor = e.actorUserId ? escapeHtml(e.actorUserId) : '—'
        const meta = e.metadata || {}
        const rev = meta.revision != null ? `rev ${escapeHtml(String(meta.revision))}` : ''
        const actionShort = escapeHtml(String(e.action || '').replace(/^workflow_/, ''))
        return `<div class="wf-audit-row">
          <span class="wf-audit-action-tag">${actionShort}</span>
          <span class="wf-audit-actor">${actor}</span>
          <span class="wf-audit-rev">${rev}</span>
          <small class="hint">${escapeHtml(when)}</small>
        </div>`
      })
      .join('')
  }

  // --- access control / resource RBAC grants (Phase 19 P2-M5c) -----------
  //
  // Co-located in the revision modal, below the audit. Backed by the
  // owner-gated /api/admin/workflows/:id/grants routes. A non-owner admin
  // gets 403 → "owner only" notice (no list/form); a host without an
  // identity store gets 404 → "not enabled" notice. Operators (org owner /
  // v3 admin) manage by bypass, so the form works for them on any workflow.

  let grantsWorkflowId = null

  function setGrantsNotice(key) {
    // Hide the list + add form, show one notice line. Used for 403 / 404.
    if (dom.wfGrantsList) dom.wfGrantsList.innerHTML = ''
    if (dom.wfGrantsEmpty) dom.wfGrantsEmpty.hidden = true
    if (dom.wfGrantsAdd) dom.wfGrantsAdd.hidden = true
    if (dom.wfGrantsMsg) {
      dom.wfGrantsMsg.textContent = t[key] || ''
      dom.wfGrantsMsg.classList.remove('ok')
      dom.wfGrantsMsg.classList.add('err')
    }
  }

  async function loadWorkflowGrants(id) {
    grantsWorkflowId = id
    if (dom.wfGrantsMsg) {
      dom.wfGrantsMsg.textContent = ''
      dom.wfGrantsMsg.classList.remove('ok', 'err')
    }
    if (dom.wfGrantsAdd) dom.wfGrantsAdd.hidden = false
    if (dom.wfGrantsEmpty) dom.wfGrantsEmpty.hidden = true
    if (dom.wfGrantsList) dom.wfGrantsList.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    await fetchWorkflowGrants(id)
  }

  // Wired to the 刷新 button (data-act="refresh-workflow-grants").
  async function refreshWorkflowGrants() {
    if (!grantsWorkflowId) return
    await loadWorkflowGrants(grantsWorkflowId)
  }

  async function fetchWorkflowGrants(id) {
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(id)}/grants`)
      if (!r.ok) {
        // 403 = non-owner admin; 404 = host without resource RBAC. The
        // revisions + audit above still work — degrade this section only.
        setGrantsNotice(r.status === 403 ? 'workflowGrantsOwnerOnly' : 'workflowGrantsUnavailable')
        return
      }
      const body = await r.json()
      renderWorkflowGrants(body.grants || [])
    } catch (err) {
      if (dom.wfGrantsList) dom.wfGrantsList.innerHTML = ''
      if (dom.wfGrantsMsg) {
        dom.wfGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfGrantsMsg.classList.add('err')
      }
    }
  }

  function renderWorkflowGrants(rows) {
    if (!dom.wfGrantsList) return
    if (rows.length === 0) {
      dom.wfGrantsList.innerHTML = ''
      if (dom.wfGrantsEmpty) dom.wfGrantsEmpty.hidden = false
      return
    }
    if (dom.wfGrantsEmpty) dom.wfGrantsEmpty.hidden = true
    dom.wfGrantsList.innerHTML = rows
      .map((g) => {
        const user = escapeHtml(g.userId)
        const perm = escapeHtml(g.perm)
        return `<div class="wf-grant-row">
          <span class="wf-grant-user-id">${user}</span>
          <span class="wf-grant-perm-tag wf-grant-perm-${perm}">${perm}</span>
          <button type="button" class="ma-btn ma-btn-secondary ma-danger wf-grant-remove"
                  data-act="remove-workflow-grant" data-user="${user}"
                  >${escapeHtml(t.workflowGrantsRemove)}</button>
        </div>`
      })
      .join('')
  }

  // Wired to the 授权 button (data-act="add-workflow-grant").
  async function addWorkflowGrant() {
    if (!grantsWorkflowId) return
    const userId = dom.wfGrantUser ? dom.wfGrantUser.value.trim() : ''
    const perm = dom.wfGrantPerm ? dom.wfGrantPerm.value : 'viewer'
    if (dom.wfGrantsMsg) {
      dom.wfGrantsMsg.textContent = ''
      dom.wfGrantsMsg.classList.remove('ok', 'err')
    }
    if (!userId) {
      if (dom.wfGrantsMsg) {
        dom.wfGrantsMsg.textContent = t.workflowGrantsNeedUser
        dom.wfGrantsMsg.classList.add('err')
      }
      return
    }
    try {
      const r = await fetch(`/api/admin/workflows/${encodeURIComponent(grantsWorkflowId)}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, perm }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.wfGrantsMsg) {
          dom.wfGrantsMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.wfGrantsMsg.classList.add('err')
        }
        return
      }
      const body = await r.json()
      if (dom.wfGrantUser) dom.wfGrantUser.value = ''
      renderWorkflowGrants(body.grants || [])
    } catch (err) {
      if (dom.wfGrantsMsg) {
        dom.wfGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfGrantsMsg.classList.add('err')
      }
    }
  }

  // Wired to per-row 撤销 buttons (data-act="remove-workflow-grant").
  async function removeWorkflowGrant(userId) {
    if (!grantsWorkflowId || !userId) return
    try {
      const r = await fetch(
        `/api/admin/workflows/${encodeURIComponent(grantsWorkflowId)}/grants/${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        if (dom.wfGrantsMsg) {
          dom.wfGrantsMsg.textContent = t.failedAlert(body.error || `${r.status}`)
          dom.wfGrantsMsg.classList.add('err')
        }
        return
      }
      // Re-pull so the (possibly now-empty) list re-renders consistently.
      await fetchWorkflowGrants(grantsWorkflowId)
    } catch (err) {
      if (dom.wfGrantsMsg) {
        dom.wfGrantsMsg.textContent = t.failedAlert(err.message || String(err))
        dom.wfGrantsMsg.classList.add('err')
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
      // Stream G day-3 — post-launch CONFIRMATION: the host annotated this step
      // with where it ACTUALLY ran when that was off this hub (resolved from the
      // persisted executedBy). The card's crossHubPanel was the PREDICTION; this
      // badge is what happened.
      //
      // day-4 — a cross-hub step that is still `suspended` is PARKED at the
      // outbound-approval gate, not "ran on" yet. Show the awaiting-approval
      // affordance (amber + inbox deep link) instead of the blue "ran on" badge;
      // the blue confirmation badge is only honest once the step left suspended.
      const awaiting = !!s.crossHub && s.status === 'suspended'
      const dest = s.crossHub ? String(s.crossHub.peerLabel || s.crossHub.peer) : ''
      const xhub = s.crossHub && !awaiting
        ? `<span class="wf-xhub-peer">${escapeHtml(
            t.workflowRunCrossHub(dest, s.crossHub.kind),
          )}</span>`
        : ''
      const awaitBlock = awaiting
        ? `<p class="wf-xhub-await">${escapeHtml(t.workflowRunAwaitingApproval(dest))} ` +
          `<a href="#home" class="wf-xhub-inbox-link">${escapeHtml(t.workflowRunGoToInbox)}</a></p>`
        : ''
      // day-5 — the transcript CHAIN. A cross-hub step that ran on a MESH peer
      // (NOT an external A2A agent — those have no peer.transcript rpc) and is no
      // longer parked can have the peer's OWN trace of that one task pulled on
      // demand. The button hits the per-step route; the result (or a fail-closed
      // reason) renders inline into the sibling .wf-peer-tx-out. Lazy by click so
      // the run detail stays cheap and we never fan out RPCs the user didn't ask
      // for. The button is text-only so the global click handler (which reads
      // e.target.dataset directly, no closest walk) resolves to it.
      const peerTx = s.crossHub && s.crossHub.kind !== 'a2a' && !awaiting
        ? `<div class="wf-peer-tx-box">
            <button type="button" class="wf-peer-tx-btn" data-act="view-peer-transcript"
                    data-run-id="${escapeHtml(run.runId)}" data-step-id="${escapeHtml(s.stepId)}">${escapeHtml(t.workflowRunPeerTranscriptBtn)}</button>
            <div class="wf-peer-tx-out"></div>
          </div>`
        : ''
      // PB — a parallel step has no step-level crossHub; the host resolves each
      // branch's destination into `branchCrossHub` (keyed by branch id, only
      // off-hub branches present). Render one badge per off-hub branch + a
      // per-branch transcript button (mesh peers only — A2A has no peer.transcript
      // rpc). The button carries data-branch-id so the click handler passes it to
      // the `?branch=` route. (A parallel step's branches never set step-level
      // executedBy, so the simple-step xhub/peerTx blocks above stay empty for it.)
      const branchBlock = s.branchCrossHub && Object.keys(s.branchCrossHub).length
        ? `<div class="wf-xhub-branches">${Object.entries(s.branchCrossHub).map(([branchId, ref]) => {
            const bDest = String(ref.peerLabel || ref.peer)
            const badge = `<span class="wf-xhub-peer">${escapeHtml(t.workflowRunBranchCrossHub(branchId, bDest, ref.kind))}</span>`
            const bTx = ref.kind !== 'a2a'
              ? `<div class="wf-peer-tx-box">
                  <button type="button" class="wf-peer-tx-btn" data-act="view-peer-transcript"
                          data-run-id="${escapeHtml(run.runId)}" data-step-id="${escapeHtml(s.stepId)}"
                          data-branch-id="${escapeHtml(branchId)}">${escapeHtml(t.workflowRunPeerTranscriptBtn)}</button>
                  <div class="wf-peer-tx-out"></div>
                </div>`
              : ''
            return `<div class="wf-xhub-branch">${badge}${bTx}</div>`
          }).join('')}</div>`
        : ''
      return `<article class="wf-step">
        <header>
          <span class="wf-run-status wf-run-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
          <strong>${escapeHtml(s.stepId)}</strong>
          <span class="wf-step-meta">${escapeHtml(sDur)} · ${escapeHtml(t.workflowRunAttempts(s.attempts || 1))}</span>
          ${xhub}
        </header>
        ${awaitBlock}
        ${err}
        ${subtasks}
        ${out}
        ${peerTx}
        ${branchBlock}
      </article>`
    }).join('')
    const payloadBlock = run.triggerPayload !== undefined
      ? `<details><summary>${escapeHtml(t.workflowRunTriggerPayload)}</summary><pre class="wf-pre">${escapeHtml(JSON.stringify(run.triggerPayload, null, 2))}</pre></details>`
      : ''
    // day-4 — run-level banner when a cross-hub step is parked at the
    // outbound-approval gate. The run's own status stays `running` (RunStatus
    // has no `suspended`), so a parked-needing-approval run is otherwise
    // indistinguishable from one still executing — derive the signal from the
    // step records instead.
    const awaitingDests = Array.from(new Set(
      (run.steps || [])
        .filter((s) => s.status === 'suspended' && s.crossHub)
        .map((s) => String(s.crossHub.peerLabel || s.crossHub.peer)),
    ))
    const parkedBanner = awaitingDests.length
      ? `<div class="wf-run-parked-banner">${escapeHtml(t.workflowRunParkedApproval(awaitingDests))} ` +
        `<a href="#home" class="wf-xhub-inbox-link">${escapeHtml(t.workflowRunGoToInbox)}</a></div>`
      : ''
    dom.wfRunDetail.innerHTML = `
      <h4>
        <span class="wf-run-status wf-run-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <code>${escapeHtml(run.runId)}</code>
      </h4>
      ${parkedBanner}
      <p class="hint">${escapeHtml(t.workflowRunDuration)}: ${escapeHtml(dur)} · ${escapeHtml(t.workflowRunTriggeredBy)}: <code>${escapeHtml(run.triggeredByTaskId)}</code></p>
      ${payloadBlock}
      ${steps || `<p class="empty">${escapeHtml(t.workflowRunNoSteps)}</p>`}
      ${finalBlock}
    `
  }

  // day-5 — render one cross-hub step's far-hub transcript slice. The shape is
  // the host's PeerTranscriptSlice: { hubId, taskId, events:[{seq,ts,kind,data}],
  // truncated }. We render a thin chronological list; `data` is shown verbatim so
  // the operator sees exactly what the peer recorded (no client-side reshaping).
  function renderPeerTranscriptSlice(slice) {
    if (!slice || !Array.isArray(slice.events) || slice.events.length === 0) {
      return `<p class="hint">${escapeHtml(t.workflowRunPeerTranscriptEmpty)}</p>`
    }
    const head = `<p class="hint">${escapeHtml(
      t.workflowRunPeerTranscriptHead(slice.hubId || '?', slice.taskId || '?'),
    )}${slice.truncated ? ' ' + escapeHtml(t.workflowRunPeerTranscriptTruncated) : ''}</p>`
    const rows = slice.events.map((ev) => {
      const ts = ev && ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''
      const data = ev && ev.data !== undefined
        ? `<pre class="wf-pre">${escapeHtml(
            typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data, null, 2),
          )}</pre>`
        : ''
      return `<li class="wf-peer-tx-ev"><span class="wf-peer-tx-kind">${escapeHtml(
        String((ev && ev.kind) || ''),
      )}</span> <span class="wf-step-meta">${escapeHtml(ts)}</span>${data}</li>`
    }).join('')
    return head + `<ul class="wf-peer-tx-list">${rows}</ul>`
  }

  // day-5 — lazily pull the far hub's transcript for ONE cross-hub step. Called
  // by the global click handler with the button's run/step ids + its sibling
  // output div. The route answers `{ok:true,slice}` or a typed `{ok:false,code}`
  // (fail-closed when the peer never opted into sharing); both render inline.
  async function viewPeerTranscript(runId, stepId, outEl, btnEl, branchId) {
    if (!outEl) return
    if (btnEl) btnEl.disabled = true
    outEl.innerHTML = `<p class="hint">${escapeHtml(t.loading)}</p>`
    try {
      // PB — a parallel branch's button carries a branchId; forward it as
      // `?branch=` so the host reads the per-branch executor/handle maps.
      const q = branchId ? `?branch=${encodeURIComponent(branchId)}` : ''
      const r = await fetch(
        `/api/admin/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/peer-transcript${q}`,
      )
      const body = await r.json().catch(() => ({}))
      if (r.ok && body && body.ok === true) {
        outEl.innerHTML = renderPeerTranscriptSlice(body.slice)
      } else if (body && body.ok === false && body.code) {
        // Typed verdict (incl. the 404'd unknown_run/unknown_step) — render the
        // localized reason rather than a bare status code.
        outEl.innerHTML = `<p class="form-msg err">${escapeHtml(t.workflowRunPeerTranscriptFail(body.code))}</p>`
      } else {
        // Host without a peer-link resolver answers 404 {error}; or any other
        // unexpected non-ok shape.
        outEl.innerHTML = `<p class="form-msg err">${escapeHtml(body.error || body.message || `${r.status}`)}</p>`
      }
    } catch (err) {
      outEl.innerHTML = `<p class="form-msg err">${escapeHtml(err.message || String(err))}</p>`
    } finally {
      if (btnEl) btnEl.disabled = false
    }
  }

  return {
    setDom,
    refreshWorkflows,
    renderWorkflows,
    removeWorkflow,
    lifecycleAction,
    openWorkflowRevisionsModal,
    closeWorkflowRevisionsModal,
    openWorkflowGraphModal,
    closeWorkflowGraphModal,
    rollbackTo,
    refreshWorkflowAudit,
    refreshWorkflowGrants,
    addWorkflowGrant,
    removeWorkflowGrant,
    openWorkflowImportModal,
    closeWorkflowImportModal,
    submitWorkflowImport,
    openWorkflowRunsModal,
    closeWorkflowRunsModal,
    openWorkflowRunDetail,
    viewPeerTranscript,
  }
}
