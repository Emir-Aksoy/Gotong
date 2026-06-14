/**
 * A-M3 — `OperatorWorkflowEditService`: the operator console steward's SITE-WIDE
 * workflow-edit executor. It wraps the member `MeWorkflowEditService` with an
 * always-editor grant view, so the ONE divergence is the dropped per-workflow
 * RBAC gate — every other step, ★ the cross-hub 出入口 lock included ★, runs the
 * member pipeline verbatim.
 *
 * This gate pins the two properties A-M3 must guarantee:
 *   1. an operator with NO grant mechanism at all can still edit a LOCAL step
 *      (the RBAC bypass that makes it site-wide) — the SAME edit a `viewer`
 *      member is refused for;
 *   2. a cross-hub egress edit (retarget / add / trigger change) is STILL
 *      `boundary_locked` and never persists — the governance contract an operator
 *      cannot bypass either.
 *
 * Light fakes for every dep (no Hub, no LLM, no sqlite). The YAML is real
 * (`parseWorkflow` runs on both the current + edited side), so the boundary lock
 * sees genuine `WorkflowDefinition`s — the production path.
 */

import { describe, expect, it } from 'vitest'

import { parseWorkflow, type LifecycleState } from '@aipehub/workflow'
import type { WorkflowAssistantOutput } from '@aipehub/workflow-assistant'

import {
  OperatorWorkflowEditService,
  type OperatorWorkflowEditDeps,
} from '../src/operator-workflow-edit-service.js'
import type { StewardWorkflowEditor } from '../src/hub-steward-service.js'
import type { PeerCapabilityView } from '../src/workflow-controller.js'

// --- YAML builders (real text → real parseWorkflow) -------------------------

interface StepSpec {
  id: string
  cap: string
  payload?: string
  dataClasses?: string[]
}

function yamlStep(s: StepSpec): string {
  const dc = s.dataClasses ? `\n        dataClasses: [${s.dataClasses.join(', ')}]` : ''
  return [
    `    - id: ${s.id}`,
    `      dispatch:`,
    `        strategy: { kind: capability, capabilities: [${s.cap}] }`,
    `        payload: ${s.payload ?? '{}'}${dc}`,
  ].join('\n')
}

function yamlWf(opts: { id?: string; trigger?: string; steps: StepSpec[] }): string {
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

// --- assistant output fake --------------------------------------------------

function assistOk(yaml: string): WorkflowAssistantOutput {
  return {
    text: yaml,
    raw: yaml,
    stopReason: 'end_turn',
    by: 'workflow-assistant',
    yaml,
    explanation: '改好了',
    draftStatus: 'valid',
  } as WorkflowAssistantOutput
}

// --- fake-deps builder (NOTE: NO `grants` field — that's the whole point) ----

interface BuildOpts {
  currentYaml: string
  state?: LifecycleState
  assist: WorkflowAssistantOutput
  participants?: Array<{ id: string; capabilities: string[] }>
  peerCapabilities?: PeerCapabilityView
}

function buildDeps(opts: BuildOpts) {
  const calls = { publish: [] as Array<{ id: string }>, saveDraft: [] as Array<{ text: string }> }
  let persistedYaml = opts.currentYaml

  // OperatorWorkflowEditDeps deliberately OMITS `grants` — there is no per-workflow
  // RBAC source anywhere in the operator path. The service injects ALWAYS_EDITOR.
  const deps: OperatorWorkflowEditDeps = {
    workflows: {
      versioning: {
        has: async () => true,
        headDefinition: async () => parseWorkflow(persistedYaml),
      },
      getState: async () => ({ state: opts.state ?? 'published' }),
      exportDefinitionText: async () => persistedYaml,
      publish: async (id, o) => {
        calls.publish.push({ id })
        if (o.text) persistedYaml = o.text
        return { id }
      },
      saveDraft: async (text) => {
        calls.saveDraft.push({ text })
        persistedYaml = text
        return { id: 'flow' }
      },
    },
    assist: {
      assist: async () => opts.assist,
    },
    participants: () => opts.participants ?? [{ id: 'local-agent', capabilities: ['wf.draft'] }],
    ...(opts.peerCapabilities ? { peerCapabilities: opts.peerCapabilities } : {}),
  }
  return { service: new OperatorWorkflowEditService(deps), calls }
}

const REQ = { workflowId: 'flow', userId: 'op1' }

// --- tests ------------------------------------------------------------------

describe('A-M3 — OperatorWorkflowEditService (site-wide, no RBAC, boundary kept)', () => {
  it('edits a LOCAL step with no grant mechanism at all (the site-wide bypass)', async () => {
    // A `viewer` member is refused this exact edit; the operator — who has no
    // grant row anywhere — sails through, because the operator path injects an
    // always-editor view. Proves the RBAC line is gone.
    const edited = yamlWf({ steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: OPERATOR-EDIT }' }] })
    const { service, calls } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(edited) })
    const r = await service.edit({ ...REQ, instruction: '把第一步改一下' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.applied).toBe('published')
      expect(r.boundary.egress).toEqual([]) // purely local
    }
    expect(calls.publish).toHaveLength(1)
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

  it('edits the LOCAL part of a cross-hub workflow (egress preserved byte-for-byte)', async () => {
    const edited = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: OPERATOR-EDIT }' },
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
      expect(r.boundary.egress).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] },
      ])
    }
    expect(calls.publish).toHaveLength(1)
  })

  it('STILL blocks retargeting a cross-hub egress step (operator can NOT bypass the lock)', async () => {
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

  it('STILL blocks adding a brand-new cross-hub egress step', async () => {
    const sneaky = yamlWf({
      steps: [
        { id: 'draft', cap: 'wf.draft', payload: '{ note: old }' },
        { id: 'sneak', cap: 'supplier.confirm-order' }, // new off-hub hop
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

  it('STILL blocks changing the trigger (ingress) capability', async () => {
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

  it('editableView returns the YAML + boundary with no grant gate', async () => {
    const { service } = buildDeps({
      currentYaml: CROSS_HUB_WF,
      assist: assistOk(CROSS_HUB_WF),
      peerCapabilities: PEER_VIEW,
    })
    const r = await service.editableView('flow', 'op1')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.crossHub).toBe(true)
      expect(r.editable).toBe(true)
      expect(r.boundary.egress).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] },
      ])
    }
  })

  it('structurally satisfies StewardWorkflowEditor (drops into performStewardAction)', () => {
    const { service } = buildDeps({ currentYaml: LOCAL_WF, assist: assistOk(LOCAL_WF) })
    const editor: StewardWorkflowEditor = service
    expect(typeof editor.edit).toBe('function')
  })
})
