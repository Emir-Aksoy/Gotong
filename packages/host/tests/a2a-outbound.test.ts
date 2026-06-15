/**
 * Route B P1-M11b — store-driven outbound A2A agent wiring.
 *
 * Proves the A2aOutboundManager materialises identity-backed config
 * (a2a_outbound_agents, M11a) onto a real Hub, and re-syncs at runtime when an
 * admin edits a row — without touching the A2A transport itself (covered by the
 * @aipehub/a2a + double-hub tests). We assert HUB STATE (`hub.participant(id)`),
 * not dispatch, so the test is deterministic and offline.
 *
 * The credential boundary is the crux: a row whose `tokenEnv` is unset is kept
 * but NOT registered ("persisted-but-inactive"), and the bearer is read from
 * the injected env reader, never from the row.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { Hub, AgentParticipant, type Logger, type Task } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { A2aOutboundManager } from '../src/a2a-outbound.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

/** A concrete non-A2A participant, to seed an id collision in the hub. */
class StubAgent extends AgentParticipant {
  protected async handleTask(_task: Task): Promise<unknown> {
    return {}
  }
}

/** Env reader backed by a plain object, so a test controls which tokens exist. */
function envFrom(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name]
}

describe('A2aOutboundManager (P1-M11b)', () => {
  let hub: Hub
  let identity: IdentityStore

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:' })
  })

  function manager(vars: Record<string, string>): A2aOutboundManager {
    return new A2aOutboundManager({ hub, source: identity, logger: silentLogger, readEnv: envFrom(vars) })
  }

  it('boot registers enabled agents whose token env is set; skips the rest', () => {
    identity.addA2aAgent({ id: 'live', capabilities: ['draft'], url: 'https://a/a2a', tokenEnv: 'LIVE_TOK' })
    identity.addA2aAgent({ id: 'no-token', capabilities: ['draft'], url: 'https://b/a2a', tokenEnv: 'MISSING' })
    identity.addA2aAgent({
      id: 'off',
      capabilities: ['draft'],
      url: 'https://c/a2a',
      tokenEnv: 'OFF_TOK',
      enabled: false,
    })

    const count = manager({ LIVE_TOK: 'secret-1', OFF_TOK: 'secret-3' }).registerAllFromStore()
    expect(count).toBe(1)
    expect(hub.participant('live')).toBeDefined()
    expect(hub.participant('live')?.capabilities).toEqual(['draft'])
    // token unset → persisted but not registered
    expect(hub.participant('no-token')).toBeUndefined()
    // disabled → not registered even though its token IS present
    expect(hub.participant('off')).toBeUndefined()
  })

  it('refresh registers a freshly-added agent and reports active', () => {
    const mgr = manager({ TOK: 'secret' })
    identity.addA2aAgent({ id: 'new-one', capabilities: ['review'], url: 'https://a/a2a', tokenEnv: 'TOK' })

    const res = mgr.refresh('new-one')
    expect(res).toEqual({ active: true })
    expect(hub.participant('new-one')).toBeDefined()
    expect(mgr.isLive('new-one')).toBe(true)
  })

  it('refresh on a token-less row keeps it inactive (persisted-but-inactive)', () => {
    const mgr = manager({}) // no tokens at all
    identity.addA2aAgent({ id: 'pending', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'NOPE' })

    const res = mgr.refresh('pending')
    expect(res).toEqual({ active: false, reason: 'token_env_unset' })
    expect(hub.participant('pending')).toBeUndefined()
    expect(mgr.isLive('pending')).toBe(false)
  })

  it('refresh after an update re-registers cleanly (unregister-then-register, no dup throw)', () => {
    const mgr = manager({ TOK: 'secret' })
    identity.addA2aAgent({ id: 'editable', capabilities: ['a'], url: 'https://old/a2a', tokenEnv: 'TOK' })
    expect(mgr.refresh('editable')).toEqual({ active: true })

    // Admin edits the row; refresh must drop the old wrapper before re-adding,
    // or hub.register would throw "already registered".
    identity.updateA2aAgent('editable', { capabilities: ['a', 'b'], url: 'https://new/a2a' })
    const res = mgr.refresh('editable')
    expect(res).toEqual({ active: true })
    expect(hub.participant('editable')?.capabilities).toEqual(['a', 'b'])
  })

  it('refresh after disabling unregisters and reports disabled', () => {
    const mgr = manager({ TOK: 'secret' })
    identity.addA2aAgent({ id: 'toggle', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })
    mgr.refresh('toggle')
    expect(hub.participant('toggle')).toBeDefined()

    identity.updateA2aAgent('toggle', { enabled: false })
    const res = mgr.refresh('toggle')
    expect(res).toEqual({ active: false, reason: 'disabled' })
    expect(hub.participant('toggle')).toBeUndefined()
    expect(mgr.isLive('toggle')).toBe(false)
  })

  it('remove unregisters the participant from the hub', () => {
    const mgr = manager({ TOK: 'secret' })
    identity.addA2aAgent({ id: 'gone', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })
    mgr.refresh('gone')
    expect(hub.participant('gone')).toBeDefined()

    mgr.remove('gone')
    expect(hub.participant('gone')).toBeUndefined()
    expect(mgr.isLive('gone')).toBe(false)
  })

  it('remove only touches OUR participants, never a same-id managed agent', () => {
    // A non-A2A participant already owns this id (e.g. a managed agent / broker).
    hub.register(new StubAgent({ id: 'shared', capabilities: ['x'] }))
    const mgr = manager({ TOK: 'secret' })
    // remove for an id we never registered must be a no-op, NOT unregister the
    // pre-existing participant.
    mgr.remove('shared')
    expect(hub.participant('shared')).toBeDefined()
  })

  it('an id colliding with an existing participant is reported, not thrown', () => {
    hub.register(new StubAgent({ id: 'clash', capabilities: ['x'] }))
    identity.addA2aAgent({ id: 'clash', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })

    const mgr = manager({ TOK: 'secret' })
    const res = mgr.refresh('clash')
    expect(res).toEqual({ active: false, reason: 'id_conflict' })
    // the pre-existing participant is untouched
    expect(hub.participant('clash')?.capabilities).toEqual(['x'])
    expect(mgr.isLive('clash')).toBe(false)
  })

  it('refresh on an unknown id reports not_found', () => {
    const res = manager({}).refresh('ghost')
    expect(res).toEqual({ active: false, reason: 'not_found' })
  })

  // Stream H2-OUT-M2 — a stored `lifecycle` (M1's v32 column) must reach the
  // constructed A2aRemoteParticipant, or an admin-registered outbound agent can
  // never talk to a long-running remote. The participant floors the option in
  // its constructor, so the floored private field is the observable proof the
  // manager wired it through (behavioral suspend→sweep→settle is the M4 e2e).
  describe('Stream H2-OUT — long-running lifecycle wiring', () => {
    /** Read the participant's floored lifecycle (private at compile time, live at runtime). */
    function lifecycleOf(id: string): { pollIntervalMs: number; maxAttempts: number } | undefined {
      const p = hub.participant(id) as unknown as {
        lifecycle?: { pollIntervalMs: number; maxAttempts: number }
      }
      return p?.lifecycle
    }

    it('passes a tuned lifecycle through to the participant (floored by it)', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({
        id: 'long',
        capabilities: ['review'],
        url: 'https://a/a2a',
        tokenEnv: 'TOK',
        lifecycle: { pollIntervalMs: 5000, maxAttempts: 40 },
      })
      expect(mgr.refresh('long')).toEqual({ active: true })
      expect(lifecycleOf('long')).toEqual({ pollIntervalMs: 5000, maxAttempts: 40 })
    })

    it('a stored {} opts in with the participant defaults (NULL would be blocking)', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({
        id: 'defaults-on',
        capabilities: ['review'],
        url: 'https://a/a2a',
        tokenEnv: 'TOK',
        lifecycle: {},
      })
      mgr.refresh('defaults-on')
      // `{}` reaches the participant truthily → opted in, defaults floored (3000/20).
      expect(lifecycleOf('defaults-on')).toEqual({ pollIntervalMs: 3000, maxAttempts: 20 })
    })

    it('a blocking agent (no lifecycle row) constructs a participant without lifecycle', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'blocking', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })
      mgr.refresh('blocking')
      // NULL column → null projection → falsy → omitted → legacy blocking edge.
      expect(lifecycleOf('blocking')).toBeUndefined()
    })

    it('turning lifecycle off via update drops it on the re-registered participant', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({
        id: 'toggle-life',
        capabilities: ['a'],
        url: 'https://a/a2a',
        tokenEnv: 'TOK',
        lifecycle: { maxAttempts: 7 },
      })
      mgr.refresh('toggle-life')
      expect(lifecycleOf('toggle-life')).toBeDefined()

      identity.updateA2aAgent('toggle-life', { lifecycle: null })
      mgr.refresh('toggle-life') // unregister-then-register picks up the cleared column
      expect(lifecycleOf('toggle-life')).toBeUndefined()
    })
  })

  // P1-M11c — the admin list reads liveness through statusOf, which must report
  // the SAME reason tryRegister would, WITHOUT mutating the hub.
  describe('statusOf (read-only liveness probe)', () => {
    it('reports active for a live agent', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'live', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })
      mgr.refresh('live')
      expect(mgr.statusOf('live')).toEqual({ active: true })
    })

    it('reports the inactive reason without touching the hub', () => {
      const mgr = manager({}) // no tokens
      identity.addA2aAgent({ id: 'disabled', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'T', enabled: false })
      identity.addA2aAgent({ id: 'no-token', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'MISSING' })

      expect(mgr.statusOf('disabled')).toEqual({ active: false, reason: 'disabled' })
      expect(mgr.statusOf('no-token')).toEqual({ active: false, reason: 'token_env_unset' })
      expect(mgr.statusOf('ghost')).toEqual({ active: false, reason: 'not_found' })
      // a pure probe must never register anything
      expect(hub.participant('no-token')).toBeUndefined()
      expect(mgr.isLive('no-token')).toBe(false)
    })

    it('reports id_conflict when another participant owns the id', () => {
      hub.register(new StubAgent({ id: 'clash', capabilities: ['x'] }))
      identity.addA2aAgent({ id: 'clash', capabilities: ['a'], url: 'https://a/a2a', tokenEnv: 'TOK' })
      const mgr = manager({ TOK: 'secret' })
      // enabled + token present, yet we never registered it → owned by the stub.
      expect(mgr.statusOf('clash')).toEqual({ active: false, reason: 'id_conflict' })
    })
  })

  // --- Item 2: outbound data-class + quota gate at the A2A edge -------------
  // The manager must wire the stored v34 columns through to the participant:
  // the data-class allowlist becomes `allowedDataClasses`, and a budget becomes
  // an `outboundQuotaGate` closure backed by a per-agent FixedWindowLimiter that
  // SURVIVES a refresh (an admin edit must not reset the window). We read the
  // participant's private fields at runtime (TS privacy is compile-time only),
  // mirroring the existing `lifecycleOf`-style probes — offline + deterministic.
  describe('Item 2 — outbound data-class + quota gate', () => {
    /** Read the gate fields the manager wired onto the live participant. */
    function gateOf(id: string): {
      allowedDataClasses?: readonly string[] | null
      outboundQuotaGate?: (task: unknown) => boolean
    } {
      const p = hub.participant(id) as unknown as {
        allowedDataClasses?: readonly string[] | null
        outboundQuotaGate?: (task: unknown) => boolean
      }
      return { allowedDataClasses: p?.allowedDataClasses, outboundQuotaGate: p?.outboundQuotaGate }
    }

    it('wires the stored data-class allowlist into the participant; null vs [] distinct', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'classed', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', allowedDataClasses: ['public'] })
      identity.addA2aAgent({ id: 'open', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK' })
      identity.addA2aAgent({ id: 'locked', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', allowedDataClasses: [] })
      mgr.refresh('classed')
      mgr.refresh('open')
      mgr.refresh('locked')
      expect(gateOf('classed').allowedDataClasses).toEqual(['public'])
      expect(gateOf('open').allowedDataClasses).toBeNull() // no contract (legacy accept-all)
      expect(gateOf('locked').allowedDataClasses).toEqual([]) // lockdown — distinct from null
    })

    it('builds an outbound quota gate only when a budget is set', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'budgeted', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', outboundQuotaBudget: 3 })
      identity.addA2aAgent({ id: 'unbudgeted', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK' })
      mgr.refresh('budgeted')
      mgr.refresh('unbudgeted')
      expect(typeof gateOf('budgeted').outboundQuotaGate).toBe('function')
      expect(gateOf('unbudgeted').outboundQuotaGate).toBeUndefined()
    })

    it('a task declaring a disallowed class fails fast — the remote is never sent to', async () => {
      const mgr = manager({ TOK: 'secret' })
      // No fetchImpl is injected, but the gate throws BEFORE any send anyway, so
      // a denied dispatch is fully offline regardless.
      identity.addA2aAgent({ id: 'gov', capabilities: ['review'], url: 'https://a/a2a', tokenEnv: 'TOK', allowedDataClasses: ['public'] })
      mgr.refresh('gov')
      const res = await hub.dispatch({
        from: 'human',
        strategy: { kind: 'explicit', to: 'gov' },
        payload: { text: 'hi' },
        dataClasses: ['secret'], // not in the ['public'] allowlist
      })
      expect(res.kind).toBe('failed')
      expect((res as { error?: string }).error).toContain('outbound_data_class_denied')
    })

    it('the quota gate enforces the budget (fail-closed past it)', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'q', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', outboundQuotaBudget: 2 })
      mgr.refresh('q')
      const gate = gateOf('q').outboundQuotaGate!
      expect(gate(undefined)).toBe(true) // 1
      expect(gate(undefined)).toBe(true) // 2
      expect(gate(undefined)).toBe(false) // 3 → over budget
    })

    it('the quota window survives a refresh — re-registering must NOT reset it', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'survive', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', outboundQuotaBudget: 2 })
      mgr.refresh('survive')
      const g1 = gateOf('survive').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(true) // budget of 2 exhausted this window
      // A refresh is what an admin edit/toggle triggers: a fresh participant is
      // registered, but the manager reuses the SAME limiter (budget unchanged).
      mgr.refresh('survive')
      const g2 = gateOf('survive').outboundQuotaGate!
      expect(g2(undefined)).toBe(false) // still exhausted — the window carried over
    })

    it('changing the budget rebuilds the limiter (a fresh window)', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'rebudget', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', outboundQuotaBudget: 1 })
      mgr.refresh('rebudget')
      const g1 = gateOf('rebudget').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(false) // exhausted at budget 1
      identity.updateA2aAgent('rebudget', { outboundQuotaBudget: 5 })
      mgr.refresh('rebudget')
      const g2 = gateOf('rebudget').outboundQuotaGate!
      expect(g2(undefined)).toBe(true) // new limiter → fresh window
    })

    it('remove drops the quota counter — a later refresh starts fresh', () => {
      const mgr = manager({ TOK: 'secret' })
      identity.addA2aAgent({ id: 'recycle', capabilities: ['x'], url: 'https://a/a2a', tokenEnv: 'TOK', outboundQuotaBudget: 1 })
      mgr.refresh('recycle')
      const g1 = gateOf('recycle').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(false) // exhausted
      // remove() is the true-delete path; it must drop the counter (unlike refresh).
      mgr.remove('recycle')
      mgr.refresh('recycle') // row still exists → re-registers with a brand-new limiter
      const g2 = gateOf('recycle').outboundQuotaGate!
      expect(g2(undefined)).toBe(true) // fresh counter proves remove() cleared it
    })
  })
})
