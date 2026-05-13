import { describe, expect, it } from 'vitest'
import { ServiceRegistry } from '../src/registry.js'
import {
  PluginConflictError,
  PluginNotFoundError,
  PluginVersionMismatchError,
} from '../src/errors.js'
import type { ServicePlugin } from '../src/plugin.js'

// Minimal stub plugin — every method is a no-op. The registry only
// inspects type/impl/version, so the rest can stay unimplemented.
function makePlugin(over: Partial<ServicePlugin> = {}): ServicePlugin {
  const noop = async () => undefined
  return {
    type: 'memory',
    impl: 'file',
    version: '0.1.0',
    validateConfig: async () => ({}),
    init: noop,
    attach: async () => ({}),
    detach: noop,
    softDelete: async () => ({
      id: 'x'.repeat(16), type: 'memory', impl: 'file',
      ownerKind: 'agent', ownerId: 'a', deletedAt: 1, expiresAt: 2,
    }),
    restore: noop,
    hardDelete: noop,
    describe: async () => ({ sizeBytes: 0 }),
    shutdown: noop,
    ...over,
  }
}

describe('ServiceRegistry.register', () => {
  it('registers a fresh plugin', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    const p = makePlugin()
    reg.register(p)
    expect(reg.find('memory', 'file')).toBe(p)
  })

  it('rejects duplicate (type, impl)', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin())
    expect(() => reg.register(makePlugin())).toThrow(PluginConflictError)
  })

  it('rejects major mismatch', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    const p = makePlugin({ version: '1.0.0' })
    expect(() => reg.register(p)).toThrow(PluginVersionMismatchError)
  })

  it('allows different impls under the same type', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin({ type: 'memory', impl: 'file' }))
    reg.register(makePlugin({ type: 'memory', impl: 'sqlite' }))
    expect(reg.all()).toHaveLength(2)
  })

  it('allows the same impl name under different types', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin({ type: 'memory', impl: 'file' }))
    reg.register(makePlugin({ type: 'artifact', impl: 'file' }))
    expect(reg.all()).toHaveLength(2)
  })
})

describe('ServiceRegistry.find', () => {
  it('throws PluginNotFoundError on miss', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    expect(() => reg.find('memory', 'nope')).toThrow(PluginNotFoundError)
  })

  it('findOrUndefined returns undefined on miss', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    expect(reg.findOrUndefined('memory', 'nope')).toBeUndefined()
  })
})

describe('ServiceRegistry.unregister', () => {
  it('removes a registered plugin', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin())
    reg.unregister('memory', 'file')
    expect(reg.has('memory', 'file')).toBe(false)
  })

  it('is a no-op on unknown key', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    expect(() => reg.unregister('memory', 'never')).not.toThrow()
  })
})

describe('ServiceRegistry.markInitialized', () => {
  it('tracks init state per (type, impl)', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin())
    expect(reg.isInitialized('memory', 'file')).toBe(false)
    reg.markInitialized('memory', 'file')
    expect(reg.isInitialized('memory', 'file')).toBe(true)
  })

  it('markAllShuttingDown flips init back', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin())
    reg.markInitialized('memory', 'file')
    reg.markAllShuttingDown()
    expect(reg.isInitialized('memory', 'file')).toBe(false)
  })
})

describe('ServiceRegistry.byType', () => {
  it('groups by type', () => {
    const reg = new ServiceRegistry({ hostMajor: 0 })
    reg.register(makePlugin({ type: 'memory', impl: 'file' }))
    reg.register(makePlugin({ type: 'memory', impl: 'sqlite' }))
    reg.register(makePlugin({ type: 'artifact', impl: 'file' }))
    const by = reg.byType()
    expect(by.get('memory')).toHaveLength(2)
    expect(by.get('artifact')).toHaveLength(1)
  })
})
