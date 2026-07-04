/**
 * v5 Item 2 X-M5 — the outbound DATA-CLASS + QUOTA gate at the A2A edge, through
 * the production WORKFLOW path (the Phase X acceptance gate).
 *
 * X-M4 proved the manager WIRES the gate (host unit tests, offline). X-M5 proves
 * the gate actually FAILS CLOSED end-to-end:
 *   1. A workflow step declares `dataClasses: [secret]`; the runner stamps it onto
 *      `Task.dataClasses`; the outbound A2A participant refuses the send BEFORE any
 *      network I/O — the remote endpoint is NEVER hit, the downstream step never
 *      runs. (Same `checkOutboundDataClasses` core function the mesh edge uses.)
 *   2. A step declaring an ALLOWED class passes the gate and the round trip
 *      completes — the remote is reached exactly once and its reply flows on.
 *   3. A per-agent quota budget is enforced across SEPARATE runs (the limiter
 *      lives in the manager, not per-dispatch): fail-closed past it, with the
 *      budget genuinely consumed — the remote is reached exactly `budget` times.
 *
 * Everything is real: a real WorkflowController on hub A, a real A2aServer
 * fronting hub B over loopback http (the "external" agent), a real IdentityStore
 * (in-memory sqlite) holding the outbound config WITH the v34 gate columns, and a
 * real A2aOutboundManager doing the registration. The external agent is BLOCKING
 * (it replies at once), so the ONLY thing that can stop the round trip is the
 * gate. We count BOTH inbound HTTP requests and the external agent's invocations,
 * making "endpoint never hit" airtight. No LLM, no real network beyond loopback.
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, InMemoryStorage, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { A2aServer } from '../src/a2a-server.js'
import { A2aOutboundManager } from '../src/a2a-outbound.js'
import { WorkflowController } from '../src/workflow-controller.js'

const PEER_A = 'hubA'
const TOKEN = 'shared-token-xm5'
const TOKEN_ENV = 'XM5_A2A_TOK' // the env var NAME the stored row references
const EXT_CAP = 'external-review' // advertised by the outbound A2A participant on hub A
const ARCHIVE_CAP = 'local-archive' // a plain local agent on hub A
const REMOTE_SKILL = 'review' // the capability hub B (the "external" agent) serves
const WORKFLOW_ID = 'a2a-outbound-gate-flow'
const AGENT_ID = 'ext-a2a' // the dispatch target id (the stored outbound agent)

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

/**
 * The workflow emits an ordinary `{kind:capability}` dispatch; it has no idea the
 * `review` capability is served by a remote A2A agent. The optional `dataClasses`
 * on the review step is the per-step governance tag the runner stamps onto
 * `Task.dataClasses` — the very thing the outbound edge gates on.
 */
function workflowYaml(reviewDataClasses?: readonly string[]): string {
  const dc = reviewDataClasses ? `\n        dataClasses: [${reviewDataClasses.join(', ')}]` : ''
  return `
schema: gotong.workflow/v1
workflow:
  id: ${WORKFLOW_ID}
  name: a2a outbound gate flow
  trigger: { capability: ax:start }
  steps:
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [${EXT_CAP}] }${dc}
        payload: { text: $trigger.payload.text }
    - id: archive
      dispatch:
        strategy: { kind: capability, capabilities: [${ARCHIVE_CAP}] }
        payload: { note: $review.output.text }
`
}

/**
 * The "external" A2A agent on hub B — BLOCKING (replies at once). Counts its own
 * invocations so a denied outbound task is provably never delivered. Only this
 * agent emits `reviewed:`, so seeing it back proves the cross-boundary trip.
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

describe('v5 Item 2 X-M5 — outbound data-class + quota gate at the A2A edge (workflow path)', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow)
  let hubB: Hub // the "external" A2A agent's hub
  let server: Server
  let url: string
  let external: ExternalReviewAgent
  let archive: ArchiveAgent
  let identity: IdentityStore
  let manager: A2aOutboundManager
  let controller: WorkflowController
  /** Inbound HTTP requests that reached hub B's /a2a endpoint. */
  let httpHits: number
  /** Task ids hub A ever parked — must stay empty (a gate denial is a plain throw). */
  let parked: string[]

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-a2a-outbound-gate-e2e-'))
    httpHits = 0
    parked = []

    // Hub A carries a production-shaped suspendNotifier purely to PROVE nothing
    // parks: a fail-closed gate throws a plain Error, it never suspends.
    hubA = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task) => {
        parked.push(task.id)
      },
    })
    hubB = new Hub({ storage: new InMemoryStorage() })
    await Promise.all([hubA.start(), hubB.start()])

    external = new ExternalReviewAgent()
    hubB.register(external)

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

    // The PRODUCTION config path: the outbound agent + its gate columns live in
    // identity, and the manager materialises it onto hub A — reading the bearer
    // from the injected env reader (the row stores the env var NAME, never the
    // secret).
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

  it('a step declaring a disallowed class fails closed — the remote endpoint is NEVER hit', async () => {
    // Allow only 'public' to leave for this agent.
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      allowedDataClasses: ['public'],
    })
    expect(manager.registerAllFromStore()).toBe(1)
    expect(manager.isLive(AGENT_ID)).toBe(true)

    // The review step declares dataClasses: [secret] — NOT in the allowlist.
    const sum = await controller.importFromText(workflowYaml(['secret']))
    expect(sum.state).toBe('published')

    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    expect(fired.kind).toBe('failed') // synchronous denial → the run fails

    const runId = (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId
    const run = await controller.readRun(runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')
    // The failure is the data-class gate specifically (not some other error).
    expect(review?.error ?? '').toContain('outbound_data_class_denied')

    // THE crux: the gate fired before any send. The loopback endpoint saw nothing,
    // the external agent ran zero times, and the downstream step never ran.
    expect(httpHits).toBe(0)
    expect(external.calls).toBe(0)
    expect(archive.filed).toHaveLength(0)
    expect(parked).toHaveLength(0) // a plain throw, never a park
  })

  it('a step declaring an allowed class passes the gate — the round trip completes', async () => {
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      allowedDataClasses: ['public'],
    })
    expect(manager.registerAllFromStore()).toBe(1)

    // The review step declares dataClasses: [public] — IN the allowlist.
    await controller.importFromText(workflowYaml(['public']))
    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    expect(fired.kind).toBe('ok')

    const runId = (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId
    const run = await controller.readRun(runId)
    expect(run?.status).toBe('done')

    // The remote was reached exactly once, and its reply flowed into the local step.
    expect(httpHits).toBe(1)
    expect(external.calls).toBe(1)
    expect(archive.filed).toHaveLength(1)
    expect(archive.filed[0]!.payload).toEqual({ note: 'reviewed: hello' })
  })

  it('a per-agent quota budget is enforced across runs — fail-closed past it, budget genuinely consumed', async () => {
    identity.addA2aAgent({
      id: AGENT_ID,
      capabilities: [EXT_CAP],
      url,
      tokenEnv: TOKEN_ENV,
      peerId: PEER_A,
      targetSkill: REMOTE_SKILL,
      outboundQuotaBudget: 2, // two outbound sends per window
      // no allowedDataClasses → the data-class gate is inert; only the quota gates
    })
    expect(manager.registerAllFromStore()).toBe(1)

    await controller.importFromText(workflowYaml()) // no per-step data class

    async function runOnce(): Promise<string> {
      const fired = await hubA.dispatch({
        from: 'admin',
        strategy: { kind: 'capability', capabilities: ['ax:start'] },
        payload: { text: 'hello' },
      })
      return fired.kind
    }

    expect(await runOnce()).toBe('ok') // 1/2
    expect(await runOnce()).toBe('ok') // 2/2
    expect(await runOnce()).toBe('failed') // 3rd → over budget, fail-closed

    // The budget was genuinely consumed across SEPARATE runs (the limiter lives in
    // the manager, not per-dispatch): the remote was reached exactly twice, and the
    // third run's review failed at the quota gate before any send.
    expect(httpHits).toBe(2)
    expect(external.calls).toBe(2)
    expect(parked).toHaveLength(0)

    const runs = await controller.listRuns({ workflowId: WORKFLOW_ID })
    expect(runs).toHaveLength(3)
    const detailed = await Promise.all(runs.map((r) => controller.readRun(r.runId)))
    expect(detailed.filter((r) => r?.status === 'done')).toHaveLength(2)
    const failedRun = detailed.find((r) => r?.status === 'failed')
    expect(failedRun, 'exactly one run failed at the quota gate').toBeDefined()
    const review = failedRun?.steps.find((s) => s.stepId === 'review')
    expect(review?.error ?? '').toContain('outbound_quota_exceeded')
    // The two that completed each round-tripped the remote reply downstream.
    expect(archive.filed).toHaveLength(2)
  })
})
