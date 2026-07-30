/**
 * SHELL-M6 — the APNs (iOS) half of the native push leg. The shared token
 * store, the FCM half, composeTapFallback and the assembly point are pinned
 * in native-push.test.ts (SHELL-M6A split).
 *
 * Pins, in order:
 *   - loadApnsConfig: absent file ⇒ OFF; broken opt-in signal (bad JSON /
 *     fields) ⇒ warn + OFF; opted in but unusable KEY ⇒ throws loudly;
 *   - buildApnsJwt verified INDEPENDENTLY with node:crypto createVerify
 *     (ieee-p1363) — the same "an outside verifier can check our bytes"
 *     posture as the VAPID tests;
 *   - ApnsSender against a REAL node:http2 h2c mock: exact path/headers, the
 *     body is the fixed low-info TAP (no member text can exist — push() has
 *     no text parameter), android rows are invisible to this leg,
 *     410/BadDeviceToken prunes, 403 drops the JWT cache, all-fail =
 *     send_failed, no ios tokens = unknown_member.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Http2Server } from 'node:http2'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApnsSender, buildApnsJwt, loadApnsConfig, type ApnsConfig } from '../src/apns-push.js'
import { NativePushTokenStore } from '../src/native-push.js'
import { TAP_PAYLOAD } from '../src/web-push-sender.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-apns-'))
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

const servers: Http2Server[] = []

afterEach(() => {
  warns.splice(0)
  infos.splice(0)
  for (const s of servers.splice(0)) s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeKeyPem(): { pem: string; publicPem: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  }
}

function writeConfig(spaceRoot: string, overrides: Record<string, unknown> = {}): string {
  const { pem } = makeKeyPem()
  writeFileSync(join(spaceRoot, 'apns-key.p8'), pem)
  writeFileSync(
    join(spaceRoot, 'apns.json'),
    JSON.stringify({
      keyId: 'ABC123DEF4',
      teamId: 'TEAM567890',
      bundleId: 'app.gotong.shell',
      environment: 'sandbox',
      ...overrides,
    }),
  )
  return pem
}

interface SeenRequest {
  path: string
  headers: Record<string, string>
  body: string
}

/** Real h2c HTTP/2 mock — answers per-token status/reason, records requests. */
function mockApns(
  respond: (token: string) => { status: number; reason?: string },
): Promise<{ origin: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = []
  const server = createServer()
  servers.push(server)
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      const path = String(headers[':path'] ?? '')
      const flat: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') flat[k] = v
      seen.push({ path, headers: flat, body: Buffer.concat(chunks).toString('utf8') })
      const token = path.replace('/3/device/', '')
      const r = respond(token)
      stream.respond({ ':status': r.status })
      stream.end(r.reason ? JSON.stringify({ reason: r.reason }) : '')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ origin: `http://127.0.0.1:${addr.port}`, seen })
    })
  })
}

const CFG = {
  keyId: 'ABC123DEF4',
  teamId: 'TEAM567890',
  bundleId: 'app.gotong.shell',
  environment: 'sandbox',
  keyFile: 'apns-key.p8',
} satisfies ApnsConfig
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const DROID = 'dEvIcE:' + 'x'.repeat(40)

describe('loadApnsConfig', () => {
  it('absent file ⇒ undefined (OFF, byte-identical hub)', () => {
    expect(loadApnsConfig(tempDir(), logger)).toBeUndefined()
    expect(warns).toHaveLength(0)
  })

  it('malformed JSON ⇒ warn + OFF', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'apns.json'), '{not json')
    expect(loadApnsConfig(dir, logger)).toBeUndefined()
    expect(warns.some((w) => w.includes('not valid JSON'))).toBe(true)
  })

  it('missing field / bad environment ⇒ warn + OFF', () => {
    const dir = tempDir()
    writeConfig(dir, { environment: 'staging' })
    expect(loadApnsConfig(dir, logger)).toBeUndefined()
    expect(warns.some((w) => w.includes('needs'))).toBe(true)

    const dir2 = tempDir()
    writeConfig(dir2, { teamId: undefined })
    expect(loadApnsConfig(dir2, logger)).toBeUndefined()
  })

  it('opted in but key file missing or garbage ⇒ THROWS (loud boot)', () => {
    const dir = tempDir()
    writeConfig(dir)
    rmSync(join(dir, 'apns-key.p8'))
    expect(() => loadApnsConfig(dir, logger)).toThrow(/not a readable private key/)

    const dir2 = tempDir()
    writeConfig(dir2)
    writeFileSync(join(dir2, 'apns-key.p8'), 'not a key')
    expect(() => loadApnsConfig(dir2, logger)).toThrow(/not a readable private key/)
  })

  it('non-EC key ⇒ THROWS', () => {
    const dir = tempDir()
    writeConfig(dir)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(
      join(dir, 'apns-key.p8'),
      rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    )
    expect(() => loadApnsConfig(dir, logger)).toThrow(/must be an EC/)
  })

  it('valid config + key ⇒ loads; keyFile may be overridden', () => {
    const dir = tempDir()
    const { pem } = makeKeyPem()
    writeFileSync(join(dir, 'other.p8'), pem)
    writeFileSync(
      join(dir, 'apns.json'),
      JSON.stringify({ ...CFG, keyFile: 'other.p8' }),
    )
    const loaded = loadApnsConfig(dir, logger)
    expect(loaded?.config.bundleId).toBe('app.gotong.shell')
    expect(loaded?.config.keyFile).toBe('other.p8')
    expect(loaded?.privateKey.asymmetricKeyType).toBe('ec')
  })
})

describe('buildApnsJwt', () => {
  it('is an ES256 JWT an independent node:crypto verifier accepts', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const now = () => 1_700_000_123_456
    const jwt = buildApnsJwt({ keyId: 'KEY1234567', teamId: 'TEAMID1234', privateKey: pair.privateKey, now })
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    })
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString('utf8'))).toEqual({
      iss: 'TEAMID1234',
      iat: 1_700_000_123,
    })
    const ok = createVerify('sha256')
      .update(Buffer.from(`${h}.${c}`, 'utf8'))
      .verify({ key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('ApnsSender (real h2c HTTP/2 mock)', () => {
  it('POSTs the fixed low-info tap with exact headers; android rows invisible; 200 ⇒ delivered + lastOkAt', async () => {
    const { origin, seen } = await mockApns(() => ({ status: 200 }))
    const dir = tempDir()
    const pem = writeConfig(dir)
    const loaded = loadApnsConfig(dir, logger)!
    const store = new NativePushTokenStore({ dir: join(dir, 'pn'), logger })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    // An android row on the same member must never reach APNs.
    await store.add('u1', { token: DROID, platform: 'android' })
    const sender = new ApnsSender({
      config: loaded.config,
      privateKey: loaded.privateKey,
      store,
      logger,
      originOverride: origin,
    })

    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect(seen).toHaveLength(1)
    const req = seen[0]!
    expect(req.path).toBe(`/3/device/${TOKEN_A}`)
    expect(req.headers['apns-topic']).toBe('app.gotong.shell')
    expect(req.headers['apns-push-type']).toBe('alert')
    expect(req.headers['apns-collapse-id']).toBe('gotong-butler-tap')
    expect(req.headers['apns-priority']).toBe('10')
    expect(Number(req.headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000)

    // The body is EXACTLY the content-free tap — nothing else can be in it
    // (push() has no text parameter), and an independent verifier accepts
    // the provider JWT in the authorization header.
    expect(JSON.parse(req.body)).toEqual({ aps: { alert: TAP_PAYLOAD, sound: 'default' } })
    const auth = req.headers.authorization!
    expect(auth.startsWith('bearer ')).toBe(true)
    const [h, c, s] = auth.slice('bearer '.length).split('.')
    const pub = (await import('node:crypto')).createPublicKey(pem)
    const ok = createVerify('sha256')
      .update(Buffer.from(`${h}.${c}`, 'utf8'))
      .verify({ key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))
    expect(ok).toBe(true)

    const rows = await store.list('u1')
    expect(rows.find((r) => r.platform === 'ios')!.lastOkAt).toBeGreaterThan(0)
    expect(rows.find((r) => r.platform === 'android')!.lastOkAt).toBeUndefined()
  })

  it('410/BadDeviceToken prunes that token; a surviving device still delivers', async () => {
    const { origin } = await mockApns((token) =>
      token === TOKEN_A ? { status: 410, reason: 'Unregistered' } : { status: 200 },
    )
    const dir = tempDir()
    writeConfig(dir)
    const loaded = loadApnsConfig(dir, logger)!
    const store = new NativePushTokenStore({ dir: join(dir, 'pn'), logger })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    await store.add('u1', { token: TOKEN_B, platform: 'ios' })
    const sender = new ApnsSender({
      config: loaded.config,
      privateKey: loaded.privateKey,
      store,
      logger,
      originOverride: origin,
    })

    expect(await sender.push('u1')).toEqual({ delivered: true })
    const rows = await store.list('u1')
    expect(rows.map((r) => r.token)).toEqual([TOKEN_B])
    expect(infos.some((m) => m.includes('pruned'))).toBe(true)
  })

  it('no ios tokens (none, or android-only) ⇒ unknown_member; all refused ⇒ send_failed', async () => {
    const { origin } = await mockApns(() => ({ status: 500 }))
    const dir = tempDir()
    writeConfig(dir)
    const loaded = loadApnsConfig(dir, logger)!
    const store = new NativePushTokenStore({ dir: join(dir, 'pn'), logger })
    const sender = new ApnsSender({
      config: loaded.config,
      privateKey: loaded.privateKey,
      store,
      logger,
      originOverride: origin,
    })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'unknown_member' })
    await store.add('u1', { token: DROID, platform: 'android' })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'unknown_member' })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })
    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'send_failed' })
    expect(warns.some((w) => w.includes('push refused'))).toBe(true)
  })

  it('403 drops the provider-JWT cache so the next push re-mints', async () => {
    let first = true
    const { origin, seen } = await mockApns(() => {
      if (first) {
        first = false
        return { status: 403, reason: 'ExpiredProviderToken' }
      }
      return { status: 200 }
    })
    const dir = tempDir()
    writeConfig(dir)
    const loaded = loadApnsConfig(dir, logger)!
    const store = new NativePushTokenStore({ dir: join(dir, 'pn'), logger })
    let nowMs = 1_700_000_000_000
    const sender = new ApnsSender({
      config: loaded.config,
      privateKey: loaded.privateKey,
      store,
      logger,
      originOverride: origin,
      now: () => nowMs,
    })
    await store.add('u1', { token: TOKEN_A, platform: 'ios' })

    expect(await sender.push('u1')).toEqual({ delivered: false, reason: 'send_failed' })
    nowMs += 60_000 // well under the 45min refresh — only the 403 explains a new mint
    expect(await sender.push('u1')).toEqual({ delivered: true })
    expect(seen[0]!.headers.authorization).not.toBe(seen[1]!.headers.authorization)
  })
})
