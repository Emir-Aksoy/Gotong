/**
 * End-to-end test: SDK-side ServiceClient ↔ transport-ws ServiceCallRouter
 * over a real WebSocket. Verifies the promise made in `docs/AGENT.md`:
 *
 *   "you can move an agent between [in-process and remote] without
 *    changing its logic"
 *
 * — i.e. a remote agent calling `this.services.memory.recall(...)` sees
 * exactly the same return shape as an in-process LlmAgent would.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub } from '@aipehub/core'
import {
  serveWebSocket,
  type ServiceCallGateway,
  type WebSocketTransportHandle,
} from '@aipehub/transport-ws'
import type { ServiceOwner } from '@aipehub/protocol'

import { AgentParticipant, connect, type Session } from '../src/index.js'

// ---------------------------------------------------------------------------
// Fake gateway + plugin handle.
// ---------------------------------------------------------------------------

class FakeMemoryHandle {
  log: Array<{ kind: string; text: string }> = []

  async recall(query: { k?: number }): Promise<Array<{ id: string; kind: string; text: string; ts: number }>> {
    const k = query.k ?? 20
    return this.log.slice(0, k).map((e, i) => ({
      id: `e${i + 1}`, kind: e.kind, text: e.text, ts: 1000 + i,
    }))
  }

  async remember(entry: { kind: string; text: string }): Promise<{ id: string; kind: string; text: string; ts: number }> {
    this.log.push(entry)
    const i = this.log.length
    return { id: `e${i}`, kind: entry.kind, text: entry.text, ts: 1000 + i }
  }

  async list(): Promise<Array<unknown>> {
    return [...this.log]
  }

  async forget(_id: string): Promise<void> {
    /* no-op */
  }

  async clear(): Promise<void> {
    this.log.length = 0
  }
}

class FakeDatastoreHandle {
  store = new Map<string, unknown>()
  get name(): string {
    return 'cases'
  }
  kv = {
    get: async (key: string): Promise<unknown> => this.store.get(key),
    set: async (key: string, value: unknown): Promise<void> => {
      this.store.set(key, value)
    },
    del: async (key: string): Promise<void> => {
      this.store.delete(key)
    },
    keys: async (prefix?: string): Promise<string[]> =>
      [...this.store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
  }
  sql = {
    exec: async (_sql: string, _params?: unknown[]): Promise<{ changes: number }> =>
      ({ changes: 1 }),
    query: async <T = Record<string, unknown>>(_sql: string, _params?: unknown[]): Promise<T[]> =>
      ([] as T[]),
  }
}

class FakeGateway implements ServiceCallGateway {
  memoryHandles = new Map<string, FakeMemoryHandle>()
  datastoreHandles = new Map<string, FakeDatastoreHandle>()

  async attach(spec: {
    type: string
    impl: string
    owner: ServiceOwner
    config: unknown
  }): Promise<{ handle: unknown }> {
    const key = `${spec.type}:${spec.impl}:${spec.owner.kind}/${spec.owner.id}`
    if (spec.type === 'memory') {
      let h = this.memoryHandles.get(key)
      if (!h) {
        h = new FakeMemoryHandle()
        this.memoryHandles.set(key, h)
      }
      return { handle: h }
    }
    if (spec.type === 'datastore') {
      let h = this.datastoreHandles.get(key)
      if (!h) {
        h = new FakeDatastoreHandle()
        this.datastoreHandles.set(key, h)
      }
      return { handle: h }
    }
    throw new Error(`fake gateway doesn't know service type '${spec.type}'`)
  }

  async detachFor(_owner: ServiceOwner): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Bare agent — the SDK's `Session.services` is what we care about; the
// agent class itself is only needed because connect() requires one.
// ---------------------------------------------------------------------------

class NoopAgent extends AgentParticipant {
  constructor(id: string) {
    super({ id, capabilities: [] })
  }
  protected handleTask(): unknown {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sdk-node — services roundtrip', () => {
  let hub: Hub
  let wsHandle: WebSocketTransportHandle
  let gateway: FakeGateway
  let session: Session | undefined

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    gateway = new FakeGateway()
    wsHandle = await serveWebSocket(hub, { port: 0, services: gateway })
  })

  afterEach(async () => {
    if (session && session.state !== 'closed') {
      await session.close()
    }
    session = undefined
    await wsHandle.close()
    await hub.stop()
  })

  it('exposes session.services when connect() got `services: [...]`', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    expect(session.services).toBeDefined()
    expect(session.services!.memory).toBeDefined()
  })

  it('does NOT expose services when connect() omits the field', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      autoReconnect: false,
    })
    expect(session.services).toBeUndefined()
  })

  it('memory.remember + memory.recall roundtrip values verbatim', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    const mem = session.services!.memory!
    const entry = await mem.remember({ kind: 'episodic', text: 'first thing' })
    expect(entry.id).toBe('e1')
    expect(entry.text).toBe('first thing')
    await mem.remember({ kind: 'episodic', text: 'second thing' })
    const past = await mem.recall({ k: 10 })
    expect(past).toHaveLength(2)
    expect(past.map((e) => e.text)).toEqual(['first thing', 'second thing'])
  })

  it('memoryFor(impl, owner) attaches a fresh per-case handle', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        // Static per-agent memory.
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
        // Wildcard case-scoped memory.
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      autoReconnect: false,
    })
    const caseA = session.services!.memoryFor('file', { kind: 'workflow-run', id: 'case-A' })
    const caseB = session.services!.memoryFor('file', { kind: 'workflow-run', id: 'case-B' })
    expect(caseA).not.toBe(caseB)
    await caseA.remember({ kind: 'episodic', text: 'from A' })
    await caseB.remember({ kind: 'episodic', text: 'from B' })

    const fromA = await caseA.recall({})
    const fromB = await caseB.recall({})
    expect(fromA.map((e) => e.text)).toEqual(['from A'])
    expect(fromB.map((e) => e.text)).toEqual(['from B'])

    // memoryFor returns cached wrapper on repeat (handle is the same JS obj).
    const caseAAgain = session.services!.memoryFor('file', { kind: 'workflow-run', id: 'case-A' })
    expect(caseAAgain).toBe(caseA)
  })

  it('datastore handle exposes name + kv + sql sub-namespaces', async () => {
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        {
          type: 'datastore',
          impl: 'sqlite',
          owner: { kind: 'agent', id: 'self' },
          config: { name: 'cases' },
        },
      ],
      autoReconnect: false,
    })
    const ds = session.services!.datastore!.cases
    expect(ds.name).toBe('cases')
    await ds.kv.set('k1', { value: 42 })
    const got = await ds.kv.get('k1')
    expect(got).toEqual({ value: 42 })
    const keys = await ds.kv.keys()
    expect(keys).toEqual(['k1'])
    const exec = await ds.sql.exec('INSERT INTO x VALUES (?)', [1])
    expect(exec.changes).toBe(1)
  })

  it('forbidden_service surfaces as a ServiceCallError', async () => {
    const { ServiceCallError } = await import('../src/service-client.js')
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    // Try to call artifact (not declared).
    const a = session.services!.artifactFor('file', { kind: 'agent', id: 'coach' })
    await expect(a.list()).rejects.toBeInstanceOf(ServiceCallError)
    try {
      await a.list()
    } catch (err) {
      expect((err as { code?: string }).code).toBe('forbidden_service')
    }
  })

  it('connection close fails pending calls with session_not_ready', async () => {
    const { ServiceCallError } = await import('../src/service-client.js')
    session = await connect({
      url: wsHandle.url,
      agents: [new NoopAgent('coach')],
      services: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      autoReconnect: false,
    })
    const mem = session.services!.memory!
    // Fire a recall, immediately close before result can arrive.
    const pending = mem.recall({ k: 1 })
    await session.close('test')
    await expect(pending).rejects.toBeInstanceOf(ServiceCallError)
    try {
      await pending
    } catch (err) {
      expect(['session_not_ready']).toContain((err as { code?: string }).code)
    }
  })
})
