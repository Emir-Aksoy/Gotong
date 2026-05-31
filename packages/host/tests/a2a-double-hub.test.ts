/**
 * Phase 18 C-M5 — two-hub A2A smoke (THE acceptance gate).
 *
 * Two real Hubs talk over real A2A HTTP/JSON-RPC on loopback — no LLM, no
 * external network, fully deterministic:
 *   - Hub B fronts an A2aServer with a real http.createServer (ephemeral port)
 *     and a deterministic mock agent (capability `echo`).
 *   - Hub A registers an A2aRemoteParticipant (capability `translate`) pointed
 *     at Hub B's /a2a with a valid pre-shared peer token + targetSkill `echo`.
 *   - A capability dispatch on Hub A → outbound A2aRemoteParticipant → POST Hub
 *     B /a2a → B dispatches to the mock agent → the reply rides back → Hub A's
 *     task ok output. We assert the round-trip text deterministically.
 *
 * Proves the whole C-track loop closes over the wire: C-M3 inbound server +
 * C-M2 client/wire-types + C-M4 outbound participant — and that the pre-shared
 * bearer actually gates it (a wrong token fails the dispatch, not silently
 * succeeds).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Task, type TaskResult } from '@aipehub/core'
import { A2aRemoteParticipant } from '@aipehub/a2a'

import { A2aServer } from '../src/a2a-server.js'

/** Deterministic receiver agent on Hub B: transforms the inbound text. */
class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'b-echo', capabilities: ['echo'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const p = task.payload
    const text =
      p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : String(p ?? '')
    return { text: `echo: ${text}` }
  }
}

const PEER_A = 'hubA'
const TOKEN_AB = 'shared-token-AB'

describe('Phase 18 C-M5 — two-hub A2A smoke (acceptance gate)', () => {
  let hubA: Hub
  let hubB: Hub
  let server: Server
  let url: string

  beforeEach(async () => {
    hubA = Hub.inMemory()
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])

    hubB.register(new EchoAgent())

    // Hub B's inbound A2A surface: only peer `hubA` presenting TOKEN_AB passes.
    const a2aServer = new A2aServer({
      hub: hubB,
      resolvePeerToken: (peerId) => (peerId === PEER_A ? TOKEN_AB : null),
      newMessageId: () => 'm-reply', // deterministic reply id
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
  })

  afterEach(async () => {
    // Force-close keep-alive sockets so close()'s callback fires promptly
    // (undici/global-fetch pools the loopback connection otherwise).
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all([hubA.stop(), hubB.stop()])
  })

  it('round-trips a capability dispatch across hubs over real A2A HTTP', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'a-remote',
        capabilities: ['translate'],
        url,
        token: TOKEN_AB,
        peerId: PEER_A,
        targetSkill: 'echo',
      }),
    )

    // Dispatch on Hub A by capability — selects the outbound A2A participant.
    const result: TaskResult = await hubA.dispatch({
      from: 'user',
      strategy: { kind: 'capability', capabilities: ['translate'] },
      payload: { text: 'hello' },
    })

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      // The deterministic round-trip: Hub B's EchoAgent transformed it and the
      // text came all the way back as Hub A's task output.
      expect(result.output).toEqual({ text: 'echo: hello' })
      expect(result.by).toBe('a-remote')
    }
  })

  it('a wrong bearer fails the dispatch (auth gates over the wire)', async () => {
    hubA.register(
      new A2aRemoteParticipant({
        id: 'a-remote',
        capabilities: ['translate'],
        url,
        token: 'wrong-token',
        peerId: PEER_A,
        targetSkill: 'echo',
      }),
    )

    const result = await hubA.dispatch({
      from: 'user',
      strategy: { kind: 'capability', capabilities: ['translate'] },
      payload: { text: 'hello' },
    })

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.error).toMatch(/HTTP 401/)
  })

  it('targets the capability the remote dispatches to via metadata.skill', async () => {
    // Point at a skill the remote has NO agent for → B replies no_participant →
    // client maps the JSON-RPC error to a failed task (proves skill routing is
    // honored, not ignored in favor of some default).
    hubA.register(
      new A2aRemoteParticipant({
        id: 'a-remote',
        capabilities: ['translate'],
        url,
        token: TOKEN_AB,
        peerId: PEER_A,
        targetSkill: 'nonexistent-skill',
      }),
    )

    const result = await hubA.dispatch({
      from: 'user',
      strategy: { kind: 'capability', capabilities: ['translate'] },
      payload: { text: 'hello' },
    })

    expect(result.kind).toBe('failed')
  })
})
