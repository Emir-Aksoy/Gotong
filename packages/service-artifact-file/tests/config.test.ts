import { describe, expect, it } from 'vitest'
import { mimeAllowed, validateArtifactFileConfig } from '../src/config.js'
import { ServiceConfigError } from '@aipehub/services-sdk'

describe('validateArtifactFileConfig', () => {
  it('accepts empty config — defaults', () => {
    const cfg = validateArtifactFileConfig({})
    expect(cfg.name).toBe('default')
    expect(cfg.maxBytesPerFile).toBe(10 * 1024 * 1024)
    expect([...cfg.allowedMimePrefixes]).toEqual(['text/', 'application/'])
  })

  it('honors name when provided', () => {
    expect(validateArtifactFileConfig({ name: 'reports' }).name).toBe('reports')
  })

  it('rejects empty name', () => {
    expect(() => validateArtifactFileConfig({ name: '' })).toThrow(ServiceConfigError)
  })

  it('rejects non-string name', () => {
    expect(() => validateArtifactFileConfig({ name: 7 })).toThrow(ServiceConfigError)
  })

  it('honors maxBytesPerFile', () => {
    expect(validateArtifactFileConfig({ maxBytesPerFile: 1024 }).maxBytesPerFile).toBe(1024)
  })

  it('rejects non-int / negative maxBytesPerFile', () => {
    expect(() => validateArtifactFileConfig({ maxBytesPerFile: -1 })).toThrow(/positive/)
    expect(() => validateArtifactFileConfig({ maxBytesPerFile: 0 })).toThrow(/positive/)
    expect(() => validateArtifactFileConfig({ maxBytesPerFile: 1.5 })).toThrow(/positive/)
  })

  it('honors allowedMimePrefixes', () => {
    const cfg = validateArtifactFileConfig({ allowedMimePrefixes: ['image/'] })
    expect([...cfg.allowedMimePrefixes]).toEqual(['image/'])
  })

  it('rejects empty allowedMimePrefixes array', () => {
    expect(() => validateArtifactFileConfig({ allowedMimePrefixes: [] }))
      .toThrow(/must not be empty/)
  })

  it('rejects non-array allowedMimePrefixes', () => {
    expect(() => validateArtifactFileConfig({ allowedMimePrefixes: 'text/' }))
      .toThrow(/must be an array/)
  })

  it('rejects empty-string prefix entry', () => {
    expect(() => validateArtifactFileConfig({ allowedMimePrefixes: [''] }))
      .toThrow(/non-empty/)
  })

  it('rejects unknown keys', () => {
    expect(() => validateArtifactFileConfig({ foo: 1 })).toThrow(/unknown config keys/)
  })

  it('tolerates a scope key', () => {
    const cfg = validateArtifactFileConfig({ scope: 'private', name: 'x' })
    expect(cfg.name).toBe('x')
  })

  it('rejects non-object root', () => {
    expect(() => validateArtifactFileConfig('hi')).toThrow(/must be an object/)
  })
})

describe('mimeAllowed', () => {
  it('matches by prefix', () => {
    expect(mimeAllowed('text/markdown', ['text/'])).toBe(true)
    expect(mimeAllowed('text/markdown', ['image/'])).toBe(false)
  })

  it("wildcard '*' allows anything", () => {
    expect(mimeAllowed('anything/here', ['*'])).toBe(true)
  })

  it('multiple prefixes — any match', () => {
    expect(mimeAllowed('image/png', ['text/', 'image/'])).toBe(true)
  })
})
