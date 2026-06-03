/**
 * Route B P1-M8c — A2A task lifecycle over real HTTP (THE acceptance gate).
 *
 * A real Hub fronts a real A2aServer (http.createServer, ephemeral port). A
 * receiver agent SUSPENDS once (long compute / HITL) and replies on resume.
 * The real a2a client drives the full lifecycle over the wire — no LLM, no
 * external network, fully deterministic (resume is triggered manually, not by
 * the sweep, so there's no timing flake):
 *
 *   1. `message/send` → the agent suspends → the server mints an OPAQUE task
 *      handle and returns a `working` Task.
 *   2. `tasks/get` while still parked → `working`.
 *   3. `hub.resumeTask(...)` (the captured park) → the agent replies.
 *   4. `tasks/get` → `completed`, carrying the resolved text all the way back.
 *   5. a DIFFERENT authenticated peer polling the SAME opaque id → TASK_NOT
 *      _FOUND (ownership isolation holds over the wire, not just in unit tests).
 *
 * Proves M8 closes end to end: M8a wire types/client + M8b host server +
 * the suspend/resume seam (hub.taskResult read passively from the transcript).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  SuspendTaskError,
  type Task,
} from '@aipehub/core'
import { a2aGetTask, a2aSendRaw, A2aClientError, isA2ATask } from '@aipehub/a2a'

import { A2aServer } from '../src/a2a-server.js'

/** A `resumeAt` so far out the sweep never fires — park until an external resume. */
const NEVER = 9_999_999_999_000

function textOf(payload: unknown): string {
  if (payload && typeof payload === 'object') return String((payload as { text?: unknown }).text ?? '')
  return String(payload ?? '')
}

/**
 * Suspends on first dispatch (stashing the inbound text), then on resume
 * returns the transformed reply — a deterministic stand-in for a long task /
 * HITL approval step.
 */
class SuspendThenReplyAgent extends AgentParticipant {
  constructor() {
    super({ id: 'b-long', capabilities: ['long-task'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    throw new SuspendTaskError({ resumeAt: NEVER, state: { text: textOf(task.payload) } })
  }
  protected async handleResume(_task: Task, state: unknown): Promise<unknown> {
    return { text: `resolved: ${(state as { text?: string }).text ?? ''}` }
  }
}

const PEER = 'hubA'
const TOKEN = 'shared-token-AB'
const PEER_OTHER = 'hubC'
const TOKEN_OTHER = 'token-c'

describe('Route B P1-M8c — A2A task lifecycle over real HTTP (acceptance gate)', () => {
  let hubB: Hub
  let server: Server
  let url: string
  /** Captured by the suspendNotifier so the test can resume deterministically. */
  let parked: { task: Task; by: string; state: unknown } | null

  beforeEach(async () => {
    parked = null
    hubB = Hub.inMemory({
      suspendNotifier: (task, by, suspend) => {
        parked = { task, by, state: suspend.state }
      },
    })
    await hubB.start()
    hubB.register(new SuspendThenReplyAgent())

    const a2aServer = new A2aServer({
      hub: hubB,
      // Two known peers so ownership isolation can be exercised over the wire.
      resolvePeerToken: (peerId) =>
        peerId === PEER ? TOKEN : peerId === PEER_OTHER ? TOKEN_OTHER : null,
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
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await hubB.stop()
  })

  it('suspend → working Task; external resume → tasks/get completes with the round-trip text', async () => {
    // 1. message/send → the agent suspends → a working Task (opaque id).
    const sent = await a2aSendRaw(url, TOKEN, 'hello', { peerId: PEER, metadata: { skill: 'long-task' } })
    expect(isA2ATask(sent)).toBe(true)
    if (!isA2ATask(sent)) return
    expect(sent.status.state).toBe('working')
    const a2aTaskId = sent.id
    expect(parked).not.toBeNull() // the suspendNotifier captured the park

    // 2. poll while still parked → working (tasks/get over real HTTP).
    const polled = await a2aGetTask(url, TOKEN, a2aTaskId, { peerId: PEER })
    expect(polled.status.state).toBe('working')

    // 3. external resume — deterministic, not the 30s sweep.
    const resumed = await hubB.resumeTask(parked!.by, parked!.task, parked!.state)
    expect(resumed.kind).toBe('ok')

    // 4. poll again → completed, with the resolved text carried all the way back.
    const done = await a2aGetTask(url, TOKEN, a2aTaskId, { peerId: PEER })
    expect(done.status.state).toBe('completed')
    expect(done.status.message?.parts).toEqual([{ kind: 'text', text: 'resolved: hello' }])
  })

  it('a different authenticated peer cannot poll the first peer’s task (ownership isolation over the wire)', async () => {
    const sent = await a2aSendRaw(url, TOKEN, 'secret', { peerId: PEER, metadata: { skill: 'long-task' } })
    if (!isA2ATask(sent)) throw new Error('expected a Task result')
    const a2aTaskId = sent.id

    // hubC authenticates fine but must not resolve hubA's opaque id → fail-closed.
    const err = await a2aGetTask(url, TOKEN_OTHER, a2aTaskId, { peerId: PEER_OTHER }).catch((e) => e)
    expect(err).toBeInstanceOf(A2aClientError)
    expect((err as A2aClientError).code).toBe(-32001) // TASK_NOT_FOUND

    // The original owner still resolves it.
    const ok = await a2aGetTask(url, TOKEN, a2aTaskId, { peerId: PEER })
    expect(ok.status.state).toBe('working')
  })
})
