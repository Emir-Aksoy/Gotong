/**
 * v5 Stream H2-M2 — an A2A LONG-RUNNING external agent as a workflow step
 * (THE acceptance gate).
 *
 * Stream H proved the BLOCKING case: a workflow step routes to an external A2A
 * agent that answers in one `message/send` round-trip (a2a-workflow-step-e2e).
 * H's deferred list named the gap this gate closes: "远端会挂起返 Task→
 * a2aGetTask 轮询是独立路径, 本 Stream 只 blocking". Here the external agent
 * SUSPENDS (returns a `working` Task — long compute or its own HITL); the
 * orchestrating workflow must park, poll `tasks/get` until the remote settles,
 * and only then feed the reply downstream.
 *
 * The whole point of H2: this is AUTOMATIC, with no host/runner change. The
 * lifecycle `A2aRemoteParticipant` (H2-M1) parks the review sub-task with a
 * FINITE `resumeAt` (vs. Stream G's NEVER_RESUME_AT approval children that need
 * the inbox two-step). The runner inherits that finite resumeAt onto the whole
 * run, so BOTH the run row and the child sub-task row are sweep-resumable, and
 * the sweep drives them to convergence — the run re-polls the child each wake
 * until the remote completes.
 *
 * Everything is real: a real WorkflowController on hub A, a real A2aServer
 * fronting hub B over a loopback http.createServer (the "external" agent), a
 * real lifecycle A2aRemoteParticipant pointed at it, a real local archive agent
 * downstream, and a production-shaped suspendNotifier on each hub. The sweep is
 * driven manually (no 30s timer) so it's fully deterministic. No LLM, no
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
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { A2aRemoteParticipant } from '@aipehub/a2a'
import { workflowParticipantId } from '@aipehub/workflow'

import { A2aServer } from '../src/a2a-server.js'
import { WorkflowController } from '../src/workflow-controller.js'

const PEER_A = 'hubA'
const TOKEN = 'shared-token-h2'
const EXT_CAP = 'external-review' // advertised by the lifecycle A2aRemoteParticipant on hub A
const ARCHIVE_CAP = 'local-archive' // a plain local agent on hub A
const REMOTE_SKILL = 'review' // the capability hub B (the "external" agent) serves
const WORKFLOW_ID = 'a2a-long-step-flow'

/** A `resumeAt` so far out the sweep never fires (the remote's own park). */
const NEVER = 9_999_999_999_000

// Same two-step shape as the BLOCKING H gate — only the remote's behavior
// changes (it suspends instead of answering inline). The runner emits an
// ordinary `{kind:capability}` dispatch; it has no idea the first capability is
// remote OR that it will park.
const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: ${WORKFLOW_ID}
  name: a2a long-running external step
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
 * (returns a `working` Task to the caller), then on resume emits the reply —
 * a deterministic stand-in for a long compute / its own HITL step. Only this
 * agent (reachable solely via the A2A HTTP endpoint) emits `reviewed:`, so
 * seeing it back proves the async cross-boundary round-trip.
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

describe('v5 Stream H2-M2 — A2A long-running external agent as a workflow step (acceptance gate)', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow)
  let hubB: Hub // the "external" A2A agent's hub
  let server: Server
  let url: string
  let archive: ArchiveAgent
  let controller: WorkflowController
  /** Latest park per task id on hub A (run + lifecycle child), survives re-parks. */
  let parkedA: Map<string, Parked>
  /** The external agent's single park on hub B (resumed to make it complete). */
  let parkedB: Parked | null

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-a2a-long-step-e2e-'))
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

  it('parks the run on the remote suspend, polls until it settles, then feeds the reply downstream', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'ext-a2a',
        capabilities: [EXT_CAP],
        url,
        token: TOKEN,
        peerId: PEER_A,
        targetSkill: REMOTE_SKILL,
        lifecycle: { pollIntervalMs: 500, maxAttempts: 20 },
        now: () => 1_000_000, // deterministic resumeAt; sweep is driven manually
      }),
    )

    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    // --- fire the trigger. The review step routes to the lifecycle A2A
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
    const childPark = [...parkedA.values()].find((p) => p.by === 'ext-a2a')
    expect(runPark, 'the run parked').toBeDefined()
    expect(childPark, 'the lifecycle child parked').toBeDefined()
    // THE H2 enabler: both rows carry a FINITE resumeAt (sweep-eligible), NOT
    // NEVER_RESUME_AT — so the host sweep drives convergence with no host change.
    expect(childPark!.resumeAt).toBeLessThan(NEVER)
    expect(runPark!.resumeAt).toBeLessThan(NEVER)

    // The external agent parked on hub B (its long compute / HITL).
    expect(parkedB).not.toBeNull()

    // --- sweep hub A while the remote is STILL working: the child polls
    //     tasks/get (working) and re-parks; the run re-polls the child
    //     (suspended) and re-parks. No progress, no premature downstream run.
    await sweepA()
    expect(parkedA.size).toBe(2)
    expect(archive.filed).toHaveLength(0)
    expect((await controller.readRun(runId))?.status).toBe('running')

    // --- the remote settles (external resume — deterministic, not its sweep).
    const resumedB = await hubB.resumeTask(parkedB!.by, parkedB!.task, parkedB!.state)
    expect(resumedB.kind).toBe('ok')

    // --- drive hub A sweeps to convergence: the child's next poll sees
    //     `completed`, settles ok; the run re-polls, folds it in, runs archive.
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

  it('a remote that never settles fails the step closed after maxAttempts (no forever-park)', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'ext-a2a',
        capabilities: [EXT_CAP],
        url,
        token: TOKEN,
        peerId: PEER_A,
        targetSkill: REMOTE_SKILL,
        lifecycle: { pollIntervalMs: 500, maxAttempts: 2 }, // tiny cap for the test
        now: () => 1_000_000,
      }),
    )

    await controller.importFromText(WORKFLOW_YAML)
    await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    const runId = (await controller.listRuns({ workflowId: WORKFLOW_ID }))[0]!.runId

    // The remote stays `working` forever (we NEVER resume hub B). Sweep hub A
    // until convergence — the child must fail closed at maxAttempts rather than
    // re-parking forever, and the run must fail (default onFailure=halt).
    for (let i = 0; i < 12 && parkedA.size > 0; i++) {
      const run = await controller.readRun(runId)
      if (run?.status === 'done' || run?.status === 'failed') break
      await sweepA()
    }

    const run = await controller.readRun(runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')
    expect(review?.error).toMatch(/failing closed/)

    // The downstream local step never ran, and nothing is left parked.
    expect(archive.filed).toHaveLength(0)
    expect(parkedA.size).toBe(0)
  })
})
