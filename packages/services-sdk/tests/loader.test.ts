import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ServiceRegistry } from '../src/registry.js'
import { DEFAULT_FIRST_PARTY_PLUGINS, loadPlugins } from '../src/loader.js'
import type { ServicePlugin } from '../src/plugin.js'

// In-memory stub plugin factory for the import-resolver fake.
function makeStub(type: string, impl: string, version = '0.1.0'): ServicePlugin {
  const noop = async () => undefined
  return {
    type, impl, version,
    validateConfig: async () => ({}),
    init: noop,
    attach: async () => ({}),
    detach: noop,
    softDelete: async () => ({
      id: '0'.repeat(16), type, impl,
      ownerKind: 'agent', ownerId: 'a', deletedAt: 1, expiresAt: 2,
    }),
    restore: noop,
    hardDelete: noop,
    describe: async () => ({ sizeBytes: 0 }),
    shutdown: noop,
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'aipe-loader-'))
  const manifestPath = join(dir, 'plugins.json')
  return { dir, manifestPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('loadPlugins', () => {
  it('loads each manifest entry into the registry', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({
        plugins: ['memory-stub', 'artifact-stub'],
      }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const imports: Record<string, ServicePlugin> = {
        'memory-stub': makeStub('memory', 'file'),
        'artifact-stub': makeStub('artifact', 'file'),
      }
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async (pkg) => ({ default: imports[pkg] }),
      })
      expect(res.loaded).toHaveLength(2)
      expect(res.errors).toHaveLength(0)
      expect(registry.has('memory', 'file')).toBe(true)
      expect(registry.has('artifact', 'file')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('a failing import is non-fatal — other plugins still load', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({
        plugins: ['ok-pkg', 'broken-pkg', 'another-ok'],
      }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async (pkg) => {
          if (pkg === 'broken-pkg') throw new Error('ENOENT: no such package')
          if (pkg === 'ok-pkg') return { default: makeStub('memory', 'file') }
          if (pkg === 'another-ok') return { default: makeStub('artifact', 'file') }
          throw new Error('unknown pkg')
        },
      })
      expect(res.loaded).toHaveLength(2)
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]!.packageName).toBe('broken-pkg')
    } finally {
      await cleanup()
    }
  })

  it('rejects a module that does not export a valid ServicePlugin', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({ plugins: ['junk'] }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async () => ({ default: { lookLikeAPlugin: false } }),
      })
      expect(res.loaded).toHaveLength(0)
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]!.message).toMatch(/did not export a valid ServicePlugin/)
    } finally {
      await cleanup()
    }
  })

  it('accepts a default-export factory function', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({ plugins: ['fac'] }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async () => ({ default: () => makeStub('memory', 'file') }),
      })
      expect(res.loaded).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('skips entries with enabled: false', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({
        plugins: [
          'enabled-one',
          { package: 'disabled-one', enabled: false },
        ],
      }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async (pkg) => {
          if (pkg === 'enabled-one') return { default: makeStub('memory', 'file') }
          throw new Error('should not import disabled')
        },
      })
      expect(res.loaded).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('auto-seeds manifest with first-party plugins on first run', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      const registry = new ServiceRegistry({ hostMajor: 0 })
      // Importer fails because the real first-party packages don't
      // exist yet at this point in the rollout — we only care that
      // the manifest got written.
      await loadPlugins({
        manifestPath, registry, seedDefaults: true,
        importPackage: async () => { throw new Error('not yet built') },
      })
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.plugins).toEqual([...DEFAULT_FIRST_PARTY_PLUGINS])
    } finally {
      await cleanup()
    }
  })

  it('seedDefaults:false leaves the manifest absent', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const res = await loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async () => ({}),
      })
      expect(res.loaded).toHaveLength(0)
      expect(res.seeded).toBe(false)
      await expect(readFile(manifestPath, 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await cleanup()
    }
  })

  it('is idempotent — second run does not re-register', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({ plugins: ['p'] }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      const importPackage = async () => ({ default: makeStub('memory', 'file') })
      await loadPlugins({ manifestPath, registry, seedDefaults: false, importPackage })
      const res2 = await loadPlugins({ manifestPath, registry, seedDefaults: false, importPackage })
      expect(res2.loaded).toHaveLength(0)
      expect(registry.all()).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('rejects a malformed plugins.json (root not object)', async () => {
    const { dir, manifestPath, cleanup } = await setup()
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(manifestPath, JSON.stringify(['memory-stub']))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      await expect(loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async () => ({}),
      })).rejects.toThrow(/object/)
    } finally {
      await cleanup()
    }
  })

  it('rejects plugins.json with non-array "plugins"', async () => {
    const { manifestPath, cleanup } = await setup()
    try {
      await writeFile(manifestPath, JSON.stringify({ plugins: 'not-array' }))
      const registry = new ServiceRegistry({ hostMajor: 0 })
      await expect(loadPlugins({
        manifestPath, registry, seedDefaults: false,
        importPackage: async () => ({}),
      })).rejects.toThrow(/array/)
    } finally {
      await cleanup()
    }
  })
})
