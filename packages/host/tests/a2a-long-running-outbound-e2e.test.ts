/**
 * v5 Stream H2-OUT-M4 — the long-running A2A lifecycle through the PRODUCTION
 * CONFIG PATH (the production-fold acceptance gate).
 *
 * H2-M2 (a2a-long-running-step-e2e) proved the MECHANISM: a hand-constructed
 * lifecycle `A2aRemoteParticipant` parks a workflow step, polls `tasks/get`, and
 * settles. But in production an operator never hand-constructs that participant —
 * they add a row to `a2a_outbound_agents` (identity, M1's v32 `lifecycle` column)
 * and the `A2aOutboundManager` materialises it onto the hub (M2). This gate
 * closes that loop: the lifecycle is driven entirely by the STORED config, never
 * a literal in the test, and the column is shown to be the decisive switch.
 *
 * Two claims, both at the store boundary:
 *   1. A row WITH `lifecycle` → the manager registers a participant that parks
 *      the run on the remote suspend, the sweep polls to convergence, and the
 *      reply flows downstream. Same end-to-end behavior as M2, but every knob
 *      came from `identity.addA2aAgent({... lifecycle ...})`.
 *   2. The SAME suspending remote, reached via a row WITHOUT `lifecycle` (the
 *      NULL-column legacy default), HARD-FAILS the step — proving the column,
 *      not the code path, is what opts an outbound agent into long-running mode.
 *      A blocking agent fails closed on a returned `working` Task.
 *
 * Everything is real: a real WorkflowController on hub A, a real A2aServer
 * fronting hub B over loopback http (the "external" agent), a real IdentityStore
 * (tmp sqlite) holding the outbound config, a real A2aOutboundManager doing the
 * registration, and a production-shaped suspendNotifier on each hub. The sweep
 * is driven manually (no 30s timer) so it's fully deterministic. No LLM, no
 * external network.
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
  type TaskResult,
} from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { workflowParticipantId } from '@gotong/workflow'

import { A2aServer } from '../src/a2a-server.js'
import { A2aOutboundManager } from '../src/a2a-outbound.js'
import { WorkflowController } from '../src/workflow-controller.js'

const PEER_A = 'hubA'
const TOKEN = 'shared-token-h2-out'
const TOKEN_ENV = 'EXT_A2A_TOK' // the env var name the stored row references
const EXT_CAP = 'external-review' // advertised by the outbound A2A participant on hub A
const ARCHIVE_CAP = 'local-archive' // a plain local agent on hub A
const REMOTE_SKILL = 'review' // the capability hub B (the "external" agent) serves
const WORKFLOW_ID = 'a2a-long-outbound-flow'
const AGENT_ID = 'ext-a2a' // the dispatch target id (the stored outbound agent)

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

// The runner emits an ordinary `{kind:capability}` dispatch; it has no idea the
// first capability is served by a remote A2A agent OR that it will park.
const WORKFLOW_YAML = `
schema: gotong.workflow/v1
workflow:
  id: ${WORKFLOW_ID}
  name: a2a long-running outbound step
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

function textOf(payload: unknown): string {
  if (payload && typeof payload === 'object') return String((payload as { text?: unknown }).text ?? '')
  return String(payload ?? '')
}

/**
 * The "external" long-running A2A agent on hub B. SUSPENDS on first dispatch
 * (returns a `working` Task to the caller), then on resume emits the reply — a
 * deterministic stand-in for a long compute / its own HITL step. Only this agent
 * emits `reviewed:`, so seeing it back proves the async cross-boundary trip.
 */
class ExternalLongReviewAgent extends AgentParticipant {
  constructor() {
    super({ id: 'b-long-reviewer', capabilities: [REMOTE_SKILL] })
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

/** A parked row, captured exactly as the host's SQLite suspendNotifier captures it. */
interface Parked {
  task: Task
  by: string
  state: unknown
  resumeAt: number
}

describe('v5 Stream H2-OUT-M4 — long-running A2A lifecycle through the production config path', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow)
  let hubB: Hub // the "external" A2A agent's hub
  let server: Server
  let url: string
  let archive: ArchiveAgent
  let identity: IdentityStore
  let manager: A2aOutboundManager
  let controller: WorkflowController
  /** Latest park per task id on hub A (run + lifecycle child), survives re-parks. */
  let parkedA: Map<string, Parked>
  /** The external agent's single park on hub B (resumed to make it complete). */
  let parkedB: Parked | null

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-a2a-long-outbound-e2e-'))
    parkedA = new Map()
    parkedB = null

    // Both hubs carry a production-shaped suspendNotifier. Hub A keys by task id
    // so a re-park (the poll loop) overwrites with the freshest state.
    hubA = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        parkedA.set(task.id, { task, by, state: s.state, resumeAt: s.resumeAt })
      },
    })
    hubB = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        parkedB = { task, by, state: s.state, resumeAt: s.resumeAt }
      },
    })
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new ExternalLongReviewAgent())

    // Hub B's inbound A2A surface: only peer `hubA` presenting TOKEN passes.
    const a2aServer = new A2aServer({
      hub: hubB,
      resolvePeerToken: (peerId) => (peerId === PEER_A ? TOKEN : null),
      newMessageId: () => 'm-reply',
    })
    server = createServer((req, res) => {
      if (req.url === '/a2a') {
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

    // The PRODUCTION config path: the outbound agent lives in identity, and the
    // manager materialises it onto hub A — reading the bearer from the injected
    // env reader (the row stores the env var NAME, never the secret).
    identity = openIdentityStore({ dbPath: ':memory:' })
    manager = new A2aOutboundManager({
      hub: hubA,
      source: identity,
      logger: silentLogger,
      readEnv: (name) => (name === TOKEN_ENV ? TOKEN : undefined),
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

  /** One sweep tick over hub A: resume every parked row; drop those that settle. */
  async function sweepA(): Promise<void> {
    for (const row of [...parkedA.values()]) {
      const result: TaskResult = await hubA.resumeTask(row.by, row.task, row.state)
      // A re-park already overwrote this id via the notifier (INSERT-OR-REPLACE
      // semantics); only terminal outcomes are removed. Mirrors the host sweep.
      if (result.kind !== 'suspended') parkedA.delete(row.task.id)
    }
  }

  it('a stored lifecycle row drives the full park→poll→settle chain (every knob from the store)', async () => {
    // Configure the outbound agent as an admin would: a row WITH `lifecycle`.
    // The manager registers it — nothing in this test constructs the participant.
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      lifecycle: { pollIntervalMs: 500, maxAttempts: 20 },
    })
    expect(manager.registerAllFromStore()).toBe(1)
    expect(manager.isLive(AGENT_ID)).toBe(true)

    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // --- fire the trigger. The review step routes to the store-registered A2A
    //     participant → message/send → the remote SUSPENDS → a working Task →
    //     the participant parks → the runner inherits and parks the whole run.
    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    expect(fired.kind).toBe('suspended')

    const runId = (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId

    // Two parked rows on hub A: the lifecycle child sub-task AND the run.
    expect(parkedA.size).toBe(2)
    const runPid = workflowParticipantId(WORKFLOW_ID)
    const runPark = [...parkedA.values()].find((p) => p.by === runPid)
    const childPark = [...parkedA.values()].find((p) => p.by === AGENT_ID)
    expect(runPark, 'the run parked').toBeDefined()
    expect(childPark, 'the lifecycle child parked').toBeDefined()
    // The store-driven lifecycle parks with a FINITE resumeAt (sweep-eligible),
    // NOT NEVER_RESUME_AT — so the host sweep drives convergence with no change.
    expect(childPark!.resumeAt).toBeLessThan(NEVER)
    expect(runPark!.resumeAt).toBeLessThan(NEVER)

    // The external agent parked on hub B (its long compute / HITL).
    expect(parkedB).not.toBeNull()

    // --- sweep hub A while the remote is STILL working: no progress, no
    //     premature downstream run.
    await sweepA()
    expect(parkedA.size).toBe(2)
    expect(archive.filed).toHaveLength(0)
    expect((await controller.readRun(runId))?.status).toBe('running')

    // --- the remote settles (external resume — deterministic, not its sweep).
    const resumedB = await hubB.resumeTask(parkedB!.by, parkedB!.task, parkedB!.state)
    expect(resumedB.kind).toBe('ok')

    // --- drive hub A sweeps to convergence.
    for (let i = 0; i < 12 && parkedA.size > 0; i++) {
      const run = await controller.readRun(runId)
      if (run?.status === 'done' || run?.status === 'failed') break
      await sweepA()
    }

    const run = await controller.readRun(runId)
    expect(run?.status).toBe('done')

    // The review step round-tripped the async remote reply (only hub B's agent
    // emits `reviewed:`), and it flowed into the downstream LOCAL step.
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ text: 'reviewed: hello' })
    expect(archive.filed).toHaveLength(1)
    expect(archive.filed[0]!.payload).toEqual({ note: 'reviewed: hello' })

    // Both rows drained — the run and its child reached terminal outcomes.
    expect(parkedA.size).toBe(0)
  })

  it('the SAME suspending remote, via a row WITHOUT lifecycle, hard-fails the step (the column is the switch)', async () => {
    // Identical row EXCEPT no `lifecycle` → NULL column → legacy blocking. The
    // manager registers a blocking participant; against a remote that returns a
    // `working` Task, a2aSend throws and the step fails closed.
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      // no lifecycle — blocking
    })
    expect(manager.registerAllFromStore()).toBe(1)

    await controller.importFromText(WORKFLOW_YAML)
    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    // Blocking: no park, the step's dispatch fails outright (default onFailure=halt).
    expect(fired.kind).toBe('failed')

    const runId = (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId
    const run = await controller.readRun(runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')

    // The remote DID park on hub B (it always suspends), but the blocking caller
    // gave up — nothing on hub A parked, and the downstream step never ran.
    expect(parkedB).not.toBeNull()
    expect(parkedA.size).toBe(0)
    expect(archive.filed).toHaveLength(0)
  })
})
