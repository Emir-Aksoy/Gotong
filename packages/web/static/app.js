/* AipeHub web UI — single-page client.
 *
 * Pulls a snapshot from /api/state on load, then streams incremental
 * HubEvents from /api/stream (SSE). Pending-human tasks render as
 * action cards with Approve / Reject buttons that POST to
 * /api/tasks/:id/(complete|reject).
 */
(() => {
  /** @typedef {{ id: string; kind: 'agent'|'human'; capabilities: string[]; load: number }} P */
  /** @typedef {{ taskId: string; assignedTo: string; title?: string; payload: unknown; createdAt: number }} Pend */

  const state = {
    /** @type {P[]} */ participants: [],
    /** @type {any[]} */ transcript: [],
    /** @type {Pend[]} */ pending: [],
  }

  const $ = (id) => document.getElementById(id)

  function setConn(status, label) {
    const el = $('conn')
    el.dataset.status = status
    el.textContent = label
  }

  // --- bootstrap ---------------------------------------------------------

  async function refresh() {
    const r = await fetch('/api/state')
    if (!r.ok) throw new Error(`/api/state ${r.status}`)
    const snap = await r.json()
    state.participants = snap.participants
    state.transcript = snap.transcript
    state.pending = snap.pending
    renderAll()
  }

  function connectStream() {
    const es = new EventSource('/api/stream')
    es.addEventListener('open', () => setConn('open', 'connected'))
    es.addEventListener('error', () => setConn('error', 'reconnecting…'))
    es.addEventListener('message', (e) => applyEvent(JSON.parse(e.data)))
    // SSE servers can send named events; we use the default 'message' channel
  }

  // --- event handling ----------------------------------------------------

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
        break
      case 'participant_left':
        state.participants = state.participants.filter((p) => p.id !== ev.data.id)
        state.pending = state.pending.filter((t) => t.assignedTo !== ev.data.id)
        break
      case 'task':
        // a task to a human becomes pending; the server's snapshot has the
        // ground truth, so re-fetch state. Cheap and avoids drift.
        refresh().catch((err) => console.error('refresh after task failed:', err))
        return
      case 'task_result':
        state.pending = state.pending.filter((t) => t.taskId !== ev.data.taskId)
        break
    }
    renderAll()
  }

  // --- rendering ---------------------------------------------------------

  function renderAll() {
    renderParticipants()
    renderTranscript()
    renderPending()
  }

  function renderParticipants() {
    const root = $('participants-list')
    root.innerHTML = ''
    if (state.participants.length === 0) {
      root.innerHTML = '<p class="empty">no participants</p>'
      return
    }
    for (const p of state.participants) {
      const div = document.createElement('div')
      div.className = `participant participant-${p.kind}`
      const caps = (p.capabilities || [])
        .map((c) => `<span class="cap">${escapeHtml(c)}</span>`)
        .join('') || '<em class="empty">no caps</em>'
      div.innerHTML =
        `<div class="p-head">` +
          `<span class="p-kind">${p.kind}</span>` +
          `<span class="p-id">${escapeHtml(p.id)}</span>` +
          `<span class="p-load">load ${p.load}</span>` +
        `</div>` +
        `<div class="p-caps">${caps}</div>`
      root.appendChild(div)
    }
  }

  function renderTranscript() {
    const root = $('transcript-list')
    $('transcript-count').textContent = String(state.transcript.length)
    root.innerHTML = ''
    // newest first
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      const e = state.transcript[i]
      const li = document.createElement('li')
      li.className = `entry entry-${e.kind}` + (isBadResult(e) ? ' bad' : '')
      li.innerHTML =
        `<span class="seq">${e.seq}</span>` +
        `<span class="kind">${e.kind}</span>` +
        `<span class="body">${escapeHtml(summarize(e))}</span>`
      root.appendChild(li)
    }
  }

  function renderPending() {
    const root = $('pending-list')
    root.innerHTML = ''
    if (state.pending.length === 0) {
      root.innerHTML = '<p class="empty">no pending tasks</p>'
      return
    }
    for (const t of state.pending) {
      const card = document.createElement('div')
      card.className = 'pending-card'
      card.innerHTML =
        `<div class="t-head">` +
          `<span class="t-title">${escapeHtml(t.title || '(untitled)')}</span>` +
          `<span class="t-to">→ ${escapeHtml(t.assignedTo)}</span>` +
        `</div>` +
        `<pre class="t-payload">${escapeHtml(JSON.stringify(t.payload, null, 2))}</pre>` +
        `<div class="t-actions">` +
          `<button data-act="complete" data-id="${escapeHtml(t.taskId)}">Approve</button>` +
          `<button data-act="reject" data-id="${escapeHtml(t.taskId)}">Reject</button>` +
        `</div>`
      root.appendChild(card)
    }
  }

  // --- summary / utility -------------------------------------------------

  function summarize(e) {
    switch (e.kind) {
      case 'participant_joined':
        return `${e.data.id} (${e.data.participantKind}) caps=[${(e.data.capabilities||[]).join(',')}]`
      case 'participant_left':
        return e.data.id
      case 'message':
        return `${e.data.from} → #${e.data.channel}`
      case 'task': {
        const s = e.data.strategy
        const target =
          s.kind === 'explicit'   ? `to=${s.to}`
        : s.kind === 'capability' ? `caps=[${s.capabilities.join(',')}]`
        :                            'broadcast'
        return `${e.data.from} "${e.data.title || ''}" via ${s.kind} ${target}`
      }
      case 'task_result': {
        const r = e.data
        if (r.kind === 'ok')        return `ok by ${r.by}`
        if (r.kind === 'failed')    return `failed by ${r.by}: ${r.error}`
        if (r.kind === 'cancelled') return `cancelled: ${r.reason}`
        return `no_participant: ${r.reason}`
      }
    }
    return ''
  }

  function isBadResult(e) {
    return e.kind === 'task_result' &&
      (e.data.kind === 'failed' || e.data.kind === 'no_participant')
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c])
  }

  // --- button clicks -----------------------------------------------------

  document.addEventListener('click', async (e) => {
    const t = e.target
    if (!(t instanceof HTMLButtonElement)) return
    const act = t.dataset.act
    const id = t.dataset.id
    if (!act || !id) return
    t.disabled = true
    try {
      const body = act === 'complete'
        ? { output: { approved: true, source: 'web-ui' } }
        : { error: 'rejected via web UI' }
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/${act}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(`failed: ${j.error || r.statusText}`)
        t.disabled = false
      }
      // success: SSE 'task_result' removes the card
    } catch (err) {
      alert(`error: ${err && err.message ? err.message : err}`)
      t.disabled = false
    }
  })

  // --- go ---------------------------------------------------------------

  refresh()
    .catch((err) => {
      console.error('initial refresh failed:', err)
      setConn('error', 'cannot reach server')
    })
    .finally(connectStream)
})()
