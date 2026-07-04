/**
 * v5 Item 2 Y-M2 — the A2A outbound APPROVAL closed loop, through the production
 * workflow path (the Phase Y acceptance gate).
 *
 * Y-M1 proved the manager WRAPS an approval-required A2A row in the gate (host
 * unit tests, offline) and unit-pinned the D4 lifecycle-resume delegation in
 * isolation. Y-M2 proves the whole loop against the LIVE stack: a workflow step
 * routed to a stored outbound A2A agent flagged `requireApprovalOutbound` does
 * NOT leave the hub until a person resolves it from their `/me` inbox.
 *
 * Four scenarios, all driven by the STORED config (the manager materialises the
 * gate from `identity.addA2aAgent({... requireApprovalOutbound ...})`):
 *   1. park    — the step parks the run + writes an approval item; the remote A2A
 *                endpoint is NEVER hit; parked at NEVER_RESUME_AT (sweep-blind).
 *   2. approve — the gated send finally reaches the remote exactly once and its
 *                reply round-trips into the downstream local step.
 *   3. reject  — fail-closed `outbound_approval_denied`; the remote is NEVER hit.
 *   4. lifecycle + approval [D4] — an approval-required row that ALSO opts into
 *                the long-running lifecycle: approve → the remote returns a
 *                `working` Task → the inner re-parks with a FINITE resumeAt; the
 *                two-step recovery must KEEP that re-park (not delete it), and the
 *                later sweep wake must be DELEGATED to the lifecycle inner's poll
 *                (the gate must not swallow a non-approval resume). Without the
 *                D4 gate delegation + the resumeChild keep-on-resuspend, the poll
 *                is lost forever and the run never converges.
 *
 * Everything is real: a real WorkflowController on hub A, a real A2aServer
 * fronting hub B over loopback http (the "external" agent), a real IdentityStore
 * (tmp sqlite) holding the outbound config + the v34 approval column, a real
 * A2aOutboundManager doing the registration WITH the approval inbox + approver
 * injected, a real FileInboxStore, a production-shaped suspendNotifier persisting
 * parks to identity, and the real HostInboxService doing the two-step resume. The
 * sweep is driven manually (no 30s timer) so it's deterministic. We count inbound
 * HTTP requests so "endpoint never hit" is airtight. No LLM, no real network.
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  InMemoryStorage,
  SuspendTaskError,
  type Logger,
  type Task,
} from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@gotong/inbox'

import { A2aServer } from '../src/a2a-server.js'
import { A2aOutboundManager } from '../src/a2a-outbound.js'
import { HostInboxService } from '../src/inbox-service.js'
import { WorkflowController } from '../src/workflow-controller.js'

const PEER_A = 'hubA'
const TOKEN = 'shared-token-ym2'
const TOKEN_ENV = 'YM2_A2A_TOK' // the env var NAME the stored row references
const EXT_CAP = 'external-review' // advertised by the outbound A2A participant on hub A
const ARCHIVE_CAP = 'local-archive' // a plain local agent on hub A
const REMOTE_SKILL = 'review' // the blocking external agent on hub B serves this
const REMOTE_SKILL_LONG = 'review-long' // the suspending external agent on hub B
const WORKFLOW_ID = 'a2a-outbound-approval-flow'
const AGENT_ID = 'ext-a2a' // the dispatch target id (the stored outbound agent)
const APPROVER = 'owner-user'

/** A `resumeAt` so far out the sweep never fires (the remote's own park). */
const NEVER = 9_999_999_999_000

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

function textOf(payload: unknown): string {
  if (payload && typeof payload === 'object') return String((payload as { text?: unknown }).text ?? '')
  return String(payload ?? '')
}

// The runner emits an ordinary `{kind:capability}` dispatch; it has no idea the
// `external-review` capability is served by a remote A2A agent OR that the agent
// is gated behind an outbound approval.
const WORKFLOW_YAML = `
schema: gotong.workflow/v1
workflow:
  id: ${WORKFLOW_ID}
  name: a2a outbound approval flow
  trigger: { capability: ax:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [${EXT_CAP}] }
        payload: { text: $trigger.payload.text }
    - id: archive
      dispatch:
        strategy: { kind: capability, capabilities: [${ARCHIVE_CAP}] }
        payload: { note: $review.output.text }
`

/**
 * The BLOCKING "external" A2A agent on hub B — replies at once. Counts its own
 * invocations so a denied / parked outbound task is provably never delivered.
 */
class ExternalReviewAgent extends AgentParticipant {
  calls = 0
  constructor() {
    super({ id: 'b-reviewer', capabilities: [REMOTE_SKILL] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.calls++
    return { text: `reviewed: ${textOf(task.payload)}` }
  }
}

/**
 * The LONG-RUNNING "external" A2A agent on hub B — SUSPENDS on first dispatch
 * (returns a `working` Task to the caller), then on resume emits the reply. The
 * stand-in for a long compute / its own HITL step.
 */
class ExternalLongReviewAgent extends AgentParticipant {
  constructor() {
    super({ id: 'b-long-reviewer', capabilities: [REMOTE_SKILL_LONG] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    throw new SuspendTaskError({ resumeAt: NEVER, state: { text: textOf(task.payload) } })
  }
  protected async handleResume(_task: Task, state: unknown): Promise<unknown> {
    return { text: `reviewed: ${(state as { text?: string }).text ?? ''}` }
  }
}

/** A downstream LOCAL agent on hub A — records what the run fed it. */
class ArchiveAgent extends AgentParticipant {
  readonly filed: Task[] = []
  constructor() {
    super({ id: 'a-archive', capabilities: [ARCHIVE_CAP] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.filed.push(task)
    return { filed: true }
  }
}

/** A parked row on hub B, captured exactly as a SQLite suspendNotifier would. */
interface ParkedB {
  task: Task
  by: string
  state: unknown
}

describe('v5 Item 2 Y-M2 — A2A outbound approval closed loop (workflow path)', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow, holds the gated outbound edge)
  let hubB: Hub // the "external" A2A agent's hub
  let server: Server
  let url: string
  let blocking: ExternalReviewAgent
  let archive: ArchiveAgent
  let identity: IdentityStore
  let inboxStore: FileInboxStore
  let service: HostInboxService
  let manager: A2aOutboundManager
  let controller: WorkflowController
  /** Inbound HTTP requests that reached hub B's /a2a endpoint. */
  let httpHits: number
  /** The long external agent's single park on hub B (resumed to make it complete). */
  let parkedB: ParkedB | null

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-a2a-outbound-approval-e2e-'))
    httpHits = 0
    parkedB = null
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })

    // Hub A persists parks the production way (→ suspended_tasks) so the real
    // HostInboxService two-step recovery + the manual sweep both work.
    hubA = new Hub({
      storage: new InMemoryStorage(),
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
    // Hub B keys its single park so the long external agent can be settled.
    hubB = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        parkedB = { task, by, state: s.state }
      },
    })
    await Promise.all([hubA.start(), hubB.start()])

    blocking = new ExternalReviewAgent()
    hubB.register(blocking)
    hubB.register(new ExternalLongReviewAgent())

    // Hub B's inbound A2A surface: only peer `hubA` presenting TOKEN passes.
    const a2aServer = new A2aServer({
      hub: hubB,
      resolvePeerToken: (peerId) => (peerId === PEER_A ? TOKEN : null),
      newMessageId: () => 'm-reply',
    })
    server = createServer((req, res) => {
      if (req.url === '/a2a') {
        httpHits++ // every genuine inbound A2A request is counted here
        void a2aServer.handle(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`

    archive = new ArchiveAgent()
    hubA.register(archive)

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    service = new HostInboxService({ hub: hubA, store: inboxStore, identity })

    // The PRODUCTION config path WITH the approval machinery injected: the
    // outbound agent + its v34 approval column live in identity, and the manager
    // materialises a gate-wrapped edge onto hub A (reading the bearer from the
    // injected env reader — the row stores the env var NAME, never the secret).
    manager = new A2aOutboundManager({
      hub: hubA,
      source: identity,
      logger: silentLogger,
      readEnv: (name) => (name === TOKEN_ENV ? TOKEN : undefined),
      approvalInbox: inboxStore,
      approver: APPROVER,
    })

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
    })
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all([hubA.stop(), hubB.stop()])
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Fire the workflow trigger on hub A. */
  async function fireTrigger(text = 'hello'): Promise<import('@gotong/core').TaskResult> {
    return hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text },
    })
  }

  /** The single pending approval item in the owner's inbox. */
  async function pendingApprovalItem() {
    const pending = await inboxStore.listPending(APPROVER)
    expect(pending).toHaveLength(1)
    return pending[0]!
  }

  async function latestRunId(): Promise<string> {
    return (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId
  }

  /** One sweep tick over hub A: resume every due row; drop those that settle. */
  async function sweepA(now: number): Promise<void> {
    for (const row of identity.listDueSuspendedTasks({ now })) {
      if (row.corrupt) {
        identity.removeSuspendedTask(row.taskId)
        continue
      }
      const task = JSON.parse(row.taskJson) as Task
      const result = await hubA.resumeTask(row.agentId, task, row.state)
      if (result.kind !== 'suspended') identity.removeSuspendedTask(row.taskId)
    }
  }

  /** Register the gated BLOCKING outbound agent (approval required). */
  function addBlockingGatedAgent(): void {
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      requireApprovalOutbound: true,
    })
    expect(manager.registerAllFromStore()).toBe(1)
    expect(manager.isLive(AGENT_ID)).toBe(true)
  }

  it('an approval-required outbound step PARKS the run; the remote is never contacted', async () => {
    addBlockingGatedAgent()
    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    const fired = await fireTrigger()
    expect(fired.kind).toBe('suspended')

    // Nothing crossed the org boundary yet.
    expect(httpHits).toBe(0)
    expect(blocking.calls).toBe(0)
    expect(archive.filed).toHaveLength(0)

    // An approval item is waiting in the owner's inbox, keyed to the parked child.
    const item = await pendingApprovalItem()
    expect(item.kind).toBe('approval')
    expect(item.parentKind).toBe('workflow') // dispatched by a workflow step
    expect(item.prompt).toContain(EXT_CAP)

    // Parked at NEVER_RESUME_AT — the sweep can't wake it; only a resolve can.
    const row = identity.getSuspendedTask(item.itemId)
    expect(row?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(row?.agentId).toBe(AGENT_ID) // the gated wrapper id (delegates to inner)
    expect(identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === item.itemId)).toBe(
      false,
    )
  })

  it('approve → the gated send reaches the remote exactly once and the reply flows downstream', async () => {
    addBlockingGatedAgent()
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger()
    const item = await pendingApprovalItem()

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    // The real cross-boundary send happened exactly once, and the reply
    // round-tripped into the downstream LOCAL step.
    expect(httpHits).toBe(1)
    expect(blocking.calls).toBe(1)
    const run = await controller.readRun(await latestRunId())
    expect(run?.status).toBe('done')
    expect(archive.filed).toHaveLength(1)
    expect(archive.filed[0]!.payload).toEqual({ note: 'reviewed: hello' })
    // Park cleaned up after the two-step recovery completed.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
  })

  it('reject → fail-closed (outbound_approval_denied); the remote is NEVER contacted', async () => {
    addBlockingGatedAgent()
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger()
    const item = await pendingApprovalItem()

    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })

    // Nothing left the hub — the rejection is enforced before any send.
    expect(httpHits).toBe(0)
    expect(blocking.calls).toBe(0)
    const run = await controller.readRun(await latestRunId())
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.error ?? '').toContain('outbound_approval_denied')
    expect(archive.filed).toHaveLength(0)
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
  })

  it('owner-scoped: another user cannot approve the outbound send', async () => {
    addBlockingGatedAgent()
    await controller.importFromText(WORKFLOW_YAML)
    await fireTrigger()
    const item = await pendingApprovalItem()

    await expect(
      service.resolve({
        itemId: item.itemId,
        userId: 'someone-else',
        decision: { kind: 'approval', approved: true },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(httpHits).toBe(0)
    expect(blocking.calls).toBe(0)
  })

  it('[D4] approve a lifecycle A2A step → the poll is DELEGATED (not swallowed) and the run converges', async () => {
    // A row that requires approval AND opts into the long-running lifecycle.
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL_LONG, // the SUSPENDING external agent
      requireApprovalOutbound: true,
      lifecycle: { pollIntervalMs: 500, maxAttempts: 20 },
    })
    expect(manager.registerAllFromStore()).toBe(1)
    await controller.importFromText(WORKFLOW_YAML)

    // --- fire → the review step routes to the gated edge → it PARKS for approval
    //     BEFORE any send (the remote is untouched).
    const fired = await fireTrigger()
    expect(fired.kind).toBe('suspended')
    const item = await pendingApprovalItem()
    expect(parkedB).toBeNull()
    expect(httpHits).toBe(0)

    // --- approve → the gated send fires → the remote returns a `working` Task →
    //     the lifecycle inner re-parks with a FINITE resumeAt. The crux: the
    //     two-step recovery must KEEP that re-park (not delete it on resume).
    await service.resolve({
      itemId: item.itemId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    expect(httpHits).toBe(1) // the send reached the remote once
    expect(parkedB).not.toBeNull() // the external long agent parked on hub B
    const childRow = identity.getSuspendedTask(item.itemId)
    expect(childRow, 'the lifecycle re-park must survive the approval resume').not.toBeNull()
    // FINITE resumeAt → sweep-eligible (NOT swallowed into a NEVER re-park).
    expect(childRow!.resumeAt).toBeLessThan(NEVER_RESUME_AT)
    const runId = await latestRunId()
    expect((await controller.readRun(runId))?.status).toBe('running')
    expect(archive.filed).toHaveLength(0) // not yet — the remote is still working

    // --- the remote settles (deterministic external resume, not its own sweep).
    const resumedB = await hubB.resumeTask(parkedB!.by, parkedB!.task, parkedB!.state)
    expect(resumedB.kind).toBe('ok')

    // --- drive hub A sweeps to convergence. Each child wake is a non-approval
    //     resume that the gate must DELEGATE to the lifecycle inner's poll.
    for (let i = 0; i < 12; i++) {
      const run = await controller.readRun(runId)
      if (run?.status === 'done' || run?.status === 'failed') break
      await sweepA(Date.now() + 60_000)
    }

    const run = await controller.readRun(runId)
    expect(run?.status).toBe('done')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ text: 'reviewed: hello' })
    expect(archive.filed).toHaveLength(1)
    expect(archive.filed[0]!.payload).toEqual({ note: 'reviewed: hello' })
    // send (1) + at least one `tasks/get` poll → proof the gate delegated the
    // lifecycle resume rather than swallowing it into a dead NEVER re-park.
    expect(httpHits).toBeGreaterThanOrEqual(2)
    // Everything drained — no stranded parks.
    expect(identity.listDueSuspendedTasks({ now: Date.now() + 60_000 })).toHaveLength(0)
  })
})
