import { describe, expect, it } from 'vitest'
import { validateMemoryFileConfig } from '../src/config.js'
import { ServiceConfigError } from '@aipehub/services-sdk'

describe('validateMemoryFileConfig', () => {
  it('accepts empty config — defaults all three kinds', () => {
    const cfg = validateMemoryFileConfig({})
    expect(cfg.kinds).toEqual(['episodic', 'semantic', 'working'])
    expect(cfg.maxEpisodicBytes).toBeUndefined()
    expect(cfg.maxSemanticBytes).toBeUndefined()
  })

  it('accepts undefined / null as empty', () => {
    expect(validateMemoryFileConfig(undefined).kinds).toEqual(['episodic', 'semantic', 'working'])
    expect(validateMemoryFileConfig(null).kinds).toEqual(['episodic', 'semantic', 'working'])
  })

  it('honors kinds when provided', () => {
    const cfg = validateMemoryFileConfig({ kinds: ['episodic'] })
    expect(cfg.kinds).toEqual(['episodic'])
  })

  it('deduplicates kinds while preserving order', () => {
    const cfg = validateMemoryFileConfig({ kinds: ['semantic', 'episodic', 'semantic'] })
    expect(cfg.kinds).toEqual(['semantic', 'episodic'])
  })

  it('rejects unknown kind', () => {
    expect(() => validateMemoryFileConfig({ kinds: ['weird'] })).toThrow(ServiceConfigError)
  })

  it('rejects empty kinds array', () => {
    expect(() => validateMemoryFileConfig({ kinds: [] })).toThrow(/must not be empty/)
  })

  it('rejects non-array kinds', () => {
    expect(() => validateMemoryFileConfig({ kinds: 'episodic' })).toThrow(/must be an array/)
  })

  it('accepts a positive int maxEpisodicBytes', () => {
    const cfg = validateMemoryFileConfig({ maxEpisodicBytes: 4_194_304 })
    expect(cfg.maxEpisodicBytes).toBe(4_194_304)
  })

  it('rejects negative maxEpisodicBytes', () => {
    expect(() => validateMemoryFileConfig({ maxEpisodicBytes: -1 })).toThrow(/positive/)
  })

  it('rejects zero maxEpisodicBytes', () => {
    expect(() => validateMemoryFileConfig({ maxEpisodicBytes: 0 })).toThrow(/positive/)
  })

  it('rejects non-integer maxEpisodicBytes', () => {
    expect(() => validateMemoryFileConfig({ maxEpisodicBytes: 1.5 })).toThrow(/positive/)
  })

  it('rejects unknown keys', () => {
    expect(() => validateMemoryFileConfig({ kinds: ['episodic'], weird: 1 })).toThrow(/unknown config keys/)
  })

  it('tolerates a scope key (the registry strips it elsewhere)', () => {
    // The registry resolves scope before the plugin sees it, but tools
    // sometimes pass the raw yaml through verbatim. Accept-and-ignore
    // rather than fail loud — matches what other yaml validators do.
    const cfg = validateMemoryFileConfig({ kinds: ['episodic'], scope: 'private' })
    expect(cfg.kinds).toEqual(['episodic'])
  })

  it('rejects non-object root', () => {
    expect(() => validateMemoryFileConfig('not-an-object')).toThrow(/must be an object/)
  })
})
