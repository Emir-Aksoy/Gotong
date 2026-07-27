/**
 * PUSH-M3 — the Web Push delivery leg + the B1 fold + env assembly.
 *
 * Pins, in order:
 *   - a real subscription (real UA keypair) receives a request this test can
 *     DECRYPT with only the browser-side materials — proving the payload is
 *     the fixed low-info tap, RFC 8291-sealed, with VAPID/TTL/Topic headers;
 *   - multi-device fan-out, 404/410 self-heal pruning, all-fail = send_failed,
 *     no subs = unknown_member;
 *   - foldWebPushIntoPush: IM delivered / transient failures NEVER touch the
 *     tap (byte-identical for IM-bound members); only unknown_member falls
 *     through; a failed tap preserves the original result for the outbox;
 *   - buildWebPushService: unset knob ⇒ undefined; malformed ⇒ warn + OFF;
 *     valid ⇒ key file + surface + disclosure that never leaks the private key.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { foldWebPushIntoPush } from '../src/im-bridge.js'
import type { ButlerPushResult } from '../src/butler-reachable.js'
import { loadOrCreateWebPushKey } from '../src/web-push-protocol.js'
import { WebPushSubscriptionStore } from '../src/web-push-store.js'
import { WebPushSender, buildWebPushService } from '../src/web-push-sender.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-webpush-sender-'))
  dirs.push(dir)
  return dir
}

const warns: string[] = []
const infos: string[] = []
const logger = {
  info: (msg: string) => {
    infos.push(msg)
  },
  warn: (msg: string) => {
    warns.push(msg)
  },
  error: () => {},
}

afterEach(() => {
  warns.splice(0)
  infos.splice(0)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One simulated browser device: UA keypair + auth secret + subscription row. */
function makeDevice(endpoint: string) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) auth[i] = (i * 37 + endpoint.length) & 0xff
  return {
    ecdh,
    auth,
    sub: {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
    },
  }
}

/** Browser-side aes128gcm decrypt (same shape as the M1 protocol test). */
function uaDecrypt(body: Buffer, uaEcdh: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const idlen = body[20]!
  const asPublic = body.subarray(21, 21 + idlen)
  const sealed = body.subarray(21 + idlen)
  const secret = uaEcdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  const delim = padded.lastIndexOf(0x02)
  return padded.subarray(0, delim)
}

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Buffer
}

/** fetch stub: per-endpoint status codes, captures everything it sees. */
function makeFetch(statusFor: (url: string) => number) {
  const seen: CapturedRequest[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    seen.push({ url, headers, body: Buffer.from(init?.body as Uint8Array) })
    const status = statusFor(url)
    return new Response(null, { status })
  }) as typeof fetch
  return { seen, fetchImpl }
}

function makeSender(opts: {
  statusFor: (url: string) => number
  now?: () => number
}) {
  const dir = tempDir()
  const key = loadOrCreateWebPushKey(join(dir, 'webpush-vapid.key'))
  const store = new WebPushSubscriptionStore({ dir: join(dir, 'push'), logger })
  const { seen, fetchImpl } = makeFetch(opts.statusFor)
  const sender = new WebPushSender({
    key,
    subject: 'mailto:ops@example.net',
    store,
    logger,
    fetchImpl,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { key, store, sender, seen }
}

describe('WebPushSender.push — the low-info tap', () => {
  it('delivers to every device; the request decrypts to the fixed tap and never member text', async () => {
    const { key, store, sender, seen } = makeSender({ statusFor: () => 201 })
    const a = makeDevice('https://fcm.googleapis.com/wp/device-a')
    const b = makeDevice('https://updates.push.services.mozilla.com/wpush/v2/device-b')
    await store.add('user-1', a.sub)
    await store.add('user-1', b.sub)

    const r = await sender.push('user-1')
    expect(r).toEqual({ delivered: true })
    expect(seen).toHaveLength(2)

    // Device A's request: headers + VAPID audience + decryptable payload.
    const reqA = seen.find((s) => s.url === a.sub.endpoint)!
    expect(reqA.headers['content-encoding']).toBe('aes128gcm')
    expect(reqA.headers['content-type']).toBe('application/octet-stream')
    expect(reqA.headers.ttl).toBe(String(24 * 3600))
    expect(reqA.headers.urgency).toBe('normal')
    expect(reqA.headers.topic).toBe('gotong-butler-tap')
    expect(reqA.headers.authorization).toMatch(/^vapid t=.+, k=.+$/)
    // k= is OUR applicationServerKey; the JWT aud is the push-service origin.
    expect(reqA.headers.authorization).toContain(`k=${key.applicationServerKey}`)
    const jwtPayload = JSON.parse(
      Buffer.from(reqA.headers.authorization.match(/t=([^,]+),/)![1]!.split('.')[1]!, 'base64url').toString('utf8'),
    )
    expect(jwtPayload.aud).toBe('https://fcm.googleapis.com')
    expect(jwtPayload.sub).toBe('mailto:ops@example.net')

    const plainA = JSON.parse(uaDecrypt(reqA.body, a.ecdh, a.auth).toString('utf8'))
    expect(plainA).toEqual({ title: '阿同 · Gotong', body: '有新消息,点开查看 · New message' })

    // Device B decrypts independently (per-subscription encryption), and its
    // VAPID audience follows ITS endpoint origin.
    const reqB = seen.find((s) => s.url === b.sub.endpoint)!
    const jwtB = JSON.parse(
      Buffer.from(reqB.headers.authorization.match(/t=([^,]+),/)![1]!.split('.')[1]!, 'base64url').toString('utf8'),
    )
    expect(jwtB.aud).toBe('https://updates.push.services.mozilla.com')
    expect(JSON.parse(uaDecrypt(reqB.body, b.ecdh, b.auth).toString('utf8')).title).toBe('阿同 · Gotong')

    // Delivery stamped lastOkAt on both rows.
    const rows = await store.list('user-1')
    expect(rows.every((row) => typeof row.lastOkAt === 'number')).toBe(true)
  })

  it('404/410 prunes that subscription (self-heal) while others still deliver', async () => {
    const { store, sender, seen } = makeSender({
      statusFor: (url) => (url.includes('dead') ? 410 : 201),
    })
    const dead = makeDevice('https://push.example.net/dead-device')
    const live = makeDevice('https://push.example.net/live-device')
    await store.add('user-1', dead.sub)
    await store.add('user-1', live.sub)

    const r = await sender.push('user-1')
    expect(r).toEqual({ delivered: true })
    expect(seen).toHaveLength(2)
    const rows = await store.list('user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.endpoint).toBe(live.sub.endpoint)
    expect(infos.some((m) => m.includes('pruned'))).toBe(true)
  })

  it('no subscriptions → unknown_member (so the fold treats web like any other missing route)', async () => {
    const { sender, seen } = makeSender({ statusFor: () => 201 })
    expect(await sender.push('user-none')).toEqual({ delivered: false, reason: 'unknown_member' })
    expect(seen).toHaveLength(0)
  })

  it('every device refusing (5xx) → send_failed with warns, rows kept for retry', async () => {
    const { store, sender } = makeSender({ statusFor: () => 500 })
    await store.add('user-1', makeDevice('https://push.example.net/a').sub)
    expect(await sender.push('user-1')).toEqual({ delivered: false, reason: 'send_failed' })
    expect(await store.list('user-1')).toHaveLength(1)
    expect(warns.some((m) => m.includes('refused'))).toBe(true)
  })
})

describe('foldWebPushIntoPush — B1 strictly gap-filling', () => {
  const ok: ButlerPushResult = { delivered: true }
  const unknown: ButlerPushResult = { delivered: false, reason: 'unknown_member' }
  const noBridge: ButlerPushResult = { delivered: false, reason: 'no_bridge' }

  function tapSpy(result: ButlerPushResult) {
    const calls: string[] = []
    const tap = async (userId: string) => {
      calls.push(userId)
      return result
    }
    return { calls, tap }
  }

  it('IM delivered → tap NOT called (IM-bound members byte-identical)', async () => {
    const { calls, tap } = tapSpy(ok)
    const fold = foldWebPushIntoPush(async () => ok, tap)
    expect(await fold('u', 'hello')).toEqual(ok)
    expect(calls).toHaveLength(0)
  })

  it('transient IM failure (no_bridge) → tap NOT called; outbox retry story owns it', async () => {
    const { calls, tap } = tapSpy(ok)
    const fold = foldWebPushIntoPush(async () => noBridge, tap)
    expect(await fold('u', 'hello')).toEqual(noBridge)
    expect(calls).toHaveLength(0)
  })

  it('unknown_member → tap fires with ONLY the userId and its success is the result', async () => {
    const { calls, tap } = tapSpy(ok)
    const fold = foldWebPushIntoPush(async () => unknown, tap)
    expect(await fold('u', 'secret text')).toEqual(ok)
    expect(calls).toEqual(['u'])
  })

  it('tap also failing → the ORIGINAL unknown_member survives (outbox queues + retries the chain)', async () => {
    const { calls, tap } = tapSpy({ delivered: false, reason: 'send_failed' })
    const fold = foldWebPushIntoPush(async () => unknown, tap)
    expect(await fold('u', 'x')).toEqual(unknown)
    expect(calls).toEqual(['u'])
  })

  it('no tap configured → the exact same push function (no wrapper at all)', async () => {
    const push = async () => unknown
    expect(foldWebPushIntoPush(push, undefined)).toBe(push)
  })
})

describe('buildWebPushService — the GOTONG_WEBPUSH knob', () => {
  it('unset ⇒ undefined and NO key file is created (byte-identical hub)', () => {
    const dir = tempDir()
    expect(buildWebPushService(dir, logger, {})).toBeUndefined()
    expect(existsSync(join(dir, 'webpush-vapid.key'))).toBe(false)
  })

  it('malformed subject ⇒ warn + OFF (fail-closed, no key file)', () => {
    const dir = tempDir()
    expect(buildWebPushService(dir, logger, { GOTONG_WEBPUSH: 'ops@example.net' })).toBeUndefined()
    expect(warns.some((m) => m.includes('GOTONG_WEBPUSH'))).toBe(true)
    expect(existsSync(join(dir, 'webpush-vapid.key'))).toBe(false)
  })

  it('valid mailto ⇒ service with key file, working surface, and a disclosure without the private key', async () => {
    const dir = tempDir()
    const svc = buildWebPushService(dir, logger, { GOTONG_WEBPUSH: 'mailto:ops@example.net' })!
    expect(svc).toBeDefined()
    expect(existsSync(join(dir, 'webpush-vapid.key'))).toBe(true)

    // applicationServerKey round-trips through the surface; 65-byte P-256 point.
    const pub = svc.surface.publicKey()
    expect(Buffer.from(pub, 'base64url')).toHaveLength(65)
    expect(svc.disclosure).toContain('mailto:ops@example.net')
    expect(svc.disclosure).toContain(pub)
    expect(svc.disclosure).not.toContain('PRIVATE KEY')

    // Surface add/count/remove reach the real store under <space>/butler/push.
    const dev = makeDevice('https://push.example.net/from-surface')
    await svc.surface.add('user-9', dev.sub)
    expect(await svc.surface.count('user-9')).toBe(1)
    expect(existsSync(join(dir, 'butler', 'push', 'user-9.json'))).toBe(true)
    expect((await svc.surface.remove('user-9', dev.sub.endpoint)).removed).toBe(true)

    // fallback(userId) is the sender's low-info leg — no-subscription member
    // resolves unknown_member without any network.
    expect(await svc.fallback('user-none')).toEqual({ delivered: false, reason: 'unknown_member' })

    // The disclosure never leaks key FILE contents either.
    const pem = readFileSync(join(dir, 'webpush-vapid.key'), 'utf8')
    expect(pem).toContain('PRIVATE KEY')
    expect(svc.disclosure.includes(pem.trim())).toBe(false)
  })
})
