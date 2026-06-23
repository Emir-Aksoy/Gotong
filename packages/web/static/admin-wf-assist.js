/* AipeHub admin console — workflow AI assistant module (Phase 13 M3/M4 + streaming follow-up).
 *
 * Extracted from admin.js (P3 audit cleanup — admin.js was 3641 lines)
 * to give the assist dialog its own cohesive home. The whole block —
 * modal open/close, status chip rendering, deep-check warnings list,
 * SSE-fed streaming preview, the POST /assist + save round-trip — is a
 * self-contained "AI authoring" feature with no cross-cuts into other
 * admin tabs.
 *
 * # Coupling shape
 *
 * Static admin scripts share one window.AipeHub namespace and run inside
 * sibling IIFEs (admin.js is the host; this file extends it). We export
 * a single factory:
 *
 *   window.AipeHub.installWorkflowAssist({ dom, state, ma, wf,
 *                                           refreshWorkflows, fetch })
 *     → { open, close, submit, save }
 *
 * The factory closes over the dependency bag once at boot; admin.js
 * wires the returned methods onto its existing event listeners. The
 * watcher channel (state.assistWatcher) is read by admin.js's
 * SSE dispatcher — same memory cell, different scopes.
 *
 * # Why a factory and not direct globals
 *
 * Direct globals would require this file to know admin.js's internal
 * `dom` / `state` / `ma` / `wf` shapes by literal name. A factory keeps
 * the contract explicit (every dep listed in one place) so a future
 * module-system migration can lift this into an ES module by changing
 * just the registration shim.
 */
;(() => {
  function install(deps) {
    const { dom, state, ma, wf, refreshWorkflows } = deps
    const fetchFn = deps.fetch || window.fetch.bind(window)

    // window.AipeHub is fully populated by the time install() runs (app-core.js
    // ran first). AH.t is a LIVE getter returning the currently-active dict —
    // read t().<key> at CALL TIME inside every render/message function so each
    // fresh action paints in the current language.
    const AH = window.AipeHub
    function t() {
      return AH.t
    }

    // Track the last result render so a language flip while the modal is OPEN
    // can repaint it. Set whenever renderResult paints the assist output; the
    // onLangChange subscriber below re-invokes it if the modal is still up.
    let lastRender = null

    // workflow-architect ARCH-M4 — dialog state beyond the result render:
    //   selectedDetail — which explanation depth the three buttons select.
    //   currentMode    — 'author' (NL → new draft) or 'explain' (narrate an
    //                    existing workflow's YAML at the chosen depth).
    //   subjectYaml/Id — in explain mode, the YAML to narrate (sent verbatim,
    //                    never regenerated) and its id (for the title).
    // Defaults reproduce today's author-mode behavior exactly.
    let selectedDetail = 'brief'
    let currentMode = 'author'
    let subjectYaml = null
    let subjectId = null

    // Reflect selectedDetail onto the three depth buttons (single source of
    // truth for the .is-active highlight). Called on open + on each click.
    function syncDepthButtons() {
      const row = dom.wfAssistDepthRow
      if (!row) return
      for (const btn of row.querySelectorAll('.wfa-depth-btn')) {
        btn.classList.toggle('is-active', btn.dataset.detail === selectedDetail)
      }
    }

    // Paint the mode-dependent chrome: title, generate-button label, and
    // whether the free-text description row + hint show (explain mode hides
    // them — there's nothing to describe, the subject YAML is fixed). Read at
    // call time so a language flip while open repaints it (onLangChange).
    function applyModeChrome() {
      const explain = currentMode === 'explain'
      if (dom.wfAssistTitle) {
        dom.wfAssistTitle.textContent = explain
          ? t().wfaArchExplainTitle(subjectId || '?')
          : t().wfAssistModalTitle
      }
      if (dom.wfAssistGenerate) {
        dom.wfAssistGenerate.textContent = explain ? t().wfaArchExplainBtn : t().wfaGenerateBtn
      }
      if (dom.wfAssistDescRow) dom.wfAssistDescRow.hidden = explain
      if (dom.wfAssistHint) dom.wfAssistHint.hidden = explain
    }

    // Render (or clear) the inline workflow diagram. The host returns a pure
    // `graph` projection on valid YAML; the shared standalone renderer draws
    // the SVG and the download anchor gets a self-contained data: URL. `t` and
    // escapeHtml are passed in so that module stays coupled to neither side.
    function renderGraph(graph) {
      const wrap = dom.wfAssistGraphWrap
      const body = dom.wfAssistGraphBody
      const dl = dom.wfAssistGraphDownload
      const G = window.AipeHubWorkflowGraph
      if (!wrap || !body) return
      if (!graph || !G) {
        wrap.hidden = true
        body.innerHTML = ''
        return
      }
      const svg = G.renderWorkflowGraphSvg(graph, { t: t(), escapeHtml: AH.escapeHtml })
      body.innerHTML = svg
      if (dl) {
        dl.href = G.svgDownloadHref(svg)
        dl.setAttribute('download', (graph.workflowId || 'workflow') + '.svg')
      }
      wrap.hidden = false
    }

    // opts (workflow-architect ARCH-M4): { mode?: 'author'|'explain',
    // subjectYaml?, subjectId? }. Omitted → author mode (today's behavior).
    // Explain mode does NOT auto-submit — the user picks a depth, then clicks
    // the (relabeled) generate button to narrate the fixed subject YAML.
    function open(opts) {
      const o = opts || {}
      currentMode = o.mode === 'explain' ? 'explain' : 'author'
      subjectYaml = currentMode === 'explain' ? o.subjectYaml || '' : null
      subjectId = currentMode === 'explain' ? o.subjectId || null : null
      dom.wfAssistDescription.value = ''
      dom.wfAssistMsg.textContent = ''
      dom.wfAssistMsg.classList.remove('ok', 'err')
      dom.wfAssistResult.hidden = true
      dom.wfAssistSave.disabled = true
      // Reset the deep-check panel so a previous run's warnings don't
      // bleed into this session — renderAssistResult will repopulate it.
      if (dom.wfAssistDeepcheckDetails) dom.wfAssistDeepcheckDetails.hidden = true
      if (dom.wfAssistDeepcheckList) dom.wfAssistDeepcheckList.innerHTML = ''
      // Streaming preview pane reset (follow-up to M3).
      if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
      if (dom.wfAssistStreamingText) dom.wfAssistStreamingText.textContent = ''
      if (dom.wfAssistStreamingMeta) dom.wfAssistStreamingMeta.textContent = ''
      // Reset the inline diagram so a previous run's graph doesn't linger.
      renderGraph(null)
      // Defensive: if a previous run's watcher leaked (modal closed
      // before fetch resolved), clear it so it can't taint this run.
      state.assistWatcher = null
      // Nothing rendered yet this session — drop any stale re-render closure.
      lastRender = null
      syncDepthButtons()
      applyModeChrome()
      dom.wfAssistModal.hidden = false
      // In explain mode there's no description box to focus; the depth row is
      // the first thing the user touches, so skip the autofocus.
      if (currentMode === 'author') setTimeout(() => dom.wfAssistDescription?.focus(), 0)
    }

    function close() {
      dom.wfAssistModal.hidden = true
      lastRender = null
      // If the user closes mid-stream the fetch is still in flight, but
      // the modal is gone — drop the watcher so its callbacks don't poke
      // hidden DOM nodes. The fetch resolve path also clears it, so this
      // is just belt-and-suspenders.
      state.assistWatcher = null
      if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
      renderGraph(null)
    }

    function renderStatusChip(status, deepCheck) {
      const chip = dom.wfAssistStatusChip
      chip.textContent = ''
      chip.classList.remove('ok', 'err')
      chip.style.padding = '0.15rem 0.5rem'
      chip.style.borderRadius = '0.25rem'
      chip.style.fontSize = '0.85em'
      if (status === 'valid') {
        // M4: valid + deep-check failed → yellow "warnings" state instead
        // of green. YAML still parses, but it references things this hub
        // doesn't actually have, so it'd fail at runtime.
        if (deepCheck && deepCheck.ok === false) {
          const n = (deepCheck.violations || []).length
          chip.textContent = t().wfaChipWarnN(n)
          chip.style.background = '#fef3c7'
          chip.style.color = '#92400e'
        } else {
          chip.textContent = t().wfaChipValid
          chip.style.background = '#d1fae5'
          chip.style.color = '#065f46'
        }
      } else if (status === 'invalid') {
        chip.textContent = t().wfaChipInvalid
        chip.style.background = '#fee2e2'
        chip.style.color = '#991b1b'
      } else if (status === 'no_yaml') {
        chip.textContent = t().wfaChipNoYaml
        chip.style.background = '#e5e7eb'
        chip.style.color = '#374151'
      } else {
        chip.textContent = status || t().wfaChipUnknown
        chip.style.background = '#e5e7eb'
        chip.style.color = '#374151'
      }
    }

    // Phase 13 M4 — short human label for each deep-check violation kind.
    // Comes from `WorkflowStructureViolationKind` in @aipehub/evals.
    function deepCheckKindLabel(kind) {
      switch (kind) {
        case 'unknown_agent':
          return t().wfaViolUnknownAgent
        case 'unknown_capability':
          return t().wfaViolUnknownCapability
        case 'bad_ref':
          return t().wfaViolBadRef
        case 'forward_ref':
          return t().wfaViolForwardRef
        case 'self_trigger_cycle':
          return t().wfaViolSelfTriggerCycle
        case 'id_collision':
          return t().wfaViolIdCollision
        default:
          return kind || t().wfaViolUnknownKind
      }
    }

    function renderDeepCheck(deepCheck) {
      const details = dom.wfAssistDeepcheckDetails
      const summary = dom.wfAssistDeepcheckSummary
      const list = dom.wfAssistDeepcheckList
      if (!details || !summary || !list) return
      list.innerHTML = ''
      // No deepCheck attached → hide panel entirely. Caller didn't pass
      // contextHints, or the YAML wasn't even valid.
      if (!deepCheck) {
        details.hidden = true
        return
      }
      if (deepCheck.ok) {
        // Quietly tell the admin everything passed; collapsed by default
        // so it doesn't compete with the YAML preview for attention.
        details.hidden = false
        details.open = false
        summary.textContent = t().wfaDeepOk
        summary.style.color = '#065f46'
        return
      }
      const violations = deepCheck.violations || []
      details.hidden = false
      details.open = true
      summary.textContent = t().wfaDeepWarnN(violations.length)
      summary.style.color = '#92400e'
      for (const v of violations) {
        const li = document.createElement('li')
        li.style.margin = '0.2rem 0'
        const label = document.createElement('strong')
        label.textContent = deepCheckKindLabel(v.kind) + ' — '
        li.appendChild(label)
        li.appendChild(document.createTextNode(v.message || ''))
        if (v.path) {
          const path = document.createElement('code')
          path.textContent = ' (' + v.path + ')'
          path.style.color = '#6b7280'
          path.style.fontSize = '0.9em'
          li.appendChild(path)
        }
        list.appendChild(li)
      }
    }

    function renderResult(result) {
      // Capture the data so a language flip while the modal is open can repaint
      // the result in the new language (see onLangChange wiring below).
      lastRender = () => renderResult(result)
      dom.wfAssistResult.hidden = false
      renderStatusChip(result.draftStatus, result.deepCheck)
      dom.wfAssistExplanation.textContent = result.explanation || ''
      dom.wfAssistYaml.textContent = result.yaml || t().wfaYamlEmpty
      if (result.draftStatus === 'invalid' && result.validationError) {
        dom.wfAssistErrorDetails.hidden = false
        dom.wfAssistValidationError.textContent = result.validationError
      } else {
        dom.wfAssistErrorDetails.hidden = true
        dom.wfAssistValidationError.textContent = ''
      }
      // Phase 13 M4 — render deep-check warnings (or pass note) below the
      // YAML preview. Save is still allowed when deepCheck.ok=false (admin
      // decides), so we only gate the save button on draftStatus.
      renderDeepCheck(result.deepCheck)
      // workflow-architect ARCH-M4 — inline the workflow diagram (host returns
      // a pure `graph` projection on valid YAML; null/invalid → panel hidden).
      renderGraph(result.graph)
      // 仅当 schema 合法 *且作者模式* 时才允许 "保存为工作流"。Explain 模式
      // 讲解的是一个已存在的工作流,"保存" 只会撞 id / 重复导入 — 关掉它。
      if (currentMode === 'author' && result.draftStatus === 'valid' && result.yaml) {
        dom.wfAssistSave.disabled = false
        dom.wfAssistSave.dataset.yaml = result.yaml
      } else {
        dom.wfAssistSave.disabled = true
        delete dom.wfAssistSave.dataset.yaml
      }
    }

    async function submit() {
      const explain = currentMode === 'explain'
      const description = (dom.wfAssistDescription.value || '').trim()
      dom.wfAssistMsg.textContent = ''
      dom.wfAssistMsg.classList.remove('ok', 'err')
      // Author mode needs a description; explain mode narrates a fixed subject
      // YAML, so there's nothing to type — skip the guard.
      if (!explain && !description) {
        dom.wfAssistMsg.textContent = t().wfaNeedDescription
        dom.wfAssistMsg.classList.add('err')
        return
      }
      dom.wfAssistGenerate.disabled = true
      dom.wfAssistGenerate.textContent = t().wfaGenerating
      dom.wfAssistMsg.textContent = t().wfaGeneratingMsg

      // Phase 13 follow-up — open the streaming preview pane and install
      // a watcher that listens on the existing SSE feed for matching
      // task / chunk / task_result events. The watcher narrows onto the
      // first `task` event with title='workflow:assist', then renders
      // each cumulative text update into the preview pane until the
      // POST resolves (or the user closes the modal).
      if (dom.wfAssistStreaming) {
        dom.wfAssistStreaming.hidden = false
        dom.wfAssistStreamingText.textContent = ''
        dom.wfAssistStreamingMeta.textContent = t().wfaWaitingChunk
      }
      state.assistWatcher = {
        taskId: null,
        onTask: (taskId) => {
          if (dom.wfAssistStreamingMeta) {
            dom.wfAssistStreamingMeta.textContent = t().wfaStreamTask(String(taskId).slice(0, 8))
          }
        },
        onChunk: (text, meta) => {
          if (!dom.wfAssistStreamingText) return
          dom.wfAssistStreamingText.textContent = text
          // Keep the latest characters in view as text grows.
          dom.wfAssistStreamingText.scrollTop = dom.wfAssistStreamingText.scrollHeight
          if (dom.wfAssistStreamingMeta && meta) {
            dom.wfAssistStreamingMeta.textContent = t().wfaStreamProgress(
              !!meta.isDone,
              text.length,
              meta.toolUses || 0,
            )
          }
        },
        onEnd: () => {
          if (dom.wfAssistStreamingMeta) {
            dom.wfAssistStreamingMeta.textContent = t().wfaStreamEnd
          }
        },
      }

      try {
        // 把当前 hub 已有的 agents + workflow ids 当 contextHints — 让 LLM
        // 用真名而不是编名字。MCP servers 暂不喂(admin UI 没有 /api 暴露)。
        const contextHints = {}
        if (Array.isArray(ma?.agents) && ma.agents.length > 0) {
          contextHints.agents = ma.agents.map((a) => {
            const entry = { id: a.id, capabilities: a.capabilities || [] }
            if (a.description) entry.description = a.description
            return entry
          })
        }
        if (Array.isArray(wf?.workflows) && wf.workflows.length > 0) {
          contextHints.existingWorkflowIds = wf.workflows.map((w) => w.id)
        }

        // workflow-architect ARCH-M4 — always carry the chosen explanation
        // depth. Explain mode sends the fixed subject YAML (host narrates it
        // without regenerating); author mode sends the description + hints.
        const body = { detail: selectedDetail }
        if (explain) {
          body.mode = 'explain'
          body.subjectYaml = subjectYaml || ''
        } else {
          body.description = description
          if (Object.keys(contextHints).length > 0) body.contextHints = contextHints
        }

        const r = await fetchFn('/api/admin/workflows/assist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await r.json().catch(() => ({}))
        if (r.status === 503) {
          dom.wfAssistMsg.textContent = t().wfaAssistDisabled
          dom.wfAssistMsg.classList.add('err')
          return
        }
        if (!r.ok) {
          dom.wfAssistMsg.textContent = t().wfaGenFailed(json.error || `HTTP ${r.status}`)
          dom.wfAssistMsg.classList.add('err')
          return
        }
        dom.wfAssistMsg.textContent = ''
        renderResult(json)
      } catch (err) {
        dom.wfAssistMsg.textContent = t().wfaGenFailed(err.message || String(err))
        dom.wfAssistMsg.classList.add('err')
      } finally {
        dom.wfAssistGenerate.disabled = false
        // Restore the mode-appropriate button label (explain vs author).
        dom.wfAssistGenerate.textContent =
          currentMode === 'explain' ? t().wfaArchExplainBtn : t().wfaGenerateBtn
        // Tear down the streaming watcher + collapse the live preview.
        // The result panel (with final yaml + deep-check) is now the
        // canonical view — the streaming pane was only useful while
        // the LLM was producing chunks.
        state.assistWatcher = null
        if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
      }
    }

    async function save() {
      const yaml = dom.wfAssistSave.dataset.yaml
      if (!yaml) return
      dom.wfAssistMsg.textContent = t().wfaSaving
      dom.wfAssistMsg.classList.remove('ok', 'err')
      try {
        // 走现有 /import route — 同一段 schema 验证 + 落盘 + register
        // 在 hub。导入失败(例如 id 冲突)会把错误回显在同一个 msg 区。
        const r = await fetchFn('/api/admin/workflows/import', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: yaml,
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) {
          dom.wfAssistMsg.textContent = t().wfaSaveFailed(body.error || `HTTP ${r.status}`)
          dom.wfAssistMsg.classList.add('err')
          return
        }
        const id = body.workflow?.id || '?'
        dom.wfAssistMsg.textContent = t().wfaSavedOk(id)
        dom.wfAssistMsg.classList.add('ok')
        await refreshWorkflows()
        setTimeout(close, 900)
      } catch (err) {
        dom.wfAssistMsg.textContent = t().wfaSaveFailed(err.message || String(err))
        dom.wfAssistMsg.classList.add('err')
      }
    }

    // workflow-architect ARCH-M4 — depth selector. Click any of the three
    // buttons to set selectedDetail; the highlight follows via syncDepthButtons.
    // Wired once at install (the row is static markup, never re-created).
    if (dom.wfAssistDepthRow) {
      dom.wfAssistDepthRow.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.wfa-depth-btn')
        if (!btn || !dom.wfAssistDepthRow.contains(btn)) return
        const d = btn.dataset.detail
        if (d !== 'oneliner' && d !== 'brief' && d !== 'detailed') return
        selectedDetail = d
        syncDepthButtons()
      })
    }

    // Live re-render: if the language flips while the assist modal is OPEN,
    // repaint the last rendered result in the new language. "Modal open" =
    // the modal element not hidden. Static-message-only states (e.g. an error
    // toast with no result rendered) keep their current text and pick up the
    // new language on the next action — acceptable best-effort.
    AH.onLangChange(() => {
      if (!dom.wfAssistModal || dom.wfAssistModal.hidden) return
      // Repaint mode chrome (the explain-mode title interpolates an id, the
      // generate-button label is mode-dependent) + the last result render.
      applyModeChrome()
      if (lastRender) lastRender()
    })

    return { open, close, submit, save }
  }

  window.AipeHub = window.AipeHub || {}
  window.AipeHub.installWorkflowAssist = install
})()
