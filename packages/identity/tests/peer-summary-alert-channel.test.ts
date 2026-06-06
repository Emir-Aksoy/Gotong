/**
 * v5 Stream F day-3 — control-plane alert notification CHANNELS (via
 * IdentityStore → PeerSummaryAlertChannelStore).
 *
 * Coverage:
 *   - add: generates a `psac_` id, defaults enabled, round-trips fields
 *   - add: explicit id; label; headerEnv; enabled=false; reused id → alert_channel_exists
 *   - add validation: bad kind, non-http url, malformed url, bad headerEnv
 *   - get/list: null for missing, created_at ASC ordering
 *   - update: targeted (undefined = keep), toggle enabled, clear headerEnv;
 *     missing id → alert_channel_not_found
 *   - remove: true then false
 *   - no-secret invariant: the row holds only a destination + a toggle + an
 *     env-var NAME — never a bearer value
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — peer summary alert channels (v5 Stream F day-3)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('add generates a psac_ id, defaults enabled, round-trips fields', () => {
    const c = store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example.com/x' })
    expect(c.id).toMatch(/^psac_[0-9a-f]+$/)
    expect(c.kind).toBe('webhook')
    expect(c.url).toBe('https://hooks.example.com/x')
    expect(c.headerEnv).toBeNull()
    expect(c.enabled).toBe(true)
    expect(c.label).toBeNull()

    const back = store.getPeerSummaryAlertChannel(c.id)
    expect(back).not.toBeNull()
    expect(back!.url).toBe('https://hooks.example.com/x')
  })

  it('add accepts an explicit id, a label, a headerEnv, enabled=false', () => {
    const c = store.addPeerSummaryAlertChannel({
      id: 'chan-1',
      kind: 'webhook',
      url: 'http://localhost:9000/alerts',
      headerEnv: 'AIPE_ALERT_WEBHOOK_TOKEN',
      label: 'ops slack',
      enabled: false,
    })
    expect(c.id).toBe('chan-1')
    expect(c.headerEnv).toBe('AIPE_ALERT_WEBHOOK_TOKEN')
    expect(c.label).toBe('ops slack')
    expect(c.enabled).toBe(false)
  })

  it('a reused explicit id → alert_channel_exists', () => {
    store.addPeerSummaryAlertChannel({ id: 'dup', kind: 'webhook', url: 'https://a.example/x' })
    try {
      store.addPeerSummaryAlertChannel({ id: 'dup', kind: 'webhook', url: 'https://b.example/y' })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as IdentityError).code).toBe('alert_channel_exists')
    }
  })

  it('rejects a bad kind, a non-http url, a malformed url, and a bad headerEnv', () => {
    expect(() =>
      // @ts-expect-error — kind outside the closed set
      store.addPeerSummaryAlertChannel({ kind: 'carrier-pigeon', url: 'https://a.example/x' }),
    ).toThrow(IdentityError)
    expect(() =>
      store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'file:///etc/passwd' }),
    ).toThrow(IdentityError)
    expect(() =>
      store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'not a url' }),
    ).toThrow(IdentityError)
    // headerEnv must be an env-var NAME, not a bearer value (no spaces/punct).
    expect(() =>
      store.addPeerSummaryAlertChannel({
        kind: 'webhook',
        url: 'https://a.example/x',
        headerEnv: 'Bearer sk-secret-123',
      }),
    ).toThrow(IdentityError)
  })

  it('get returns null for a missing id; list is created_at ASC', () => {
    expect(store.getPeerSummaryAlertChannel('nope')).toBeNull()
    const a = store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://a.example/x' })
    const b = store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://b.example/y' })
    expect(store.listPeerSummaryAlertChannels().map((c) => c.id)).toEqual([a.id, b.id])
  })

  it('update is targeted (undefined = keep), toggles enabled, clears headerEnv', () => {
    const c = store.addPeerSummaryAlertChannel({
      kind: 'webhook',
      url: 'https://a.example/x',
      headerEnv: 'TOKEN_A',
    })
    const u1 = store.updatePeerSummaryAlertChannel(c.id, { enabled: false })
    expect(u1.enabled).toBe(false)
    expect(u1.url).toBe('https://a.example/x') // untouched
    expect(u1.headerEnv).toBe('TOKEN_A') // untouched

    const u2 = store.updatePeerSummaryAlertChannel(c.id, { url: 'https://a.example/y', headerEnv: null })
    expect(u2.url).toBe('https://a.example/y')
    expect(u2.headerEnv).toBeNull()

    try {
      store.updatePeerSummaryAlertChannel('missing', { enabled: true })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as IdentityError).code).toBe('alert_channel_not_found')
    }
  })

  it('remove returns true then false', () => {
    const c = store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://a.example/x' })
    expect(store.removePeerSummaryAlertChannel(c.id)).toBe(true)
    expect(store.removePeerSummaryAlertChannel(c.id)).toBe(false)
  })

  it('a channel holds only a destination + a toggle + an env-var NAME — never a secret value', () => {
    const c = store.addPeerSummaryAlertChannel({
      kind: 'webhook',
      url: 'https://a.example/x',
      headerEnv: 'TOKEN',
    })
    expect(Object.keys(c).sort()).toEqual(
      ['createdAt', 'enabled', 'headerEnv', 'id', 'kind', 'label', 'updatedAt', 'url'].sort(),
    )
    // headerEnv is the NAME of an env var, not its value.
    expect(c.headerEnv).toBe('TOKEN')
  })
})
