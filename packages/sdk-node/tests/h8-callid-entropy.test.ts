/**
 * H8 regression — SERVICE_CALL callId must be CSPRNG-derived.
 *
 * Pre-3.4: `c${counter}_${Math.random().toString(36).slice(2,8)}`.
 *
 * Today's local-pending-call table matches purely on callId, so a
 * collision is at worst "wrong handler resolves a stale frame within
 * one session". But:
 *
 *   - The next protocol bump multiplexes SERVICE_RESULT across
 *     sessions; a collision becomes a real routing security boundary.
 *   - After `fork()` the Mersenne-Twister-backed Math.random() in
 *     Node shares its seed with the parent, so two children mint
 *     identical callIds in lockstep until something reseeds.
 *
 * The fix swaps Math.random() for `randomBytes(6).toString('hex')` —
 * 48 bits of crypto-grade entropy, same on-wire width.
 *
 * See AUDIT-v3.3.md finding H8.
 */

import { describe, expect, it, vi } from 'vitest'

import { ServiceClientImpl } from '../src/service-client.js'

function makeClient(opts?: {
  capturedCallIds?: string[]
  failSend?: boolean
}): ServiceClientImpl {
  const capturedCallIds = opts?.capturedCallIds
  return new ServiceClientImpl({
    declarations: [],
    sendCall: (frame) => {
      capturedCallIds?.push(frame.callId)
      if (opts?.failSend) throw new Error('test: send refused')
    },
    defaultAgentId: () => 'test-agent',
    callTimeoutMs: 30,
  })
}

describe('H8 — sdk-node SERVICE_CALL callId entropy', () => {
  it('callId format: `c<counter-base36>_<12 hex chars>`', async () => {
    // Drive one call and inspect the captured callId. `12 hex` is
    // exactly what `randomBytes(6).toString('hex')` produces, and is
    // also the same width the pre-3.4 string had (no decoder change).
    const captured: string[] = []
    const c = makeClient({ capturedCallIds: captured, failSend: false })
    const handle = c.customFor('memory', 'file', { kind: 'agent', id: 'a' })
    // Fire-and-don't-await; timeout will reject the promise but we
    // only care about what hit the wire. Use a catch to swallow.
    void handle.call('recall', { q: 'x' }).catch(() => {})

    // Tick the event loop so the sendCall callback runs.
    await new Promise((r) => setTimeout(r, 5))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatch(/^c[0-9a-z]+_[0-9a-f]{12}$/)
    await c.failAllPending('test cleanup')
  })

  it('1000 callIds are all unique (rules out Math.random short-period collisions)', async () => {
    // The pre-3.4 form took 6 base-36 chars (≈31 bits effective);
    // birthday-collision odds across 1000 draws are non-trivial
    // (~1 in 70). With `randomBytes(6).toString('hex')` we have 48
    // bits, so a collision in 1000 draws is astronomical. Use this
    // as a smoke check that the new entropy source is wired up.
    const captured: string[] = []
    const c = makeClient({ capturedCallIds: captured, failSend: true })
    const handle = c.customFor('memory', 'file', { kind: 'agent', id: 'a' })

    const calls: Promise<unknown>[] = []
    for (let i = 0; i < 1000; i++) {
      // failSend rejects synchronously; catch so vitest doesn't see
      // an unhandled rejection.
      calls.push(handle.call('recall', { i }).catch(() => undefined))
    }
    await Promise.all(calls)

    const unique = new Set(captured)
    expect(unique.size).toBe(captured.length)
    expect(captured.length).toBe(1000)
  })

  it('the random suffix actually varies (not a constant on the fast path)', async () => {
    // If a future refactor accidentally caches the random suffix or
    // pulls it from `Math.random()` again (now that the API surface
    // looks the same), this catches it: the SET of distinct
    // 12-hex-char suffixes across 50 calls must be 50.
    const captured: string[] = []
    const c = makeClient({ capturedCallIds: captured, failSend: true })
    const handle = c.customFor('memory', 'file', { kind: 'agent', id: 'a' })

    for (let i = 0; i < 50; i++) {
      await handle.call('recall', { i }).catch(() => undefined)
    }
    const suffixes = new Set(captured.map((id) => id.split('_')[1]))
    expect(suffixes.size).toBe(50)
  })

  it('the counter prefix increments monotonically — pre-3.4 invariant preserved', async () => {
    // The counter is the "human-readable" half. Verify we didn't
    // accidentally swap THAT to a random value too — the format is
    // `c<counter-base36>_<random>`; only the second half changed.
    const captured: string[] = []
    const c = makeClient({ capturedCallIds: captured, failSend: true })
    const handle = c.customFor('memory', 'file', { kind: 'agent', id: 'a' })

    for (let i = 0; i < 5; i++) {
      await handle.call('recall', { i }).catch(() => undefined)
    }
    const counters = captured.map((id) => parseInt(id.split('_')[0]!.slice(1), 36))
    expect(counters).toEqual([1, 2, 3, 4, 5])
  })

  it('does not call Math.random for callId generation', async () => {
    // Hard guard: spy on Math.random and assert it was not touched
    // during a SERVICE_CALL dispatch. (Other code in the SDK might
    // call Math.random for unrelated reasons in the future — but a
    // SERVICE_CALL dispatch must not.)
    const spy = vi.spyOn(Math, 'random')
    try {
      const c = makeClient({ failSend: true })
      const handle = c.customFor('memory', 'file', { kind: 'agent', id: 'a' })
      await handle.call('recall', {}).catch(() => undefined)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
