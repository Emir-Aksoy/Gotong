/**
 * butler-workflow-create-e2e — Track A BE-M3. The governed `create_workflow` verb
 * end to end, closing the seams the isolated unit test can't:
 *
 *   ① MULTI-GATE COMPOSITION — the butler is wired the way main.ts wires it: the
 *      steward gate (BF-M7) AND the create_workflow gate (BE-M3) in one `governed`
 *      array. A `create_workflow` call must resume into the CREATE gate's executor
 *      (the member 工作流架构师), not the steward — proving `governedFor` routes by
 *      tool name across two composed `GovernedActionToolset`s.
 *   ② park → /me → approve → the REAL `MeWorkflowCreateService.create` runs (its
 *      genuine NL→YAML→parse→boundary→persist pipeline), landing a draft owned by
 *      the member. Nothing is created before approval.
 *   ③ the LOCAL-ONLY gate is inherited: a workflow with cross-hub egress is denied
 *      by the service's real boundary primitive → the butler relays "couldn't",
 *      and NO draft is persisted.
 *   ④ reject → fail-closed: the create service is never called.
 *
 * The create service is REAL (its boundary + parse logic is the code under test);
 * only its persistence sink + grant writer + assistant are recording fakes, so the
 * test stays hermetic (no WorkflowController, no LLM, no sqlite for the draft). The
 * butler loop, park, /me item, and two-step resume are the real code.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  type AgentRecord,
  type Logger,
  type ManagedAgentLifecycle,
  type ParticipantId,
} from '@gotong/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'
import { PersonalButlerAgent } from '@gotong/personal-butler'
import { parseWorkflow, projectWorkflowGraph } from '@gotong/workflow'
import type { WorkflowAssistantOutput } from '@gotong/workflow-assistant'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import { buildButlerWorkflowCreateToolset } from '../src/personal-butler-workflow-create.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostMeAgentService } from '../src/me-agent-service.js'
import { MeWorkflowCreateService } from '../src/me-workflow-create-service.js'
import type { PeerCapabilityView } from '../src/workflow-controller.js'

const USER = 'u1'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

// --- real YAML for the fake assistant to "author" ---------------------------

function yamlWf(steps: string): string {
  return [
    'schema: gotong.workflow/v1',
    'workflow:',
    '  id: daily-todo',
    '  trigger:',
    '    capability: run-flow',
    '  steps:',
    steps,
  ].join('\n')
}
const LOCAL_WF = yamlWf(
  ['    - id: draft', '      dispatch:', '        strategy: { kind: capability, capabilities: [wf.draft] }', '        payload: { note: hi }'].join('\n'),
)
const CROSS_HUB_WF = yamlWf(
  [
    '    - id: draft',
    '      dispatch:',
    '        strategy: { kind: capability, capabilities: [wf.draft] }',
    '        payload: { note: hi }',
    '    - id: place',
    '      dispatch:',
    '        strategy: { kind: capability, capabilities: [supplier.confirm-order] }',
    '        payload: {}',
    '        dataClasses: [public]',
  ].join('\n'),
)
// A peer serving `supplier.confirm-order` off-hub → the `place` step reads as egress.
const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    { peer: 'supplier-hub', label: '供货商 Hub', capabilities: ['supplier.confirm-order'] },
  ],
}

function assistOk(yaml: string): WorkflowAssistantOutput {
  return {
    text: yaml, raw: yaml, stopReason: 'end_turn', by: 'workflow-assistant',
    yaml, explanation: '每天早上把你的待办整理成要点发给你。', draftStatus: 'valid',
    graph: projectWorkflowGraph(parseWorkflow(yaml)),
  } as WorkflowAssistantOutput
}

// A REAL MeWorkflowCreateService with recording fakes for its sinks. Its boundary
// (cross-hub reject) + parse logic run for real — that's the point.
function makeCreateService(yaml: string, peer?: PeerCapabilityView) {
  const saved: Array<{ id: string; by?: string }> = []
  const grants: Array<{ workflowId: string; userId: string; perm: string }> = []
  const svc = new MeWorkflowCreateService({
    grants: { setWorkflowGrant: (i) => { grants.push({ workflowId: i.workflowId, userId: i.userId, perm: i.perm }); return undefined } },
    workflows: {
      versioning: { has: async () => false },
      saveDraft: async (text, o) => { const id = parseWorkflow(text).id; saved.push({ id, ...(o.by ? { by: o.by } : {}) }); return { id } },
      exportDefinitionText: async () => null,
    },
    assist: { assist: async () => assistOk(yaml) },
    participants: () => [{ id: 'local-agent', capabilities: ['wf.draft'] }],
    ...(peer ? { peerCapabilities: peer } : {}),
  })
  return { svc, saved, grants }
}

// --- deterministic provider: emits create_workflow --------------------------

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerCreateProvider implements LlmProvider {
  readonly name = 'butler-wf-create-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const content = lastUserMessage(req)?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      yield { type: 'text', text: blob.includes('"isError":true') ? '好的,那就先不建了。' : '已经帮你把工作流建成草稿了。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    const text = typeof content === 'string' ? content : ''
    if (/建|新建|工作流/.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'wf-1', name: 'create_workflow', input: { instruction: text } },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  async start(record: AgentRecord): Promise<void> { this.started.push(record) }
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> { return ['mock'] }
  async onAgentRemoved(): Promise<void> {}
}

interface Rig {
  tmp: string
  memRoot: string
  hub: Hub
  identity: IdentityStore
  space: Space
  meAgents: HostMeAgentService
  inboxStore: FileInboxStore
  inboxService: HostInboxService
  provider: ButlerCreateProvider
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-butler-wfc-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-wfc-e2e' })
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite'), masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()
  const hub = new Hub({
    space,
    suspendNotifier: async (task, by, s) => {
      identity.persistSuspendedTask({
        taskId: task.id, agentId: by, hubId: 'local',
        originUserId: task.origin?.userId ?? null, resumeAt: s.resumeAt, state: s.state,
        taskJson: JSON.stringify(task),
      })
      const approver = task.origin?.userId
      if (approver) {
        const item = butlerApprovalItemFor(task, by, s.state, { approver })
        if (item) await inboxStore.write(item)
      }
    },
  })
  await hub.start()
  const lifecycle = new FakeLifecycle()
  const meAgents = new HostMeAgentService({ space, hub, identity, lifecycle })
  const inboxService = new HostInboxService({ hub, store: inboxStore, identity })
  return { tmp, memRoot: join(tmp, 'mem'), hub, identity, space, meAgents, inboxStore, inboxService, provider: new ButlerCreateProvider() }
}

describe('butler-workflow-create-e2e — BE-M3 (real create service + real butler loop)', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  // A butler wired EXACTLY like main.ts: steward gate + create_workflow gate composed.
  function butlerWith(createSvc: MeWorkflowCreateService): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id: 'butler:u1',
      provider: r.provider,
      memory: openButlerMemory({ rootDir: r.memRoot, userId: USER, logger: silentLogger }) as MemoryHandle,
      system: '你是用户的私人管家。改动系统前先请示。',
      governed: [
        buildButlerGovernedToolset({ userId: USER, agents: r.meAgents }),
        buildButlerWorkflowCreateToolset({ userId: USER, create: createSvc }),
      ],
      maxToolRounds: 6,
    })
  }

  async function dispatch(prompt: string) {
    return r.hub.dispatch({ from: `user:${USER}`, strategy: { kind: 'explicit', to: 'butler:u1' }, payload: prompt, origin: { orgId: 'local', userId: USER } })
  }

  // ① + ② — parks, then approval runs the REAL create service (routed to the create
  //          gate, NOT the steward), landing a member-owned draft.
  it('① create_workflow parks and ② approval authors a member-owned draft', async () => {
    const { svc, saved, grants } = makeCreateService(LOCAL_WF)
    r.hub.register(butlerWith(svc))

    const parked = await dispatch('帮我建一个每天早上整理待办的工作流。')
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    // Nothing authored yet — the gate held before any side effect.
    expect(saved).toHaveLength(0)
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.prompt).toContain('新建工作流') // describe → the inbox title

    // Approve → resumes into the CREATE gate's executor (the real service runs).
    await r.inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: true } })
    expect(saved).toEqual([{ id: 'daily-todo', by: USER }]) // real NL→YAML→persist ran
    expect(grants).toEqual([{ workflowId: 'daily-todo', userId: USER, perm: 'owner' }]) // owned by member
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    // Routing proof: the steward side was untouched — no agent was created.
    expect((await r.space.agents()).some((a) => a.id.startsWith('me.u1.'))).toBe(false)
  })

  // ③ — the local-only gate is inherited: a cross-hub workflow is denied, no draft.
  it('③ a cross-hub workflow is refused by the service boundary — no draft persisted', async () => {
    const { svc, saved } = makeCreateService(CROSS_HUB_WF, PEER_VIEW)
    r.hub.register(butlerWith(svc))

    const parked = await dispatch('建个工作流,让供货商 hub 帮我确认订单。')
    if (parked.kind !== 'suspended') throw new Error('expected a park')
    await r.inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: true } })

    // The real boundary primitive rejected the egress hop → nothing saved.
    expect(saved).toHaveLength(0)
    // The task still completes ok (the butler relayed the denial as a tool result).
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
  })

  // ④ — reject → fail-closed: the create service is never called.
  it('④ rejecting the park never calls the create service', async () => {
    const { svc, saved } = makeCreateService(LOCAL_WF)
    r.hub.register(butlerWith(svc))

    const parked = await dispatch('帮我建一个整理待办的工作流。')
    if (parked.kind !== 'suspended') throw new Error('expected a park')
    await r.inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: false } })

    expect(saved).toHaveLength(0)
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })
})
