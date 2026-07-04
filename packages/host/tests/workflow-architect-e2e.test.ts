/**
 * ARCH-M8 — end-to-end acceptance for the 工作流架构师 (Workflow Architect).
 *
 * The deterministic example (`examples/workflow-architect`) proves the AGENT
 * behaviors host-free. The ARCH-M5 unit test drives `MeWorkflowCreateService`
 * with light fakes. This gate closes the seam neither can: the REAL host
 * pipeline, end to end —
 *
 *   a real `WorkflowAssistantAgent` dispatched through a real `Hub` (a
 *   DETERMINISTIC mock LLM so the assertion is stable, not the network) +
 *   the real `verdictForYamlWithDeepCheck` graph/deep-check + a real
 *   `WorkflowController` + `WorkflowVersioning` (file-backed, run-drift-safe) +
 *   real `IdentityStore` RBAC grants + the real `workflowBoundary` lock.
 *
 * Exactly the spec the user asked for ("内置一个 agent 能在自然语言下搭建工作流
 * YAML…配图…", and the member side stays local-only):
 *
 *   1. The assist output carries the CORRECT graph — node/edge counts match an
 *      independent projection of the produced YAML (the 工作流图片介绍 is the real
 *      picture of THIS workflow, not a stale/fabricated one).
 *   2. The deep-check catches a FABRICATED capability against the live inventory
 *      — the warning a plain NL generator can't produce. (Advisory, so the draft
 *      still lands; the warning is surfaced, not swallowed.)
 *   3. A member's plain-language CREATE lands a DRAFT owned by the member, on
 *      THIS hub only.
 *   4. ★ A member-authored workflow with an off-hub hop is REFUSED and nothing is
 *      persisted — the controller holds nothing, exactly like the editor's lock.
 *
 * The assistant is a real `WorkflowAssistantAgent`; only its LLM is a mock whose
 * reply is keyed off a marker the test embeds in the instruction — one provider,
 * every scenario, fully deterministic, no real key.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, InMemoryStorage } from '@gotong/core'
import { MockLlmProvider, type LlmRequest } from '@gotong/llm'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { parseWorkflow, projectWorkflowGraph } from '@gotong/workflow'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
} from '@gotong/workflow-assistant'

import { WorkflowController, type PeerCapabilityView } from '../src/workflow-controller.js'
import {
  MeWorkflowCreateService,
  type WorkflowAssistAuthorView,
} from '../src/me-workflow-create-service.js'

// --- YAML builders (real text → real parseWorkflow) -------------------------

interface StepSpec {
  id: string
  cap: string
  payload?: string
}

function yamlStep(s: StepSpec): string {
  return [
    `    - id: ${s.id}`,
    `      dispatch:`,
    `        strategy: { kind: capability, capabilities: [${s.cap}] }`,
    `        payload: ${s.payload ?? '{}'}`,
  ].join('\n')
}

function yamlWf(opts: { id: string; trigger: string; steps: StepSpec[] }): string {
  return (
    [
      'schema: gotong.workflow/v1',
      'workflow:',
      `  id: ${opts.id}`,
      '  trigger:',
      `    capability: ${opts.trigger}`,
      '  steps:',
      ...opts.steps.map(yamlStep),
    ].join('\n') + '\n'
  )
}

// A purely-local 2-step workflow (4 nodes, 4 edges, 1 data edge). All caps are
// served by the local worker, so it authors + saves cleanly.
const LOCAL_AUTHORED = yamlWf({
  id: 'morning-digest',
  trigger: 'run-morning',
  steps: [
    { id: 'gather', cap: 'collect-notes' },
    { id: 'summarize', cap: 'summarize', payload: '{ source: $gather.output }' },
  ],
})

// A workflow that PARSES fine but dispatches to a capability NOBODY serves
// (not local, not a peer) — the deep-check flags `unknown_capability`.
const FABRICATED_CAP = yamlWf({
  id: 'poster-maker',
  trigger: 'run-poster',
  steps: [{ id: 'render', cap: 'image-generation' }],
})

// A member-authored workflow whose second step leaves the hub: `supplier.confirm-order`
// is served by a PEER, not locally → an off-hub egress hop the lock refuses.
const CROSS_AUTHORED = yamlWf({
  id: 'member-cross',
  trigger: 'run-cross',
  steps: [
    { id: 'local-draft', cap: 'draft' },
    { id: 'place-order', cap: 'supplier.confirm-order' },
  ],
})

/** The peer advertising the off-hub cap — the SAME view the create service's
 *  cross-hub detection consumes, so what it refuses matches what the UI flags. */
const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    { peer: 'supplier-hub', label: '供货商 Hub', capabilities: ['supplier.confirm-order'] },
  ],
}

// --- deterministic assistant LLM --------------------------------------------

/** Wrap a YAML body in the ```yaml fence the assistant extracts. */
function fence(yaml: string): string {
  return ['好的，这是工作流：', '', '```yaml', yaml.trimEnd(), '```'].join('\n')
}

/**
 * The mock keys its reply off a marker the test embeds in the member's
 * instruction (which the service folds into the prompt). One provider, every
 * scenario, fully deterministic.
 */
const MARK = { local: 'MARK_LOCAL', fabricated: 'MARK_FABRICATED', cross: 'MARK_CROSS' }
function architectReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  if (seen.includes(MARK.fabricated)) return fence(FABRICATED_CAP)
  if (seen.includes(MARK.cross)) return fence(CROSS_AUTHORED)
  if (seen.includes(MARK.local)) return fence(LOCAL_AUTHORED)
  // No marker — echo a benign valid workflow so an unexpected call still parses.
  return fence(LOCAL_AUTHORED)
}

// --- rig --------------------------------------------------------------------

const MEMBER = 'alice'
// The local worker serves these — the inventory the deep-check checks against
// AND the local-cap set the boundary lock uses.
const LOCAL_CAPS = ['collect-notes', 'summarize', 'draft']

interface Rig {
  tmp: string
  hub: Hub
  identity: IdentityStore
  controller: WorkflowController
  assist: WorkflowAssistAuthorView
  /** Build the create service with (or without) the off-hub capability view. */
  makeCreate: (peer?: PeerCapabilityView) => MeWorkflowCreateService
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-arch-e2e-'))
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  // The local worker — a known capability in the inventory AND part of the
  // boundary's local-cap set.
  hub.register(new HumanParticipant({ id: 'local-worker', capabilities: LOCAL_CAPS }))

  // The REAL architect, with a deterministic mock LLM.
  hub.register(
    new WorkflowAssistantAgent({
      provider: new MockLlmProvider({ reply: architectReply }),
      maxTokens: 2048,
    }),
  )

  // The host's assist adapter — like `WorkflowAssistSurface.assist`, it threads
  // mode/detail/subjectYaml/contextHints into the dispatch payload (NOT just
  // description), so the agent's author/explain + deep-check branches activate.
  const assist: WorkflowAssistAuthorView = {
    async assist(input) {
      const result = await hub.dispatch({
        from: input.by,
        strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
        payload: {
          description: input.description,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.subjectYaml !== undefined ? { subjectYaml: input.subjectYaml } : {}),
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

  const makeCreate = (peer?: PeerCapabilityView) =>
    new MeWorkflowCreateService({
      grants: identity,
      workflows: controller,
      assist,
      participants: () =>
        hub.participants().map((p) => ({ id: p.id, capabilities: p.capabilities })),
      ...(peer ? { peerCapabilities: peer } : {}),
    })

  return { tmp, hub, identity, controller, assist, makeCreate }
}

async function teardown(r: Rig): Promise<void> {
  await r.hub.stop()
  r.identity.close()
  await rm(r.tmp, { recursive: true, force: true })
}

// --- tests ------------------------------------------------------------------

describe('workflow-architect ARCH-M8 — assist + member create, real stack', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(() => teardown(r))

  it('1. the assist output carries the CORRECT graph (node/edge counts match the YAML)', async () => {
    const out = await r.assist.assist({
      description: `每天早上收集笔记再总结发我 ${MARK.local}`,
      mode: 'author',
      contextHints: { agents: [{ id: 'local-worker', capabilities: LOCAL_CAPS }] },
      by: MEMBER,
    })

    expect(out.draftStatus).toBe('valid')
    expect(out.graph).toBeDefined()
    // ★ the graph is the TRUE projection of the produced YAML, not a stale one.
    const oracle = projectWorkflowGraph(parseWorkflow(out.yaml))
    expect(out.graph).toEqual(oracle)
    // Spell the picture out: trigger + 2 steps + output = 4 nodes; 3 sequence
    // backbone edges + 1 data edge (gather → summarize via $ref) = 4 edges.
    expect(out.graph!.workflowId).toBe('morning-digest')
    expect(out.graph!.nodes).toHaveLength(4)
    expect(out.graph!.edges).toHaveLength(4)
    expect(out.graph!.edges.filter((e) => e.kind === 'data')).toHaveLength(1)
  })

  it('2. the deep-check catches a FABRICATED capability against the live inventory', async () => {
    const out = await r.assist.assist({
      description: `给我做一张海报 ${MARK.fabricated}`,
      mode: 'author',
      // The live inventory: only the local worker's caps. `image-generation` is
      // not in it (and not a peer) — exactly the fabricated-capability case.
      contextHints: { agents: [{ id: 'local-worker', capabilities: LOCAL_CAPS }] },
      by: MEMBER,
    })

    // The YAML parses — a plain generator would call this "fine".
    expect(out.draftStatus).toBe('valid')
    // ★ but the architect's deep-check flags it (advisory, never blocks).
    expect(out.deepCheck).toBeDefined()
    expect(out.deepCheck!.ok).toBe(false)
    expect(out.deepCheck!.violations.map((v) => v.kind)).toContain('unknown_capability')
    // The graph still rides along — a valid (if flawed) workflow is still drawable.
    expect(out.graph?.workflowId).toBe('poster-maker')
  })

  it('3. a member CREATE lands a DRAFT owned by the member (local-only)', async () => {
    const svc = r.makeCreate() // no peer view → single hub
    const res = await svc.create({
      instruction: `每天早上收集笔记再总结发我 ${MARK.local}`,
      userId: MEMBER,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.workflowId).toBe('morning-digest')
      expect(res.graph?.workflowId).toBe('morning-digest') // the flowchart rides the result
    }
    // ★ it really persisted: the controller now has it, as a DRAFT, owned by alice.
    expect(await r.controller.versioning.has('morning-digest')).toBe(true)
    expect((await r.controller.getState('morning-digest')).state).toBe('draft')
    expect(r.identity.hasWorkflowGrant('morning-digest', MEMBER, 'owner')).toBe(true)
    // A draft is never auto-live — the /me catalog (published-only) won't show it yet.
  })

  it('★ 4. a member CREATE with an off-hub hop is REFUSED and nothing is persisted', async () => {
    const svc = r.makeCreate(PEER_VIEW) // peer advertises supplier.confirm-order
    const res = await svc.create({
      instruction: `下单给供货商 ${MARK.cross}`,
      userId: MEMBER,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('cross_hub')
      // the member-readable message names the off-hub capability.
      expect(res.message).toContain('supplier.confirm-order')
    }
    // ★ the security claim: the lock blocked the WRITE — the controller holds
    // nothing, and no owner grant was seeded.
    expect(await r.controller.versioning.has('member-cross')).toBe(false)
    expect(r.identity.hasWorkflowGrant('member-cross', MEMBER, 'owner')).toBe(false)
  })
})
