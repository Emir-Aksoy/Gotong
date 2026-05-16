/**
 * Tests for the third-party service-type allowlist extension hook
 * (`registerServiceMethods` from `@aipehub/protocol`).
 *
 * Validates:
 *   1. Registration is set-merge (idempotent, never destructive).
 *   2. Built-in methods survive any registration.
 *   3. Rejected shapes (deep paths, empty strings) fail cleanly.
 *   4. `ServiceCallRouter` consults the runtime allowlist — a freshly
 *      registered third-party method dispatches; an unregistered one
 *      returns `unknown_method`.
 *
 * Each test calls `resetServiceMethodsForTests()` first because the
 * allowlist is a process-wide singleton: leaking state between tests
 * would hide regressions where a stray `registerServiceMethods` in one
 * test makes another test pass for the wrong reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BUILTIN_SERVICE_METHODS,
  getServiceMethods,
  isServiceMethodAllowed,
  registerServiceMethods,
  resetServiceMethodsForTests,
  unregisterServiceMethods,
  type ServiceCallFrame,
  type ServiceOwner,
  type ServiceUseDecl,
} from '@aipehub/protocol'

import { ServiceCallRouter } from '../src/service-call-router.js'
import type { ServiceCallGateway } from '../src/server.js'

beforeEach(() => {
  resetServiceMethodsForTests()
})
afterEach(() => {
  resetServiceMethodsForTests()
})

describe('registerServiceMethods (protocol)', () => {
  it('starts with exactly the built-ins', () => {
    expect([...(getServiceMethods('memory') ?? [])]).toEqual(
      expect.arrayContaining([...BUILTIN_SERVICE_METHODS.memory!]),
    )
    expect(getServiceMethods('notion')).toBeUndefined()
    expect(isServiceMethodAllowed('notion', 'pages.create')).toBe(false)
  })

  it('adds a third-party type without touching built-ins', () => {
    registerServiceMethods('notion', ['pages.create', 'pages.read'])
    expect([...(getServiceMethods('notion') ?? [])]).toEqual(
      expect.arrayContaining(['pages.create', 'pages.read']),
    )
    // Built-ins untouched.
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
    expect(isServiceMethodAllowed('artifact', 'write')).toBe(true)
  })

  it('is set-merge — re-registering the same method is a no-op', () => {
    registerServiceMethods('notion', ['pages.create'])
    registerServiceMethods('notion', ['pages.create'])
    const set = getServiceMethods('notion')
    expect(set?.size).toBe(1)
  })

  it('extending a built-in type adds but does not remove anything', () => {
    // Hypothetical plugin that adds `'export'` to the memory type.
    registerServiceMethods('memory', ['export'])
    // Built-in `recall` still allowed.
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
    // New method allowed.
    expect(isServiceMethodAllowed('memory', 'export')).toBe(true)
  })

  it('rejects paths with more than one dot', () => {
    expect(() =>
      registerServiceMethods('weird', ['a.b.c']),
    ).toThrow(/more than one dot/)
  })

  it('rejects non-array methods and empty type', () => {
    // @ts-expect-error testing runtime guard
    expect(() => registerServiceMethods('x', null)).toThrow(/array/)
    expect(() => registerServiceMethods('', ['a'])).toThrow(/non-empty/)
  })

  it('skips empty / non-string entries silently', () => {
    registerServiceMethods('notion', [
      'pages.read',
      // @ts-expect-error testing runtime guard
      null,
      '',
      // @ts-expect-error testing runtime guard
      42,
    ])
    const set = getServiceMethods('notion')
    expect([...set!]).toEqual(['pages.read'])
  })

  it('unregisterServiceMethods removes only the named third-party methods', () => {
    registerServiceMethods('notion', ['pages.create', 'pages.read'])
    expect([...(getServiceMethods('notion') ?? [])].sort()).toEqual([
      'pages.create',
      'pages.read',
    ])
    unregisterServiceMethods('notion', ['pages.create'])
    expect([...(getServiceMethods('notion') ?? [])]).toEqual(['pages.read'])
  })

  it('unregisterServiceMethods will NOT remove built-in methods', () => {
    // memory:recall is a built-in. Even an explicit unregister call must
    // leave it in place — the built-in set is the floor.
    unregisterServiceMethods('memory', ['recall'])
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
  })

  it('unregisterServiceMethods collapses entry when only built-ins remain', () => {
    // For a type with no built-ins, unregistering all registered methods
    // should remove the runtime entry entirely (so `getServiceMethods` matches
    // the "never registered" shape — `undefined`).
    registerServiceMethods('notion', ['pages.create'])
    expect(getServiceMethods('notion')).toBeDefined()
    unregisterServiceMethods('notion', ['pages.create'])
    expect(getServiceMethods('notion')).toBeUndefined()
    expect(isServiceMethodAllowed('notion', 'pages.create')).toBe(false)
  })

  it('unregisterServiceMethods is a no-op on unknown type', () => {
    // Deleting nothing is fine — we don't want plugin shutdown to throw
    // because a type was already gone.
    expect(() => unregisterServiceMethods('ghost', ['x'])).not.toThrow()
    expect(isServiceMethodAllowed('memory', 'recall')).toBe(true)
  })

  it('unregisterServiceMethods throws on bad input (symmetric with register)', () => {
    // Same throw policy as `registerServiceMethods` for type / methods —
    // catches plugin lifecycle bugs loudly rather than corrupting state.
    expect(() => unregisterServiceMethods('', ['x'])).toThrow(/non-empty/)
    expect(() =>
      unregisterServiceMethods(
        'memory',
        null as unknown as readonly string[],
      ),
    ).toThrow(/array/)
  })
})

// -----------------------------------------------------------------------------
// End-to-end through ServiceCallRouter
// -----------------------------------------------------------------------------

class NotionHandle {
  created: Array<{ title: string }> = []
  pages = {
    create: async (input: { title: string }) => {
      this.created.push(input)
      return { id: `p-${this.created.length}` }
    },
    read: async (id: string) => ({ id, title: this.created[0]?.title ?? '?' }),
  }
}

class StubGateway implements ServiceCallGateway {
  handle = new NotionHandle()
  async attach(): Promise<{ handle: unknown }> {
    return { handle: this.handle }
  }
  async detachFor(): Promise<void> {}
}

function frame(opts: {
  type: string
  impl: string
  method: string
  args?: unknown[]
  owner?: ServiceOwner
  from?: string
}): ServiceCallFrame {
  return {
    type: 'SERVICE_CALL',
    callId: `c-${Math.random().toString(36).slice(2, 8)}`,
    from: opts.from ?? 'agent-a',
    service: {
      type: opts.type,
      impl: opts.impl,
      owner: opts.owner ?? { kind: 'agent', id: 'agent-a' },
    },
    method: opts.method,
    args: opts.args ?? [],
  }
}

describe('ServiceCallRouter respects the runtime allowlist', () => {
  const decls: ServiceUseDecl[] = [
    { type: 'notion', impl: 'official', owner: { kind: 'agent', id: 'self' }, config: {} },
  ]

  it('unknown_method when type was never registered', async () => {
    const gw = new StubGateway()
    const r = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['agent-a'],
    })
    const res = await r.route(
      frame({ type: 'notion', impl: 'official', method: 'pages.create', args: [{ title: 't' }] }),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('unknown_method')
  })

  it('dispatches once the type is registered', async () => {
    registerServiceMethods('notion', ['pages.create', 'pages.read'])
    const gw = new StubGateway()
    const r = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['agent-a'],
    })
    const res = await r.route(
      frame({ type: 'notion', impl: 'official', method: 'pages.create', args: [{ title: 't' }] }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toEqual({ id: 'p-1' })
      expect(gw.handle.created).toEqual([{ title: 't' }])
    }
  })

  it('still rejects non-registered methods on a registered type', async () => {
    registerServiceMethods('notion', ['pages.create'])
    const gw = new StubGateway()
    const r = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['agent-a'],
    })
    const res = await r.route(
      frame({ type: 'notion', impl: 'official', method: 'pages.delete' }),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('unknown_method')
  })
})
