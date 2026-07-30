/**
 * SHELL-M6A — the shared native-push core + the FCM (Android) leg.
 *
 * Pins, in order:
 *   - validateNativeToken / NativePushTokenStore: per-platform token shapes
 *     (ios hex folded lowercase, android verbatim case-SENSITIVE), the
 *     allowedPlatforms registration gate, reads serving BOTH platforms even
 *     when a leg's config bounced, cap/prune/reader disciplines (mirrors
 *     web-push-store);
 *   - loadFcmConfig: absent ⇒ OFF; not a service-account JSON ⇒ warn + OFF;
 *     opted in but private_key unusable / non-RSA ⇒ throws loudly;
 *   - buildGoogleAssertion verified INDEPENDENTLY with node:crypto
 *     createVerify('RSA-SHA256') — outside-verifier posture;
 *   - FcmSender against a REAL node:http HTTP mock covering BOTH endpoints
 *     (OAuth2 token grant + /v1/.../messages:send): exact path/headers, the
 *     body is the fixed low-info TAP (push() has no text parameter), ios rows
 *     invisible, 45-min access-token cache, 404/UNREGISTERED and
 *     SENDER_ID_MISMATCH prune, 401 drops the token cache;
 *   - composeTapFallback merge semantics (parallel legs, ≥1 ok, honest
 *     reasons);
 *   - buildNativePushService: no files ⇒ undefined; per-file legs raise their
 *     platform only; registration for an unserved platform is refused;
 *     disclosures never contain key bytes; the composed fallback delivers
 *     end-to-end through the FCM mock.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ButlerPushResult } from '../src/butler-reachable.js'
import {
  FcmSender,
  NativePushTokenStore,
  buildGoogleAssertion,
  buildNativePushService,
  composeTapFallback,
  loadFcmConfig,
  validateNativeToken,
} from '../src/native-push.js'
import { TAP_PAYLOAD } from '../src/web-push-sender.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-fcm-'))
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

const servers: Server[] = []

afterEach(() => {
  warns.splice(0)
  infos.splice(0)
  for (const s of servers.splice(0)) s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// One RSA pair for the whole file — keygen is the slow part, the pins aren't.
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 })
const RSA_PEM = RSA.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

const TOKEN_A = 'a'.repeat(64)
const DROID_A = 'dEvIcE:' + 'x'.repeat(40)
const DROID_B = 'droid-b_' + 'y'.repeat(40)

function writeFcmConfig(spaceRoot: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(spaceRoot, 'fcm.json'),
    JSON.stringify({
      type: 'service_account',
      project_id: 'gotong-test',
      private_key_id: 'fcmkid0001',
      private_key: RSA_PEM,
      client_email: 'push@gotong-test.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
      ...overrides,
    }),
  )
}

interface FcmSeenSend {
  path: string
  auth: string
  body: { message?: { token?: string } } & Record<string, unknown>
}

/**
 * Real HTTP/1.1 mock serving BOTH Google endpoints: POST /token answers the
 * OAuth2 JWT-bearer grant with sequential access tokens (at-1, at-2, …);
 * everything else is messages:send, answered per device token.
 */
function mockFcm(
  respond: (token: string) => { status: number; body?: unknown },
): Promise<{ origin: string; tokenGrants: string[]; sends: FcmSeenSend[] }> {
  const tokenGrants: string[] = []
  const sends: FcmSeenSend[] = []
  let minted = 0
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/token') {
        tokenGrants.push(body)
        minted++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: `at-${minted}`, expires_in: 3600, token_type: 'Bearer' }))
        return
      }
      const parsed = JSON.parse(body) as FcmSeenSend['body']
      sends.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: parsed })
      const r = respond(String(parsed.message?.token ?? ''))
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body === undefined ? '{}' : JSON.stringify(r.body))
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ origin: `http://127.0.0.1:${addr.port}`, tokenGrants, sends })
    })
  })
}

function makeSender(
  origin: string,
  opts: { now?: () => number } = {},
): { sender: FcmSender; store: NativePushTokenStore } {
  const dir = tempDir()
  writeFcmConfig(dir, { token_uri: `${origin}/token` })
  const loaded = loadFcmConfig(dir, logger)!
  const store = new NativePushTokenStore({ dir: join(dir, 'pn'), logger })
  const sender = new FcmSender({
    config: loaded.config,
    privateKey: loaded.privateKey,
    store,
    logger,
    endpointOverride: origin,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { sender, store }
}

describe('validateNativeToken / NativePushTokenStore', () => {
  it('ios: 16–200 hex folded lowercase; android: 32–512 verbatim, case preserved', () => {
    const ios = validateNativeToken({ token: ' ' + TOKEN_A.toUpperCase() + ' ', platform: 'ios' }, 7)
    expect(ios).toEqual({ token: TOKEN_A, platform: 'ios', createdAt: 7 })
    expect(() => validateNativeToken({ token: 'zzzz', platform: 'ios' }, 1)).toThrow(/hex/)

    const droid = validateNativeToken({ token: DROID_A, platform: 'android' }, 9)
    expect(droid).toEqual({ token: DROID_A, platform: 'android', createdAt: 9 })
    expect(() => validateNativeToken({ token: 'short', platform: 'android' }, 1)).toThrow(/32/)
    expect(() => validateNativeToken({ token: 'x'.repeat(30) + '+/', platform: 'android' }, 1)).toThrow(/token chars/)
    expect(() => validateNativeToken({ token: DROID_A, platform: 'web' }, 1)).toThrow(/"ios" or "android"/)
  })

  it('allowedPlatforms gates registration — a leg-less platform is refused loudly', () => {
    expect(() => validateNativeToken({ token: DROID_A, platform: 'android' }, 1, ['ios'])).toThrow(
      /no push leg for "android"/,
    )
    try {
      validateNativeToken({ token: TOKEN_A, platform: 'ios' }, 1, [])
      expect.unreachable()
    } catch (err) {
      expect((err as { code?: string }).code).toBe('invalid')
      expect(String(err)).toContain('serves: none')
    }
  })

  it('reads serve BOTH platforms even when a leg is paused (config bounced ≠ registrations destroyed)', async () => {
    const dir = join(tempDir(), 'pn')
    const both = new NativePushTokenStore({ dir, logger })
    await both.add('u1', { token: TOKEN_A, platform: 'ios' })
    await both.add('u1', { token: DROID_A, platform: 'android' })

    const iosOnly = new NativePushTokenStore({ dir, logger, allowedPlatforms: ['ios'] })
    expect((await iosOnly.list('u1')).map((t) => t.platform).sort()).toEqual(['android', 'ios'])
    await expect(iosOnly.add('u1', { token: DROID_B, platform: 'android' })).rejects.toThrow(/no push leg/)
  })

  it('remove folds case for ios rows only — android tokens are case-sensitive', async () => {
    const store = new NativePushTokenStore({ dir: join(tempDir(), 'pn'), logger })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    await store.add('u1', { token: DROID_A, platform: 'android' })
    expect(await store.remove('u1', DROID_A.toLowerCase())).toEqual({ removed: false })
    expect(await store.remove('u1', DROID_A)).toEqual({ removed: true })
    expect(await store.remove('u1', TOKEN_A.toUpperCase())).toEqual({ removed: true })
  })

  it('upserts by token, caps at 5 dropping the oldest loudly, removes idempotently', async () => {
    const store = new NativePushTokenStore({ dir: join(tempDir(), 'pn'), logger, now: () => 1 })
    for (let i = 0; i < 5; i++) {
      await store.add('u1', { token: String(i).repeat(32), platform: 'ios' })
    }
    const again = await store.add('u1', { token: '4'.repeat(32), platform: 'ios' })
    expect(again.replaced).toBe(true)
    expect(again.count).toBe(5)
    const sixth = await store.add('u1', { token: 'f'.repeat(32), platform: 'ios' })
    expect(sixth.dropped).toBe(1)
    expect(warns.some((w) => w.includes('cap reached'))).toBe(true)
    const list = await store.list('u1')
    expect(list).toHaveLength(5)
    expect(list.some((t) => t.token === '0'.repeat(32))).toBe(false)

    expect(await store.remove('u1', 'f'.repeat(32))).toEqual({ removed: true })
    expect(await store.remove('u1', 'f'.repeat(32))).toEqual({ removed: false })
  })

  it('reader never quarantines: bad file ⇒ warn + [], bad entries skipped', async () => {
    const dir = join(tempDir(), 'pn')
    const store = new NativePushTokenStore({ dir, logger })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    writeFileSync(join(dir, 'u2.json'), 'not json')
    expect(await store.list('u2')).toEqual([])
    expect(warns.some((w) => w.includes('not valid JSON'))).toBe(true)
    writeFileSync(
      join(dir, 'u3.json'),
      JSON.stringify({
        tokens: [{ token: 'zz', platform: 'ios' }, { token: DROID_B, platform: 'android', createdAt: 3 }],
      }),
    )
    const rows = await store.list('u3')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token).toBe(DROID_B)
  })

  it('refuses hostile userIds before any path assembly', async () => {
    const store = new NativePushTokenStore({ dir: join(tempDir(), 'pn'), logger })
    await expect(store.list('../../etc')).rejects.toThrow()
  })
})

describe('loadFcmConfig', () => {
  it('absent file ⇒ undefined (OFF, byte-identical hub)', () => {
    expect(loadFcmConfig(tempDir(), logger)).toBeUndefined()
    expect(warns).toHaveLength(0)
  })

  it('malformed JSON / not a service-account JSON ⇒ warn + OFF', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fcm.json'), '{not json')
    expect(loadFcmConfig(dir, logger)).toBeUndefined()
    expect(warns.some((w) => w.includes('not valid JSON'))).toBe(true)

    const dir2 = tempDir()
    writeFcmConfig(dir2, { type: 'user' })
    expect(loadFcmConfig(dir2, logger)).toBeUndefined()
    const dir3 = tempDir()
    writeFcmConfig(dir3, { project_id: undefined })
    expect(loadFcmConfig(dir3, logger)).toBeUndefined()
    expect(warns.some((w) => w.includes('service-account'))).toBe(true)
  })

  it('opted in but private_key garbage or non-RSA ⇒ THROWS (loud boot)', () => {
    const dir = tempDir()
    writeFcmConfig(dir, { private_key: 'not a key' })
    expect(() => loadFcmConfig(dir, logger)).toThrow(/not a readable private key/)

    const dir2 = tempDir()
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    writeFcmConfig(dir2, { private_key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string })
    expect(() => loadFcmConfig(dir2, logger)).toThrow(/must be an RSA key/)
  })

  it('valid service-account JSON ⇒ loads verbatim fields; token_uri defaults when absent', () => {
    const dir = tempDir()
    writeFcmConfig(dir)
    const loaded = loadFcmConfig(dir, logger)!
    expect(loaded.config).toEqual({
      projectId: 'gotong-test',
      clientEmail: 'push@gotong-test.iam.gserviceaccount.com',
      tokenUri: 'https://oauth2.googleapis.com/token',
      privateKeyId: 'fcmkid0001',
    })
    expect(loaded.privateKey.asymmetricKeyType).toBe('rsa')

    const dir2 = tempDir()
    writeFcmConfig(dir2, { token_uri: undefined, private_key_id: undefined })
    const loaded2 = loadFcmConfig(dir2, logger)!
    expect(loaded2.config.tokenUri).toBe('https://oauth2.googleapis.com/token')
    expect(loaded2.config.privateKeyId).toBeUndefined()
  })
})

describe('buildGoogleAssertion', () => {
  it('is an RS256 JWT-bearer assertion an independent node:crypto verifier accepts', () => {
    const jwt = buildGoogleAssertion({
      clientEmail: 'push@gotong-test.iam.gserviceaccount.com',
      tokenUri: 'https://oauth2.googleapis.com/token',
      privateKey: RSA.privateKey,
      privateKeyId: 'fcmkid0001',
      now: () => 1_700_000_123_456,
    })
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'fcmkid0001',
    })
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString('utf8'))).toEqual({
      iss: 'push@gotong-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_123,
      exp: 1_700_000_123 + 3600,
    })
    const ok = createVerify('RSA-SHA256')
      .update(Buffer.from(`${h}.${c}`, 'utf8'))
      .verify(RSA.publicKey, Buffer.from(s!, 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('FcmSender (real HTTP mock: OAuth2 grant + messages:send)', () => {
  it('mints via JWT-bearer grant, POSTs the fixed low-info tap; ios rows invisible; caches the access token', async () => {
    const { origin, tokenGrants, sends } = await mockFcm(() => ({ status: 200, body: { name: 'projects/x/messages/1' } }))
    const { sender, store } = makeSender(origin)
    await store.add('u1', { token: DROID_A, platform: 'android' })
    // An ios row on the same member must never reach FCM.
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })

    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect(sends).toHaveLength(1)
    const req = sends[0]!
    expect(req.path).toBe('/v1/projects/gotong-test/messages:send')
    expect(req.auth).toBe('Bearer at-1')
    // EXACTLY the content-free tap — push() has no text parameter.
    expect(req.body).toEqual({
      message: {
        token: DROID_A,
        notification: { title: TAP_PAYLOAD.title, body: TAP_PAYLOAD.body },
        android: { ttl: '86400s', collapseKey: 'gotong-butler-tap' },
      },
    })

    // The grant carried a verifiable assertion for OUR service account.
    expect(tokenGrants).toHaveLength(1)
    const grant = new URLSearchParams(tokenGrants[0]!)
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, c, s] = grant.get('assertion')!.split('.')
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')).iss).toBe(
      'push@gotong-test.iam.gserviceaccount.com',
    )
    const ok = createVerify('RSA-SHA256')
      .update(Buffer.from(`${h}.${c}`, 'utf8'))
      .verify(RSA.publicKey, Buffer.from(s!, 'base64url'))
    expect(ok).toBe(true)

    // Second push within 45min: no new grant, and only the android row stamps.
    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect(tokenGrants).toHaveLength(1)
    expect(sends).toHaveLength(2)
    const rows = await store.list('u1')
    expect(rows.find((r) => r.platform === 'android')!.lastOkAt).toBeGreaterThan(0)
    expect(rows.find((r) => r.platform === 'ios')!.lastOkAt).toBeUndefined()
  })

  it('404/UNREGISTERED prunes that token; a surviving device still delivers', async () => {
    const { origin } = await mockFcm((token) =>
      token === DROID_A
        ? {
            status: 404,
            body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
          }
        : { status: 200 },
    )
    const { sender, store } = makeSender(origin)
    await store.add('u1', { token: DROID_A, platform: 'android' })
    await store.add('u1', { token: DROID_B, platform: 'android' })

    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect((await store.list('u1')).map((r) => r.token)).toEqual([DROID_B])
    expect(infos.some((m) => m.includes('pruned'))).toBe(true)
  })

  it('SENDER_ID_MISMATCH (token from another Firebase project) also prunes', async () => {
    const { origin } = await mockFcm(() => ({
      status: 403,
      body: { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } },
    }))
    const { sender, store } = makeSender(origin)
    await store.add('u1', { token: DROID_A, platform: 'android' })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'send_failed' })
    expect(await store.list('u1')).toEqual([])
  })

  it('401 drops the access-token cache so the next push re-mints', async () => {
    let first = true
    const { origin, tokenGrants, sends } = await mockFcm(() => {
      if (first) {
        first = false
        return { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }
      }
      return { status: 200 }
    })
    let nowMs = 1_700_000_000_000
    const { sender, store } = makeSender(origin, { now: () => nowMs })
    await store.add('u1', { token: DROID_A, platform: 'android' })

    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'send_failed' })
    expect(warns.some((w) => w.includes('access token refused'))).toBe(true)
    nowMs += 60_000 // well under the 45min refresh — only the 401 explains a new mint
    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect(tokenGrants).toHaveLength(2)
    expect(sends[1]!.auth).toBe('Bearer at-2')
  })

  it('no android tokens ⇒ unknown_member; all refused ⇒ send_failed', async () => {
    const { origin } = await mockFcm(() => ({ status: 500 }))
    const { sender, store } = makeSender(origin)
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'unknown_member' })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'unknown_member' })
    await store.add('u1', { token: DROID_A, platform: 'android' })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'send_failed' })
    expect(warns.some((w) => w.includes('push refused'))).toBe(true)
  })
})

describe('composeTapFallback', () => {
  const delivered = async (): Promise<ButlerPushResult> => ({ delivered: true })
  const unknown = async (): Promise<ButlerPushResult> => ({ delivered: false, reason: 'unknown_member' })
  const failed = async (): Promise<ButlerPushResult> => ({ delivered: false, reason: 'send_failed' })
  const boom = async (): Promise<ButlerPushResult> => {
    throw new Error('boom')
  }

  it('absent legs pass through untouched (single leg = identity)', () => {
    expect(composeTapFallback(undefined, undefined)).toBeUndefined()
    expect(composeTapFallback(delivered, undefined)).toBe(delivered)
    expect(composeTapFallback(undefined, delivered)).toBe(delivered)
  })

  it('≥1 delivered wins; send_failed beats unknown_member; both-unknown stays unknown', async () => {
    expect(await composeTapFallback(unknown, delivered)!('u')).toEqual({ delivered: true })
    expect(await composeTapFallback(failed, unknown)!('u')).toEqual({
      delivered: false,
      reason: 'send_failed',
    })
    expect(await composeTapFallback(unknown, unknown)!('u')).toEqual({
      delivered: false,
      reason: 'unknown_member',
    })
  })

  it('a throwing leg never sinks the other; alone it counts as send_failed', async () => {
    expect(await composeTapFallback(boom, delivered)!('u')).toEqual({ delivered: true })
    expect(await composeTapFallback(boom, unknown)!('u')).toEqual({
      delivered: false,
      reason: 'send_failed',
    })
  })
})

describe('buildNativePushService', () => {
  function writeApnsConfig(spaceRoot: string): string {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    writeFileSync(join(spaceRoot, 'apns-key.p8'), pem)
    writeFileSync(
      join(spaceRoot, 'apns.json'),
      JSON.stringify({
        keyId: 'ABC123DEF4',
        teamId: 'TEAM567890',
        bundleId: 'app.gotong.shell',
        environment: 'sandbox',
      }),
    )
    return pem
  }

  it('neither file ⇒ undefined (the hub stays byte-identical)', () => {
    expect(buildNativePushService(tempDir(), logger)).toBeUndefined()
  })

  it('apns.json alone ⇒ ios-only: android registration refused, ios round-trip works', async () => {
    const dir = tempDir()
    writeApnsConfig(dir)
    const svc = buildNativePushService(dir, logger)!
    expect(svc.surface.platforms()).toEqual(['ios'])
    expect(svc.disclosures).toHaveLength(1)
    expect(svc.disclosures[0]).toContain('app.gotong.shell')

    await expect(svc.surface.add('u1', { token: DROID_A, platform: 'android' })).rejects.toThrow(/no push leg/)
    const r = await svc.surface.add('u1', { token: TOKEN_A, platform: 'ios' })
    expect(r.count).toBe(1)
    expect(await svc.surface.count('u1')).toBe(1)
    expect(await svc.surface.remove('u1', TOKEN_A)).toEqual({ removed: true })
    // The store landed under <space>/butler/push-native — file-first, visible.
    expect(readFileSync(join(dir, 'butler', 'push-native', 'u1.json'), 'utf8')).toContain('tokens')
  })

  it('fcm.json alone ⇒ android-only; disclosure names project + account, never key bytes; fallback delivers end-to-end', async () => {
    const { origin, sends } = await mockFcm(() => ({ status: 200 }))
    const dir = tempDir()
    writeFcmConfig(dir, { token_uri: `${origin}/token` })
    const svc = buildNativePushService(dir, logger, { fcmEndpointOverride: origin })!
    expect(svc.surface.platforms()).toEqual(['android'])
    expect(svc.disclosures).toHaveLength(1)
    expect(svc.disclosures[0]).toContain('gotong-test')
    expect(svc.disclosures[0]).toContain('push@gotong-test.iam.gserviceaccount.com')
    for (const line of svc.disclosures) {
      expect(line).not.toContain('PRIVATE KEY')
      for (const pemLine of RSA_PEM.split('\n')) {
        if (pemLine.trim().length > 8) expect(line).not.toContain(pemLine.trim())
      }
    }

    await expect(svc.surface.add('u1', { token: TOKEN_A, platform: 'ios' })).rejects.toThrow(/no push leg/)
    await svc.surface.add('u1', { token: DROID_A, platform: 'android' })
    expect(await svc.fallback('u1')).toEqual({ delivered: true })
    expect(sends).toHaveLength(1)
    expect(await svc.fallback('nobody')).toEqual({ delivered: false, reason: 'unknown_member' })
  })

  it('both files ⇒ both platforms served, two disclosures, one shared store', async () => {
    const dir = tempDir()
    writeApnsConfig(dir)
    writeFcmConfig(dir)
    const svc = buildNativePushService(dir, logger)!
    expect(svc.surface.platforms()).toEqual(['ios', 'android'])
    expect(svc.disclosures).toHaveLength(2)
    await svc.surface.add('u1', { token: TOKEN_A, platform: 'ios' })
    await svc.surface.add('u1', { token: DROID_A, platform: 'android' })
    expect(await svc.surface.count('u1')).toBe(2)
  })
})
