/* AipeHub — worker view.
 *
 * Workflow:
 *   1. User submits join form -> POST /api/workers
 *   2. Server creates a HumanParticipant; client remembers `myId`.
 *   3. On disconnect/refresh: my participant lingers on the hub. Worker can
 *      reclaim by re-entering the same nickname (gets 409 then DELETE+retry).
 *      For v1.1 we just store myId in sessionStorage so reloads continue to
 *      "be" that worker, and the Leave button calls DELETE /api/workers/:id.
 */
(() => {
  const { $, t, applyStaticI18n, onLangChange, escapeHtml, summarize, isBadResult,
          fetchJson, connectStream } = window.AipeHub

  const state = {
    participants: [],
    transcript: [],
    pending: [],          // all human-bound pending tasks (we filter to me when rendering)
    myId: null,
  }

  const ME_KEY = 'aipehub.worker.id'

  function getMyId() {
    try { return sessionStorage.getItem(ME_KEY) || null } catch { return null }
  }
  function setMyId(id) {
    try {
      if (id) sessionStorage.setItem(ME_KEY, id)
      else sessionStorage.removeItem(ME_KEY)
    } catch { /* ignore */ }
    state.myId = id
  }

  // --- DOM refs (resolved on DOMContentLoaded) ---------------------------
  let dom = null

  function resolveDom() {
    dom = {
      overlay: $('join-overlay'),
      form: $('join-form'),
      joinId: $('join-id'),
      joinCaps: $('join-caps'),
      joinError: $('join-error'),
      leaveBtn: $('leave-btn'),
      meLabel: $('me-label'),
      roleBadge: $('role-badge'),
      myTasksList: $('my-tasks-list'),
      participantsList: $('participants-list'),
      transcriptList: $('transcript-list'),
      transcriptCount: $('transcript-count'),
    }
  }

  // --- bootstrap ---------------------------------------------------------

  async function refresh() {
    const snap = await fetchJson('/api/state')
    state.participants = snap.participants
    state.transcript = snap.transcript
    state.pending = snap.pending
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
        break
      case 'participant_left':
        state.participants = state.participants.filter((p) => p.id !== ev.data.id)
        state.pending = state.pending.filter((task) => task.assignedTo !== ev.data.id)
        if (state.myId === ev.data.id) {
          // somebody (or some other tab) leaved us
          setMyId(null)
          showJoinForm()
        }
        break
      case 'task':
        refresh().catch((err) => console.error('refresh after task failed:', err))
        return
      case 'task_result':
        state.pending = state.pending.filter((task) => task.taskId !== ev.data.taskId)
        break
    }
    renderAll()
  }

  // --- view switching -----------------------------------------------------

  function showJoinForm() {
    dom.overlay.hidden = false
    dom.leaveBtn.hidden = true
    dom.meLabel.hidden = true
    dom.roleBadge.hidden = true
  }

  function showWorkbench() {
    dom.overlay.hidden = true
    dom.leaveBtn.hidden = false
    dom.meLabel.hidden = false
    dom.roleBadge.hidden = false
    const me = state.participants.find((p) => p.id === state.myId)
    const caps = me ? (me.capabilities || []).join(',') : ''
    dom.meLabel.textContent = caps
      ? `${state.myId} · ${caps}`
      : state.myId || ''
  }

  // --- rendering ----------------------------------------------------------

  function renderAll() {
    if (!dom) return
    if (state.myId) showWorkbench()
    else showJoinForm()
    renderParticipants()
    renderMyTasks()
    renderTranscript()
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
      const meCls = p.id === state.myId ? ' participant-me' : ''
      div.className = `participant participant-${p.kind}${meCls}`
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

  function renderMyTasks() {
    const root = dom.myTasksList
    root.innerHTML = ''
    const mine = state.myId
      ? state.pending.filter((task) => task.assignedTo === state.myId)
      : []
    if (mine.length === 0) {
      root.innerHTML = `<p class="empty">${escapeHtml(state.myId ? t.noMyTasks : t.noPending)}</p>`
      return
    }
    for (const task of mine) {
      const card = document.createElement('div')
      card.className = 'pending-card'
      card.innerHTML =
        `<div class="t-head">` +
          `<span class="t-title">${escapeHtml(task.title || t.untitled)}</span>` +
          `<span class="t-to">→ ${escapeHtml(task.assignedTo)}</span>` +
        `</div>` +
        `<pre class="t-payload">${escapeHtml(JSON.stringify(task.payload, null, 2))}</pre>` +
        `<div class="t-actions">` +
          `<button data-act="complete" data-id="${escapeHtml(task.taskId)}">${escapeHtml(t.approve)}</button>` +
          `<button data-act="reject" data-id="${escapeHtml(task.taskId)}">${escapeHtml(t.reject)}</button>` +
        `</div>`
      root.appendChild(card)
    }
  }

  function renderTranscript() {
    const root = dom.transcriptList
    dom.transcriptCount.textContent = String(state.transcript.length)
    root.innerHTML = ''
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

  // --- actions -----------------------------------------------------------

  async function join(id, capsRaw) {
    dom.joinError.textContent = ''
    const capabilities = capsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      const r = await fetchJson('/api/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, capabilities }),
      })
      setMyId(r.id)
      await refresh()
    } catch (err) {
      dom.joinError.textContent = t.failedAlert(err.message || String(err))
    }
  }

  async function leave() {
    if (!state.myId) return
    const id = state.myId
    setMyId(null)
    try {
      await fetchJson(`/api/workers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (err) {
      console.warn('leave failed:', err)
    }
    showJoinForm()
    renderAll()
  }

  async function completeTask(taskId) {
    await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { approved: true, by: state.myId, source: 'worker-ui' } }),
    })
  }

  async function rejectTask(taskId) {
    await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: `rejected by ${state.myId || 'worker'}` }),
    })
  }

  // --- wire it up --------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async () => {
    resolveDom()
    state.myId = getMyId()

    dom.form.addEventListener('submit', (e) => {
      e.preventDefault()
      const id = dom.joinId.value.trim()
      const caps = dom.joinCaps.value.trim()
      if (!id) return
      join(id, caps)
    })

    dom.leaveBtn.addEventListener('click', leave)

    document.addEventListener('click', async (e) => {
      const target = e.target
      if (!(target instanceof HTMLButtonElement)) return
      const act = target.dataset.act
      const id = target.dataset.id
      if (!act || !id) return
      target.disabled = true
      try {
        if (act === 'complete') await completeTask(id)
        else if (act === 'reject') await rejectTask(id)
      } catch (err) {
        alert(t.failedAlert(err.message || String(err)))
        target.disabled = false
      }
    })

    onLangChange(() => {
      applyStaticI18n()
      renderAll()
    })

    try {
      await refresh()
      // If my id is set but server doesn't know me, clear it.
      if (state.myId && !state.participants.find((p) => p.id === state.myId)) {
        setMyId(null)
        renderAll()
      }
    } catch (err) {
      console.error('initial refresh failed:', err)
    }
    connectStream(applyEvent)
  })
})()
