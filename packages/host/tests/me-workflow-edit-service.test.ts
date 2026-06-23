/**
 * WFEDIT-M2 — unit tests for the member NL workflow-edit service. Light fakes
 * for every dep (no Hub, no LLM, no sqlite): we drive the decision pipeline
 * directly and assert (a) the cross-hub 出入口 lock blocks boundary-touching
 * edits BEFORE any persistence, (b) local edits flow through to publish/saveDraft
 * by lifecycle state, and (c) RBAC / state / assistant failures map to typed
 * reasons.
 *
 * The YAML is real (`parseWorkflow` runs on both the "current" and the
 * "edited" side), so the boundary lock sees genuine `WorkflowDefinition`s — the
 * same path production takes.
 */

import { describe, expect, it } from 'vitest'

import { parseWorkflow, type LifecycleState } from '@aipehub/workflow'
import type { WorkflowAssistantOutput } from '@aipehub/workflow-assistant'

import {
  MeWorkflowEditService,
  sanitizeEditHistory,
  type MeWorkflowEditDeps,
  type MeWorkflowEditTurn,
} from '../src/me-workflow-edit-service.js'
import type { PeerCapabilityView } from '../src/workflow-controller.js'

// --- YAML builders (real text → real parseWorkflow) -------------------------

interface StepSpec {
  id: string
  cap: string
  payload?: string
  dataClasses?: string[]
}

function yamlStep(s: StepSpec): string {
  // dataClasses is a sibling of strategy/payload under dispatch → 8-space indent.
  const dc = s.dataClasses ? `\n        dataClasses: [${s.dataClasses.join(', ')}]` : ''
  return [
    `    - id: ${s.id}`,
    `      dispatch:`,
    `        strategy: { kind: capability, capabilities: [${s.cap}] }`,
    `        payload: ${s.payload ?? '{}'}${dc}`,
  ].join('\n')
}

function yamlWf(opts: { id?: string; trigger?: string; steps: StepSpec[] }): string {
  // parseWorkflow wants `schema:` at the top level and everything else nested
  // under a `workflow:` object (see packages/workflow/src/schema.ts).
  return [
    'schema: aipehub.workflow/v1',
    'workflow:',
    `  id: ${opts.id ?? 'flow'}`,
    '  trigger:',
    `    capability: ${opts.trigger ?? 'run-flow'}`,
    '  steps:',
    ...opts.steps.map(yamlStep),
  ].join('\n')
}

const LOCAL_WF = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: old }' }] })

const CROSS_HUB_WF = yamlWf({
  steps: [
    { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
    { id: 'place', cap: 'supplier.confirm-order', dataClasses: ['public'] },
  ],
})

/** A peer serving two off-hub caps — lets a retarget go cap→cap. */
const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    {
      peer: 'supplier-hub',
      label: '供货商 Hub',
      capabilities: ['supplier.confirm-order', 'supplier.express'],
    },
  ],
}

// --- assistant output fakes -------------------------------------------------

function assistOk(
  yaml: string,
  extra?: { explanation?: string; deepCheck?: WorkflowAssistantOutput['deepCheck'] },
): WorkflowAssistantOutput {
  return {
    text: yaml,
    raw: yaml,
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml,
    explanation: extra?.explanation ?? '改好了',
    draftStatus: 'valid',
    ...(extra?.deepCheck ? { deepCheck: extra.deepCheck } : {}),
  } as WorkflowAssistantOutput
}

function assistInvalid(): WorkflowAssistantOutput {
  return {
    text: '',
    raw: '',
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml: '',
    explanation: '改出来的 YAML 不合法',
    draftStatus: 'invalid',
    validationError: 'step "x" references unknown step',
  } as WorkflowAssistantOutput
}

// --- fake-deps builder ------------------------------------------------------

type GrantLevel = 'none' | 'viewer' | 'editor' | 'owner'
const RANK: Record<GrantLevel, number> = { none: 0, viewer: 1, editor: 2, owner: 3 }

interface BuildOpts {
  currentYaml: string
  state?: LifecycleState
  exists?: boolean
  /** `null` ⇒ no editable source; omitted ⇒ mirrors currentYaml. */
  source?: string | null
  grant?: GrantLevel
  assist: WorkflowAssistantOutput | Error
  participants?: Array<{ id: string; capabilities: string[] }>
  peerCapabilities?: PeerCapabilityView
  /**
   * WFEDIT-S2 — sticky cross-hub caps recorded for this workflow. Present (even
   * `[]`) wires a marker reader into the service; `undefined` leaves it absent
   * (pre-S2 behavior: live detection only).
   */
  sticky?: string[]
  failPersist?: Error
  /** MCD-M4 — installed MCP server names fed into the architect's contextHints. */
  mcpServerNames?: () => Promise<ReadonlyArray<string>> | ReadonlyArray<string>
}

function buildDeps(opts: BuildOpts) {
  const calls = {
    assist: 0,
    /** D3 — every prompt the assistant saw (history-folding assertions). */
    assistDescriptions: [] as string[],
    /** D4 — whether each assist call carried a per-call chunk sink. */
    assistHadOnChunk: [] as boolean[],
    /** MCD-M4 — the MCP server names the assistant saw via contextHints. */
    assistMcpServers: [] as Array<ReadonlyArray<string> | undefined>,
    publish: [] as Array<{ id: string; text?: string; by?: string }>,
    saveDraft: [] as Array<{ text: string; by?: string }>,
  }
  let persistedYaml = opts.currentYaml
  const grantRank = RANK[opts.grant ?? 'editor']

  const deps: MeWorkflowEditDeps = {
    grants: {
      hasWorkflowGrant: (_id, _userId, min) => grantRank >= RANK[min],
    },
    workflows: {
      versioning: {
        has: async () => opts.exists ?? true,
        // `original` is read before persist, so this reflects the pre-edit YAML.
        headDefinition: async () => parseWorkflow(persistedYaml),
      },
      getState: async () => ({ state: opts.state ?? 'published' }),
      exportDefinitionText: async () =>
        opts.source === undefined ? persistedYaml : opts.source,
      publish: async (id, o) => {
        if (opts.failPersist) throw opts.failPersist
        calls.publish.push({ id, ...o })
        if (o.text) persistedYaml = o.text
        return { id }
      },
      saveDraft: async (text, o) => {
        if (opts.failPersist) throw opts.failPersist
        calls.saveDraft.push({ text, ...o })
        persistedYaml = text
        return { id: 'flow' }
      },
    },
    assist: {
      assist: async (input) => {
        calls.assist++
        calls.assistDescriptions.push(input.description)
        calls.assistHadOnChunk.push(typeof input.onChunk === 'function')
        calls.assistMcpServers.push(input.contextHints?.mcpServers)
        // D4 — exercise the per-call streaming path when the caller wired one.
        input.onChunk?.('chunk-1')
        input.onChunk?.('chunk-2')
        if (opts.assist instanceof Error) throw opts.assist
        return opts.assist
      },
    },
    participants: () => opts.participants ?? [{ id: 'local-agent', capabilities: ['wf.draft'] }],
    ...(opts.peerCapabilities ? { peerCapabilities: opts.peerCapabilities } : {}),
    ...(opts.mcpServerNames ? { mcpServerNames: opts.mcpServerNames } : {}),
    ...(opts.sticky !== undefined
      ? { crossHubMarkers: { get: async () => opts.sticky as string[] } }
      : {}),
  }
  return { service: new MeWorkflowEditService(deps), calls }
}

const REQ = { workflowId: 'flow', userId: 'alice' }

// --- tests ------------------------------------------------------------------

describe('MeWorkflowEditService.edit — gates', () => {
  it('refuses a member without an editor grant (assistant never runs)', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, grant: 'viewer', assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forbidden')
    expect(calls.assist).toBe(0)
  })

  it('returns not_found for an unknown workflow', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, exists: false, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('refuses editing a workflow under review', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, state: 'review', assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('under_review')
    expect(calls.assist).toBe(0)
  })

  it('refuses editing an archived workflow', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, state: 'archived', assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('archived')
  })

  it('returns no_source when there is no editable YAML mirror', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, source: null, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no_source')
  })
})

describe('MeWorkflowEditService.edit — local edits flow through', () => {
  it('publishes a local-only edit to a live workflow', async () => {
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: NEW-AND-LONGER }' }] })
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(edited, { explanation: '把提示改长了' }) })
    const r = await service.edit({ ...REQ, instruction: '把第一步的提示写详细点' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.applied).toBe('published')
      expect(r.explanation).toBe('把提示改长了')
      expect(r.boundary.egress).toEqual([]) // purely local
      // WFEDIT-D1 — the result carries a line diff of what actually changed:
      // exactly the payload line was replaced, everything else reads `same`.
      expect(r.diff.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual([
        '        payload: { note: old }',
      ])
      expect(r.diff.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual([
        '        payload: { note: NEW-AND-LONGER }',
      ])
      expect(r.diff.some((l) => l.kind === 'same')).toBe(true)
    }
    expect(calls.publish).toHaveLength(1)
    expect(calls.publish[0]?.text).toBe(edited)
    expect(calls.publish[0]?.by).toBe('alice')
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('saves a draft (not publish) when the workflow is a draft', async () => {
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: NEW }' }] })
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, state: 'draft', assist: assistOk(edited) })
    const r = await service.edit({ ...REQ, instruction: '改一下' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.applied).toBe('draft')
    expect(calls.saveDraft).toHaveLength(1)
    expect(calls.publish).toHaveLength(0)
  })

  it('allows editing the LOCAL part of a cross-hub workflow (egress preserved)', async () => {
    // draft step changes; the cross-hub `place` step is untouched.
    const edited = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: MEMBER-EDIT }' },
        { id: 'place', cap: 'supplier.confirm-order', dataClasses: ['public'] },
      ],
    })
    const { service, calls } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(edited),
      peerCapabilities: PEER_VIEW,
    })
    const r = await service.edit({ ...REQ, instruction: '把起草那步改一下' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The locked boundary is reported back so the member SEES what stayed put.
      expect(r.boundary.egress).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] },
      ])
    }
    expect(calls.publish).toHaveLength(1)
  })

  it('threads deepCheck warnings through on success', async () => {
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: x }' }] })
    const deepCheck = { ok: false, violations: [{ kind: 'unknown_capability', path: 'steps[0]', message: 'no agent serves wf.draft' }] }
    const { service } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(edited, { deepCheck: deepCheck as WorkflowAssistantOutput['deepCheck'] }),
    })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.deepCheck).toEqual(deepCheck)
  })
})

describe('MeWorkflowEditService.edit — the cross-hub boundary lock', () => {
  it('rejects retargeting a cross-hub egress step (and never persists)', async () => {
    const retargeted = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
        { id: 'place', cap: 'supplier.express', dataClasses: ['public'] }, // ← off-hub target changed
      ],
    })
    const { service, calls } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(retargeted),
      peerCapabilities: PEER_VIEW,
    })
    const r = await service.edit({ ...REQ, instruction: '把下单发到加急那个' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('boundary_locked')
      expect(r.violations?.[0]?.kind).toBe('egress_retargeted')
      expect(r.violations?.[0]?.stepId).toBe('place')
    }
    expect(calls.publish).toHaveLength(0) // ← blocked BEFORE persistence
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('rejects changing the trigger (ingress) capability', async () => {
    const reTriggered = yamlWf({ trigger: 'run-other', steps: [{ id: 'draft', cap: 'wf.draft' }] })
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(reTriggered) })
    const r = await service.edit({ ...REQ, instruction: '换个触发方式' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('boundary_locked')
      expect(r.violations?.map((v) => v.kind)).toEqual(['trigger_changed'])
    }
    expect(calls.publish).toHaveLength(0)
  })

  it('rejects adding a brand-new cross-hub egress step', async () => {
    const sneaky = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
        { id: 'sneak', cap: 'supplier.confirm-order' }, // new off-hub hop the member tried to add
      ],
    })
    const { service, calls } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(sneaky),
      peerCapabilities: PEER_VIEW,
    })
    const r = await service.edit({ ...REQ, instruction: '加一步发给供货商' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('boundary_locked')
      expect(r.violations?.[0]?.kind).toBe('egress_added')
    }
    expect(calls.publish).toHaveLength(0)
  })
})

describe('MeWorkflowEditService — the sticky offline-peer lock (S2)', () => {
  // The off-hub target retargeting members try when the peer is down. Same shape
  // as the boundary-lock test above, but with NO `peerCapabilities` (offline).
  const RETARGET = yamlWf({
    steps: [
      { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
      { id: 'place', cap: 'supplier.express', dataClasses: ['public'] },
    ],
  })

  it('reactivates an OFFLINE egress via the sticky marker — retarget is caught', async () => {
    // Peer is down at edit time (no peerCapabilities), so live detection sees a
    // purely-local workflow. The marker remembers `place` left off-hub before,
    // so the lock still fires.
    const { service, calls } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(RETARGET),
      sticky: ['supplier.confirm-order', 'supplier.express'],
      // peerCapabilities intentionally ABSENT
    })
    const r = await service.edit({ ...REQ, instruction: '把下单发到加急那个' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('boundary_locked')
      expect(r.violations?.[0]?.kind).toBe('egress_retargeted')
      expect(r.violations?.[0]?.stepId).toBe('place')
    }
    expect(calls.publish).toHaveLength(0) // ← still blocked BEFORE persistence
    expect(calls.saveDraft).toHaveLength(0)
  })

  it('WITHOUT the marker, the same offline-peer retarget slips through (the gap S2 closes)', async () => {
    // No marker + no peer view → live detection flags nothing cross-hub (the cap
    // is served by nobody, so it never reads as egress) → the retarget persists.
    // This is exactly the hole the sticky marker plugs.
    const { service, calls } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(RETARGET),
      // no sticky, no peerCapabilities
    })
    const r = await service.edit({ ...REQ, instruction: '把下单发到加急那个' })
    expect(r.ok).toBe(true) // ← slips, because nothing flagged it cross-hub
    expect(calls.publish).toHaveLength(1)
  })

  it('an empty marker is a no-op (no over-lock when nothing was ever off-hub)', async () => {
    // sticky: [] wires the reader but records no caps → identical to absent.
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: NEW-AND-LONGER }' }] })
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(edited), sticky: [] })
    const r = await service.edit({ ...REQ, instruction: '改第一步' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.boundary.egress).toEqual([])
    expect(calls.publish).toHaveLength(1)
  })

  it('auto-deactivates a sticky cap once it is served locally (the cap came in-house)', async () => {
    // The off-hub cap is now answered by a LOCAL agent → the step is local, so
    // even with the marker still listing it the lock must not fire. Members can
    // freely edit a step that no longer leaves the hub.
    const editedLocalPlace = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
        { id: 'place', cap: 'supplier.confirm-order', payload: '{ note: MEMBER-EDIT }' },
      ],
    })
    const { service, calls } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(editedLocalPlace),
      sticky: ['supplier.confirm-order'],
      participants: [
        { id: 'local-agent', capabilities: ['wf.draft'] },
        { id: 'in-house', capabilities: ['supplier.confirm-order'] },
      ],
    })
    const r = await service.edit({ ...REQ, instruction: '改下单那步的内容' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.boundary.egress).toEqual([]) // served locally ⇒ no longer egress
    expect(calls.publish).toHaveLength(1)
  })

  it('editableView surfaces an offline cross-hub egress via the sticky marker', async () => {
    const { service } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      sticky: ['supplier.confirm-order'],
      assist: assistOk(CROSS_HUB_WF),
      // peer offline
    })
    const r = await service.editableView('flow', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.crossHub).toBe(true)
      expect(r.boundary.egress).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] },
      ])
    }
  })
})

describe('MeWorkflowEditService.edit — assistant / structure failures', () => {
  it('surfaces an invalid assistant draft as assistant_failed', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistInvalid() })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('assistant_failed')
      expect(r.draftStatus).toBe('invalid')
    }
    expect(calls.publish).toHaveLength(0)
  })

  it('surfaces an assist dispatch error as assistant_unavailable', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, assist: new Error('no api key') })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('assistant_unavailable')
  })

  it('rejects an assistant edit that changes the workflow id', async () => {
    const renamed = yamlWf({ id: 'other-flow', steps: [{ id: 'draft', cap: 'wf.draft' }] })
    const { service } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(renamed) })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('id_changed')
  })

  it('maps a structure-gate rejection from persist to structure_failed', async () => {
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: x }' }] })
    const { service } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(edited),
      failPersist: new Error("workflow 'flow' failed structural check — bad_ref @ steps[0]"),
    })
    const r = await service.edit({ ...REQ, instruction: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('structure_failed')
      expect(r.detail).toContain('bad_ref')
    }
  })
})

describe('MeWorkflowEditService.editableView', () => {
  it('returns the current YAML + boundary + crossHub flag for a federated workflow', async () => {
    const { service } = buildDeps({ currentYaml: CROSS_HUB_WF, peerCapabilities: PEER_VIEW, assist: assistOk(CROSS_HUB_WF) })
    const r = await service.editableView('flow', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.crossHub).toBe(true)
      expect(r.editable).toBe(true)
      expect(r.yaml).toBe(CROSS_HUB_WF)
      expect(r.boundary).toEqual({
        trigger: 'run-flow',
        egress: [{ stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] }],
      })
    }
  })

  it('marks a purely-local workflow as not cross-hub', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const r = await service.editableView('flow', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.crossHub).toBe(false)
      expect(r.boundary.egress).toEqual([])
    }
  })

  it('refuses the editable view without an editor grant', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, grant: 'viewer', assist: assistOk(LOCAL_WF) })
    const r = await service.editableView('flow', 'alice')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forbidden')
  })

  it('reports an archived workflow as not editable', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, state: 'archived', assist: assistOk(LOCAL_WF) })
    const r = await service.editableView('flow', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.editable).toBe(false)
  })
})

// --- D3: edit conversation history ------------------------------------------

describe('MeWorkflowEditService — edit conversation history (D3)', () => {
  it('folds prior turns into the assistant prompt, before the current request', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({
      ...REQ,
      instruction: '再礼貌一点',
      history: [
        { instruction: '把提示语改得礼貌一些', outcome: '已发布上线。把提示语改礼貌了。' },
        { instruction: '把出口指到 express', outcome: '失败:跨 hub 出入口不能改。' },
      ],
    })
    expect(r.ok).toBe(true)
    const prompt = calls.assistDescriptions[0]!
    expect(prompt).toContain('=== 之前的修改对话')
    expect(prompt).toContain('1. 用户: 把提示语改得礼貌一些')
    expect(prompt).toContain('结果: 已发布上线。把提示语改礼貌了。')
    expect(prompt).toContain('2. 用户: 把出口指到 express')
    expect(prompt).toContain('结果: 失败:跨 hub 出入口不能改。')
    // Conversation sits between the YAML and the current request.
    expect(prompt.indexOf('=== 之前的修改对话')).toBeGreaterThan(prompt.indexOf('=== 当前工作流 YAML ==='))
    expect(prompt.indexOf('=== 之前的修改对话')).toBeLessThan(prompt.indexOf('=== 用户的修改要求 ==='))
  })

  it('omits the conversation section when there is no history', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true)
    expect(calls.assistDescriptions[0]).not.toContain('之前的修改对话')
  })

  it('caps the prompt at the LAST 6 turns', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const history = Array.from({ length: 8 }, (_, i) => ({ instruction: `turn-${i + 1}-要求` }))
    const r = await service.edit({ ...REQ, instruction: '继续', history })
    expect(r.ok).toBe(true)
    const prompt = calls.assistDescriptions[0]!
    expect(prompt).not.toContain('turn-1-要求')
    expect(prompt).not.toContain('turn-2-要求')
    expect(prompt).toContain('turn-3-要求')
    expect(prompt).toContain('turn-8-要求')
  })
})

describe('MeWorkflowEditService — streaming edit preview (D4)', () => {
  it('forwards onChunk to the assist surface; chunks flow up THIS call', async () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const got: string[] = []
    const r = await service.edit({ ...REQ, instruction: '改点东西', onChunk: (c) => got.push(c) })
    expect(r.ok).toBe(true)
    expect(got).toEqual(['chunk-1', 'chunk-2'])
  })

  it('omits the onChunk field entirely when the caller did not stream', async () => {
    // The fake records presence, not just use — a stray always-present field
    // would silently turn every assist call into a "streaming" one.
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true)
    expect(calls.assistHadOnChunk).toEqual([false])
  })
})

describe('MeWorkflowEditService.edit — MCD-M4 MCP hints', () => {
  it('feeds installed MCP server names into the assistant contextHints', async () => {
    const { service, calls } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(LOCAL_WF),
      mcpServerNames: () => ['chroma-rag', 'obsidian-notes'],
    })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true)
    // The architect edits AROUND components that are already wired.
    expect(calls.assistMcpServers).toEqual([['chroma-rag', 'obsidian-notes']])
  })

  it('omits the MCP hint when no servers are installed (empty list)', async () => {
    const { service, calls } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(LOCAL_WF),
      mcpServerNames: () => [],
    })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true)
    expect(calls.assistMcpServers).toEqual([undefined])
  })

  it('omits the MCP hint entirely when no provider is wired (the default)', async () => {
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true)
    expect(calls.assistMcpServers).toEqual([undefined])
  })

  it('is best-effort: a registry read failure just omits the hint (edit still succeeds)', async () => {
    const { service, calls } = buildDeps({
      currentYaml: LOCAL_WF,
      assist: assistOk(LOCAL_WF),
      mcpServerNames: () => {
        throw new Error('registry off')
      },
    })
    const r = await service.edit({ ...REQ, instruction: '改点东西' })
    expect(r.ok).toBe(true) // the MCP hint is advisory — its failure never blocks editing
    expect(calls.assistMcpServers).toEqual([undefined])
  })
})

describe('sanitizeEditHistory (D3 pure)', () => {
  it('drops malformed turns and trims fields', () => {
    const out = sanitizeEditHistory([
      'just a string',
      null,
      42,
      { instruction: 99 },
      { instruction: '   ' },
      { instruction: '  好要求  ', outcome: '  有结果  ' },
      { instruction: '没结果的要求', outcome: 7 },
    ])
    expect(out).toEqual([
      { instruction: '好要求', outcome: '有结果' },
      { instruction: '没结果的要求' },
    ])
  })

  it('clips over-long fields to 500 chars + ellipsis', () => {
    const long = 'x'.repeat(600)
    const out = sanitizeEditHistory([{ instruction: long, outcome: long }])
    expect(out[0]!.instruction).toHaveLength(501)
    expect(out[0]!.instruction.endsWith('…')).toBe(true)
    expect(out[0]!.outcome).toHaveLength(501)
  })

  it('keeps only the last 6 turns and tolerates non-array input', () => {
    const turns: MeWorkflowEditTurn[] = Array.from({ length: 9 }, (_, i) => ({ instruction: `t${i + 1}` }))
    const out = sanitizeEditHistory(turns)
    expect(out.map((t) => t.instruction)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9'])
    expect(sanitizeEditHistory(undefined)).toEqual([])
    expect(sanitizeEditHistory('nope')).toEqual([])
  })
})
