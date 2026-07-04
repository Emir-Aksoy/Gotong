/**
 * Shared plugin contract tests.
 *
 * Every plugin imports `runPluginContract` from this entry and runs
 * it against its own implementation. The intent is to catch "my
 * plugin behaves slightly different from the spec" bugs at the
 * package level rather than letting them slip into integration tests.
 *
 * Usage in a plugin's test file:
 *
 *   import { describe } from 'vitest'
 *   import { runPluginContract } from '@gotong/services-sdk/testing'
 *   import { MemoryFilePlugin } from '../src/index.js'
 *
 *   describe('contract: memory-file', () => {
 *     runPluginContract({
 *       plugin: new MemoryFilePlugin(),
 *       sampleConfig: { scope: 'private', kinds: ['episodic'] },
 *       sampleOwner: { kind: 'agent', id: 'test-agent' },
 *     })
 *   })
 *
 * The factory uses the local `vitest` binding from the caller's
 * suite — we re-export `it` / `expect` here only to keep the public
 * surface stable.
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ServicePlugin } from './plugin.js'
import type { Owner } from './owner.js'
import { createLogger } from '@gotong/core'

export interface PluginContractCase<TConfig, THandle> {
  /** Plugin under test. A fresh instance per `describe` block. */
  plugin: ServicePlugin<TConfig, THandle>
  /**
   * Config the plugin's `validateConfig` will accept. Used to attach
   * a handle for the lifecycle checks.
   */
  sampleConfig: unknown
  /** Owner the handle is attached to. */
  sampleOwner: Owner
  /**
   * Optional smoke-write to verify data survives detach + re-attach.
   * Called once after the first `attach`; the returned cleanup is
   * called inside the contract after the second `attach`. If absent,
   * persistence is not verified beyond "plugin agreed to write".
   */
  writeSample?: (handle: THandle) => Promise<void>
  /** Optional assertion run on a re-attached handle. */
  expectSamplePersisted?: (handle: THandle) => Promise<void>
}

/**
 * Run the standard contract suite. Invoke inside a `describe` block.
 * Sets up a temp directory; tears it down on `afterAll`.
 */
export function runPluginContract<TConfig, THandle>(
  cs: PluginContractCase<TConfig, THandle>,
): void {
  let rootDir: string
  let config: TConfig
  const logger = createLogger('contract-test', { disabled: true })

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'gotong-svc-contract-'))
    config = await cs.plugin.validateConfig(cs.sampleConfig)
    await cs.plugin.init({
      rootDir,
      logger,
      hub: { now: () => Date.now(), publishEvent: () => undefined },
    })
  })

  afterAll(async () => {
    await cs.plugin.shutdown()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('declares type, impl, version', () => {
    expect(cs.plugin.type).toBeTypeOf('string')
    expect(cs.plugin.type.length).toBeGreaterThan(0)
    expect(cs.plugin.impl).toBeTypeOf('string')
    expect(cs.plugin.impl.length).toBeGreaterThan(0)
    expect(cs.plugin.version).toMatch(/^\d+\./)
  })

  it('attach + detach round-trip', async () => {
    const handle = await cs.plugin.attach(cs.sampleOwner, config)
    expect(handle).toBeDefined()
    await cs.plugin.detach(cs.sampleOwner)
  })

  it('describe returns a finite snapshot', async () => {
    const handle = await cs.plugin.attach(cs.sampleOwner, config)
    try {
      if (cs.writeSample) await cs.writeSample(handle)
      const snap = await cs.plugin.describe(cs.sampleOwner)
      expect(Number.isFinite(snap.sizeBytes)).toBe(true)
      expect(snap.sizeBytes).toBeGreaterThanOrEqual(0)
    } finally {
      await cs.plugin.detach(cs.sampleOwner)
    }
  })

  it('data persists across detach + re-attach', async () => {
    // First attach: write a sample
    const first = await cs.plugin.attach(cs.sampleOwner, config)
    if (cs.writeSample) await cs.writeSample(first)
    await cs.plugin.detach(cs.sampleOwner)

    // Second attach: read it back
    const second = await cs.plugin.attach(cs.sampleOwner, config)
    try {
      if (cs.expectSamplePersisted) await cs.expectSamplePersisted(second)
    } finally {
      await cs.plugin.detach(cs.sampleOwner)
    }
  })

  it('softDelete → restore round-trip preserves data', async () => {
    const h1 = await cs.plugin.attach(cs.sampleOwner, config)
    if (cs.writeSample) await cs.writeSample(h1)
    await cs.plugin.detach(cs.sampleOwner)

    const ref = await cs.plugin.softDelete(cs.sampleOwner)
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    expect(ref.type).toBe(cs.plugin.type)
    expect(ref.impl).toBe(cs.plugin.impl)
    expect(ref.deletedAt).toBeGreaterThan(0)
    expect(ref.expiresAt).toBeGreaterThan(ref.deletedAt)

    // After softDelete describe should report empty or near-empty.
    const afterSnap = await cs.plugin.describe(cs.sampleOwner)
    expect(afterSnap.sizeBytes).toBe(0)

    // Restore brings data back at the original owner key.
    await cs.plugin.restore(ref)
    const h2 = await cs.plugin.attach(cs.sampleOwner, config)
    try {
      if (cs.expectSamplePersisted) await cs.expectSamplePersisted(h2)
    } finally {
      await cs.plugin.detach(cs.sampleOwner)
    }
  })

  it('softDelete twice on same day is idempotent (same id)', async () => {
    // Re-attach + write so the second softDelete has something to do.
    const h = await cs.plugin.attach(cs.sampleOwner, config)
    if (cs.writeSample) await cs.writeSample(h)
    await cs.plugin.detach(cs.sampleOwner)

    const a = await cs.plugin.softDelete(cs.sampleOwner)
    const b = await cs.plugin.softDelete(cs.sampleOwner)
    expect(b.id).toBe(a.id)

    // Cleanup so the suite's afterAll doesn't trip over stale trash.
    await cs.plugin.hardDelete(a)
  })
}
