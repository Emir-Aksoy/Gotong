/**
 * Phase 6 #2 — LlmAgent onAuthFailure hook.
 *
 * Verifies the auth-failure detection + best-effort hook contract:
 *   - .status === 401 → hook called, original error still surfaces
 *   - SDK AuthenticationError class name → hook called
 *   - .status === 429 / 500 → hook NOT called (transient errors)
 *   - hook absent → no crash; error path identical to baseline
 *   - hook throws → swallowed; original 401 still surfaces
 *
 * Uses inline stub providers rather than extending MockLlmProvider so
 * we control the exact error shape (status field, error class name)
 * each case needs.
 */

import { describe, it, expect } from 'vitest'
import { Hub, type Task } from '@aipehub/core'
import {
  LlmAgent,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src/index.js'

function makeTask(payload: unknown, capabilities = ['draft']) {
  return {
    from: 'system' as const,
    strategy: { kind: 'capability' as const, capabilities },
    payload,
  }
}

/** Provider that throws an error with the given shape on every call. */
function throwingProvider(buildError: () => Error): LlmProvider {
  return {
    name: 'stub',
    async complete(_req: LlmRequest): Promise<LlmResponse> {
      throw buildError()
    },
  }
}

describe('LlmAgent — onAuthFailure hook', () => {
  it('fires on .status === 401 with the original error and task', async () => {
    const hookCalls: Array<{ err: unknown; task: Task }> = []
    const err401 = Object.assign(new Error('Unauthorized'), { status: 401 })
    const provider = throwingProvider(() => err401)

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new LlmAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      onAuthFailure: async (err, task) => {
        hookCalls.push({ err, task })
      },
    }))

    const result = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(hookCalls).toHaveLength(1)
    expect(hookCalls[0]!.err).toBe(err401)
    expect(result.kind).toBe('failed')
  })

  it('fires when error class name matches /AuthenticationError/i', async () => {
    let called = false
    class AuthenticationError extends Error {
      constructor() {
        super('bad key')
        this.name = 'AuthenticationError'
      }
    }
    const provider = throwingProvider(() => new AuthenticationError())

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new LlmAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      onAuthFailure: () => { called = true },
    }))

    await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(called).toBe(true)
  })

  it('does NOT fire on .status === 429 (rate-limited)', async () => {
    let called = false
    const provider = throwingProvider(() =>
      Object.assign(new Error('rate limited'), { status: 429 }),
    )

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new LlmAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      onAuthFailure: () => { called = true },
    }))

    const result = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(called).toBe(false)
    expect(result.kind).toBe('failed') // transient errors still surface
  })

  it('does NOT fire on .status === 500 (server error)', async () => {
    let called = false
    const provider = throwingProvider(() =>
      Object.assign(new Error('internal'), { status: 500 }),
    )

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new LlmAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      onAuthFailure: () => { called = true },
    }))

    await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(called).toBe(false)
  })

  it('hook absent — 401 path identical to baseline (no crash)', async () => {
    const provider = throwingProvider(() =>
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    )

    const hub = Hub.inMemory()
    await hub.start()
    // No onAuthFailure passed.
    hub.register(new LlmAgent({ id: 'a', capabilities: ['draft'], provider }))

    const result = await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.error).toContain('Unauthorized')
    }
  })

  it('hook throw is swallowed; original 401 still surfaces', async () => {
    const err401 = Object.assign(new Error('Unauthorized'), { status: 401 })
    const provider = throwingProvider(() => err401)

    // Silence console.error inside this test — we want the test output
    // clean, but we still want the production code path to log to
    // console.error so operators see the hook failure in host logs.
    const origErr = console.error
    const logged: unknown[][] = []
    console.error = (...args: unknown[]) => { logged.push(args) }

    try {
      const hub = Hub.inMemory()
      await hub.start()
      hub.register(new LlmAgent({
        id: 'a',
        capabilities: ['draft'],
        provider,
        onAuthFailure: () => {
          throw new Error('vault revoke failed')
        },
      }))

      const result = await hub.dispatch(makeTask('hi'))
      await hub.stop()

      expect(result.kind).toBe('failed')
      if (result.kind === 'failed') {
        // Original 401 message reaches the task — the hook's error
        // did NOT mask it.
        expect(result.error).toContain('Unauthorized')
      }
      // Hook failure was logged to console.error.
      expect(logged.some((args) =>
        args.some((a) => String(a).includes('onAuthFailure')),
      )).toBe(true)
    } finally {
      console.error = origErr
    }
  })

  it('fires once even with multi-round tool-use loop (first round 401)', async () => {
    // The 401 happens on the first provider call inside the
    // tool-use loop too. We verify the hook still gets called exactly
    // once — wrapping is centralized in streamWithAuthHook (Phase 8 M5)
    // so all call sites converge.
    let calls = 0
    const provider = throwingProvider(() =>
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    )

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new LlmAgent({
      id: 'a',
      capabilities: ['draft'],
      provider,
      onAuthFailure: () => { calls++ },
    }))

    await hub.dispatch(makeTask('hi'))
    await hub.stop()

    expect(calls).toBe(1)
  })
})
