/**
 * Regression test for the host's default plugin resolver.
 *
 * Why this file exists separately from `services-e2e.test.ts`:
 *   - That file pins the manifest to `memory-file` only AND was
 *     historically the only place the "real" plugin path got exercised.
 *   - `services-bootstrap.test.ts` always passes an `importPackage` fake,
 *     so it never touches the production resolution code at all.
 *
 * Together, neither file caught the original PR-5/-13 bug: pnpm's
 * isolated module graph means `services-sdk/dist/loader.js`'s naive
 * `import(pkg)` can't see plugin packages declared as host
 * dependencies, because services-sdk's own `node_modules/@aipehub/`
 * only contains `core`. Three plugins were declared as host deps but
 * none of them resolved when the host actually booted.
 *
 * This test:
 *   - asserts the DEFAULT importer (no `importPackage` opt) resolves
 *     all three first-party plugin packages,
 *   - asserts each plugin is registered + initialised end-to-end,
 *   - asserts the data dirs actually got mkdir'd on disk.
 *
 * If a future change reverts to a non-host-anchored resolver, this
 * fails immediately rather than only at production boot time.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space } from '@aipehub/core'
import type { Owner, MemoryHandle, ArtifactHandle, DatastoreHandle } from '@aipehub/services-sdk'

import { bootstrapServices } from '../src/services/index.js'

const logger = createLogger('services-default-resolver-test', { disabled: true })

describe('host services — default importPackage resolves all first-party plugins', () => {
  let root: string
  let space: Space
  let hub: Hub
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-default-resolver-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    // Deliberately do NOT write a plugins.json — let the loader's
    // auto-seed produce one with all three first-party packages,
    // exactly as a fresh host install would see.
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('seeds plugins.json AND loads memory:file + artifact:file + datastore:sqlite via the default importer', async () => {
    // No `importPackage` — the host's host-anchored resolver is in play.
    const boot = await bootstrapServices({ space, hub, logger })

    expect(boot.seeded).toBe(true)
    // No errors means every default first-party package both imported
    // AND initialised cleanly. Before the resolver fix this was 3 errors.
    expect(
      boot.errors.map((e) => `${e.packageName}: ${e.message}`),
    ).toEqual([])
    const ready = boot.ready.map((p) => `${p.type}:${p.impl}`).sort()
    expect(ready).toEqual(['artifact:file', 'datastore:sqlite', 'memory:file'])

    // Each plugin's data dir was mkdir'd by Phase 2 of bootstrap.
    expect(existsSync(join(space.paths.services, 'memory', 'file'))).toBe(true)
    expect(existsSync(join(space.paths.services, 'artifact', 'file'))).toBe(true)
    expect(existsSync(join(space.paths.services, 'datastore', 'sqlite'))).toBe(true)

    // Exercise each handle to prove `attach` returned something live.
    const owner: Owner = { kind: 'agent', id: 'smoke' }

    const mem = (await boot.services.attach({
      type: 'memory', impl: 'file', owner, config: {},
    })).handle as MemoryHandle
    await mem.remember({ kind: 'episodic', text: 'hello' })
    expect((await mem.recall({ query: 'hello' })).map((e) => e.text)).toContain('hello')

    const art = (await boot.services.attach({
      type: 'artifact', impl: 'file', owner, config: {},
    })).handle as ArtifactHandle
    await art.write('notes/today.md', '# today\nhi')
    const got = await art.read('notes/today.md')
    expect(got.content).toContain('hi')
    expect(got.mime).toMatch(/^text\//)

    const ds = (await boot.services.attach({
      type: 'datastore', impl: 'sqlite', owner, config: { name: 'kv' },
    })).handle as DatastoreHandle
    await ds.kv.set('k', 'v')
    expect(await ds.kv.get('k')).toBe('v')

    await boot.services.shutdownAll()
  })
})
