import { describe, expect, it } from 'vitest'
import { ServiceConfigError } from '@gotong/services-sdk'
import { DEFAULT_MAX_BYTES, validateDatastoreSqliteConfig } from '../src/config.js'

describe('validateDatastoreSqliteConfig', () => {
  it('requires name', () => {
    expect(() => validateDatastoreSqliteConfig({})).toThrow(ServiceConfigError)
    expect(() => validateDatastoreSqliteConfig({ name: '' })).toThrow(/non-empty/)
  })

  it('honors name when provided', () => {
    expect(validateDatastoreSqliteConfig({ name: 'cases' }).name).toBe('cases')
  })

  it('rejects unsafe name characters', () => {
    expect(() => validateDatastoreSqliteConfig({ name: '../escape' })).toThrow(/must match/)
    expect(() => validateDatastoreSqliteConfig({ name: 'a/b' })).toThrow(/must match/)
    expect(() => validateDatastoreSqliteConfig({ name: 'a b' })).toThrow(/must match/)
  })

  it('default maxBytes is 50 MB', () => {
    expect(validateDatastoreSqliteConfig({ name: 'x' }).maxBytes).toBe(DEFAULT_MAX_BYTES)
  })

  it('honors maxBytes', () => {
    expect(validateDatastoreSqliteConfig({ name: 'x', maxBytes: 1024 }).maxBytes).toBe(1024)
  })

  it('rejects non-int / negative maxBytes', () => {
    expect(() => validateDatastoreSqliteConfig({ name: 'x', maxBytes: -1 })).toThrow(/positive/)
    expect(() => validateDatastoreSqliteConfig({ name: 'x', maxBytes: 0 })).toThrow(/positive/)
    expect(() => validateDatastoreSqliteConfig({ name: 'x', maxBytes: 1.5 })).toThrow(/positive/)
  })

  it('captures schema when present', () => {
    const cfg = validateDatastoreSqliteConfig({
      name: 'x',
      schema: 'CREATE TABLE foo(a TEXT);',
    })
    expect(cfg.schema).toMatch(/CREATE TABLE/)
  })

  it('rejects non-string schema', () => {
    expect(() => validateDatastoreSqliteConfig({ name: 'x', schema: 123 })).toThrow(/must be a string/)
  })

  it('rejects unknown keys', () => {
    expect(() => validateDatastoreSqliteConfig({ name: 'x', foo: 1 })).toThrow(/unknown config keys/)
  })

  it('tolerates a scope key', () => {
    // scope is consumed by the Hub before the plugin sees it; accept silently.
    const cfg = validateDatastoreSqliteConfig({ name: 'x', scope: 'private' })
    expect(cfg.name).toBe('x')
  })

  it('rejects non-object root', () => {
    expect(() => validateDatastoreSqliteConfig('hi')).toThrow(/must be an object/)
    expect(() => validateDatastoreSqliteConfig(null)).toThrow(/must be an object/)
    expect(() => validateDatastoreSqliteConfig([])).toThrow(/must be an object/)
  })
})
