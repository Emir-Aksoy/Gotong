/**
 * ACP-OUT-M2 — store-driven outbound ACP agent wiring.
 *
 * Proves the AcpOutboundManager materialises identity-backed config
 * (acp_outbound_agents, M1) onto a real Hub, and re-syncs at runtime when an
 * admin edits a row — without spawning anything (AcpParticipant spawns lazily on
 * the first dispatch, which never happens here). We assert HUB STATE
 * (`hub.participant(id)`), not dispatch, so the test is deterministic and offline.
 *
 * The contrast with a2a-outbound: there is NO credential axis. An ACP agent
 * carries no secret and no env-var pointer (it rides the underlying agent's own
 * login), so a row is inactive only because it's disabled, id-conflicts, or is
 * not found — never "token unset".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Hub, AgentParticipant, type Logger, type Task } from '@aipehub/core'
import { AcpParticipant } from '@aipehub/acp-agent'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { AcpOutboundManager } from '../src/acp-outbound.js'

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

/** A concrete non-ACP participant, to seed an id collision in the hub. */
class StubAgent extends AgentParticipant {
  protected async handleTask(_task: Task): Promise<unknown> {
    return {}
  }
}

describe('AcpOutboundManager (ACP-OUT-M2)', () => {
  let hub: Hub
  let identity: IdentityStore

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:' })
  })

  function manager(): AcpOutboundManager {
    return new AcpOutboundManager({ hub, source: identity, logger: silentLogger })
  }

  it('boot registers enabled agents; skips disabled — no token gate', () => {
    identity.addAcpAgent({ id: 'claude', capabilities: ['code'], command: 'npx', args: ['@zed-industries/claude-code-acp'] })
    identity.addAcpAgent({ id: 'codex', capabilities: ['review'], command: 'codex-acp' })
    identity.addAcpAgent({ id: 'off', capabilities: ['code'], command: 'npx', enabled: false })

    const count = manager().registerAllFromStore()
    expect(count).toBe(2)
    expect(hub.participant('claude')).toBeDefined()
    expect(hub.participant('claude')?.capabilities).toEqual(['code'])
    expect(hub.participant('codex')).toBeDefined()
    // disabled → not registered
    expect(hub.participant('off')).toBeUndefined()
  })

  it('refresh registers a freshly-added agent and reports active', () => {
    const mgr = manager()
    identity.addAcpAgent({ id: 'new-one', capabilities: ['review'], command: 'codex-acp' })

    const res = mgr.refresh('new-one')
    expect(res).toEqual({ active: true })
    expect(hub.participant('new-one')).toBeDefined()
    expect(mgr.isLive('new-one')).toBe(true)
  })

  it('refresh after an update re-registers cleanly (unregister-then-register, no dup throw)', () => {
    const mgr = manager()
    identity.addAcpAgent({ id: 'editable', capabilities: ['a'], command: 'npx', args: ['old'] })
    expect(mgr.refresh('editable')).toEqual({ active: true })

    // Admin edits the row; refresh must drop the old wrapper before re-adding,
    // or hub.register would throw "already registered".
    identity.updateAcpAgent('editable', { capabilities: ['a', 'b'], command: 'codex-acp' })
    const res = mgr.refresh('editable')
    expect(res).toEqual({ active: true })
    expect(hub.participant('editable')?.capabilities).toEqual(['a', 'b'])
  })

  it('refresh after disabling unregisters and reports disabled', () => {
    const mgr = manager()
    identity.addAcpAgent({ id: 'toggle', capabilities: ['a'], command: 'npx' })
    mgr.refresh('toggle')
    expect(hub.participant('toggle')).toBeDefined()

    identity.updateAcpAgent('toggle', { enabled: false })
    const res = mgr.refresh('toggle')
    expect(res).toEqual({ active: false, reason: 'disabled' })
    expect(hub.participant('toggle')).toBeUndefined()
    expect(mgr.isLive('toggle')).toBe(false)
  })

  it('remove unregisters the participant from the hub', () => {
    const mgr = manager()
    identity.addAcpAgent({ id: 'gone', capabilities: ['a'], command: 'npx' })
    mgr.refresh('gone')
    expect(hub.participant('gone')).toBeDefined()

    mgr.remove('gone')
    expect(hub.participant('gone')).toBeUndefined()
    expect(mgr.isLive('gone')).toBe(false)
  })

  it('remove only touches OUR participants, never a same-id managed agent', () => {
    // A non-ACP participant already owns this id (e.g. a managed agent / broker).
    hub.register(new StubAgent({ id: 'shared', capabilities: ['x'] }))
    const mgr = manager()
    // remove for an id we never registered must be a no-op, NOT unregister the
    // pre-existing participant.
    mgr.remove('shared')
    expect(hub.participant('shared')).toBeDefined()
  })

  // Regression (surfaced by real-machine integration): Hub.unregister drops the
  // participant from the registry but never fires onShutdown — that runs only on
  // whole-hub stop(). An outbound ACP participant holds a long-lived child
  // subprocess (the codex/claude bridge), so the manager MUST terminate it on
  // remove/refresh or the process leaks after every admin delete/disable/edit.
  // (terminate() on a never-started session is a safe no-op, so letting the real
  // onShutdown run here is harmless.)
  describe('subprocess lifecycle (no leak on remove/edit)', () => {
    it('remove terminates the held participant (onShutdown), not just unregisters it', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'gone', capabilities: ['a'], command: 'npx' })
      mgr.refresh('gone')
      const shutdown = vi.spyOn(AcpParticipant.prototype, 'onShutdown')

      mgr.remove('gone')

      expect(hub.participant('gone')).toBeUndefined()
      // The fix: the participant hub.unregister() returns gets onShutdown()'d so
      // its child subprocess is killed (the call is synchronous; the kill ladder
      // it kicks off is fire-and-forget).
      expect(shutdown).toHaveBeenCalledTimes(1)
      shutdown.mockRestore()
    })

    it('refresh after an edit terminates the OLD participant before re-registering', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'editable', capabilities: ['a'], command: 'npx' })
      mgr.refresh('editable')
      const shutdown = vi.spyOn(AcpParticipant.prototype, 'onShutdown')

      identity.updateAcpAgent('editable', { command: 'codex-acp' })
      mgr.refresh('editable')

      // Old wrapper's subprocess terminated exactly once; the fresh wrapper stays
      // live with its own (lazy, independent) session.
      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(mgr.isLive('editable')).toBe(true)
      shutdown.mockRestore()
    })

    it('remove of an id we never owned never terminates a foreign participant', () => {
      hub.register(new StubAgent({ id: 'shared', capabilities: ['x'] }))
      const mgr = manager()
      const shutdown = vi.spyOn(AcpParticipant.prototype, 'onShutdown')

      mgr.remove('shared')

      // The early `!live.has(id)` guard returns before touching the hub, so no
      // onShutdown fires and the pre-existing participant is untouched.
      expect(shutdown).not.toHaveBeenCalled()
      expect(hub.participant('shared')).toBeDefined()
      shutdown.mockRestore()
    })
  })

  it('an id colliding with an existing participant is reported, not thrown', () => {
    hub.register(new StubAgent({ id: 'clash', capabilities: ['x'] }))
    identity.addAcpAgent({ id: 'clash', capabilities: ['a'], command: 'npx' })

    const mgr = manager()
    const res = mgr.refresh('clash')
    expect(res).toEqual({ active: false, reason: 'id_conflict' })
    // the pre-existing participant is untouched
    expect(hub.participant('clash')?.capabilities).toEqual(['x'])
    expect(mgr.isLive('clash')).toBe(false)
  })

  it('refresh on an unknown id reports not_found', () => {
    const res = manager().refresh('ghost')
    expect(res).toEqual({ active: false, reason: 'not_found' })
  })

  // The admin list reads liveness through statusOf, which must report the SAME
  // reason tryRegister would, WITHOUT mutating the hub.
  describe('statusOf (read-only liveness probe)', () => {
    it('reports active for a live agent', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'live', capabilities: ['a'], command: 'npx' })
      mgr.refresh('live')
      expect(mgr.statusOf('live')).toEqual({ active: true })
    })

    it('reports the inactive reason without touching the hub', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'disabled', capabilities: ['a'], command: 'npx', enabled: false })

      expect(mgr.statusOf('disabled')).toEqual({ active: false, reason: 'disabled' })
      expect(mgr.statusOf('ghost')).toEqual({ active: false, reason: 'not_found' })
      // a pure probe must never register anything
      expect(hub.participant('disabled')).toBeUndefined()
      expect(mgr.isLive('disabled')).toBe(false)
    })

    it('reports id_conflict when another participant owns the id', () => {
      hub.register(new StubAgent({ id: 'clash', capabilities: ['x'] }))
      identity.addAcpAgent({ id: 'clash', capabilities: ['a'], command: 'npx' })
      const mgr = manager()
      // enabled, yet we never registered it → owned by the stub.
      expect(mgr.statusOf('clash')).toEqual({ active: false, reason: 'id_conflict' })
    })
  })

  // --- Item 2: outbound data-class + quota gate at the ACP edge -------------
  // Same wiring proof as A2A, with one ACP-specific twist: the data-class gate
  // runs BEFORE the subprocess is spawned (`session.ensureStarted()`), so a
  // denied task never starts the coding agent. We prove that behaviorally with a
  // deliberately bogus command — a denial yields `outbound_data_class_denied`,
  // NOT an ENOENT from a spawn that should never have happened.
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
      const mgr = manager()
      identity.addAcpAgent({ id: 'classed', capabilities: ['code'], command: 'npx', allowedDataClasses: ['public'] })
      identity.addAcpAgent({ id: 'open', capabilities: ['code'], command: 'npx' })
      identity.addAcpAgent({ id: 'locked', capabilities: ['code'], command: 'npx', allowedDataClasses: [] })
      mgr.refresh('classed')
      mgr.refresh('open')
      mgr.refresh('locked')
      expect(gateOf('classed').allowedDataClasses).toEqual(['public'])
      expect(gateOf('open').allowedDataClasses).toBeNull() // no contract (legacy accept-all)
      expect(gateOf('locked').allowedDataClasses).toEqual([]) // lockdown — distinct from null
    })

    it('builds an outbound quota gate only when a budget is set', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'budgeted', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 3 })
      identity.addAcpAgent({ id: 'unbudgeted', capabilities: ['code'], command: 'npx' })
      mgr.refresh('budgeted')
      mgr.refresh('unbudgeted')
      expect(typeof gateOf('budgeted').outboundQuotaGate).toBe('function')
      expect(gateOf('unbudgeted').outboundQuotaGate).toBeUndefined()
    })

    it('a disallowed class fails fast — the subprocess is NEVER spawned (gate before ensureStarted)', async () => {
      const mgr = manager()
      // A deliberately bogus command: if the gate did not fire first,
      // ensureStarted() would try to spawn it and fail with ENOENT. Because the
      // data-class gate runs BEFORE ensureStarted(), we get a clean denial and the
      // binary is never touched.
      identity.addAcpAgent({ id: 'gov', capabilities: ['code'], command: '/nonexistent/acp-binary', allowedDataClasses: ['public'] })
      mgr.refresh('gov')
      const res = await hub.dispatch({
        from: 'human',
        strategy: { kind: 'explicit', to: 'gov' },
        payload: { text: 'review this' },
        dataClasses: ['secret'], // not in the ['public'] allowlist
      })
      expect(res.kind).toBe('failed')
      expect((res as { error?: string }).error).toContain('outbound_data_class_denied')
      // The bogus binary was never spawned — no ENOENT leaked through.
      expect((res as { error?: string }).error ?? '').not.toContain('ENOENT')
    })

    it('the quota gate enforces the budget (fail-closed past it)', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'q', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 2 })
      mgr.refresh('q')
      const gate = gateOf('q').outboundQuotaGate!
      expect(gate(undefined)).toBe(true) // 1
      expect(gate(undefined)).toBe(true) // 2
      expect(gate(undefined)).toBe(false) // 3 → over budget
    })

    it('the quota window survives a refresh — re-registering must NOT reset it', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'survive', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 2 })
      mgr.refresh('survive')
      const g1 = gateOf('survive').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(true) // budget of 2 exhausted this window
      mgr.refresh('survive') // an admin edit/toggle re-registers a fresh participant…
      const g2 = gateOf('survive').outboundQuotaGate!
      expect(g2(undefined)).toBe(false) // …but the limiter was reused — window carried over
    })

    it('changing the budget rebuilds the limiter (a fresh window)', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'rebudget', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 1 })
      mgr.refresh('rebudget')
      const g1 = gateOf('rebudget').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(false) // exhausted at budget 1
      identity.updateAcpAgent('rebudget', { outboundQuotaBudget: 5 })
      mgr.refresh('rebudget')
      const g2 = gateOf('rebudget').outboundQuotaGate!
      expect(g2(undefined)).toBe(true) // new limiter → fresh window
    })

    it('remove drops the quota counter — a later refresh starts fresh', () => {
      const mgr = manager()
      identity.addAcpAgent({ id: 'recycle', capabilities: ['code'], command: 'npx', outboundQuotaBudget: 1 })
      mgr.refresh('recycle')
      const g1 = gateOf('recycle').outboundQuotaGate!
      expect(g1(undefined)).toBe(true)
      expect(g1(undefined)).toBe(false) // exhausted
      mgr.remove('recycle') // the true-delete path drops the counter (unlike refresh)
      mgr.refresh('recycle') // row still exists → re-registers with a brand-new limiter
      const g2 = gateOf('recycle').outboundQuotaGate!
      expect(g2(undefined)).toBe(true) // fresh counter proves remove() cleared it
    })
  })
})
