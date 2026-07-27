/**
 * PUSH-M2 — per-member Web Push subscription store.
 *
 * Pins the ONE validator choke point (https-only, no localhost / IP literals
 * = the SSRF boundary, key shapes), the reachable/outbox family discipline
 * (assertSafeOwnerId before paths, per-user serialize chain, reader never
 * quarantines), and the loud cap (oldest dropped with a warn, never silently).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WEBPUSH_MAX_SUBSCRIPTIONS,
  WebPushStoreError,
  WebPushSubscriptionStore,
  validateSubscription,
} from '../src/web-push-store.js'

/** A syntactically valid subscription (real key shapes, fake endpoint). */
function sub(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  return {
    endpoint,
    keys: {
      // 65 bytes starting 0x04 / 16 bytes — the shapes the validator demands.
      p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  }
}

const dirs: string[] = []
const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
const logger = {
  info: () => {},
  warn: (msg: string, ctx?: Record<string, unknown>) => warns.push({ msg, ctx }),
  error: () => {},
}

function makeStore(now = () => 1_000) {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-webpush-store-'))
  dirs.push(dir)
  return { dir, store: new WebPushSubscriptionStore({ dir, logger, now }) }
}

afterEach(() => {
  warns.splice(0)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('add / list / remove round-trip', () => {
  it('persists per member, upserts by endpoint, removes idempotently', async () => {
    const { dir, store } = makeStore()
    const first = await store.add('user-1', { ...sub(), ua: 'Chrome on Android' })
    expect(first).toEqual({ count: 1, replaced: false, dropped: 0 })

    const rows = await store.list('user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ua).toBe('Chrome on Android')
    expect(rows[0]!.createdAt).toBe(1_000)
    // Flat family layout + atomic write left no tmp litter.
    expect(readFileSync(join(dir, 'user-1.json'), 'utf8')).toContain('fcm.googleapis.com')
    expect(readdirSync(dir).filter((f) => f.includes('tmp'))).toHaveLength(0)

    // Same endpoint again = update in place, not a second device.
    const again = await store.add('user-1', sub())
    expect(again).toEqual({ count: 1, replaced: true, dropped: 0 })

    expect(await store.remove('user-1', sub().endpoint)).toEqual({ removed: true })
    expect(await store.remove('user-1', sub().endpoint)).toEqual({ removed: false })
    expect(await store.list('user-1')).toHaveLength(0)
  })

  it('caps devices per member, dropping the oldest LOUDLY', async () => {
    const { store } = makeStore()
    for (let i = 0; i < WEBPUSH_MAX_SUBSCRIPTIONS; i++) {
      await store.add('user-1', sub(`https://push.example.net/device/${i}`))
    }
    const r = await store.add('user-1', sub('https://push.example.net/device/new'))
    expect(r.dropped).toBe(1)
    const rows = await store.list('user-1')
    expect(rows).toHaveLength(WEBPUSH_MAX_SUBSCRIPTIONS)
    expect(rows.some((s) => s.endpoint.endsWith('/device/0'))).toBe(false)
    expect(rows.some((s) => s.endpoint.endsWith('/device/new'))).toBe(true)
    expect(warns.some((w) => w.msg.includes('cap'))).toBe(true)
  })

  it('members are isolated files; concurrent adds serialize per user', async () => {
    const { store } = makeStore()
    await Promise.all([
      store.add('user-1', sub('https://push.example.net/a')),
      store.add('user-1', sub('https://push.example.net/b')),
      store.add('user-2', sub('https://push.example.net/c')),
    ])
    expect(await store.list('user-1')).toHaveLength(2)
    expect(await store.list('user-2')).toHaveLength(1)
  })

  it('markDelivered stamps lastOkAt and never throws for unknown endpoints', async () => {
    let t = 1_000
    const { store } = makeStore(() => t)
    await store.add('user-1', sub())
    t = 5_000
    await store.markDelivered('user-1', sub().endpoint)
    await store.markDelivered('user-1', 'https://push.example.net/never-stored')
    const rows = await store.list('user-1')
    expect(rows[0]!.lastOkAt).toBe(5_000)
  })
})

describe('the validator choke point (SSRF boundary + key shapes)', () => {
  const cases: Array<[string, unknown]> = [
    ['non-object', 'hi'],
    ['missing endpoint', { keys: sub().keys }],
    ['http endpoint', sub('http://fcm.googleapis.com/x')],
    ['localhost', sub('https://localhost/push')],
    ['*.localhost', sub('https://evil.localhost/push')],
    ['IPv4 literal (even public)', sub('https://8.8.8.8/push')],
    ['IPv4 literal (private)', sub('https://192.168.1.10/push')],
    ['IPv6 literal', sub('https://[::1]/push')],
    ['oversized endpoint', sub(`https://push.example.net/${'x'.repeat(2100)}`)],
    ['not a URL', sub('nonsense')],
    ['bad p256dh length', { ...sub(), keys: { ...sub().keys, p256dh: 'AAAA' } }],
    [
      'p256dh without the 0x04 prefix',
      { ...sub(), keys: { ...sub().keys, p256dh: Buffer.alloc(65, 5).toString('base64url') } },
    ],
    ['bad auth length', { ...sub(), keys: { ...sub().keys, auth: 'AAAA' } }],
    ['missing keys', { endpoint: sub().endpoint }],
  ]

  it.each(cases)('refuses %s with a typed invalid', (_label, input) => {
    try {
      validateSubscription(input, 0)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(WebPushStoreError)
      expect((err as WebPushStoreError).code).toBe('invalid')
    }
  })

  it('the store add() funnels through the same validator', async () => {
    const { store } = makeStore()
    await expect(store.add('user-1', sub('https://[::1]/push'))).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(await store.list('user-1')).toHaveLength(0)
  })

  it('bounds and control-strips the display-only ua', async () => {
    const { store } = makeStore()
    await store.add('user-1', { ...sub(), ua: `Chrome${String.fromCharCode(0x0a)}on${String.fromCharCode(0x202e)}X${'y'.repeat(200)}` })
    const rows = await store.list('user-1')
    expect(rows[0]!.ua).not.toContain(String.fromCharCode(0x0a))
    expect(rows[0]!.ua!.length).toBeLessThanOrEqual(80)
  })

  it('hostile userIds are refused before any path assembly', async () => {
    const { store } = makeStore()
    await expect(store.add('../escape', sub())).rejects.toThrow()
    await expect(store.list('../escape')).rejects.toThrow()
  })
})

describe('reader discipline (never quarantine)', () => {
  it('a malformed file yields [] with a warn — evidence left in place', async () => {
    const { dir, store } = makeStore()
    writeFileSync(join(dir, 'user-1.json'), 'not json at all')
    expect(await store.list('user-1')).toEqual([])
    expect(warns.some((w) => w.msg.includes('not valid JSON'))).toBe(true)
    expect(readFileSync(join(dir, 'user-1.json'), 'utf8')).toBe('not json at all')
  })

  it('malformed ENTRIES are skipped individually, good ones survive', async () => {
    const { dir, store } = makeStore()
    writeFileSync(
      join(dir, 'user-1.json'),
      JSON.stringify({
        subs: [
          { ...sub(), createdAt: 42 },
          { endpoint: 'http://insecure.example/x', keys: sub().keys, createdAt: 43 },
          'garbage',
        ],
      }),
    )
    const rows = await store.list('user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.createdAt).toBe(42)
    expect(warns.some((w) => w.msg.includes('skipped'))).toBe(true)
  })
})
