/**
 * Pin down the version-shape constants + method-allowlist runtime API.
 * `majorVersionOf` is on every WELCOME / HELLO path; the
 * `registerServiceMethods` / `getServiceMethods` pair is the contract
 * third-party plugins use to extend the wire surface.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  AWAIT_APPROVAL_TIMEOUT_MS,
  BUILTIN_SERVICE_METHODS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SERVICE_CALL_TIMEOUT_MS,
  getServiceMethods,
  HELLO_TIMEOUT_MS,
  isServiceMethodAllowed,
  majorVersionOf,
  MAX_MISSED_PINGS,
  PROTOCOL_VERSION,
  registerServiceMethods,
  resetServiceMethodsForTests,
  unregisterServiceMethods,
} from '../src/index.js'

afterEach(() => {
  // Each test mutates the runtime allowlist. Reset to built-ins so the
  // next test starts clean.
  resetServiceMethodsForTests()
})

describe('PROTOCOL_VERSION + timing constants', () => {
  it('PROTOCOL_VERSION matches semver dotted form (M.m)', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/)
  })

  it('heartbeat / hello / approval / max-missed pings have sensible bounds', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
    expect(HELLO_TIMEOUT_MS).toBeGreaterThan(0)
    expect(AWAIT_APPROVAL_TIMEOUT_MS).toBeGreaterThan(HELLO_TIMEOUT_MS)
    expect(MAX_MISSED_PINGS).toBeGreaterThan(0)
    expect(DEFAULT_SERVICE_CALL_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('majorVersionOf', () => {
  it('extracts the integer prefix from dotted versions', () => {
    expect(majorVersionOf('1.0')).toBe(1)
    expect(majorVersionOf('1.2')).toBe(1)
    expect(majorVersionOf('2.0.5')).toBe(2)
    expect(majorVersionOf('42.99.99-pre.1')).toBe(42)
  })

  it('returns -1 on unparseable input (the canary for bad HELLOs)', () => {
    // Used by the server to reject malformed version strings without
    // throwing. -1 is the documented sentinel so any comparison `===` to
    // a real major returns false.
    expect(majorVersionOf('')).toBe(-1)
    expect(majorVersionOf('abc')).toBe(-1)
    expect(majorVersionOf('.5')).toBe(-1)
  })
})

describe('BUILTIN_SERVICE_METHODS', () => {
  it('covers the three first-party services', () => {
    expect(Object.keys(BUILTIN_SERVICE_METHODS).sort()).toEqual(
      ['artifact', 'datastore', 'memory'],
    )
  })

  it('memory exposes recall/remember/list/forget/clear', () => {
    expect(BUILTIN_SERVICE_METHODS.memory).toEqual(
      ['recall', 'remember', 'list', 'forget', 'clear'],
    )
  })

  it('datastore exposes both kv.* and sql.* nested methods', () => {
    const methods = BUILTIN_SERVICE_METHODS.datastore ?? []
    expect(methods).toContain('kv.get')
    expect(methods).toContain('kv.set')
    expect(methods).toContain('sql.exec')
    expect(methods).toContain('sql.query')
  })
})

describe('isServiceMethodAllowed / getServiceMethods — built-ins', () => {
  it('returns true for built-ins out of the box', () => {
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
    expect(isServiceMethodAllowed('artifact', 'write')).toBe(true)
    expect(isServiceMethodAllowed('datastore', 'sql.query')).toBe(true)
  })

  it('returns false for unknown methods on a known type', () => {
    expect(isServiceMethodAllowed('memory', 'forge')).toBe(false)
    expect(isServiceMethodAllowed('memory', '')).toBe(false)
  })

  it('returns false for unknown type entirely', () => {
    expect(isServiceMethodAllowed('notion', 'pages.read')).toBe(false)
    expect(getServiceMethods('notion')).toBeUndefined()
  })
})

describe('registerServiceMethods', () => {
  it('adds a new type + methods so the router can dispatch them', () => {
    expect(isServiceMethodAllowed('notion', 'pages.read')).toBe(false)
    registerServiceMethods('notion', ['pages.read', 'pages.create'])
    expect(isServiceMethodAllowed('notion', 'pages.read')).toBe(true)
    expect(isServiceMethodAllowed('notion', 'pages.create')).toBe(true)
    expect(isServiceMethodAllowed('notion', 'pages.delete')).toBe(false)
  })

  it('extending a built-in type unions with the built-in set', () => {
    registerServiceMethods('memory', ['summary'])
    // Built-in still allowed.
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
    // Extension also allowed.
    expect(isServiceMethodAllowed('memory', 'summary')).toBe(true)
  })

  it('is idempotent — registering the same method twice is fine', () => {
    registerServiceMethods('notion', ['pages.read'])
    registerServiceMethods('notion', ['pages.read'])
    expect(getServiceMethods('notion')?.size).toBe(1)
  })

  it('refuses dotted paths deeper than one level', () => {
    // Router can't reach `a.b.c` — failing at registration time is the
    // helpful path so plugin authors learn early.
    expect(() => registerServiceMethods('x', ['a.b.c'])).toThrow(/more than one dot/)
  })

  it('rejects non-string type / non-array methods', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => registerServiceMethods('', ['x'])).toThrow(/non-empty string/)
    // @ts-expect-error — testing runtime guard
    expect(() => registerServiceMethods('x', 'x')).toThrow(/methods must be an array/)
  })

  it('skips empty / non-string entries silently', () => {
    // @ts-expect-error — testing runtime guard
    registerServiceMethods('weird', ['', null, undefined, 'okay'])
    expect(getServiceMethods('weird')?.has('okay')).toBe(true)
    expect(getServiceMethods('weird')?.size).toBe(1)
  })
})

describe('unregisterServiceMethods', () => {
  it('removes a registered third-party method', () => {
    registerServiceMethods('notion', ['pages.read', 'pages.create'])
    unregisterServiceMethods('notion', ['pages.create'])
    expect(isServiceMethodAllowed('notion', 'pages.read')).toBe(true)
    expect(isServiceMethodAllowed('notion', 'pages.create')).toBe(false)
  })

  it('refuses to drop built-in methods (the floor is immutable)', () => {
    unregisterServiceMethods('memory', ['recall'])
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
  })

  it('collapses to the built-in snapshot when only extras are removed', () => {
    registerServiceMethods('memory', ['summary'])
    expect(getServiceMethods('memory')?.has('summary')).toBe(true)
    unregisterServiceMethods('memory', ['summary'])
    // Back to just built-ins.
    expect(getServiceMethods('memory')?.has('summary')).toBe(false)
    expect(getServiceMethods('memory')?.has('recall')).toBe(true)
  })

  it('drops the type entirely when no built-ins exist', () => {
    registerServiceMethods('notion', ['pages.read'])
    unregisterServiceMethods('notion', ['pages.read'])
    expect(getServiceMethods('notion')).toBeUndefined()
  })

  it('is a no-op on unknown type', () => {
    // Unlike register, "delete nothing" is fine.
    expect(() => unregisterServiceMethods('ghost', ['x'])).not.toThrow()
  })

  it('rejects bad inputs the same way register does', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => unregisterServiceMethods('', ['x'])).toThrow(/non-empty string/)
    // @ts-expect-error — testing runtime guard
    expect(() => unregisterServiceMethods('memory', 'x')).toThrow(/methods must be an array/)
  })
})

describe('resetServiceMethodsForTests', () => {
  it('restores built-ins after mutation', () => {
    registerServiceMethods('notion', ['pages.read'])
    expect(isServiceMethodAllowed('notion', 'pages.read')).toBe(true)
    resetServiceMethodsForTests()
    expect(getServiceMethods('notion')).toBeUndefined()
    // Built-ins still present.
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
  })
})
