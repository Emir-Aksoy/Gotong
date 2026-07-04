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
      headerEnv: 'GOTONG_ALERT_WEBHOOK_TOKEN',
      label: 'ops slack',
      enabled: false,
    })
    expect(c.id).toBe('chan-1')
    expect(c.headerEnv).toBe('GOTONG_ALERT_WEBHOOK_TOKEN')
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
    // platform/target are DESTINATION bits (null for webhook), not secrets —
    // the only sensitive field is headerEnv, and it's an env-var NAME.
    expect(Object.keys(c).sort()).toEqual(
      ['createdAt', 'enabled', 'headerEnv', 'id', 'kind', 'label', 'platform', 'target', 'updatedAt', 'url'].sort(),
    )
    // headerEnv is the NAME of an env var, not its value.
    expect(c.headerEnv).toBe('TOKEN')
  })

  // --- multi-channel pass (im / email kinds + platform/target columns) ---

  it('webhook leaves platform and target null', () => {
    const c = store.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://a.example/x' })
    expect(c.platform).toBeNull()
    expect(c.target).toBeNull()
  })

  it('im add requires a platform from the closed set, round-trips an optional target', () => {
    const c = store.addPeerSummaryAlertChannel({
      kind: 'im',
      url: 'https://api.telegram.org/bot/sendMessage',
      platform: 'telegram',
      target: '-1001234567890',
      headerEnv: 'TG_BOT_TOKEN',
    })
    expect(c.kind).toBe('im')
    expect(c.platform).toBe('telegram')
    expect(c.target).toBe('-1001234567890')
    expect(c.headerEnv).toBe('TG_BOT_TOKEN')

    // incoming-webhook platforms (slack/discord/lark) target via the url, so
    // target is optional for im.
    const slack = store.addPeerSummaryAlertChannel({
      kind: 'im',
      url: 'https://hooks.slack.com/services/T/B/x',
      platform: 'slack',
    })
    expect(slack.platform).toBe('slack')
    expect(slack.target).toBeNull()
  })

  it('im rejects a missing or out-of-set platform', () => {
    expect(() =>
      store.addPeerSummaryAlertChannel({ kind: 'im', url: 'https://a.example/x' }),
    ).toThrow(IdentityError)
    expect(() =>
      // @ts-expect-error — platform outside the closed set
      store.addPeerSummaryAlertChannel({ kind: 'im', url: 'https://a.example/x', platform: 'myspace' }),
    ).toThrow(IdentityError)
  })

  it('email requires a target (the recipient) and forces platform null', () => {
    expect(() =>
      store.addPeerSummaryAlertChannel({ kind: 'email', url: 'https://api.mailer.example/send' }),
    ).toThrow(IdentityError)

    const c = store.addPeerSummaryAlertChannel({
      kind: 'email',
      url: 'https://api.mailer.example/send',
      target: 'ops@example.com',
      headerEnv: 'MAILER_API_KEY',
    })
    expect(c.kind).toBe('email')
    expect(c.target).toBe('ops@example.com')
    expect(c.platform).toBeNull() // platform is im-only
  })

  it('a kind switch scrubs now-irrelevant platform/target', () => {
    const c = store.addPeerSummaryAlertChannel({
      kind: 'im',
      url: 'https://api.telegram.org/bot/sendMessage',
      platform: 'telegram',
      target: 'chat-1',
    })
    // im → webhook: platform/target become meaningless and are nulled.
    const w = store.updatePeerSummaryAlertChannel(c.id, { kind: 'webhook' })
    expect(w.platform).toBeNull()
    expect(w.target).toBeNull()

    // webhook → email without supplying a recipient must fail (email needs target).
    expect(() => store.updatePeerSummaryAlertChannel(c.id, { kind: 'email' })).toThrow(IdentityError)

    // webhook → email WITH a recipient succeeds and keeps platform null.
    const e = store.updatePeerSummaryAlertChannel(c.id, { kind: 'email', target: 'ops@example.com' })
    expect(e.kind).toBe('email')
    expect(e.target).toBe('ops@example.com')
    expect(e.platform).toBeNull()
  })
})
