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

import { describe, it, expect, beforeEach } from 'vitest'

import { Hub, AgentParticipant, type Logger, type Task } from '@aipehub/core'
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
})
