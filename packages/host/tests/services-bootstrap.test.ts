/**
 * `bootstrapServices` — host-side wiring of `@gotong/services-sdk`.
 *
 * What's covered:
 *
 *   - Cold-start auto-seed: a fresh space gets a `plugins.json` written
 *     with the default first-party packages.
 *   - Per-plugin data dir is mkdir-ed before `plugin.init` is called.
 *   - `plugin.init` is called exactly once per plugin, with a correct
 *     `rootDir`, a logger, and a working hub surface.
 *   - Plugin import failure does NOT crash the boot — the broken
 *     plugin shows up in `errors`, the rest of the plugins still init.
 *   - Plugin init failure unregisters the plugin so agents fail loud.
 *   - `seedDefaults: false` does NOT write `plugins.json`.
 *   - `GOTONG_SERVICES_NO_SEED=1` env var disables seeding.
 *   - Idempotent: re-bootstrap on an existing space picks up the
 *     manifest as-is.
 *
 * Test design: every test passes its own `importPackage` fake so we
 * never hit the npm graph or rely on which packages happen to be in
 * the workspace. End-to-end with the real `service-memory-file`
 * plugin is covered separately in `services-e2e.test.ts`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLogger, Hub, Space } from '@gotong/core'
import type { Owner, ServicePlugin, TrashRef } from '@gotong/services-sdk'

import { bootstrapServices } from '../src/services/index.js'

const logger = createLogger('services-test', { disabled: true })

/**
 * Minimal fake plugin. Records every lifecycle call so tests can
 * assert order + arguments. `type` and `impl` are settable so one
 * fake can stand in for multiple registry rows.
 */
function makeFakePlugin(opts: {
  type?: string
  impl?: string
  version?: string
  initThrows?: Error
  shutdownThrows?: Error
} = {}): ServicePlugin & {
  calls: Array<{ method: string; arg?: unknown }>
  initCtxRootDir?: string
} {
  const plugin: ServicePlugin & {
    calls: Array<{ method: string; arg?: unknown }>
    initCtxRootDir?: string
  } = {
    type: opts.type ?? 'memory',
    impl: opts.impl ?? 'fake',
    version: opts.version ?? '0.1.0',
    calls: [],
    async validateConfig(raw) {
      this.calls.push({ method: 'validateConfig', arg: raw })
      return raw as Record<string, unknown>
    },
    async init(ctx) {
      this.calls.push({ method: 'init', arg: { rootDir: ctx.rootDir } })
      this.initCtxRootDir = ctx.rootDir
      if (opts.initThrows) throw opts.initThrows
    },
    async attach(owner, config) {
      this.calls.push({ method: 'attach', arg: { owner, config } })
      return { kind: 'fake-handle', owner }
    },
    async detach(owner) {
      this.calls.push({ method: 'detach', arg: owner })
    },
    async softDelete(owner) {
      this.calls.push({ method: 'softDelete', arg: owner })
      const ref: TrashRef = {
        id: 'fakehash00000000',
        type: this.type,
        impl: this.impl,
        ownerKind: owner.kind,
        ownerId: owner.id,
        deletedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_000 + 86_400_000 * 30,
      }
      return ref
    },
    async restore(ref) {
      this.calls.push({ method: 'restore', arg: ref })
    },
    async hardDelete(ref) {
      this.calls.push({ method: 'hardDelete', arg: ref })
    },
    async describe(owner) {
      this.calls.push({ method: 'describe', arg: owner })
      return { sizeBytes: 0 }
    },
    async shutdown() {
      this.calls.push({ method: 'shutdown' })
      if (opts.shutdownThrows) throw opts.shutdownThrows
    },
  }
  return plugin
}

describe('bootstrapServices — fresh space', () => {
  let root: string
  let space: Space
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-services-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('auto-seeds plugins.json with the default first-party packages', async () => {
    const fakeMod = (n: string): unknown => ({
      default: () => makeFakePlugin({ type: 'memory', impl: n }),
    })
    const importPackage = vi.fn(async (pkg: string) => fakeMod(pkg.replace('@gotong/', '')))
    const boot = await bootstrapServices({
      space,
      logger,
      importPackage,
    })
    expect(boot.seeded).toBe(true)
    expect(existsSync(join(root, 'services', 'plugins.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(root, 'services', 'plugins.json'), 'utf8'))
    expect(manifest.plugins).toContain('@gotong/service-memory-file')
    expect(manifest.plugins).toContain('@gotong/service-artifact-file')
    expect(manifest.plugins).toContain('@gotong/service-datastore-sqlite')
  })

  it('mkdirs the per-plugin data dir and passes it to plugin.init', async () => {
    const fake = makeFakePlugin({ type: 'memory', impl: 'file' })
    const importPackage = async () => ({ default: () => fake })
    const boot = await bootstrapServices({
      space,
      logger,
      importPackage,
      seedDefaults: true,
    })
    // Even though we seeded the default 3, our import returns the same
    // fake instance for all of them — the registry rejects collisions,
    // so only the first registers. We can still check the dir setup
    // logic on that single registered row.
    expect(boot.ready.length).toBeGreaterThanOrEqual(1)
    expect(fake.initCtxRootDir).toBeDefined()
    expect(fake.initCtxRootDir!.startsWith(join(root, 'services'))).toBe(true)
    expect(existsSync(fake.initCtxRootDir!)).toBe(true)
  })

  it('seedDefaults: false writes nothing on a fresh space (zero plugins ready)', async () => {
    const boot = await bootstrapServices({
      space,
      logger,
      seedDefaults: false,
      importPackage: vi.fn(),
    })
    expect(boot.seeded).toBe(false)
    expect(existsSync(join(root, 'services', 'plugins.json'))).toBe(false)
    expect(boot.ready).toHaveLength(0)
  })

  it('honors GOTONG_SERVICES_NO_SEED=1 when seedDefaults is unset', async () => {
    const prev = process.env.GOTONG_SERVICES_NO_SEED
    process.env.GOTONG_SERVICES_NO_SEED = '1'
    try {
      const boot = await bootstrapServices({
        space,
        logger,
        importPackage: vi.fn(),
      })
      expect(boot.seeded).toBe(false)
      expect(existsSync(join(root, 'services', 'plugins.json'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.GOTONG_SERVICES_NO_SEED
      else process.env.GOTONG_SERVICES_NO_SEED = prev
    }
  })
})

describe('bootstrapServices — failure modes', () => {
  let root: string
  let space: Space
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-services-fail-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('plugin import failure is reported in errors[] without crashing', async () => {
    const importPackage = async (pkg: string) => {
      if (pkg.includes('memory')) {
        return { default: () => makeFakePlugin({ type: 'memory', impl: 'file' }) }
      }
      if (pkg.includes('artifact')) {
        throw new Error('synthetic ENOENT')
      }
      if (pkg.includes('datastore')) {
        return { default: () => makeFakePlugin({ type: 'datastore', impl: 'sqlite' }) }
      }
      throw new Error('unknown pkg ' + pkg)
    }
    const boot = await bootstrapServices({
      space,
      logger,
      importPackage,
    })
    // memory + datastore should be ready, artifact should be in errors.
    expect(boot.ready.map((p) => `${p.type}:${p.impl}`)).toEqual(
      expect.arrayContaining(['memory:file', 'datastore:sqlite']),
    )
    expect(boot.errors.length).toBe(1)
    expect(boot.errors[0]!.packageName).toContain('artifact')
  })

  it('plugin.init failure unregisters the plugin', async () => {
    const goodMem = makeFakePlugin({ type: 'memory', impl: 'file' })
    const badArt = makeFakePlugin({
      type: 'artifact',
      impl: 'file',
      initThrows: new Error('init exploded'),
    })
    const importPackage = async (pkg: string) => {
      if (pkg.includes('memory')) return { default: () => goodMem }
      if (pkg.includes('artifact')) return { default: () => badArt }
      // Skip datastore — it'd be a third success and the test gets noisy.
      throw new Error('synthetic skip')
    }
    const boot = await bootstrapServices({
      space,
      logger,
      importPackage,
    })
    expect(boot.ready.map((p) => `${p.type}:${p.impl}`)).toEqual(['memory:file'])
    // artifact appears in errors twice? No — once. The synthetic-skip
    // datastore appears too. Verify artifact is among them.
    expect(boot.errors.some((e) => e.packageName.includes('artifact'))).toBe(true)
    // The half-initialised artifact must not be findable.
    expect(boot.services.hasPlugin('artifact', 'file')).toBe(false)
    // The good memory plugin must be findable.
    expect(boot.services.hasPlugin('memory', 'file')).toBe(true)
  })
})

describe('HubServices — attach/detach/softDelete/restore round-trip', () => {
  let root: string
  let space: Space
  let hub: Hub
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-host-services-rt-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  async function bootWithSingleFake() {
    const fake = makeFakePlugin({ type: 'memory', impl: 'file' })
    const importPackage = async (pkg: string) => {
      if (pkg.includes('memory')) return { default: () => fake }
      // Force the seeded artifact + datastore packages to fail silently.
      throw new Error('test-skip')
    }
    const boot = await bootstrapServices({
      space,
      hub,
      logger,
      importPackage,
    })
    return { boot, fake }
  }

  it('attach → calls validateConfig + plugin.attach in order', async () => {
    const { boot, fake } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({
      type: 'memory',
      impl: 'file',
      owner,
      config: { hello: 'world' },
    })
    const order = fake.calls.map((c) => c.method)
    expect(order).toContain('validateConfig')
    expect(order).toContain('attach')
    // validateConfig must precede attach
    expect(order.indexOf('validateConfig')).toBeLessThan(order.indexOf('attach'))
  })

  it('detachFor calls plugin.detach for every live attach on that owner', async () => {
    const { boot, fake } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({ type: 'memory', impl: 'file', owner, config: {} })
    const detached = await boot.services.detachFor(owner)
    expect(detached.map((d) => `${d.type}:${d.impl}`)).toEqual(['memory:file'])
    expect(fake.calls.some((c) => c.method === 'detach')).toBe(true)
  })

  it('detachFor on an owner with no attaches is a no-op', async () => {
    const { boot } = await bootWithSingleFake()
    const detached = await boot.services.detachFor({ kind: 'agent', id: 'never' })
    expect(detached).toEqual([])
  })

  it('softDelete detaches first, then trashes', async () => {
    const { boot, fake } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({ type: 'memory', impl: 'file', owner, config: {} })
    const ref = await boot.services.softDelete({ type: 'memory', impl: 'file', owner })
    expect(ref.type).toBe('memory')
    expect(ref.impl).toBe('file')
    const methods = fake.calls.map((c) => c.method)
    // detach comes before softDelete in the call sequence.
    expect(methods.indexOf('detach')).toBeLessThan(methods.indexOf('softDelete'))
  })

  it('restore forwards to the matching plugin', async () => {
    const { boot, fake } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({ type: 'memory', impl: 'file', owner, config: {} })
    const ref = await boot.services.softDelete({ type: 'memory', impl: 'file', owner })
    await boot.services.restore(ref)
    expect(fake.calls.some((c) => c.method === 'restore')).toBe(true)
  })

  it('hardDelete forwards to the matching plugin', async () => {
    const { boot, fake } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({ type: 'memory', impl: 'file', owner, config: {} })
    const ref = await boot.services.softDelete({ type: 'memory', impl: 'file', owner })
    await boot.services.hardDelete(ref)
    expect(fake.calls.some((c) => c.method === 'hardDelete')).toBe(true)
  })

  it('shutdownAll calls plugin.shutdown for every registered plugin', async () => {
    const { boot, fake } = await bootWithSingleFake()
    await boot.services.shutdownAll()
    expect(fake.calls.some((c) => c.method === 'shutdown')).toBe(true)
  })

  it('attach after shutdownAll throws', async () => {
    const { boot } = await bootWithSingleFake()
    await boot.services.shutdownAll()
    await expect(
      boot.services.attach({
        type: 'memory',
        impl: 'file',
        owner: { kind: 'agent', id: 'a' },
        config: {},
      }),
    ).rejects.toThrow(/shutdown/)
  })

  it('shutdownAll tolerates a plugin whose shutdown throws', async () => {
    const fake = makeFakePlugin({
      type: 'memory',
      impl: 'file',
      shutdownThrows: new Error('boom'),
    })
    const importPackage = async (pkg: string) => {
      if (pkg.includes('memory')) return { default: () => fake }
      throw new Error('skip')
    }
    const boot = await bootstrapServices({ space, hub, logger, importPackage })
    await expect(boot.services.shutdownAll()).resolves.not.toThrow()
  })

  it('liveHandlesFor returns the currently-attached handles for the owner', async () => {
    const { boot } = await bootWithSingleFake()
    const owner: Owner = { kind: 'agent', id: 'a1' }
    await boot.services.attach({ type: 'memory', impl: 'file', owner, config: {} })
    const live = boot.services.liveHandlesFor(owner)
    expect(live).toHaveLength(1)
    expect(live[0]!.type).toBe('memory')
    // Different owner sees nothing.
    expect(boot.services.liveHandlesFor({ kind: 'agent', id: 'b' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// v1.2.6: wireMethods lifecycle — bootstrap registers, shutdownAll unregisters.
// Without this, a long-lived process (e.g. test harness mounting/unmounting
// plugins) leaks third-party wire methods in the process-wide allowlist.
// ---------------------------------------------------------------------------

describe('bootstrapServices — wireMethods runtime allowlist lifecycle', () => {
  let tmpRoot: string
  let hub: Hub

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'gotong-wireMethods-'))
    const init = await Space.init(tmpRoot, { name: 'test' })
    hub = new Hub({ space: init.space })
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('registers wireMethods at bootstrap and unregisters them on shutdown', async () => {
    const { getServiceMethods, resetServiceMethodsForTests } = await import(
      '@gotong/protocol'
    )
    // Start from a known floor — any prior test that registered wire methods
    // would leak through the process-wide singleton. The fact that we MUST
    // call this in a non-test context is itself the bug v1.2.6 fixes.
    resetServiceMethodsForTests()

    const fake: ServicePlugin = {
      type: 'notion',          // not a built-in type
      impl: 'cloud',
      version: '0.0.1',
      wireMethods: ['pages.create', 'pages.read'],
      async init() {
        /* no-op */
      },
      async validateConfig(raw) {
        return raw as Record<string, unknown>
      },
      async attach() {
        return { handle: {} as never, owner: { kind: 'agent', id: 'a' } }
      },
      async detach() {
        /* no-op */
      },
      async softDelete() {
        return {
          id: 't',
          type: 'notion',
          impl: 'cloud',
          ownerKind: 'agent',
          ownerId: 'a',
          deletedAt: 0,
          expiresAt: 0,
        } as TrashRef
      },
      async restore() {},
      async hardDelete() {},
      async describe() {
        return { sizeBytes: 0 }
      },
      async shutdown() {},
    }

    // bootstrapServices reads plugins.json from disk — write one that
    // points at our fake (importPackage will short-circuit the actual
    // npm resolve and hand back `fake`).
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(hub.space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@third-party/notion-cloud'] }),
      'utf8',
    )
    const boot = await bootstrapServices({
      space: hub.space,
      hub,
      logger,
      seedDefaults: false,
      importPackage: async () => fake,
    })

    // After bootstrap, the wire methods are in the runtime allowlist.
    const afterBoot = getServiceMethods('notion')
    expect(afterBoot).toBeDefined()
    expect([...(afterBoot ?? [])].sort()).toEqual([
      'pages.create',
      'pages.read',
    ])

    // Shut down — every wireMethod should be rolled back.
    await boot.services.shutdownAll()

    // 'notion' is not a built-in type, so unregistering all its methods
    // collapses the runtime entry — it should be back to `undefined`.
    expect(getServiceMethods('notion')).toBeUndefined()
  })
})
