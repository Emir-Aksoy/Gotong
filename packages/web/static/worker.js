/* Gotong — worker view (v2.0, file-first).
 *
 * No sessionStorage / localStorage. The browser's only state is the
 * HttpOnly `gotong_worker` cookie set by POST /api/workers; identity is
 * recovered on each load via GET /api/whoami.
 */
(() => {
  const { $, t, applyStaticI18n, onLangChange, escapeHtml, summarize, isBadResult,
          fetchJson, connectStream, syncLangFromConfig,
          fetchLeaderboard, renderLeaderboard, attachCapChips,
          attachContribToggle, applyContribToggleState } = window.Gotong

  const state = {
    participants: [],
    transcript: [],
    pending: [],
    myId: null,
    myCaps: [],
  }

  let dom = null
  // Per-tab leaderboard window; defaults to "all time". No persistence.
  let lbWindow = 'all'

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
      lbWindow: $('lb-window'),
      lbList: $('leaderboard-list'),
      lbSummary: $('lb-summary'),
      contribToggle: $('contrib-toggle'),
      contribToggleInput: $('contrib-toggle-input'),
    }
  }

  // --- bootstrap ---------------------------------------------------------

  async function refresh() {
    const snap = await fetchJson('/api/state')
    state.participants = snap.participants
    state.transcript = snap.transcript
    state.pending = snap.pending
    if (snap.config?.defaultLang) syncLangFromConfig(snap.config.defaultLang)
    renderAll()
  }

  async function recoverIdentity() {
    const me = await fetchJson('/api/whoami')
    if (me.role === 'worker') {
      state.myId = me.id
      state.myCaps = me.capabilities || []
      // Sync the contribution-toggle to the saved preference. The toggle
      // is only meaningful for a signed-in worker — hidden in the join
      // view (showJoinForm / showWorkbench handle visibility).
      applyContribToggleState(dom.contribToggle, dom.contribToggleInput, me.contributionOptOut === true)
    } else {
      state.myId = null
      state.myCaps = []
    }
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
          state.myId = null
          state.myCaps = []
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

  function showJoinForm() {
    dom.overlay.hidden = false
    dom.leaveBtn.hidden = true
    dom.meLabel.hidden = true
    dom.roleBadge.hidden = true
    if (dom.contribToggle) dom.contribToggle.hidden = true
  }

  function showWorkbench() {
    dom.overlay.hidden = true
    dom.leaveBtn.hidden = false
    dom.meLabel.hidden = false
    dom.roleBadge.hidden = false
    if (dom.contribToggle) dom.contribToggle.hidden = false
    const capsStr = (state.myCaps || []).join(',')
    dom.meLabel.textContent = capsStr ? `${state.myId} · ${capsStr}` : state.myId || ''
  }

  function renderAll() {
    if (!dom) return
    if (state.myId) showWorkbench()
    else showJoinForm()
    renderParticipants()
    renderMyTasks()
    renderTranscript()
    // Pull leaderboard for the current window — workers see the same
    // numbers admins do (visibility is the feature). Silent on failure
    // so a hiccup doesn't break the rest of the page.
    refreshLeaderboard().catch((err) => console.warn('leaderboard refresh failed:', err))
  }

  async function refreshLeaderboard() {
    if (!dom?.lbList) return
    const lb = await fetchLeaderboard(lbWindow)
    renderLeaderboard(dom.lbList, lb, dom.lbSummary)
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

  async function join(id, capsRaw) {
    dom.joinError.textContent = ''
    const capabilities = capsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      const r = await fetchJson('/api/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, capabilities }),
      })
      state.myId = r.id
      state.myCaps = r.capabilities || []
      await refresh()
    } catch (err) {
      dom.joinError.textContent = t.failedAlert(err.message || String(err))
    }
  }

  async function leave() {
    if (!state.myId) return
    const id = state.myId
    state.myId = null
    state.myCaps = []
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

  document.addEventListener('DOMContentLoaded', async () => {
    resolveDom()

    dom.form.addEventListener('submit', (e) => {
      e.preventDefault()
      const id = dom.joinId.value.trim()
      const caps = dom.joinCaps.value.trim()
      if (!id) return
      join(id, caps)
    })

    dom.leaveBtn.addEventListener('click', leave)

    if (dom.lbWindow) {
      dom.lbWindow.addEventListener('change', () => {
        lbWindow = dom.lbWindow.value
        refreshLeaderboard().catch((err) => console.warn('leaderboard switch failed:', err))
      })
    }

    attachContribToggle(dom.contribToggle, dom.contribToggleInput)
    attachCapChips(dom.joinCaps)

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

    // View switcher — jump to the admin (`/admin`) view. If the user
    // already has an `gotong_admin` cookie they land in the admin
    // console directly; otherwise the admin page presents the usual
    // login flow. No client-side state is saved here.
    const switchToAdminBtn = document.getElementById('switch-to-admin-btn')
    if (switchToAdminBtn) {
      switchToAdminBtn.addEventListener('click', () => {
        window.location.href = '/admin'
      })
    }

    try {
      await recoverIdentity()
      await refresh()
    } catch (err) {
      console.error('initial load failed:', err)
    }
    connectStream(applyEvent)
  })
})()
