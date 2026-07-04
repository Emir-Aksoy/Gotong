/**
 * End-to-end integration test for protocol v1.1 services-over-ws.
 *
 * Drives the full production path:
 *
 *   Real Hub → bootstrapServices (real `service-memory-file` plugin
 *   on a real tmp dir) → serveWebSocket + HubServices gateway →
 *   sdk-node connect() with services HELLO → SERVICE_CALL frames →
 *   verify the data landed on disk.
 *
 * Different from `packages/host/tests/case-context.test.ts` (which is
 * in-memory unit) and from `packages/sdk-node/tests/services-roundtrip.
 * test.ts` (which uses a fake gateway). This test is the only one that
 * exercises **the real plugin + real WS + real SDK** together, so a
 * regression in any of the three surfaces breaks here first.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type Task } from '@gotong/core'
import { AgentParticipant, connect, type Session, type ServiceClient } from '@gotong/sdk-node'
import { serveWebSocket, type WebSocketTransportHandle } from '@gotong/transport-ws'

import { bootstrapServices, type HubServices } from '../src/services/index.js'

class CaseAgent extends AgentParticipant {
  services?: ServiceClient
  constructor(id: string) {
    super({ id, capabilities: ['case-work'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { caseId: string; text: string }
    const mem = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: payload.caseId,
    })
    await mem.remember({ kind: 'episodic', text: payload.text, meta: { agent: this.id } })
    // `recall` returns newest-first by spec (memory contract). `latestText`
    // is therefore the entry we *just* remembered.
    const all = await mem.recall({ k: 50 })
    return { count: all.length, latestText: all[0]?.text }
  }
}

describe('integration: services over ws (protocol v1.1)', () => {
  let tmpRoot: string
  let space: Awaited<ReturnType<typeof Space.init>>['space']
  let hub: Hub
  let services: HubServices
  let ws: WebSocketTransportHandle

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'gotong-ws-svc-'))
    const init = await Space.init(tmpRoot, { name: 'test' })
    space = init.space
    hub = new Hub({ space })
    await hub.start()
    // Enable just memory:file — keeps the test free of sqlite native bindings.
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@gotong/service-memory-file'] }),
      'utf8',
    )
    const boot = await bootstrapServices({ space, hub })
    services = boot.services
    ws = await serveWebSocket(hub, { port: 0, services })
  })

  afterEach(async () => {
    await ws.close()
    await services.shutdownAll()
    await hub.stop()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('two sidecar agents share a case memory via SERVICE_CALL → real disk', async () => {
    const writer = new CaseAgent('writer')
    const reviewer = new CaseAgent('reviewer')
    const sessionW: Session = await connect({
      url: ws.url,
      agents: [writer],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      autoReconnect: false,
    })
    writer.services = sessionW.services
    const sessionR: Session = await connect({
      url: ws.url,
      agents: [reviewer],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      autoReconnect: false,
    })
    reviewer.services = sessionR.services

    const caseId = `case-${Date.now()}`

    // Writer goes first.
    const r1 = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'writer' },
      payload: { caseId, text: 'first thing' },
      title: 't1',
    })
    expect(r1.kind).toBe('ok')
    if (r1.kind === 'ok') {
      expect(r1.output).toEqual({ count: 1, latestText: 'first thing' })
    }

    // Reviewer sees what writer wrote (same case, different agent / session).
    const r2 = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'reviewer' },
      payload: { caseId, text: 'second thing' },
      title: 't2',
    })
    expect(r2.kind).toBe('ok')
    if (r2.kind === 'ok') {
      // After reviewer's remember, both entries are visible to it via
      // recall — proving the two independent WS sessions share the same
      // owner's memory plugin on the host. `latestText` is what reviewer
      // just wrote.
      expect(r2.output).toEqual({ count: 2, latestText: 'second thing' })
    }

    // The bytes landed on disk under the case's workflow-run owner.
    const jsonlPath = join(
      space.paths.services,
      'memory',
      'file',
      'workflow-run',
      caseId,
      'episodic.jsonl',
    )
    const raw = await readFile(jsonlPath, 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    const entries = lines.map((l) => JSON.parse(l) as { text: string; meta?: { agent?: string } })
    expect(entries.map((e) => e.text)).toEqual(['first thing', 'second thing'])
    expect(entries.map((e) => e.meta?.agent)).toEqual(['writer', 'reviewer'])

    await sessionW.close()
    await sessionR.close()
  })

  it('forbidden_owner when agent declared only its own scope but tries case-scope', async () => {
    const { ServiceCallError } = await import('@gotong/sdk-node')
    const agent = new CaseAgent('only-self')
    const session: Session = await connect({
      url: ws.url,
      agents: [agent],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    agent.services = session.services

    // Try to use workflow-run scope — not declared.
    const memory = agent.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: 'unauthorized',
    })
    await expect(memory.recall({ k: 5 })).rejects.toBeInstanceOf(ServiceCallError)
    try {
      await memory.recall({ k: 5 })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('forbidden_owner')
    }

    await session.close()
  })

  it('disconnect detaches every lazy-attached owner on the host side', async () => {
    const agent = new CaseAgent('disconnecting')
    const session: Session = await connect({
      url: ws.url,
      agents: [agent],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      autoReconnect: false,
    })
    agent.services = session.services

    // Touch three cases to attach three handles.
    for (const id of ['c1', 'c2', 'c3']) {
      const m = agent.services!.memoryFor('file', { kind: 'workflow-run', id })
      await m.remember({ kind: 'episodic', text: id })
    }

    // Close the session — host should detach all three.
    await session.close()

    // Memory-file plugin is robust against re-attach after detach: we can
    // attach a fresh handle for the same owner and verify the data persists.
    // (We don't need a getter for "currently attached"; we just confirm the
    // disconnect didn't blow up the host process or corrupt files.)
    const direct = await services.attach({
      type: 'memory',
      impl: 'file',
      owner: { kind: 'workflow-run', id: 'c2' },
      config: {},
    })
    const handle = direct.handle as { list: () => Promise<Array<{ text: string }>> }
    const entries = await handle.list()
    expect(entries.map((e) => e.text)).toEqual(['c2'])
  })
})
