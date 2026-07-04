/**
 * Lifecycle for Hub Services (PR-10):
 *
 *   - softDelete publishes a `service_trashed` event on the hub
 *     transcript so the admin SSE stream sees it.
 *   - softDeleteAllForOwner walks every registered plugin and
 *     soft-deletes for the same Owner, collecting per-plugin
 *     successes / failures.
 *   - listTrashAll unions every plugin's listTrash().
 *   - sweepExpiredTrash hard-deletes entries past `expiresAt` and
 *     publishes `service_purged`.
 *   - LifecycleSweeper start/stop/runOnce. Stop awaits the in-flight
 *     tick so a shutdown handler doesn't race the sweeper.
 *   - LocalAgentPool.onAgentRemoved soft-deletes every plugin for
 *     the removed agent's owner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger, Hub, Space, type AgentRecord, type TranscriptEntry } from '@gotong/core'
import { TRASH_DEFAULT_RETENTION_MS, type Owner, type ServicePlugin, type TrashRef } from '@gotong/services-sdk'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import {
  bootstrapServices,
  LifecycleSweeper,
  type HubServices,
} from '../src/services/index.js'

const logger = createLogger('lifecycle-test', { disabled: true })

/**
 * Tiny fake plugin with a configurable trash window so tests can
 * make entries "expired" without time-travelling the system clock.
 */
function makeFakePlugin(opts: {
  type?: string
  impl?: string
  /** Override of how to date trash entries. Default = now. */
  trashAt?: () => number
  /** Override of expiresAt window. Default 30 days from deletedAt. */
  retentionMs?: number
}): ServicePlugin & {
  calls: string[]
  trash: TrashRef[]
} {
  const trashAt = opts.trashAt ?? (() => Date.now())
  const retentionMs = opts.retentionMs ?? TRASH_DEFAULT_RETENTION_MS
  return {
    type: opts.type ?? 'memory',
    impl: opts.impl ?? 'fake',
    version: '0.1.0',
    calls: [],
    trash: [] as TrashRef[],
    async validateConfig(raw) {
      return raw as Record<string, unknown>
    },
    async init() { /* noop */ },
    async attach(owner) {
      return { ok: true, owner }
    },
    async detach() {
      this.calls.push('detach')
    },
    async softDelete(owner: Owner) {
      const deletedAt = trashAt()
      const ref: TrashRef = {
        id: Math.random().toString(36).slice(2, 10).padEnd(16, '0'),
        type: this.type,
        impl: this.impl,
        ownerKind: owner.kind,
        ownerId: owner.id,
        deletedAt,
        expiresAt: deletedAt + retentionMs,
      }
      this.trash.push(ref)
      this.calls.push(`softDelete:${owner.kind}/${owner.id}`)
      return ref
    },
    async restore() {
      this.calls.push('restore')
    },
    async hardDelete(ref) {
      this.trash = this.trash.filter((r) => r.id !== ref.id)
      this.calls.push(`hardDelete:${ref.id}`)
    },
    async describe() {
      return { sizeBytes: 0 }
    },
    async shutdown() {
      this.calls.push('shutdown')
    },
    async listTrash() {
      return [...this.trash]
    },
  } as unknown as ServicePlugin & { calls: string[]; trash: TrashRef[] }
}

describe('HubServices.softDelete publishes service_trashed', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let captured: TranscriptEntry[]
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-lc-'))
    await rm(root, { recursive: true, force: true })
    const o = await Space.init(root, { name: 'test' })
    space = o.space
    hub = new Hub({ space })
    await hub.start()
    captured = []
    hub.onEvent((e) => captured.push(e))
    // Force a single fake plugin via the loader's importPackage hook.
    const fake = makeFakePlugin({ type: 'memory', impl: 'file' })
    const boot = await bootstrapServices({
      space, hub, logger,
      importPackage: async (pkg) => {
        if (pkg.includes('memory')) return { default: () => fake }
        throw new Error('skip')
      },
    })
    services = boot.services
  })
  afterEach(async () => {
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('softDelete emits a service_trashed transcript entry', async () => {
    const owner: Owner = { kind: 'agent', id: 'a1' }
    const ref = await services.softDelete({
      type: 'memory', impl: 'file', owner, reason: 'test',
    })
    const ev = captured.find((c) => c.kind === 'service_trashed')
    expect(ev).toBeDefined()
    if (ev && ev.kind === 'service_trashed') {
      expect(ev.data.type).toBe('memory')
      expect(ev.data.impl).toBe('file')
      expect(ev.data.ownerKind).toBe('agent')
      expect(ev.data.ownerId).toBe('a1')
      expect(ev.data.ref.id).toBe(ref.id)
      expect(ev.data.ref.reason).toBe('test')
    }
  })

  it('softDeleteAllForOwner returns one row per registered plugin', async () => {
    const out = await services.softDeleteAllForOwner({ kind: 'agent', id: 'a1' })
    // Only memory:file is registered in this suite.
    expect(out).toHaveLength(1)
    expect(out[0]!.ref).toBeDefined()
  })

  it('listTrashAll unions every plugin', async () => {
    await services.softDelete({
      type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' },
    })
    const all = await services.listTrashAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.type).toBe('memory')
    expect(all[0]!.impl).toBe('file')
  })
})

describe('HubServices.sweepExpiredTrash', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let fake: ServicePlugin & { calls: string[]; trash: TrashRef[] }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-sweep-'))
    await rm(root, { recursive: true, force: true })
    const o = await Space.init(root, { name: 'test' })
    space = o.space
    hub = new Hub({ space })
    await hub.start()
    // Use a 100ms retention so we don't have to time-travel.
    fake = makeFakePlugin({ type: 'memory', impl: 'file', retentionMs: 100 })
    const boot = await bootstrapServices({
      space, hub, logger,
      importPackage: async (pkg) => {
        if (pkg.includes('memory')) return { default: () => fake }
        throw new Error('skip')
      },
    })
    services = boot.services
  })
  afterEach(async () => {
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('does not purge entries that are not yet expired', async () => {
    await services.softDelete({
      type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' },
    })
    const r = await services.sweepExpiredTrash(Date.now())
    expect(r.scanned).toBe(1)
    expect(r.purged).toBe(0)
    expect(fake.trash).toHaveLength(1)
  })

  it('purges entries past expiresAt and publishes service_purged', async () => {
    const captured: TranscriptEntry[] = []
    hub.onEvent((e) => captured.push(e))
    const ref = await services.softDelete({
      type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' },
    })
    // Pretend a long time has passed.
    const future = ref.expiresAt + 1000
    const r = await services.sweepExpiredTrash(future)
    expect(r.purged).toBe(1)
    expect(fake.trash).toHaveLength(0)
    const purgeEvt = captured.find((c) => c.kind === 'service_purged')
    expect(purgeEvt).toBeDefined()
    if (purgeEvt && purgeEvt.kind === 'service_purged') {
      expect(purgeEvt.data.trashId).toBe(ref.id)
    }
  })
})

describe('LifecycleSweeper', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let fake: ServicePlugin & { calls: string[]; trash: TrashRef[] }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-sweeper-'))
    await rm(root, { recursive: true, force: true })
    const o = await Space.init(root, { name: 'test' })
    space = o.space
    hub = new Hub({ space })
    await hub.start()
    fake = makeFakePlugin({ type: 'memory', impl: 'file', retentionMs: 1 })
    const boot = await bootstrapServices({
      space, hub, logger,
      importPackage: async (pkg) => {
        if (pkg.includes('memory')) return { default: () => fake }
        throw new Error('skip')
      },
    })
    services = boot.services
  })
  afterEach(async () => {
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('runOnce purges expired entries without engaging the timer', async () => {
    const ref = await services.softDelete({
      type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a1' },
    })
    // 1ms retention → ref is already expired by the time we sweep.
    await new Promise((r) => setTimeout(r, 10))
    const s = new LifecycleSweeper({ services, intervalMs: 60_000, logger })
    const r = await s.runOnce()
    expect(r.purged).toBe(1)
    expect(fake.trash.find((t) => t.id === ref.id)).toBeUndefined()
  })

  it('stop() awaits the in-flight tick (no race)', async () => {
    const s = new LifecycleSweeper({ services, intervalMs: 60_000, logger })
    s.start()
    // Even if start fires a microtask sweep, stop() must wait for it.
    await expect(s.stop()).resolves.not.toThrow()
  })

  it('runOnce on a stopped sweeper is a no-op', async () => {
    const s = new LifecycleSweeper({ services, intervalMs: 60_000, logger })
    await s.stop()
    expect(await s.runOnce()).toEqual({ scanned: 0, purged: 0 })
  })
})

describe('LocalAgentPool.onAgentRemoved', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-onrm-'))
    await rm(root, { recursive: true, force: true })
    const o = await Space.init(root, { name: 'test' })
    space = o.space
    hub = new Hub({ space })
    await hub.start()
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@gotong/service-memory-file'] }, null, 2) + '\n',
      'utf8',
    )
    const boot = await bootstrapServices({ space, hub, logger })
    services = boot.services
  })
  afterEach(async () => {
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('soft-deletes every plugin for the removed agent', async () => {
    // Spawn an agent + write some memory so trash has payload.
    await space.upsertAgent({
      id: 'coach',
      allowedCapabilities: ['intake'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'mock',
        system: 'hi',
        uses: [{ type: 'memory', impl: 'file', config: {} }],
      },
    } as AgentRecord)
    const pool = new LocalAgentPool({ hub, space, services })
    await pool.start()
    const live = services.liveHandlesFor({ kind: 'agent', id: 'coach' })
    await (live[0]!.handle as { remember: (e: { kind: 'episodic'; text: string }) => Promise<unknown> })
      .remember({ kind: 'episodic', text: 'first chat' })

    // Now do the removal flow.
    await pool.stop('coach')
    await space.removeAgent('coach')
    await pool.onAgentRemoved!('coach')

    const all = await services.listTrashAll()
    expect(all.find((r) => r.type === 'memory' && r.ownerId === 'coach')).toBeDefined()
  })

  it('is a safe no-op when services is undefined', async () => {
    const pool = new LocalAgentPool({ hub, space /* no services */ })
    await expect(pool.onAgentRemoved!('whatever')).resolves.not.toThrow()
  })
})
