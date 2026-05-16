/**
 * End-to-end smoke for the host services boot with the real
 * `@aipehub/service-memory-file` plugin.
 *
 * Why a separate file from `services-bootstrap.test.ts`:
 *   - the fake-plugin tests over there verify shape + error-handling
 *     in isolation — they pass even if the SDK changes its plugin
 *     shape because every test plugin is custom-built.
 *   - this file proves the **wiring is real**: a host that imports
 *     `@aipehub/service-memory-file` through dynamic import gets a
 *     working `MemoryHandle` back from `services.attach`. If we ever
 *     break the loader/factory convention, this file is the one that
 *     fails first.
 *
 * We skip the other two defaults (`artifact-file` is in the workspace
 * but `datastore-sqlite` is not yet — PR-9) by writing our own
 * manifest with only `memory-file` listed.
 */

import { writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space } from '@aipehub/core'
import type { MemoryHandle, Owner } from '@aipehub/services-sdk'

import { bootstrapServices } from '../src/services/index.js'

const logger = createLogger('services-e2e', { disabled: true })

describe('services e2e — real memory-file plugin', () => {
  let root: string
  let space: Space
  let hub: Hub
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-host-services-e2e-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    // Force-pin to memory-file only. The artifact + datastore packages
    // are loaded fine in real life, but this test focuses on the
    // wiring proof. PR-13's end-to-end suite covers the full triad.
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@aipehub/service-memory-file'] }, null, 2) + '\n',
      'utf8',
    )
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('boots, attaches, persists, recalls, softDelete, restore — full loop', async () => {
    const boot = await bootstrapServices({ space, hub, logger })
    expect(boot.errors).toHaveLength(0)
    expect(boot.ready.map((p) => `${p.type}:${p.impl}`)).toEqual(['memory:file'])

    const owner: Owner = { kind: 'agent', id: 'industry-coach' }
    const attached = await boot.services.attach({
      type: 'memory',
      impl: 'file',
      owner,
      config: {},
    })
    const handle = attached.handle as MemoryHandle

    // Write + read back proves the plugin's `attach` returned a live
    // handle, not a stub.
    await handle.remember({ kind: 'episodic', text: 'Q1 review went well' })
    const recalled = await handle.recall({ query: 'Q1' })
    expect(recalled.map((e) => e.text)).toContain('Q1 review went well')

    // Snapshot for admin UI.
    const snap = await boot.services.describe({ type: 'memory', impl: 'file', owner })
    expect(snap.sizeBytes).toBeGreaterThan(0)

    // Soft delete the owner.
    const ref = await boot.services.softDelete({ type: 'memory', impl: 'file', owner })
    expect(ref.id).toMatch(/^[0-9a-f]{16}$/)
    // After softDelete a fresh describe should show zero.
    const after = await boot.services.describe({ type: 'memory', impl: 'file', owner })
    expect(after.sizeBytes).toBe(0)

    // Restore brings the data back. Since the old handle was detached
    // during softDelete (it was previously attached), we attach again.
    await boot.services.restore(ref)
    const reattached = await boot.services.attach({
      type: 'memory',
      impl: 'file',
      owner,
      config: {},
    })
    const handle2 = reattached.handle as MemoryHandle
    const after2 = await handle2.recall({ query: 'Q1' })
    expect(after2.map((e) => e.text)).toContain('Q1 review went well')

    await boot.services.shutdownAll()
  })
})
