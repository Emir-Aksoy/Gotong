/**
 * SW-M9 A-M7 — the OPERATOR-console hub steward ("管家") end-to-end acceptance
 * gate. The site-wide twin of `hub-steward-e2e.test.ts`.
 *
 * The member gate proves a member can manage their OWN namespaced resources
 * (`me.<userId>.*` agents, editor-granted workflows). THIS gate proves the
 * operator steward — the SAME `createHubStewardService`, parameterized with
 * `OPERATOR_STEWARD_IDS` + the operator system prompt + a SITE-WIDE agent
 * executor (`HostOperatorAgentService`) + a grant-free workflow editor
 * (`OperatorWorkflowEditService`) + an all-workflows directory
 * (`operatorStewardWorkflowDirectory`) — manages the WHOLE hub, while STILL
 * honouring the two hard constraints through a SECOND confirmation:
 *
 *   ★② a `delete_agent` (DANGEROUS) parks in the OPERATOR's inbox under the
 *      OPERATOR broker id (`aipehub:steward-exec:operator`, disjoint from the
 *      member broker) — nothing removed until APPROVE; a REJECT leaves it intact;
 *      and the operator can delete an agent it NEVER created (site-wide reach the
 *      member service structurally cannot do).
 *   ★③ a cross-hub workflow edit (CROSS_HUB) parks — WITHOUT any per-workflow
 *      grant (the operator owns the site) — yet even after approval the egress
 *      stays byte-invariant (the boundary lock binds an operator too).
 *
 * Plus the everyday paths: ① a safe `create_agent` lands a SITE-WIDE agent whose
 * id is the operator's VERBATIM handle (not the member's `me.<userId>.*`
 * composition); ④ a forbidden ask (peer trust policy) is refused, nothing touched.
 *
 * Same deterministic-mock discipline as the member gate: the steward LLM keys its
 * proposal JSON off a marker in the instruction, the workflow assistant's LLM is a
 * SECOND mock keyed off its own marker — every scenario stable without a real key.
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
import { buildOperatorStewardSystemPrompt, type StewardAction } from '@aipehub/hub-steward'

import { WorkflowController, type PeerCapabilityView } from '../src/workflow-controller.js'
import { MeWorkflowEditService, type WorkflowAssistView } from '../src/me-workflow-edit-service.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostOperatorAgentService } from '../src/operator-agent-service.js'
import { HostStewardSensitiveExecutors } from '../src/steward-sensitive.js'
import { OperatorWorkflowEditService } from '../src/operator-workflow-edit-service.js'
import { operatorStewardWorkflowDirectory } from '../src/operator-workflow-directory.js'
import {
  createHubStewardService,
  OPERATOR_STEWARD_IDS,
  type HubStewardSurface,
} from '../src/hub-steward-service.js'

// The operator's user id — in production a real v4 owner/admin with a `/me`
// inbox (A-M6 gates on `resolveActor(req).userId`); here just the id the surface
// forces server-side + the inbox key.
const OP = 'op1'

// --- steward LLM (mock) -----------------------------------------------------
// Keys its proposal off a marker the test embeds in the operator's instruction.
// Unlike the member mock, the create handle is a SITE-WIDE id used VERBATIM and
// the delete targets that verbatim id.

const MK = { create: 'MK_CREATE', del: 'MK_DELETE', edit: 'MK_EDIT', refuse: 'MK_REFUSE', cred: 'MK_CRED' }
// The inner marker the steward's `edit_workflow` instruction carries through to
// the workflow assistant's OWN mock, so the assistant returns the local-edit YAML.
const ASSIST_MARK = 'MARK_CROSSLOCAL'

// B-M4 — a throwaway env var + secret for the sensitive credential scenarios. The
// action only ever NAMES this var; the secret lives in the env channel and must
// never appear in a proposal / inbox item / parked suspended-task row.
const CRED_ENV = 'AIPE_TEST_OPERATOR_STEWARD_CRED'
const CRED_SECRET = 'sk-operator-secret-never-in-any-artifact'

// The verbatim site-wide id the operator names directly (no `me.<userId>.*`).
const SITE_AGENT = 'support-bot'

function fenceJson(obj: unknown): string {
  return ['好的:', '', '```json', JSON.stringify(obj, null, 2), '```'].join('\n')
}

function stewardReply(req: LlmRequest): string {
  const seen = JSON.stringify(req)
  if (seen.includes(MK.create)) {
    return fenceJson({
      reply: '好的,这就给全站建一个客服助手。',
      actions: [
        {
          kind: 'create_agent',
          handle: SITE_AGENT, // operator: the FULL id, used verbatim
          label: '客服助手',
          provider: 'mock',
          system: '你回答客户的常见问题。',
          capabilities: ['support-chat'],
        },
      ],
    })
  }
  if (seen.includes(MK.del)) {
    return fenceJson({
      reply: '要删掉这个全站助手吗?这个动作需要你再确认一次。',
      actions: [{ kind: 'delete_agent', agentId: SITE_AGENT }],
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
  if (seen.includes(MK.cred)) {
    // A sensitive write — the proposal NAMES the host env var, never the secret.
    return fenceJson({
      reply: '好的,我准备注册一个站点级 Anthropic 凭证,密钥从主机环境变量读取,要你再确认一次。',
      actions: [
        {
          kind: 'set_credential_ref',
          provider: 'anthropic',
          envVarName: CRED_ENV,
          label: '站点 Anthropic 密钥',
        },
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
// Mirrors the member gate: a local draft step + a cross-hub egress to a peer.
// The operator may reshape the LOCAL step but the egress is byte-locked.

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
// What the operator SHOULD be able to do: reshape the local step, egress untouched.
const CROSS_FLOW_LOCALEDIT = yamlWf({
  id: 'cross-flow',
  trigger: 'run-cross',
  steps: [step('draft', 'wf.draft', '{ note: OPERATOR_EDITED_LOCAL }'), step('place', 'supplier.confirm-order', '{}', 'public')],
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
  operatorAgents: HostOperatorAgentService
  lifecycle: FakeLifecycle
  surface: HubStewardSurface
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-operator-steward-e2e-'))
  const { space } = await Space.init(tmp, { name: 'operator-steward-e2e' })

  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })

  // Production-shaped suspend persistence (the broker throws SuspendTaskError →
  // the scheduler calls this → HostInboxService reconstructs + resumes).
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

  // A local worker serving the workflow's LOCAL capability.
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

  const lifecycle = new FakeLifecycle()

  // ── the OPERATOR executors (the SW-M9 swaps) ──────────────────────────────
  // Site-wide agent directory (verbatim ids, every managed agent, owner-grant
  // seed via the real IdentityStore). Grant-free workflow editor (drops RBAC,
  // KEEPS the cross-hub boundary lock). All-workflows directory (no per-member
  // grant filter). The member gate uses HostMeAgentService / MeWorkflowEditService
  // / a grant-filtered inline directory in their place.
  const operatorAgents = new HostOperatorAgentService({ space, lifecycle, grants: identity })
  const operatorWorkflowEdit = new OperatorWorkflowEditService({
    workflows: controller,
    assist,
    participants: () => hub.participants(),
    peerCapabilities: PEER_VIEW,
  })
  const operatorWorkflows = operatorStewardWorkflowDirectory(controller)

  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()
  const inboxService = new HostInboxService({ hub, store: inboxStore, identity })

  const surface = createHubStewardService({
    hub,
    config: { provider: 'mock' },
    agents: operatorAgents,
    workflows: operatorWorkflows,
    workflowEditor: operatorWorkflowEdit,
    inbox: inboxStore,
    logger: createLogger('test-operator-steward-e2e'),
    provider: new MockLlmProvider({ reply: stewardReply }),
    ids: OPERATOR_STEWARD_IDS, // disjoint agent / cap / broker ids — coexist with the member steward
    systemOverride: buildOperatorStewardSystemPrompt(),
    // B-M2 — THIS flag is the privilege boundary: with operator:true the classifier
    // graduates the four sensitive writes from `forbidden` (member) to `dangerous`
    // (always-inbox). B-M3 — the operator-only executors that actually run a
    // sensitive write AFTER approval (env→vault / peer / quota). The member steward
    // (hub-steward-e2e) constructs WITHOUT either, so it stays structurally fenced.
    operator: true,
    sensitive: new HostStewardSensitiveExecutors({ identity }),
  })
  if (!surface) throw new Error('createHubStewardService returned null (expected a surface)')

  return { tmp, hub, identity, space, controller, inboxStore, inboxService, operatorAgents, lifecycle, surface }
}

/** Resolve a parked steward approval through the REAL HostInboxService two-step. */
async function resolve(r: Rig, itemId: string, approved: boolean): Promise<void> {
  await r.inboxService.resolve({ itemId, userId: OP, decision: { kind: 'approval', approved } })
}

async function hasAgent(r: Rig, id: string): Promise<boolean> {
  return (await r.space.agents()).some((a) => a.id === id)
}

describe('SW-M9 A-M7 — operator hub steward end-to-end (site-wide, the two hard constraints)', () => {
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
  //    SITE-WIDE agent whose id is the operator's VERBATIM handle (NOT a
  //    `me.<userId>.*` composition) + real owner grant + spawn called.
  it('① plan→safe create_agent→apply builds a real site-wide agent at the verbatim id', async () => {
    const proposal = await r.surface.plan({ userId: OP, instruction: `给全站建一个客服助手 ${MK.create}` })
    expect(proposal.actions).toHaveLength(1)
    const ca = proposal.actions[0]!
    expect(ca.tier).toBe('safe')
    expect(ca.action.kind).toBe('create_agent')

    const res = await r.surface.apply({ userId: OP, action: ca.action })
    expect(res.status).toBe('done')
    if (res.status !== 'done' || res.result.kind !== 'create_agent') throw new Error('expected done/create_agent')
    // VERBATIM site-wide id — the operator distinction vs the member's namespacing.
    expect(res.result.agent.id).toBe(SITE_AGENT)

    expect(await hasAgent(r, SITE_AGENT)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', SITE_AGENT, userPrincipal(OP), 'owner')).toBe(true)
    expect(r.lifecycle.started.map((a) => a.id)).toContain(SITE_AGENT)
  })

  // ★② the DANGEROUS hard constraint: a delete parks under the OPERATOR broker id;
  //    the operator must approve from THEIR inbox before anything is removed.
  it('★② plan→delete_agent parks at NEVER under the OPERATOR broker, blind to the sweep — nothing removed yet', async () => {
    await r.surface.apply({
      userId: OP,
      action: {
        kind: 'create_agent',
        handle: SITE_AGENT,
        label: '客服助手',
        provider: 'mock',
        system: 's',
        capabilities: ['support-chat'],
      },
    })

    const proposal = await r.surface.plan({ userId: OP, instruction: `删掉那个全站助手 ${MK.del}` })
    const da = proposal.actions[0]!
    expect(da.tier).toBe('dangerous')

    const res = await r.surface.apply({ userId: OP, action: da.action })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('dangerous')

    // Parked under the OPERATOR broker id (disjoint from the member broker) at the
    // never-resume sentinel; the timer sweep is blind to it — only a resolve wakes
    // it. THIS is R1: the parked row carries the operator broker so the inbox
    // resolve wakes the operator's broker, never the member's.
    const row = r.identity.getSuspendedTask(res.inboxItemId)
    expect(row?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    expect(OPERATOR_STEWARD_IDS.brokerId).toBe('aipehub:steward-exec:operator')
    expect(row?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(r.identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === res.inboxItemId)).toBe(false)

    const pending = await r.inboxStore.listPending(OP)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.parentKind).toBe('none')
    expect(await hasAgent(r, SITE_AGENT)).toBe(true)
  })

  it('★② approving a parked delete from /me actually removes the site-wide agent', async () => {
    await r.surface.apply({
      userId: OP,
      action: {
        kind: 'create_agent',
        handle: SITE_AGENT,
        label: '客服助手',
        provider: 'mock',
        system: 's',
        capabilities: ['support-chat'],
      },
    })
    const res = await r.surface.apply({ userId: OP, action: { kind: 'delete_agent', agentId: SITE_AGENT } })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    await resolve(r, res.inboxItemId, true)

    expect(await hasAgent(r, SITE_AGENT)).toBe(false)
    expect(r.identity.hasResourceGrant('agent', SITE_AGENT, userPrincipal(OP), 'viewer')).toBe(false)
    expect(r.lifecycle.removed).toContain(SITE_AGENT)
    expect(r.identity.getSuspendedTask(res.inboxItemId)).toBeNull()
    expect(await r.inboxStore.listPending(OP)).toHaveLength(0)
  })

  it('★② rejecting a parked delete from /me leaves the site-wide agent intact (fail-closed)', async () => {
    await r.surface.apply({
      userId: OP,
      action: {
        kind: 'create_agent',
        handle: SITE_AGENT,
        label: '客服助手',
        provider: 'mock',
        system: 's',
        capabilities: ['support-chat'],
      },
    })
    const res = await r.surface.apply({ userId: OP, action: { kind: 'delete_agent', agentId: SITE_AGENT } })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    await resolve(r, res.inboxItemId, false)

    expect(await hasAgent(r, SITE_AGENT)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', SITE_AGENT, userPrincipal(OP), 'owner')).toBe(true)
    expect(r.lifecycle.removed).not.toContain(SITE_AGENT)
  })

  // ★② SITE-WIDE REACH — the operator can delete an agent it NEVER created. A
  //    `legacy-bot` is seeded DIRECTLY into the Space (no operator owner grant);
  //    the member service is structurally fenced to `me.<userId>.*` and could
  //    never touch it. The operator parks → approves → it's gone.
  it('★② the operator can delete a site-wide agent it never created (member service structurally cannot)', async () => {
    await r.space.upsertAgent({
      id: 'legacy-bot',
      allowedCapabilities: ['legacy'],
      managed: { kind: 'llm', provider: 'mock', system: 'an older site agent' },
      displayName: '历史助手',
    })
    expect(await hasAgent(r, 'legacy-bot')).toBe(true)
    // The operator never owns it — no owner grant exists.
    expect(r.identity.hasResourceGrant('agent', 'legacy-bot', userPrincipal(OP), 'owner')).toBe(false)

    const res = await r.surface.apply({ userId: OP, action: { kind: 'delete_agent', agentId: 'legacy-bot' } })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    // Parked under the operator broker — same second-confirmation discipline.
    expect(r.identity.getSuspendedTask(res.inboxItemId)?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    expect(await hasAgent(r, 'legacy-bot')).toBe(true)

    await resolve(r, res.inboxItemId, true)

    expect(await hasAgent(r, 'legacy-bot')).toBe(false)
    expect(r.lifecycle.removed).toContain('legacy-bot')
  })

  // ★③ the CROSS_HUB hard constraint — site-wide: an edit to a workflow that
  //    leaves this hub parks WITHOUT any per-workflow grant (the operator owns
  //    the site); the OpenClaw editor runs only after approval; the egress stays
  //    byte-for-byte. NO `setWorkflowGrant` here — the operator directory surfaces
  //    every workflow, which a member with no grant would never see.
  it('★③ a cross-hub workflow edit parks with NO grant, then on approval lands a new revision with the egress byte-invariant', async () => {
    await r.controller.importFromText(CROSS_FLOW) // rev1, crossHubSteps captured
    // Deliberately NO setWorkflowGrant — the operator needs none.

    const proposal = await r.surface.plan({ userId: OP, instruction: `把这个工作流改礼貌点 ${MK.edit}` })
    const ea = proposal.actions[0]!
    expect(ea.tier).toBe('cross_hub') // host derived cross-hub from crossHubSteps via the operator directory

    const res = await r.surface.apply({ userId: OP, action: ea.action })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('cross_hub')
    expect(r.identity.getSuspendedTask(res.inboxItemId)?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    // The edit did NOT run yet — still only rev1.
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(1)

    await resolve(r, res.inboxItemId, true)

    // On approval the OpenClaw editor ran: a NEW revision, the local step changed,
    // the cross-hub egress survived byte-for-byte (the boundary lock holds for an
    // operator too — double protection).
    expect(await r.controller.listRevisions('cross-flow')).toHaveLength(2)
    const onDisk = await r.controller.exportDefinitionText('cross-flow')
    expect(onDisk).toContain('OPERATOR_EDITED_LOCAL')
    expect(onDisk).toContain('supplier.confirm-order')
  })

  // ④ a forbidden ask (peer trust policy) is refused — nothing parked, nothing run.
  it('④ a forbidden ask (peer trust policy) is refused, nothing touched', async () => {
    const proposal = await r.surface.plan({ userId: OP, instruction: `帮我改 peer 信任策略 ${MK.refuse}` })
    const fa = proposal.actions[0]!
    expect(fa.tier).toBe('forbidden')

    const res = await r.surface.apply({ userId: OP, action: fa.action })
    expect(res.status).toBe('refused')
    if (res.status !== 'refused') throw new Error('unreachable')
    expect(res.reason).toContain('联邦')
    expect(await r.inboxStore.listPending(OP)).toHaveLength(0)
  })

  // ─── ★ B-M4 — the four SENSITIVE writes (credentials / peer / security) ──────
  // Operator-only, and EVERY one is the highest discipline: it ALWAYS parks in the
  // operator's inbox — STRICTER than a delete, NEVER an inline `done`. The four
  // kinds graduated from `forbidden` (a member) to `dangerous` (an operator) in
  // B-M2; here we prove the PRODUCTION-SHAPED surface path end-to-end:
  //   apply → park under the OPERATOR broker (NEVER_RESUME_AT, sweep-blind)
  //        → approve → executes via the REAL IdentityStore
  //        → reject → fail-closed (nothing written).
  // The key-safety invariant rides along on every credential path: the action
  // carries only the env-var NAME — the secret never appears in a proposal, an
  // inbox item, or a parked suspended-task row (the executor resolves
  // `process.env[envVarName]` at apply time, the one plaintext holder).

  it('★ B-M4 plan tiers set_credential_ref as dangerous (graduated from forbidden) and names only the env var', async () => {
    const proposal = await r.surface.plan({ userId: OP, instruction: `注册站点 Anthropic 凭证 ${MK.cred}` })
    expect(proposal.actions).toHaveLength(1)
    const ca = proposal.actions[0]!
    // A member would get `forbidden`; the operator gets the highest second-
    // confirmation tier — NEVER `safe` (which would run inline).
    expect(ca.tier).toBe('dangerous')
    expect(ca.action.kind).toBe('set_credential_ref')
    // The proposal carries the env-var NAME, never a secret.
    expect(JSON.stringify(ca.action)).toContain(CRED_ENV)
    expect(JSON.stringify(proposal)).not.toContain(CRED_SECRET)
  })

  it('★ B-M4 set_credential_ref parks under the OPERATOR broker carrying ONLY the env-var name; approve mints a readable ORG vault row', async () => {
    process.env[CRED_ENV] = CRED_SECRET
    try {
      const res = await r.surface.apply({
        userId: OP,
        action: { kind: 'set_credential_ref', provider: 'anthropic', envVarName: CRED_ENV, label: '站点 Anthropic 密钥' },
      })
      expect(res.status).toBe('pending_approval')
      if (res.status !== 'pending_approval') throw new Error('unreachable')
      expect(res.tier).toBe('dangerous') // the highest tier — never inline

      // Parked under the OPERATOR broker at the never-resume sentinel; the sweep
      // is blind to it, only a resolve can wake it (same R1 discipline as delete).
      const row = r.identity.getSuspendedTask(res.inboxItemId)
      expect(row?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
      expect(row?.resumeAt).toBe(NEVER_RESUME_AT)

      // ★ no-plaintext: neither the parked row NOR the inbox item carries the
      // secret; both carry only the env-var NAME (the executor reads it at apply).
      expect(JSON.stringify(row)).not.toContain(CRED_SECRET)
      expect(JSON.stringify(row)).toContain(CRED_ENV)
      const item = (await r.inboxStore.listPending(OP)).find((i) => i.itemId === res.inboxItemId)
      expect(item).toBeDefined()
      expect(JSON.stringify(item)).not.toContain(CRED_SECRET)
      expect(item?.prompt).toContain(CRED_ENV)

      // Nothing minted yet — the write waits for the second confirmation.
      expect(r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org' })).toHaveLength(0)

      await resolve(r, res.inboxItemId, true)

      // Approved → the executor read process.env[CRED_ENV] and stored the secret.
      const orgKeys = r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
      expect(orgKeys).toHaveLength(1)
      expect(r.identity.readVaultSecret(orgKeys[0]!.id)).toBe(CRED_SECRET)
      // The minted row's stored projection records the env-var NAME, never the secret.
      expect(JSON.stringify(orgKeys[0])).not.toContain(CRED_SECRET)
      expect(r.identity.getSuspendedTask(res.inboxItemId)).toBeNull()
    } finally {
      delete process.env[CRED_ENV]
    }
  })

  it('★ B-M4 rejecting a parked set_credential_ref mints nothing (fail-closed) even with the env var set', async () => {
    process.env[CRED_ENV] = CRED_SECRET
    try {
      const res = await r.surface.apply({
        userId: OP,
        action: { kind: 'set_credential_ref', provider: 'anthropic', envVarName: CRED_ENV },
      })
      if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

      await resolve(r, res.inboxItemId, false)

      // Fail-closed — the executor never ran; no org credential exists.
      expect(r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org' })).toHaveLength(0)
      expect(r.identity.getSuspendedTask(res.inboxItemId)).toBeNull()
      expect(await r.inboxStore.listPending(OP)).toHaveLength(0)
    } finally {
      delete process.env[CRED_ENV]
    }
  })

  it('★ B-M4 revoke_credential parks, then on approval revokes the ORG key', async () => {
    const seeded = r.identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: 'sk-org-seed-to-revoke',
      metadata: { provider: 'anthropic' },
    })
    expect(r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })).toHaveLength(1)

    const res = await r.surface.apply({ userId: OP, action: { kind: 'revoke_credential', credentialId: seeded.id } })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(r.identity.getSuspendedTask(res.inboxItemId)?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    // Still active before approval.
    expect(r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })).toHaveLength(1)

    await resolve(r, res.inboxItemId, true)

    // Revoked — no longer in the active set.
    expect(r.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })).toHaveLength(0)
  })

  it('★ B-M4 set_peer_policy parks, then on approval applies the trust-contract change', async () => {
    const reg = r.identity.addPeer({ peerId: 'orgZ', endpointUrl: 'wss://z.example/hub', peerToken: 'tok-z' })
    expect(r.identity.getPeer(reg.id)?.shareSummary).toBe(false) // baseline

    const res = await r.surface.apply({
      userId: OP,
      action: { kind: 'set_peer_policy', peerId: reg.id, shareSummary: true, allowedDataClasses: ['public'] },
    })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(r.identity.getSuspendedTask(res.inboxItemId)?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    // Unchanged before approval.
    expect(r.identity.getPeer(reg.id)?.shareSummary).toBe(false)

    await resolve(r, res.inboxItemId, true)

    const after = r.identity.getPeer(reg.id)
    expect(after?.shareSummary).toBe(true)
    expect(after?.allowedDataClasses).toEqual(['public'])
  })

  it('★ B-M4 set_security_quota (scope=hub) parks, then on approval writes a hub-wide quota', async () => {
    expect(r.identity.getOrgQuota('llm_tokens', 'daily')).toBeNull() // baseline

    const res = await r.surface.apply({
      userId: OP,
      action: { kind: 'set_security_quota', scope: 'hub', metric: 'llm_tokens', period: 'daily', limit: 2000 },
    })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(r.identity.getSuspendedTask(res.inboxItemId)?.agentId).toBe(OPERATOR_STEWARD_IDS.brokerId)
    expect(r.identity.getOrgQuota('llm_tokens', 'daily')).toBeNull() // not written yet

    await resolve(r, res.inboxItemId, true)

    expect(r.identity.getOrgQuota('llm_tokens', 'daily')?.quota).toBe(2000)
  })

  // ★ B-M4 the MEMBER side: a member steward (operator:false, NO sensitive dep)
  //   REFUSES every sensitive kind — they tier `forbidden`, so `apply` returns
  //   `refused` and nothing is parked. This is the apply-level complement to the
  //   classifier-level proof (classify.test.ts) and the chokepoint-level proof
  //   (steward-sensitive-e2e "double gate"). The member steward is structurally
  //   incapable of a sensitive write: it never receives the operator flag OR the
  //   sensitive executors.
  it('★ B-M4 a member steward refuses every sensitive kind — nothing parked', async () => {
    const memberSurface = createHubStewardService({
      hub: r.hub,
      config: { provider: 'mock' },
      agents: r.operatorAgents, // never reached — a forbidden action returns before any executor
      workflows: { listForUser: async () => [] },
      workflowEditor: {
        edit: async () => {
          throw new Error('member workflow editor reached on a sensitive kind — gate bug')
        },
      },
      inbox: r.inboxStore,
      logger: createLogger('test-member-steward-refuse'),
      provider: new MockLlmProvider({ reply: stewardReply }),
      // NO ids → DEFAULT member ids (disjoint from the operator's, no collision);
      // NO operator (→ false); NO sensitive — fenced by construction.
    })
    if (!memberSurface) throw new Error('member surface was null')

    const sensitive: StewardAction[] = [
      { kind: 'set_credential_ref', provider: 'anthropic', envVarName: CRED_ENV },
      { kind: 'revoke_credential', credentialId: 'cred_x' },
      { kind: 'set_peer_policy', peerId: 'orgX', shareSummary: true },
      { kind: 'set_security_quota', scope: 'hub', metric: 'llm_tokens', period: 'daily', limit: 1 },
    ]
    for (const action of sensitive) {
      const res = await memberSurface.apply({ userId: OP, action })
      expect(res.status).toBe('refused')
      if (res.status !== 'refused') throw new Error('unreachable')
      // The generic forbidden reason names the out-of-scope domains.
      expect(res.reason).toContain('凭证')
    }
    // Not one of the four parked anything in the member's inbox.
    expect(await r.inboxStore.listPending(OP)).toHaveLength(0)
  })
})
