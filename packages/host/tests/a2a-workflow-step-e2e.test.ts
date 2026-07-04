/**
 * v5 Stream H-M1 — A2A external agent as a workflow step (acceptance gate).
 *
 * THE test the stream exists to prove: a real workflow step whose capability is
 * served by an `A2aRemoteParticipant` routes OUT to an EXTERNAL A2A agent over
 * real HTTP, and that agent's reply flows back as the step's output and feeds a
 * downstream LOCAL step.
 *
 * Stream G proved a workflow step can cross to a MESH peer (Gotong↔Gotong over
 * an inproc HubLink, gated by the outbound approval gate). H is the sibling: the
 * destination is an EXTERNAL A2A endpoint reached via `A2aRemoteParticipant`
 * (the Phase 18 C-M4 outbound edge). The mechanism is identical capability
 * dispatch — the A2A participant is just a local participant advertising the
 * capability — so no runner/schema change is needed. This is the regression
 * guard that the path stays wired (and that A2A auth still gates it even when
 * the caller is a workflow, not a direct admin dispatch).
 *
 * Everything is real: a real WorkflowController on hub A, a real A2aServer
 * fronting hub B over a loopback http.createServer (the "external" A2A agent), a
 * real A2aRemoteParticipant pointed at it, a real local archive agent
 * downstream. No LLM, no external network, fully deterministic.
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task } from '@gotong/core'
import { A2aRemoteParticipant } from '@gotong/a2a'

import { A2aServer } from '../src/a2a-server.js'
import { WorkflowController } from '../src/workflow-controller.js'

const PEER_A = 'hubA'
const TOKEN = 'shared-token-ax'
const EXT_CAP = 'external-review' // advertised by the A2aRemoteParticipant on hub A
const ARCHIVE_CAP = 'local-archive' // a plain local agent on hub A
const REMOTE_SKILL = 'review' // the capability hub B (the "external" agent) serves

// A two-step workflow: step `review` dispatches the capability the outbound A2A
// participant advertises (so it routes OUT to the external agent); step `archive`
// is a LOCAL capability whose payload refs the A2A reply — proving the external
// result flowed back into the run. The runner emits an ordinary
// `{kind:capability}` dispatch; it has no idea the first capability is remote.
const WORKFLOW_YAML = `
schema: gotong.workflow/v1
workflow:
  id: a2a-step-flow
  name: a2a external step
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

/** The "external" A2A agent living on hub B — transforms the inbound text. */
class ExternalReviewAgent extends AgentParticipant {
  constructor() {
    super({ id: 'b-reviewer', capabilities: [REMOTE_SKILL] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const p = task.payload
    const text =
      p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : String(p ?? '')
    // Only this agent (reachable solely via the A2A HTTP endpoint) emits the
    // `reviewed:` prefix — so seeing it back proves the cross-boundary round-trip.
    return { text: `reviewed: ${text}` }
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

describe('v5 Stream H-M1 — A2A external agent as a workflow step (acceptance gate)', () => {
  let tmp: string
  let hubA: Hub // orchestrator (runs the workflow)
  let hubB: Hub // the "external" A2A agent's hub
  let server: Server
  let url: string
  let archive: ArchiveAgent
  let controller: WorkflowController

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-a2a-wf-step-e2e-'))
    hubA = Hub.inMemory()
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new ExternalReviewAgent())

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
    const port = (server.address() as AddressInfo).port
    url = `http://127.0.0.1:${port}/a2a`

    archive = new ArchiveAgent()
    hubA.register(archive)

    controller = new WorkflowController({
      hub: hubA,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
    })
  })

  afterEach(async () => {
    // Force-close keep-alive sockets so close()'s callback fires promptly.
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all([hubA.stop(), hubB.stop()])
    rmSync(tmp, { recursive: true, force: true })
  })

  it('routes a workflow step OUT to an external A2A agent and feeds the reply downstream', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'ext-a2a',
        capabilities: [EXT_CAP],
        url,
        token: TOKEN,
        peerId: PEER_A,
        targetSkill: REMOTE_SKILL,
      }),
    )

    const sum = await controller.importFromText(WORKFLOW_YAML)
    expect(sum.state).toBe('published')

    const fired = await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })
    expect(fired.kind).toBe('ok')

    const runs = await controller.listRuns({ workflowId: 'a2a-step-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('done')

    // The review step routed to the outbound A2A participant and round-tripped to
    // the external agent (only hub B's agent emits the `reviewed:` prefix).
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.output).toEqual({ text: 'reviewed: hello' })

    // The external reply flowed into the downstream LOCAL step's payload.
    expect(archive.filed).toHaveLength(1)
    expect(archive.filed[0]!.payload).toEqual({ note: 'reviewed: hello' })
  })

  it('a wrong bearer fails the step and the run fails (A2A auth gates even from a workflow)', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'ext-a2a',
        capabilities: [EXT_CAP],
        url,
        token: 'wrong-token',
        peerId: PEER_A,
        targetSkill: REMOTE_SKILL,
      }),
    )

    await controller.importFromText(WORKFLOW_YAML)
    await hubA.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ax:start'] },
      payload: { text: 'hello' },
    })

    // The review step fails (401) → default onFailure=halt fails the run.
    const runs = await controller.listRuns({ workflowId: 'a2a-step-flow' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('failed')
    const review = run?.steps.find((s) => s.stepId === 'review')
    expect(review?.status).toBe('failed')
    expect(review?.error).toMatch(/401/)

    // The downstream local step never ran.
    expect(archive.filed).toHaveLength(0)
  })
})
