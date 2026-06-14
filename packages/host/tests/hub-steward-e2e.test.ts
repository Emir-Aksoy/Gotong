/**
 * SW-M8 — the hub steward ("管家") end-to-end acceptance gate.
 *
 * The unit tests (steward-plan / steward-apply-safe / steward-apply-gated) drive
 * the service with light fakes and resume via `hub.resumeTask` directly. THIS
 * gate closes the one seam none of them can: the WHOLE production path, end to
 * end —
 *
 *   real Hub (real Space) + a production-shaped `suspendNotifier` persisting
 *   parked tasks to a real IdentityStore (tmp sqlite) + the real FileInboxStore
 *   + the real `HostMeAgentService` (real Space `upsertAgent` + real
 *   `resource_grants` ownership; only the agent SPAWN is faked, exactly as every
 *   host agent test does) + the real `MeWorkflowEditService` (real
 *   WorkflowController + a real WorkflowAssistantAgent dispatched through the hub
 *   with a deterministic mock LLM) + the real `StewardApprovalBroker` + the real
 *   `HostInboxService` two-step resolve.
 *
 * The two hard constraints the steward exists to honour
 * (「跨 hub 间的工作流需要再次确认，危险动作都再次确认」) are the ★ scenarios:
 *
 *   ② a `delete_agent` (DANGEROUS) parks in the member's inbox; nothing is
 *      removed until the member APPROVES from `/me` — and a REJECT leaves the
 *      agent intact (fail-closed);
 *   ③ a cross-hub workflow edit (CROSS_HUB) parks; the OpenClaw editor runs only
 *      after approval, and even then the egress stays byte-invariant.
 *
 * Plus the everyday paths: ① a safe `create_agent` applies inline; ④ a forbidden
 * ask (peer trust policy) is refused, nothing touched.
 *
 * The steward LLM is a deterministic mock whose proposal JSON is keyed off a
 * marker in the member's instruction; the workflow assistant's LLM is a SECOND
 * mock keyed off its own marker — so every scenario is stable without a real key.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  HumanParticipant,
  createLogger,
  type AgentRecord,
  type ManagedAgentLifecycle,
  type ParticipantId,
} from '@aipehub/core'
import { MockLlmProvider, type LlmRequest } from '@aipehub/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  userPrincipal,
  type IdentityStore,
} from '@aipehub/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@aipehub/inbox'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  type WorkflowAssistantOutput,
} from '@aipehub/workflow-assistant'
import type { StewardSnapshotWorkflow } from '@aipehub/hub-steward'

import { WorkflowController, type PeerCapabilityView } from '../src/workflow-controller.js'
import { MeWorkflowEditService, type WorkflowAssistView } from '../src/me-workflow-edit-service.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostMeAgentService } from '../src/me-agent-service.js'
import {
  createHubStewardService,
  type HubStewardSurface,
  type StewardWorkflowDirectory,
} from '../src/hub-steward-service.js'
import { STEWARD_EXEC_PARTICIPANT_ID } from '../src/steward-approval.js'

const USER = 'u1'

// --- steward LLM (mock) -----------------------------------------------------
// Keys its proposal off a marker the test embeds in the member's instruction
// (the host folds the instruction into the agent prompt). One provider, every
// scenario, fully deterministic.

const MK = { create: 'MK_CREATE', del: 'MK_DELETE', edit: 'MK_EDIT', refuse: 'MK_REFUSE' }
// The inner marker the steward's `edit_workflow` instruction carries through to
// the workflow assistant's OWN mock, so the assistant returns the local-edit YAML.
const ASSIST_MARK = 'MARK_CROSSLOCAL'

function fenceJson(obj: unknown): string {
  return ['好的:', '', '```json', JSON.stringify(obj, null, 2), '```'].join('\n')
}

function stewardReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  if (seen.includes(MK.create)) {
    return fenceJson({
      reply: '好的,这就给你建一个邮件总结助手。',
      actions: [
        {
          kind: 'create_agent',
          handle: 'mailer',
          label: '邮件总结助手',
          provider: 'mock',
          system: '你把邮件总结成要点。',
          capabilities: ['summarize-mail'],
        },
      ],
    })
  }
  if (seen.includes(MK.del)) {
    return fenceJson({
      reply: '要删掉这个助手吗?这个动作需要你再确认一次。',
      actions: [{ kind: 'delete_agent', agentId: `me.${USER}.mailer` }],
    })
  }
  if (seen.includes(MK.edit)) {
    return fenceJson({
      reply: '这个工作流会跨出本 hub,我准备好后要你再确认一次。',
      actions: [
        { kind: 'edit_workflow', workflowId: 'cross-flow', instruction: `把起草那步改一下 ${ASSIST_MARK}` },
      ],
    })
  }
  if (seen.includes(MK.refuse)) {
    return fenceJson({
      reply: '修改 peer 信任策略超出我的范围。',
      actions: [
        { kind: 'refuse', reason: '修改 peer 信任策略涉及联邦安全,请到设置 → 联邦面板手动操作。' },
      ],
    })
  }
  return fenceJson({ reply: '我在这儿。', actions: [] })
}

// --- workflow assistant LLM (mock) + the cross-hub workflow ------------------
// Mirrors me-workflow-edit-e2e: a local draft step + a cross-hub egress to a
// peer. The member may reshape the LOCAL step but the egress is byte-locked.

function yamlWf(opts: { id: string; trigger: string; steps: string[] }): string {
  return (
    ['schema: aipehub.workflow/v1', 'workflow:', `  id: ${opts.id}`, '  trigger:', `    capability: ${opts.trigger}`, '  steps:', ...opts.steps].join(
      '\n',
    ) + '\n'
  )
}
const step = (id: string, cap: string, payload: string, dc?: string): string =>
  [
    `    - id: ${id}`,
    `      dispatch:`,
    `        strategy: { kind: capability, capabilities: [${cap}] }`,
    `        payload: ${payload}${dc ? `\n        dataClasses: [${dc}]` : ''}`,
  ].join('\n')

const CROSS_FLOW = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [step('draft', 'wf.draft', '{ note: original }'), step('place', 'supplier.confirm-order', '{}', 'public')],
})
// What the member SHOULD be able to do: reshape the local step, egress untouched.
const CROSS_FLOW_LOCALEDIT = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [step('draft', 'wf.draft', '{ note: MEMBER_EDITED_LOCAL }'), step('place', 'supplier.confirm-order', '{}', 'public')],
})

const PEER_VIEW: PeerCapabilityView = {
  peerCapabilities: () => [
    { peer: 'supplier-hub', label: '供货商 Hub', capabilities: ['supplier.confirm-order'] },
  ],
}

function assistantReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  // The steward forwards `... ASSIST_MARK` as the edit instruction → here.
  if (seen.includes(ASSIST_MARK)) {
    return ['改好了:', '', '```yaml', CROSS_FLOW_LOCALEDIT.trimEnd(), '```'].join('\n')
  }
  return ['改好了:', '', '```yaml', CROSS_FLOW_LOCALEDIT.trimEnd(), '```'].join('\n')
}

// --- faked spawn (every host agent test fakes this) -------------------------

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  removed: ParticipantId[] = []
  async start(record: AgentRecord): Promise<void> {
    this.started.push(record)
  }
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> {
    return ['mock']
  }
  async onAgentRemoved(id: ParticipantId): Promise<void> {
    this.removed.push(id)
  }
}

// --- rig --------------------------------------------------------------------

interface Rig {
  tmp: string
  hub: Hub
  identity: IdentityStore
  space: Space
  controller: WorkflowController
  inboxStore: FileInboxStore
  inboxService: HostInboxService
  meAgents: HostMeAgentService
  lifecycle: FakeLifecycle
  surface: HubStewardSurface
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-steward-e2e-'))
  const { space } = await Space.init(tmp, { name: 'steward-e2e' })

  // Real IdentityStore (vault unlocked, mirroring me-agent-service.test) so the
  // member-agent + resource_grants machinery is fully real.
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })

  // Production-shaped suspend persistence: the scheduler calls this when the
  // broker throws SuspendTaskError. Mirror the host's notifier so HostInboxService
  // can reconstruct + resume exactly as in production.
  const hub = new Hub({
    space,
    suspendNotifier: (task, by, s) => {
      identity.persistSuspendedTask({
        taskId: task.id,
        agentId: by,
        hubId: 'local',
        originUserId: task.origin?.userId ?? null,
        resumeAt: s.resumeAt,
        state: s.state,
        taskJson: JSON.stringify(task),
      })
    },
  })
  await hub.start()

  // A local worker serving the workflow's LOCAL capability — a known cap in the
  // inventory AND part of the boundary's local-cap set.
  hub.register(new HumanParticipant({ id: 'local-worker', capabilities: ['wf.draft'] }))

  // The REAL workflow assistant (deterministic mock LLM) + the host's assist
  // adapter, mirroring WorkflowAssistSurface.assist.
  hub.register(new WorkflowAssistantAgent({ provider: new MockLlmProvider({ reply: assistantReply }), maxTokens: 2048 }))
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

  // The controller has the peer view armed at IMPORT, so cross-flow's `place`
  // step is detected cross-hub and the summary carries crossHubSteps.
  const controller = new WorkflowController({
    hub,
    definitionsDir: join(tmp, 'workflows', 'definitions'),
    spaceRoot: tmp,
    peerCapabilities: PEER_VIEW,
  })

  const meWorkflowEdit = new MeWorkflowEditService({
    grants: identity,
    workflows: controller,
    assist,
    participants: () => hub.participants(),
    peerCapabilities: PEER_VIEW,
  })

  const lifecycle = new FakeLifecycle()
  const meAgents = new HostMeAgentService({ space, hub, identity, lifecycle })

  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()
  const inboxService = new HostInboxService({ hub, store: inboxStore, identity })

  // The StewardWorkflowDirectory adapter — the SAME shape main.ts wires: list the
  // workflows this member may edit (editor+ grant), each flagged cross-hub from
  // the controller's crossHubSteps (the same detector the editor lock uses).
  const stewardWorkflows: StewardWorkflowDirectory = {
    async listForUser(userId) {
      const out: StewardSnapshotWorkflow[] = []
      for (const s of await controller.listAll()) {
        if (!identity.hasResourceGrant('workflow', s.id, userPrincipal(userId), 'editor')) continue
        out.push({ id: s.id, ...(s.name ? { name: s.name } : {}), crossHub: (s.crossHubSteps?.length ?? 0) > 0 })
      }
      return out
    },
  }

  const surface = createHubStewardService({
    hub,
    config: { provider: 'mock' },
    agents: meAgents,
    workflows: stewardWorkflows,
    workflowEditor: meWorkflowEdit,
    inbox: inboxStore,
    logger: createLogger('test-steward-e2e'),
    provider: new MockLlmProvider({ reply: stewardReply }),
  })
  if (!surface) throw new Error('createHubStewardService returned null (expected a surface)')

  return { tmp, hub, identity, space, controller, inboxStore, inboxService, meAgents, lifecycle, surface }
}

/** Resolve a parked steward approval through the REAL HostInboxService two-step. */
async function resolve(r: Rig, itemId: string, approved: boolean): Promise<void> {
  await r.inboxService.resolve({ itemId, userId: USER, decision: { kind: 'approval', approved } })
}

async function hasAgent(r: Rig, id: string): Promise<boolean> {
  return (await r.space.agents()).some((a) => a.id === id)
}

describe('SW-M8 — hub steward end-to-end (the two hard constraints, real stack)', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(async () => {
    await r.hub.stop()
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  // ① the safe everyday path: plan → safe create_agent → apply lands a real
  //    owned agent (real Space upsert + real owner grant + spawn called).
  it('① plan→safe create_agent→apply builds a real owned agent', async () => {
    const proposal = await r.surface.plan({ userId: USER, instruction: `建一个总结邮件的助手 ${MK.create}` })
    expect(proposal.actions).toHaveLength(1)
    const ca = proposal.actions[0]!
    expect(ca.tier).toBe('safe')
    expect(ca.action.kind).toBe('create_agent')

    const res = await r.surface.apply({ userId: USER, action: ca.action })
    expect(res.status).toBe('done')
    if (res.status !== 'done' || res.result.kind !== 'create_agent') throw new Error('expected done/create_agent')
    expect(res.result.agent.id).toBe(`me.${USER}.mailer`)

    // Real effects: persisted in the Space, owner grant recorded, spawn called.
    expect(await hasAgent(r, `me.${USER}.mailer`)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', `me.${USER}.mailer`, userPrincipal(USER), 'owner')).toBe(true)
    expect(r.lifecycle.started.map((a) => a.id)).toContain(`me.${USER}.mailer`)
  })

  // ★② the DANGEROUS hard constraint: a delete parks; the member must approve
  //    from the inbox before anything is removed; a reject leaves it intact.
  it('★② plan→delete_agent parks at NEVER, blind to the sweep, with an inbox item — nothing removed yet', async () => {
    // Seed the agent the member will try to delete.
    await r.meAgents.create(USER, { id: 'mailer', label: '邮件助手', provider: 'mock', system: 's', capabilities: ['x'] })

    const proposal = await r.surface.plan({ userId: USER, instruction: `删掉那个助手 ${MK.del}` })
    const da = proposal.actions[0]!
    expect(da.tier).toBe('dangerous')

    const res = await r.surface.apply({ userId: USER, action: da.action })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('dangerous')

    // Parked under the broker id at the never-resume sentinel; the timer sweep
    // (resume_at <= now) is blind to it — only a resolve can wake it.
    const row = r.identity.getSuspendedTask(res.inboxItemId)
    expect(row?.agentId).toBe(STEWARD_EXEC_PARTICIPANT_ID)
    expect(row?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(r.identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === res.inboxItemId)).toBe(false)

    // An approval item lands in the MEMBER'S own inbox; the agent is STILL there.
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.parentKind).toBe('none')
    expect(await hasAgent(r, `me.${USER}.mailer`)).toBe(true)
  })

  it('★② approving a parked delete from /me actually removes the agent (the second confirmation runs it)', async () => {
    await r.meAgents.create(USER, { id: 'mailer', label: '邮件助手', provider: 'mock', system: 's', capabilities: ['x'] })
    const res = await r.surface.apply({ userId: USER, action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` } })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    await resolve(r, res.inboxItemId, true)

    // NOW the delete happened — agent gone from the Space, owner grant cleared,
    // lifecycle notified. Parked row + inbox item cleaned up.
    expect(await hasAgent(r, `me.${USER}.mailer`)).toBe(false)
    expect(r.identity.hasResourceGrant('agent', `me.${USER}.mailer`, userPrincipal(USER), 'viewer')).toBe(false)
    expect(r.lifecycle.removed).toContain(`me.${USER}.mailer`)
    expect(r.identity.getSuspendedTask(res.inboxItemId)).toBeNull()
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })

  it('★② rejecting a parked delete from /me leaves the agent intact (fail-closed)', async () => {
    await r.meAgents.create(USER, { id: 'mailer', label: '邮件助手', provider: 'mock', system: 's', capabilities: ['x'] })
    const res = await r.surface.apply({ userId: USER, action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` } })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    await resolve(r, res.inboxItemId, false)

    // The agent survived the rejected second confirmation.
    expect(await hasAgent(r, `me.${USER}.mailer`)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', `me.${USER}.mailer`, userPrincipal(USER), 'owner')).toBe(true)
    expect(r.lifecycle.removed).not.toContain(`me.${USER}.mailer`)
  })

  // ★③ the CROSS_HUB hard constraint: an edit to a workflow that leaves this hub
  //    parks; the OpenClaw editor runs only after approval; the egress stays put.
  it('★③ a cross-hub workflow edit parks, then on approval lands a new revision with the egress byte-invariant', async () => {
    await r.controller.importFromText(CROSS_FLOW) // rev1, crossHubSteps captured
    r.identity.setWorkflowGrant({ workflowId: 'cross-flow', userId: USER, perm: 'editor', grantedBy: 'owner' })

    const proposal = await r.surface.plan({ userId: USER, instruction: `把这个工作流改礼貌点 ${MK.edit}` })
    const ea = proposal.actions[0]!
    expect(ea.tier).toBe('cross_hub') // host derived cross-hub from crossHubSteps

    const res = await r.surface.apply({ userId: USER, action: ea.action })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('cross_hub')
    // The edit did NOT run yet — still only rev1.
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(1)

    await resolve(r, res.inboxItemId, true)

    // On approval the OpenClaw editor ran: a NEW revision, the local step changed,
    // the cross-hub egress survived byte-for-byte (the editor's lock holds even
    // after the second confirmation — double protection).
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(2)
    const onDisk = await r.controller.exportDefinitionText('cross-flow')
    expect(onDisk).toContain('MEMBER_EDITED_LOCAL')
    expect(onDisk).toContain('supplier.confirm-order')
  })

  // ④ a forbidden ask (peer trust policy) is refused — nothing parked, nothing run.
  it('④ a forbidden ask (peer trust policy) is refused, nothing touched', async () => {
    const proposal = await r.surface.plan({ userId: USER, instruction: `帮我改 peer 信任策略 ${MK.refuse}` })
    const fa = proposal.actions[0]!
    expect(fa.tier).toBe('forbidden')

    const res = await r.surface.apply({ userId: USER, action: fa.action })
    expect(res.status).toBe('refused')
    if (res.status !== 'refused') throw new Error('unreachable')
    expect(res.reason).toContain('联邦')
    // Nothing parked.
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })
})
