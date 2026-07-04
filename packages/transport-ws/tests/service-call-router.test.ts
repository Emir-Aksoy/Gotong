/**
 * Unit tests for `ServiceCallRouter` — ACL, cache, lazy attach, dispose,
 * error mapping. No real WebSocket / Hub / plugin needed: the router
 * talks to its `ServiceCallGateway` interface, and we provide a fake.
 */

import { describe, expect, it } from 'vitest'

import type {
  ServiceCallFrame,
  ServiceOwner,
  ServiceUseDecl,
} from '@gotong/protocol'

import { ServiceCallRouter, ownerPatternMatches } from '../src/service-call-router.js'
import type { ServiceCallGateway } from '../src/server.js'

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

class FakeMemoryHandle {
  remembered: Array<{ kind: string; text: string }> = []

  async recall(query: { k?: number }): Promise<Array<{ id: string; text: string }>> {
    return this.remembered.slice(0, query.k ?? 20).map((e, i) => ({
      id: `e${i}`,
      text: e.text,
    }))
  }

  async remember(entry: { kind: string; text: string }): Promise<{ id: string }> {
    this.remembered.push(entry)
    return { id: `e${this.remembered.length}` }
  }

  // No `clear` — used to test 'unknown_method' for handle-side missing impl.
}

class FakeGateway implements ServiceCallGateway {
  attachCount = 0
  detachCalls: ServiceOwner[] = []
  handles = new Map<string, FakeMemoryHandle>()

  /** Optional knob: cause `attach` to throw for testing attach_failed. */
  throwOnAttach = false

  async attach(spec: {
    type: string
    impl: string
    owner: ServiceOwner
    config: unknown
  }): Promise<{ handle: unknown }> {
    if (this.throwOnAttach) {
      throw new Error('plugin refused: simulated')
    }
    this.attachCount += 1
    const key = `${spec.type}:${spec.impl}:${spec.owner.kind}/${spec.owner.id}`
    let h = this.handles.get(key)
    if (!h) {
      h = new FakeMemoryHandle()
      this.handles.set(key, h)
    }
    return { handle: h }
  }

  async detachFor(owner: ServiceOwner): Promise<void> {
    this.detachCalls.push(owner)
  }
}

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function call(opts: {
  callId?: string
  from: string
  type: string
  impl: string
  owner: ServiceOwner
  method: string
  args?: unknown[]
}): ServiceCallFrame {
  return {
    type: 'SERVICE_CALL',
    callId: opts.callId ?? `c-${Math.random().toString(36).slice(2, 8)}`,
    from: opts.from,
    service: { type: opts.type, impl: opts.impl, owner: opts.owner },
    method: opts.method,
    args: opts.args ?? [],
  }
}

function router(opts: {
  gateway: FakeGateway
  declarations: ServiceUseDecl[]
  agents: string[]
}): ServiceCallRouter {
  return new ServiceCallRouter({
    gateway: opts.gateway,
    declarations: opts.declarations,
    sessionAgentIds: opts.agents,
    warn: () => {
      /* silence during tests */
    },
  })
}

// -----------------------------------------------------------------------------
// ownerPatternMatches — the ACL primitive
// -----------------------------------------------------------------------------

describe('ownerPatternMatches', () => {
  it("matches when kind+id are literal-equal", () => {
    expect(
      ownerPatternMatches(
        { kind: 'agent', id: 'coach' },
        { kind: 'agent', id: 'coach' },
        'coach',
      ),
    ).toBe(true)
  })

  it("rejects when kinds differ", () => {
    expect(
      ownerPatternMatches(
        { kind: 'agent', id: 'coach' },
        { kind: 'workflow-run', id: 'coach' },
        'coach',
      ),
    ).toBe(false)
  })

  it("'*' id matches any concrete id of the same kind", () => {
    expect(
      ownerPatternMatches(
        { kind: 'workflow-run', id: '*' },
        { kind: 'workflow-run', id: 'case-abc' },
        'coach',
      ),
    ).toBe(true)
    expect(
      ownerPatternMatches(
        { kind: 'workflow-run', id: '*' },
        { kind: 'agent', id: 'case-abc' },
        'coach',
      ),
    ).toBe(false)
  })

  it("'self' resolves to the calling agent's id (agent kind only)", () => {
    expect(
      ownerPatternMatches(
        { kind: 'agent', id: 'self' },
        { kind: 'agent', id: 'coach' },
        'coach',
      ),
    ).toBe(true)
    expect(
      ownerPatternMatches(
        { kind: 'agent', id: 'self' },
        { kind: 'agent', id: 'someone-else' },
        'coach',
      ),
    ).toBe(false)
  })

  it("'self' on non-agent kind never matches", () => {
    // Server-side validation rejects this in HELLO; the matcher is the
    // belt to its suspenders.
    expect(
      ownerPatternMatches(
        { kind: 'workflow-run', id: 'self' },
        { kind: 'workflow-run', id: 'coach' },
        'coach',
      ),
    ).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Router — successful happy path
// -----------------------------------------------------------------------------

describe('ServiceCallRouter — happy path', () => {
  it('routes a recall call end-to-end (lazy attach + method invoke)', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    // Seed some data so recall has something to return.
    const seedFrame = call({
      from: 'coach',
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'remember',
      args: [{ kind: 'episodic', text: 'hello' }],
    })
    const seed = await r.route(seedFrame)
    expect(seed.ok).toBe(true)

    const recallFrame = call({
      from: 'coach',
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall',
      args: [{ k: 5 }],
    })
    const result = await r.route(recallFrame)
    expect(result).toEqual({
      type: 'SERVICE_RESULT',
      callId: recallFrame.callId,
      ok: true,
      value: [{ id: 'e0', text: 'hello' }],
    })
    expect(gateway.attachCount).toBe(1)  // remember + recall reused the same handle
  })

  it('reuses cached handle for repeat (type, impl, owner) — only one attach', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{ k: 1 }],
    }))
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{ k: 1 }],
    }))
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{ k: 1 }],
    }))
    expect(gateway.attachCount).toBe(1)
    expect(r.cacheSize()).toBe(1)
  })

  it('wildcard owner pattern lets different concrete ids attach separately', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        // Declare wildcard for workflow-run
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      agents: ['coach'],
    })
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-A' },
      method: 'recall', args: [{}],
    }))
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-B' },
      method: 'recall', args: [{}],
    }))
    expect(gateway.attachCount).toBe(2)  // two distinct cases → two handles
    expect(r.cacheSize()).toBe(2)
  })
})

// -----------------------------------------------------------------------------
// Router — error mapping
// -----------------------------------------------------------------------------

describe('ServiceCallRouter — error codes', () => {
  it('unknown_agent when call.from is not in the session', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    const result = await r.route(call({
      from: 'imposter',  // not in agents
      type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'imposter' },
      method: 'recall', args: [{}],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('unknown_agent')
    expect(gateway.attachCount).toBe(0)  // never reached the gateway
  })

  it('forbidden_service when (type, impl) is not declared', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    const result = await r.route(call({
      from: 'coach', type: 'artifact', impl: 'file',  // not declared
      owner: { kind: 'agent', id: 'coach' },
      method: 'list', args: [],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('forbidden_service')
  })

  it('forbidden_owner when (type, impl) matches but owner pattern does not', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    const result = await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-X' },  // declaration was agent/self
      method: 'recall', args: [{}],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('forbidden_owner')
  })

  it('unknown_method when method is not on the allowlist', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    const result = await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'evilEval',  // not on memory's allowlist
      args: ['anything'],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('unknown_method')
  })

  it('unknown_method when handle does not implement an allowed method', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    // FakeMemoryHandle deliberately doesn't implement `clear`.
    const result = await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'clear', args: [],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('unknown_method')
  })

  it('attach_failed when gateway.attach throws', async () => {
    const gateway = new FakeGateway()
    gateway.throwOnAttach = true
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    const result = await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{}],
    }))
    expect(result.ok).toBe(false)
    const e = (result as { ok: false; error: { code: string; message: string } }).error
    expect(e.code).toBe('attach_failed')
    expect(e.message).toContain('plugin refused')
  })

  it('bad_args when args is not an array', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    // Cheat the type to inject a non-array.
    const bad = call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{}],
    })
    ;(bad as unknown as { args: unknown }).args = { not: 'an array' }
    const result = await r.route(bad)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('bad_args')
  })
})

// -----------------------------------------------------------------------------
// Router — lifecycle
// -----------------------------------------------------------------------------

describe('ServiceCallRouter — lifecycle', () => {
  it('dispose detaches every cached owner exactly once', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      agents: ['coach'],
    })
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-A' },
      method: 'recall', args: [{}],
    }))
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-B' },
      method: 'recall', args: [{}],
    }))
    expect(r.cacheSize()).toBe(2)
    await r.dispose()
    expect(gateway.detachCalls).toHaveLength(2)
    expect(gateway.detachCalls.map((o) => o.id).sort()).toEqual(['case-A', 'case-B'])
  })

  it('onAgentLeft detaches only that agent’s owners (others survive)', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
        { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
      ],
      agents: ['coach', 'analyst'],
    })
    // Coach and analyst each attach their own per-agent memory.
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{}],
    }))
    await r.route(call({
      from: 'analyst', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'analyst' },
      method: 'recall', args: [{}],
    }))
    // And case-memory (workflow-run) which is shared and should survive.
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: 'case-X' },
      method: 'recall', args: [{}],
    }))
    expect(r.cacheSize()).toBe(3)
    await r.onAgentLeft('coach')
    expect(gateway.detachCalls).toEqual([{ kind: 'agent', id: 'coach' }])
    expect(r.cacheSize()).toBe(2)  // analyst's + workflow-run/case-X kept
  })

  it('dispose is idempotent', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{}],
    }))
    await r.dispose()
    await r.dispose()
    expect(gateway.detachCalls).toHaveLength(1)
  })

  it('route after dispose returns session_not_ready', async () => {
    const gateway = new FakeGateway()
    const r = router({
      gateway,
      declarations: [
        { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
      ],
      agents: ['coach'],
    })
    await r.dispose()
    const result = await r.route(call({
      from: 'coach', type: 'memory', impl: 'file',
      owner: { kind: 'agent', id: 'coach' },
      method: 'recall', args: [{}],
    }))
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { code: string } }).error.code).toBe('session_not_ready')
  })
})
