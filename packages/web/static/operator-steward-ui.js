/**
 * SW-M9 A-M8 — the OPERATOR-console hub steward ("站点管家").
 *
 * The operator-console twin of the member steward (which lives atop the "我的"
 * home tab and manages the caller's OWN resources). This panel sits on the
 * owner/admin "总览" (overview) tab and drives the SITE-WIDE steward:
 *
 *   POST /api/admin/steward/plan    propose (zero side effects)
 *   POST /api/admin/steward/apply   execute ONE accepted action
 *
 * Self-contained module; same activation pattern as acp-ui.js / a2a-ui.js
 * (owner/admin, MutationObserver on <body data-active-tab>, targets its own
 * panel by id). Unlike the federation panels it fetches nothing on tab focus —
 * it's a chat box that starts empty.
 *
 * Privilege lives entirely server-side: the host wired a SECOND steward service
 * here (the operator one — a site-wide agent executor + a grant-free workflow
 * editor) behind `requireAdmin`. The action we forward is `unknown`; the host
 * re-validates + re-classifies + re-tiers it, so we NEVER trust a client tier.
 *
 * A dangerous (delete_agent) or cross-hub (cross-hub workflow edit) action is
 * parked as an approval addressed to THIS operator's `/me` inbox (北极星「人是
 * Participant」: a second confirmation belongs to a person's inbox, whichever
 * SPA started it). We render a deep-link to the home tab rather than duplicate
 * the inbox view here (the inline admin inbox is explicitly deferred).
 *
 * i18n: reads the live dict off window.Gotong.t at call time (app-core.js runs
 * before this panel is injected). Op-specific strings are `opSteward*`; the
 * tier badges + common labels reuse the proven `meSteward*` / `meWf*` keys.
 */
;(function () {
  'use strict'

  const AH = window.Gotong
  function t() {
    return AH.t
  }

  const API = '/api/admin/steward'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }
  function escHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // This conversation (client-held; the hub stores nothing between turns —
  // each plan POST resends the trimmed history so multi-step follow-ups work).
  let chat = []
  // The proposed actions from the most recent plan, indexed by card.
  let actions = []

  // ---- shell ------------------------------------------------------------

  function buildUi(root) {
    const d = t()
    root.innerHTML =
      '<div class="me-steward operator-steward">' +
      '<h2>' + escHtml(d.opStewardTitle) + '</h2>' +
      '<p class="me-meta">' + escHtml(d.opStewardHint) + '</p>' +
      '<textarea id="op-steward-input" rows="3" placeholder="' + escHtml(d.opStewardPlaceholder) + '"></textarea>' +
      '<button id="op-steward-send" type="button" class="me-primary-btn">' + escHtml(d.meStewardSend) + '</button>' +
      '<div id="op-steward-status" class="me-status"></div>' +
      '<div id="op-steward-output" class="me-steward-output"></div>' +
      '</div>'
    const send = $('#op-steward-send', root)
    if (send) send.addEventListener('click', submitPlan)
    const out = $('#op-steward-output', root)
    if (out) out.addEventListener('click', onOutputClick)
  }

  // ---- plan -------------------------------------------------------------

  async function submitPlan() {
    const input = document.getElementById('op-steward-input')
    const status = document.getElementById('op-steward-status')
    const output = document.getElementById('op-steward-output')
    if (!input || !status || !output) return
    const instruction = (input.value || '').trim()
    if (!instruction) {
      status.className = 'me-status error'
      status.textContent = t().meStewardEmptyInput
      return
    }
    status.className = 'me-status'
    status.textContent = t().meStewardThinking
    try {
      const r = await fetch(API + '/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: instruction, history: chat.slice(-12) }),
      })
      const j = await r.json().catch(function () {
        return {}
      })
      if (!r.ok) throw new Error((j && (j.error || j.message)) || 'HTTP ' + r.status)
      status.textContent = ''
      input.value = ''
      chat.push({ role: 'user', content: instruction })
      if (j.reply) chat.push({ role: 'assistant', content: String(j.reply) })
      renderProposal(j)
    } catch (err) {
      status.className = 'me-status error'
      status.textContent = t().meStewardPlanFailed(err && err.message ? err.message : err)
    }
  }

  // Render the steward's reply + one card per proposed action. `actions` keeps
  // the verbatim action objects so apply forwards exactly what was proposed.
  function renderProposal(j) {
    const out = document.getElementById('op-steward-output')
    if (!out) return
    actions = Array.isArray(j.actions) ? j.actions : []
    const reply = j && j.reply ? '<div class="me-steward-reply">' + escHtml(String(j.reply)) + '</div>' : ''
    const cards = actions
      .map(function (ca, idx) {
        return actionCard(ca, idx)
      })
      .join('')
    const note = actions.length === 0 ? '<p class="me-meta">' + escHtml(t().meStewardNoActions) + '</p>' : ''
    out.innerHTML = reply + cards + note
  }

  function actionCard(ca, idx) {
    const action = (ca && ca.action) || {}
    const tier = (ca && ca.tier) || 'safe'
    const summary = (ca && ca.summary) || (action && action.kind) || ''
    if (action.kind === 'inspect' || tier === 'inspect') {
      return (
        '<div class="me-steward-card inspect"><div class="me-steward-answer">' +
        escHtml(String(action.answer || summary)) +
        '</div></div>'
      )
    }
    if (tier === 'forbidden') {
      const reason = (ca && ca.reason) || ''
      return (
        '<div class="me-steward-card forbidden">' +
        tierBadge('forbidden') +
        '<div class="me-steward-summary">' +
        escHtml(t().meStewardForbiddenNote) +
        escHtml(reason) +
        '</div></div>'
      )
    }
    const gated = tier === 'dangerous' || tier === 'cross_hub'
    const label = gated ? t().meStewardSubmitApproval : t().meStewardApply
    return (
      '<div class="me-steward-card" data-idx="' + idx + '">' +
      tierBadge(tier) +
      '<div class="me-steward-summary">' +
      escHtml(summary) +
      '</div>' +
      '<button type="button" class="me-primary-btn op-steward-apply-btn" data-idx="' + idx + '">' +
      escHtml(label) +
      '</button>' +
      '<div class="me-steward-result"></div></div>'
    )
  }

  function tierBadge(tier) {
    const d = t()
    const map = {
      safe: ['safe', d.meStewardTierSafe],
      dangerous: ['dangerous', d.meStewardTierDangerous],
      cross_hub: ['cross-hub', d.meStewardTierCrossHub],
      forbidden: ['forbidden', d.meStewardTierForbidden],
    }
    const pair = map[tier] || map.safe
    return '<span class="me-steward-tier ' + pair[0] + '">' + escHtml(pair[1]) + '</span>'
  }

  // ---- apply ------------------------------------------------------------

  function onOutputClick(ev) {
    const applyBtn = ev.target.closest && ev.target.closest('.op-steward-apply-btn')
    if (applyBtn) {
      applyAction(applyBtn)
      return
    }
    const inboxBtn = ev.target.closest && ev.target.closest('.op-steward-goto-inbox')
    if (inboxBtn) gotoInbox()
  }

  async function applyAction(btn) {
    const idx = Number(btn.dataset.idx)
    const ca = actions[idx]
    if (!ca || !ca.action) return
    const card = btn.closest('.me-steward-card')
    const resultEl = card && card.querySelector('.me-steward-result')
    const prev = btn.textContent
    btn.disabled = true
    btn.textContent = t().meStewardApplying
    try {
      const r = await fetch(API + '/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Forwarded VERBATIM — the server re-validates + re-tiers it.
        body: JSON.stringify({ action: ca.action }),
      })
      const j = await r.json().catch(function () {
        return {}
      })
      renderResult(resultEl, btn, r, j)
      recordOutcome(ca.action, r, j)
    } catch (err) {
      if (resultEl) {
        resultEl.className = 'me-steward-result error'
        resultEl.textContent = t().meStewardApplyFailed(err && err.message ? err.message : err)
      }
      btn.disabled = false
      btn.textContent = prev
    }
  }

  // Record a TERMINAL apply outcome into `chat` so the next plan POST round-trips
  // it: the host folds `{kind,status,subject}` into a `[执行结果] …` line and the
  // operator steward builds its next step on what already ran. Only the
  // whitelisted shape is sent — the host re-validates kind/status and renders the
  // text itself, so this can't inject a "succeeded" narrative. An `invalid` /
  // transport error left the button live to retry, so it's not recorded.
  function recordOutcome(action, r, j) {
    const kind = action && action.kind
    if (!kind) return
    const raw = j && j.status
    let status = null
    if (r.ok && raw === 'done') status = 'done'
    else if (raw === 'pending_approval' || raw === 'needs_approval') status = 'pending_approval'
    else if (raw === 'refused') status = 'refused'
    if (!status) return
    chat.push({ role: 'assistant', content: '', result: { kind: kind, status: status, subject: subjectOf(action, j) } })
  }

  // The thing an action acted on, for the result line. Reads only non-secret
  // identifier fields (never an env-var value / secret); the host clips it anyway.
  function subjectOf(action, j) {
    const res = (j && j.result) || {}
    const fromResult = res.agent && (res.agent.id || res.agent.label)
    const fromAction =
      action &&
      (action.id ||
        action.agentId ||
        action.workflowId ||
        action.handle ||
        action.provider ||
        action.credentialId ||
        action.peerId)
    return String(fromResult || fromAction || '')
  }

  // Render an apply outcome into the card; retire the button on a terminal
  // result (done / parked / refused) so it can't be double-fired. An `invalid`
  // / transport error leaves the button live to retry.
  function renderResult(resultEl, btn, r, j) {
    if (!resultEl) return
    const status = j && j.status
    if (r.ok && status === 'done') {
      const res = (j && j.result) || {}
      if (res.kind === 'create_agent' || res.kind === 'edit_agent') {
        resultEl.className = 'me-steward-result ok'
        const label = (res.agent && (res.agent.label || res.agent.id)) || ''
        resultEl.textContent =
          res.kind === 'create_agent' ? t().meStewardCreated(label) : t().meStewardEditedAgent(label)
        btn.remove()
      } else if (res.kind === 'edit_workflow') {
        renderWorkflowEdit(resultEl, res.edit)
        btn.remove()
      } else {
        resultEl.className = 'me-steward-result ok'
        resultEl.textContent = t().meStewardDone
        btn.remove()
      }
      return
    }
    if (status === 'pending_approval') {
      resultEl.className = 'me-steward-result pending'
      resultEl.innerHTML =
        escHtml(t().opStewardPending) +
        ' <button type="button" class="me-secondary-btn op-steward-goto-inbox">' +
        escHtml(t().meStewardGoInbox) +
        '</button>'
      btn.remove()
      return
    }
    if (status === 'needs_approval') {
      resultEl.className = 'me-steward-result pending'
      resultEl.textContent = t().meStewardNeedsApproval
      btn.remove()
      return
    }
    if (status === 'refused') {
      resultEl.className = 'me-steward-result error'
      resultEl.textContent = (j && j.reason) || t().meStewardForbiddenNote
      btn.remove()
      return
    }
    // `invalid` (HTTP 400) or any {error}/{message} failure — keep the button live.
    resultEl.className = 'me-steward-result error'
    resultEl.textContent =
      (status === 'invalid' && j && j.reason) || (j && (j.error || j.message)) || t().meOpFailedHttp(r.status)
    btn.disabled = false
    const ca = actions[Number(btn.dataset.idx)]
    btn.textContent = ca && (ca.tier === 'dangerous' || ca.tier === 'cross_hub') ? t().meStewardSubmitApproval : t().meStewardApply
  }

  // An `edit_workflow` outcome reuses the WFEDIT row diff. A locally-safe edit
  // can still come back `ok === false` (assistant failed / boundary locked) — an
  // honest outcome surfaced with the reason + any violations.
  function renderWorkflowEdit(resultEl, edit) {
    if (!edit) {
      resultEl.className = 'me-steward-result ok'
      resultEl.textContent = t().meStewardDone
      return
    }
    if (edit.ok === false) {
      resultEl.className = 'me-steward-result error'
      let html = escHtml(String(edit.message || edit.detail || t().meWfErrAssistantFailed))
      const violations = Array.isArray(edit.violations)
        ? edit.violations.map(function (v) {
            return (v && (v.detail || v.kind)) || ''
          }).filter(Boolean)
        : []
      if (violations.length)
        html +=
          '<ul>' +
          violations
            .map(function (v) {
              return '<li>' + escHtml(v) + '</li>'
            })
            .join('') +
          '</ul>'
      resultEl.innerHTML = html
      return
    }
    resultEl.className = 'me-steward-result ok'
    const applied = edit.applied === 'published' ? t().meWfEditPublished : t().meWfEditDraftSaved
    let html = '<div>' + escHtml(t().meStewardWorkflowEdited(applied, edit.explanation || '')) + '</div>'
    if (Array.isArray(edit.diff) && edit.diff.some(function (l) {
      return l && (l.kind === 'add' || l.kind === 'del')
    })) {
      html += '<div class="me-wf-diff-rows">' + renderDiffRows(edit.diff) + '</div>'
    }
    resultEl.innerHTML = html
  }

  function diffRow(l) {
    const kind = l && l.kind === 'add' ? 'add' : l && l.kind === 'del' ? 'del' : 'same'
    const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
    return '<div class="me-wf-diff-' + kind + '">' + sign + ' ' + escHtml(String((l && l.text) || '')) + '</div>'
  }

  function renderDiffRows(diff) {
    const out = []
    let i = 0
    while (i < diff.length) {
      if (!diff[i] || diff[i].kind !== 'same') {
        out.push(diffRow(diff[i]))
        i++
        continue
      }
      let j = i
      while (j < diff.length && diff[j] && diff[j].kind === 'same') j++
      const keepHead = i === 0 ? 0 : 2
      const keepTail = j === diff.length ? 0 : 2
      if (j - i > keepHead + keepTail + 1) {
        for (let k = i; k < i + keepHead; k++) out.push(diffRow(diff[k]))
        out.push('<div class="me-wf-diff-skip">' + escHtml(t().meWfDiffSkip(j - i - keepHead - keepTail)) + '</div>')
        for (let k = j - keepTail; k < j; k++) out.push(diffRow(diff[k]))
      } else {
        for (let k = i; k < j; k++) out.push(diffRow(diff[k]))
      }
      i = j
    }
    return out.join('')
  }

  // Jump to the operator's own inbox (the home tab) where a parked steward
  // action awaits the second confirmation. app.js's tab router refreshes the
  // inbox on home focus, so the parked item shows up.
  function gotoInbox() {
    if (AH && typeof AH.gotoTab === 'function') AH.gotoTab('home')
    const inbox = document.querySelector('.me-inbox')
    if (inbox && inbox.scrollIntoView) inbox.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---- activation (mirror acp-ui.js) ------------------------------------

  function init() {
    const root = document.querySelector('#operator-steward-panel')
    if (!root) return
    buildUi(root)
    // Re-render the shell on language switch. The transient proposal output is
    // cleared (the conversation `chat` persists and rides the next plan), same
    // as the federation panels relabel on language change.
    AH.onLangChange(function () {
      buildUi(root)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
