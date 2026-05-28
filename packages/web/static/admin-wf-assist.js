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

    function open() {
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
      // Defensive: if a previous run's watcher leaked (modal closed
      // before fetch resolved), clear it so it can't taint this run.
      state.assistWatcher = null
      dom.wfAssistModal.hidden = false
      setTimeout(() => dom.wfAssistDescription?.focus(), 0)
    }

    function close() {
      dom.wfAssistModal.hidden = true
      // If the user closes mid-stream the fetch is still in flight, but
      // the modal is gone — drop the watcher so its callbacks don't poke
      // hidden DOM nodes. The fetch resolve path also clears it, so this
      // is just belt-and-suspenders.
      state.assistWatcher = null
      if (dom.wfAssistStreaming) dom.wfAssistStreaming.hidden = true
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
          chip.textContent = `⚠ schema 通过，但有 ${n} 项深度警告`
          chip.style.background = '#fef3c7'
          chip.style.color = '#92400e'
        } else {
          chip.textContent = '✓ 校验通过 (可保存)'
          chip.style.background = '#d1fae5'
          chip.style.color = '#065f46'
        }
      } else if (status === 'invalid') {
        chip.textContent = '✗ YAML 不合 v1 schema'
        chip.style.background = '#fee2e2'
        chip.style.color = '#991b1b'
      } else if (status === 'no_yaml') {
        chip.textContent = '— LLM 没生成 YAML'
        chip.style.background = '#e5e7eb'
        chip.style.color = '#374151'
      } else {
        chip.textContent = status || '(未知)'
        chip.style.background = '#e5e7eb'
        chip.style.color = '#374151'
      }
    }

    // Phase 13 M4 — short human label for each deep-check violation kind.
    // Comes from `WorkflowStructureViolationKind` in @aipehub/evals.
    function deepCheckKindLabel(kind) {
      switch (kind) {
        case 'unknown_agent':
          return '指向不存在的 agent'
        case 'unknown_capability':
          return '当前 hub 没 agent 提供该 capability'
        case 'bad_ref':
          return '$ref 指向不存在的 step'
        case 'forward_ref':
          return '$ref 指向更晚执行的 step'
        case 'self_trigger_cycle':
          return '会触发自己 — 死循环'
        case 'id_collision':
          return 'workflow.id 已存在'
        default:
          return kind || '(unknown)'
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
        summary.textContent = '深度检查通过 (0 项警告)'
        summary.style.color = '#065f46'
        return
      }
      const violations = deepCheck.violations || []
      details.hidden = false
      details.open = true
      summary.textContent = `深度检查警告 — ${violations.length} 项 (workflow 可保存，但运行时可能失败)`
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
      dom.wfAssistResult.hidden = false
      renderStatusChip(result.draftStatus, result.deepCheck)
      dom.wfAssistExplanation.textContent = result.explanation || ''
      dom.wfAssistYaml.textContent = result.yaml || '(空 — LLM 没生成 YAML fence)'
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
      // 仅当 schema 合法时才允许 "保存为工作流" — 把 yaml 缓存在 button
      // 的 dataset 上,save 时直接读。
      if (result.draftStatus === 'valid' && result.yaml) {
        dom.wfAssistSave.disabled = false
        dom.wfAssistSave.dataset.yaml = result.yaml
      } else {
        dom.wfAssistSave.disabled = true
        delete dom.wfAssistSave.dataset.yaml
      }
    }

    async function submit() {
      const description = (dom.wfAssistDescription.value || '').trim()
      dom.wfAssistMsg.textContent = ''
      dom.wfAssistMsg.classList.remove('ok', 'err')
      if (!description) {
        dom.wfAssistMsg.textContent = '请先填一句描述'
        dom.wfAssistMsg.classList.add('err')
        return
      }
      dom.wfAssistGenerate.disabled = true
      dom.wfAssistGenerate.textContent = '生成中…'
      dom.wfAssistMsg.textContent = '正在生成,通常 5-20 秒…'

      // Phase 13 follow-up — open the streaming preview pane and install
      // a watcher that listens on the existing SSE feed for matching
      // task / chunk / task_result events. The watcher narrows onto the
      // first `task` event with title='workflow:assist', then renders
      // each cumulative text update into the preview pane until the
      // POST resolves (or the user closes the modal).
      if (dom.wfAssistStreaming) {
        dom.wfAssistStreaming.hidden = false
        dom.wfAssistStreamingText.textContent = ''
        dom.wfAssistStreamingMeta.textContent = '等待 LLM 第一个 chunk…'
      }
      state.assistWatcher = {
        taskId: null,
        onTask: (taskId) => {
          if (dom.wfAssistStreamingMeta) {
            dom.wfAssistStreamingMeta.textContent = `task=${String(taskId).slice(0, 8)}…`
          }
        },
        onChunk: (text, meta) => {
          if (!dom.wfAssistStreamingText) return
          dom.wfAssistStreamingText.textContent = text
          // Keep the latest characters in view as text grows.
          dom.wfAssistStreamingText.scrollTop = dom.wfAssistStreamingText.scrollHeight
          if (dom.wfAssistStreamingMeta && meta) {
            const tools = meta.toolUses ? ` · 🔧 ${meta.toolUses}` : ''
            dom.wfAssistStreamingMeta.textContent =
              (meta.isDone ? '✓ 流结束' : '● 生成中') + ` · ${text.length} chars${tools}`
          }
        },
        onEnd: () => {
          if (dom.wfAssistStreamingMeta) {
            dom.wfAssistStreamingMeta.textContent = '✓ 流结束 — 等待 schema 校验 + 深度检查…'
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

        const body = { description }
        if (Object.keys(contextHints).length > 0) body.contextHints = contextHints

        const r = await fetchFn('/api/admin/workflows/assist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await r.json().catch(() => ({}))
        if (r.status === 503) {
          dom.wfAssistMsg.textContent =
            'AI 助手未启用 — 设置 AIPE_ASSISTANT_PROVIDER + 对应 API key 后重启 host'
          dom.wfAssistMsg.classList.add('err')
          return
        }
        if (!r.ok) {
          dom.wfAssistMsg.textContent = '生成失败:' + (json.error || `HTTP ${r.status}`)
          dom.wfAssistMsg.classList.add('err')
          return
        }
        dom.wfAssistMsg.textContent = ''
        renderResult(json)
      } catch (err) {
        dom.wfAssistMsg.textContent = '生成失败:' + (err.message || String(err))
        dom.wfAssistMsg.classList.add('err')
      } finally {
        dom.wfAssistGenerate.disabled = false
        dom.wfAssistGenerate.textContent = '生成草稿'
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
      dom.wfAssistMsg.textContent = '保存中…'
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
          dom.wfAssistMsg.textContent = '保存失败:' + (body.error || `HTTP ${r.status}`)
          dom.wfAssistMsg.classList.add('err')
          return
        }
        const id = body.workflow?.id || '?'
        dom.wfAssistMsg.textContent = `已保存 workflow ${id}`
        dom.wfAssistMsg.classList.add('ok')
        await refreshWorkflows()
        setTimeout(close, 900)
      } catch (err) {
        dom.wfAssistMsg.textContent = '保存失败:' + (err.message || String(err))
        dom.wfAssistMsg.classList.add('err')
      }
    }

    return { open, close, submit, save }
  }

  window.AipeHub = window.AipeHub || {}
  window.AipeHub.installWorkflowAssist = install
})()
