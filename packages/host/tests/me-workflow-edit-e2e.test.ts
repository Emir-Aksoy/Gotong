/**
 * WFEDIT-M5 — end-to-end acceptance for member natural-language workflow
 * editing with the cross-hub 出入口 lock.
 *
 * The M2 unit test drives the service with light fakes; the M3 route test
 * forwards to a FAKE surface. This gate closes the one seam neither can: the
 * REAL host pipeline, end to end —
 *
 *   real WorkflowController + WorkflowVersioning (the file-backed, run-drift-safe
 *   versioning core) + a real WorkflowAssistantAgent dispatched through a real
 *   Hub (a DETERMINISTIC mock LLM so the assertion is stable, not the network) +
 *   real IdentityStore RBAC grants + the real `enforceEditBoundary` lock.
 *
 * Three claims, proven against the real stack — exactly the spec the user asked
 * for ("自然语言改工作流;有跨 hub 连接的不能改出入口,只能改自己的部分"):
 *
 *   1. A member's plain-language edit of a PURELY-LOCAL workflow becomes a new
 *      immutable revision on the SAME workflow (rev1 → rev2), not a fork. Full
 *      OpenClaw freedom: only the trigger is pinned, the step body changed.
 *   2. ★ A member who tries to RETARGET a cross-hub egress is rejected
 *      `boundary_locked` AND nothing is persisted — the controller still holds
 *      ONLY rev1, and the on-disk YAML is byte-identical. The lock truly
 *      prevents the write; it doesn't merely return an error. (the security claim)
 *   3. A member editing the LOCAL step of a cross-hub workflow keeps the egress
 *      byte-invariant and DOES get a new revision (rev2) — "改自己这边" works.
 *
 * The assistant is a real `WorkflowAssistantAgent` (real YAML extraction +
 * draftStatus + deepCheck), only its LLM is a mock whose reply is keyed off a
 * marker embedded in the member's instruction — so a single provider serves all
 * scenarios deterministically without burning a real key.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, InMemoryStorage } from '@aipehub/core'
import { MockLlmProvider, type LlmRequest } from '@aipehub/llm'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
} from '@aipehub/workflow-assistant'

import { WorkflowController, type PeerCapabilityView } from '../src/workflow-controller.js'
import {
  MeWorkflowEditService,
  type WorkflowAssistView,
} from '../src/me-workflow-edit-service.js'

// --- YAML builders (real text → real parseWorkflow, mirrors the M2 unit test) -

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

function yamlWf(opts: { id: string; trigger: string; steps: StepSpec[] }): string {
  return (
    [
      'schema: aipehub.workflow/v1',
      'workflow:',
      `  id: ${opts.id}`,
      '  trigger:',
      `    capability: ${opts.trigger}`,
      '  steps:',
      ...opts.steps.map(yamlStep),
    ].join('\n') + '\n'
  )
}

// Local-only workflow: one local step, no off-hub hop.
const LOCAL_FLOW = yamlWf({
  id: 'local-flow',
  trigger: 'run-local',
  steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: original }' }],
})
// The assistant's edited version (a longer note) — what the member asked for.
const LOCAL_FLOW_EDITED = yamlWf({
  id: 'local-flow',
  trigger: 'run-local',
  steps: [{ id: 'draft', cap: 'wf.draft', payload: '{ note: MEMBER_MADE_THIS_LONGER }' }],
})

// Cross-hub workflow: a local draft step + a cross-hub `place` egress to a peer.
const CROSS_FLOW = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [
    { id: 'draft', cap: 'wf.draft', payload: '{ note: original }' },
    { id: 'place', cap: 'supplier.confirm-order', dataClasses: ['public'] },
  ],
})
// What a member SHOULDN'T be able to do: repoint the off-hub destination.
const CROSS_FLOW_RETARGET = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [
    { id: 'draft', cap: 'wf.draft', payload: '{ note: original }' },
    { id: 'place', cap: 'supplier.express', dataClasses: ['public'] }, // ← egress moved
  ],
})
// What a member SHOULD be able to do: reshape the local step, egress untouched.
const CROSS_FLOW_LOCALEDIT = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [
    { id: 'draft', cap: 'wf.draft', payload: '{ note: MEMBER_EDITED_LOCAL }' },
    { id: 'place', cap: 'supplier.confirm-order', dataClasses: ['public'] }, // ← identical
  ],
})

/** A peer advertising two off-hub caps — the same view the controller's
 *  cross-hub-step detection consumes, so the lock matches what the UI flags. */
const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    {
      peer: 'supplier-hub',
      label: '供货商 Hub',
      capabilities: ['supplier.confirm-order', 'supplier.express'],
    },
  ],
}

// --- deterministic assistant LLM -------------------------------------------

/** Wrap a YAML body in the ```yaml fence the assistant extracts. */
function fence(yaml: string): string {
  return ['这是改好的工作流:', '', '```yaml', yaml.trimEnd(), '```'].join('\n')
}

/**
 * The mock LLM keys its reply off a marker the test embeds in the member's
 * instruction (which the service folds into the assistant's prompt). One
 * provider, every scenario, fully deterministic — no network, no real key.
 */
const MARK = { localOnly: 'MARK_LOCALONLY', retarget: 'MARK_RETARGET', crossLocal: 'MARK_CROSSLOCAL' }
function assistantReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  if (seen.includes(MARK.crossLocal)) return fence(CROSS_FLOW_LOCALEDIT)
  if (seen.includes(MARK.retarget)) return fence(CROSS_FLOW_RETARGET)
  if (seen.includes(MARK.localOnly)) return fence(LOCAL_FLOW_EDITED)
  // No marker — echo a benign valid edit so an unexpected call still parses.
  return fence(LOCAL_FLOW_EDITED)
}

// --- rig --------------------------------------------------------------------

interface Rig {
  tmp: string
  hub: Hub
  identity: IdentityStore
  controller: WorkflowController
  assist: WorkflowAssistView
  /** Build the service with (or without) the off-hub capability view. */
  makeService: (peer?: PeerCapabilityView) => MeWorkflowEditService
}

const MEMBER = 'alice'

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-wfedit-e2e-'))
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  // A local worker serving the workflows' LOCAL capability — so it's a known
  // capability in the inventory AND part of the boundary's local-cap set.
  hub.register(new HumanParticipant({ id: 'local-worker', capabilities: ['wf.draft'] }))

  // The REAL assistant, with a deterministic mock LLM. No few-shot examples →
  // the prompt stays small and the marker-match reply is unambiguous.
  const assistant = new WorkflowAssistantAgent({
    provider: new MockLlmProvider({ reply: assistantReply }),
    maxTokens: 2048,
  })
  hub.register(assistant)

  // The host's assist adapter, mirroring WorkflowAssistSurface.assist exactly:
  // dispatch a workflow:assist task through the real hub and return the output.
  const assist: WorkflowAssistView = {
    async assist(input) {
      const result = await hub.dispatch({
        from: input.by,
        strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
        payload: {
          description: input.description,
          ...(input.contextHints ? { contextHints: input.contextHints } : {}),
        },
        title: 'workflow:assist',
      })
      if (result.kind !== 'ok') throw new Error(`assist dispatch failed: ${result.kind}`)
      return result.output as WorkflowAssistantOutput
    },
  }

  const controller = new WorkflowController({
    hub,
    definitionsDir: join(tmp, 'workflows', 'definitions'),
    spaceRoot: tmp,
  })

  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

  const makeService = (peer?: PeerCapabilityView) =>
    new MeWorkflowEditService({
      grants: identity,
      workflows: controller,
      assist,
      participants: () => hub.participants(),
      ...(peer ? { peerCapabilities: peer } : {}),
    })

  return { tmp, hub, identity, controller, assist, makeService }
}

async function teardown(r: Rig): Promise<void> {
  await r.hub.stop()
  r.identity.close()
  await rm(r.tmp, { recursive: true, force: true })
}

/** Grant `alice` editor on a workflow (the RBAC the service gates on). */
function grantEditor(r: Rig, workflowId: string): void {
  r.identity.setWorkflowGrant({ workflowId, userId: MEMBER, perm: 'editor', grantedBy: 'owner' })
}

// --- tests ------------------------------------------------------------------

describe('WFEDIT-M5 — member NL workflow edit, real stack', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(() => teardown(r))

  it('local-only edit lands as a new immutable revision on the same workflow (no drift)', async () => {
    await r.controller.importFromText(LOCAL_FLOW) // publishes rev1
    grantEditor(r, 'local-flow')
    expect(await r.controller.listRevisions('local-flow')).toHaveLength(1)

    const svc = r.makeService() // no peer view → purely local
    const res = await svc.edit({
      workflowId: 'local-flow',
      instruction: `把第一步的提示写详细一点 ${MARK.localOnly}`,
      userId: MEMBER,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.applied).toBe('published') // a live workflow → publish-edit
      expect(res.boundary.egress).toEqual([]) // purely local: only the trigger is pinned
      expect(res.boundary.trigger).toBe('run-local')
    }
    // ★ no drift: a NEW revision on the SAME id, and the change is on disk.
    expect(await r.controller.listRevisions('local-flow')).toHaveLength(2)
    const onDisk = await r.controller.exportDefinitionText('local-flow')
    expect(onDisk).toContain('MEMBER_MADE_THIS_LONGER')
    expect((await r.controller.getState('local-flow')).state).toBe('published')
  })

  it('★ rejects retargeting a cross-hub egress AND persists nothing (the lock is real)', async () => {
    await r.controller.importFromText(CROSS_FLOW) // rev1
    grantEditor(r, 'cross-flow')
    const before = await r.controller.exportDefinitionText('cross-flow')
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(1)

    const svc = r.makeService(PEER_VIEW)
    const res = await svc.edit({
      workflowId: 'cross-flow',
      instruction: `把下单那步改发到加急渠道 ${MARK.retarget}`,
      userId: MEMBER,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('boundary_locked')
      expect(res.violations?.[0]?.kind).toBe('egress_retargeted')
      expect(res.violations?.[0]?.stepId).toBe('place')
    }
    // ★ the security claim: the controller still has ONLY rev1, and the on-disk
    // YAML is byte-identical — the lock blocked the write, not just the response.
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(1)
    expect(await r.controller.exportDefinitionText('cross-flow')).toBe(before)
    expect(await r.controller.exportDefinitionText('cross-flow')).not.toContain('supplier.express')
  })

  it('allows editing the LOCAL step of a cross-hub workflow (egress byte-invariant, new rev)', async () => {
    await r.controller.importFromText(CROSS_FLOW) // rev1
    grantEditor(r, 'cross-flow')

    const svc = r.makeService(PEER_VIEW)
    const res = await svc.edit({
      workflowId: 'cross-flow',
      instruction: `把起草那一步改一下 ${MARK.crossLocal}`,
      userId: MEMBER,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      // The locked boundary is reported back so the member SEES what stayed put.
      expect(res.boundary.egress).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] },
      ])
    }
    // A new revision landed; the egress hop survived byte-for-byte, the local
    // step changed.
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(2)
    const onDisk = await r.controller.exportDefinitionText('cross-flow')
    expect(onDisk).toContain('MEMBER_EDITED_LOCAL')
    expect(onDisk).toContain('supplier.confirm-order')
    expect(onDisk).toContain('dataClasses: [public]')
    expect(onDisk).not.toContain('supplier.express')
  })

  it('editableView surfaces the real YAML + the governed boundary for a cross-hub workflow', async () => {
    await r.controller.importFromText(CROSS_FLOW)
    grantEditor(r, 'cross-flow')

    const svc = r.makeService(PEER_VIEW)
    const view = await svc.editableView('cross-flow', MEMBER)

    expect(view.ok).toBe(true)
    if (view.ok) {
      expect(view.crossHub).toBe(true)
      expect(view.editable).toBe(true)
      expect(view.yaml).toContain('supplier.confirm-order')
      expect(view.boundary).toEqual({
        trigger: 'run-cross',
        egress: [{ stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] }],
      })
    }
  })

  it('refuses a member without an editor grant (the assistant never runs)', async () => {
    await r.controller.importFromText(LOCAL_FLOW)
    // No grant seeded for alice.
    const svc = r.makeService()
    const res = await svc.edit({
      workflowId: 'local-flow',
      instruction: `改点东西 ${MARK.localOnly}`,
      userId: MEMBER,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('forbidden')
    // The local-only workflow stayed at rev1 — nothing was touched.
    expect(await r.controller.listRevisions('local-flow')).toHaveLength(1)
  })
})
