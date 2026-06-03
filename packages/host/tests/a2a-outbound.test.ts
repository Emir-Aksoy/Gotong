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
})
