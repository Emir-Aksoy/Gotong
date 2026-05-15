/**
 * Per-decl method narrowing (v1.2). When a decl supplies `methods: [...]`,
 * any SERVICE_CALL whose method name is not in that list returns
 * `forbidden_method` — even if the type-level allowlist (built-ins plus
 * registered third-party methods) would let it through.
 */

import { describe, expect, it } from 'vitest'

import type { ServiceCallFrame, ServiceUseDecl } from '@aipehub/protocol'

import { ServiceCallRouter } from '../src/service-call-router.js'
import type { ServiceCallGateway } from '../src/server.js'

class FakeMem {
  log: string[] = []
  async recall(_q: unknown) { this.log.push('recall'); return [] }
  async remember(_e: unknown) { this.log.push('remember'); return { id: 'x' } }
  async forget(_id: string) { this.log.push('forget') }
}

class FakeGateway implements ServiceCallGateway {
  handle = new FakeMem()
  async attach() { return { handle: this.handle } }
  async detachFor() {}
}

function frame(method: string, callId = 'c-1'): ServiceCallFrame {
  return {
    type: 'SERVICE_CALL',
    callId,
    from: 'a-1',
    service: { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'a-1' } },
    method,
    args: method === 'recall' ? [{}] : method === 'remember' ? [{ kind: 'episodic', text: 't' }] : ['x'],
  }
}

describe('per-decl method allowlist (forbidden_method)', () => {
  it('rejects methods not in decl.methods even if type-level allows', async () => {
    const decls: ServiceUseDecl[] = [
      {
        type: 'memory',
        impl: 'file',
        owner: { kind: 'agent', id: 'self' },
        methods: ['recall', 'list'],   // read-only scope
      },
    ]
    const gw = new FakeGateway()
    const router = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['a-1'],
    })

    // recall — explicitly allowed.
    const ok = await router.route(frame('recall'))
    expect(ok.ok).toBe(true)
    expect(gw.handle.log).toEqual(['recall'])

    // remember — built-in but not in this decl's methods list.
    const err = await router.route(frame('remember', 'c-2'))
    expect(err.ok).toBe(false)
    if (!err.ok) {
      expect(err.error.code).toBe('forbidden_method')
      expect(err.error.message).toContain('not in the per-decl allowlist')
    }
    // Plugin's `remember` was NOT touched.
    expect(gw.handle.log).toEqual(['recall'])
  })

  it('omitted decl.methods means "all methods on the type allowlist"', async () => {
    const decls: ServiceUseDecl[] = [
      { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      // ↑ no `methods` field
    ]
    const gw = new FakeGateway()
    const router = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['a-1'],
    })

    const r1 = await router.route(frame('recall'))
    const r2 = await router.route(frame('remember', 'c-2'))
    const r3 = await router.route(frame('forget', 'c-3'))
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
  })

  it('still returns unknown_method for type-level disallowed methods even when in decl.methods', async () => {
    // If a malicious / mistaken caller declares `methods: ['shutdown']`
    // (not in the type allowlist), the type-level check still rejects
    // it BEFORE the per-decl check.
    const decls: ServiceUseDecl[] = [
      {
        type: 'memory',
        impl: 'file',
        owner: { kind: 'agent', id: 'self' },
        methods: ['shutdown'],
      },
    ]
    const gw = new FakeGateway()
    const router = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['a-1'],
    })
    const err = await router.route(frame('shutdown'))
    expect(err.ok).toBe(false)
    if (!err.ok) {
      // type-level rejection wins — the user's `methods` doesn't smuggle
      // names past the allowlist.
      expect(err.error.code).toBe('unknown_method')
    }
  })

  it('multiple decls for the same (type,impl) — match any', async () => {
    const decls: ServiceUseDecl[] = [
      {
        type: 'memory',
        impl: 'file',
        owner: { kind: 'agent', id: 'self' },
        methods: ['recall'],
      },
      {
        type: 'memory',
        impl: 'file',
        owner: { kind: 'workflow-run', id: '*' },
        methods: ['recall', 'remember'],
      },
    ]
    const gw = new FakeGateway()
    const router = new ServiceCallRouter({
      gateway: gw,
      declarations: decls,
      sessionAgentIds: ['a-1'],
    })

    // First decl matches (agent/self) — only recall allowed.
    const r1 = await router.route(frame('recall'))
    expect(r1.ok).toBe(true)

    // Same agent/self decl scope, but trying remember — denied by first decl
    // (the only decl that matches owner=agent/a-1).
    const r2 = await router.route(frame('remember', 'c-2'))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe('forbidden_method')

    // Workflow-run/case-7 — second decl matches and allows remember.
    const r3 = await router.route({
      type: 'SERVICE_CALL',
      callId: 'c-3',
      from: 'a-1',
      service: {
        type: 'memory',
        impl: 'file',
        owner: { kind: 'workflow-run', id: 'case-7' },
      },
      method: 'remember',
      args: [{ kind: 'episodic', text: 't' }],
    })
    expect(r3.ok).toBe(true)
  })
})
