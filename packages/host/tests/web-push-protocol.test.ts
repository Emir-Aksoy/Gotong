/**
 * PUSH-M1 — Web Push pure core.
 *
 * The load-bearing test is the RFC 8291 §5 worked example, asserted on the
 * COMPLETE message body byte-for-byte: one wrong info string, HKDF step, header
 * field, or padding octet anywhere in the chain and the body cannot match. The
 * round-trip test then covers the production path (random ephemeral key + salt)
 * by playing the browser side of the same RFCs.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WEBPUSH_MAX_PLAINTEXT_BYTES,
  buildVapidAuthorization,
  encryptWebPushPayload,
  loadOrCreateWebPushKey,
  pushAudienceOf,
} from '../src/web-push-protocol.js'

const b64 = (s: string) => Buffer.from(s, 'base64url')

// RFC 8291 §5 — every value verbatim from the RFC.
const VEC = {
  plaintext: b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPrivate: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  asPublic: b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  uaPublic: b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  auth: b64('BTBZMqHH6r4Tts7J_aSIgg'),
  salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlml' +
    'MoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4M' +
    'qgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** Browser-side decrypt per RFC 8291/8188 — the mirror of the implementation. */
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
  expect(delim).toBeGreaterThanOrEqual(0)
  expect(padded.subarray(delim + 1).every((o) => o === 0)).toBe(true)
  return padded.subarray(0, delim)
}

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-webpush-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('encryptWebPushPayload (RFC 8291)', () => {
  it('reproduces the RFC 8291 §5 example body byte-for-byte', () => {
    expect(VEC.plaintext.toString('utf8')).toBe('When I grow up, I want to be a watermelon')
    const body = encryptWebPushPayload(VEC.uaPublic, VEC.auth, VEC.plaintext, {
      asPrivateKey: VEC.asPrivate,
      salt: VEC.salt,
    })
    expect(body.toString('base64url')).toBe(VEC.body)
    // Header layout sanity on top of the opaque match: salt ‖ rs=4096 ‖ idlen=65 ‖ as_public.
    expect(body.subarray(0, 16)).toEqual(VEC.salt)
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body.subarray(21, 86)).toEqual(VEC.asPublic)
  })

  it('production path (random ephemeral key + salt) round-trips on the browser side', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const message = Buffer.from('阿同有新消息 — tap to open /me', 'utf8')
    const body = encryptWebPushPayload(ua.getPublicKey(), auth, message)
    expect(uaDecrypt(body, ua, auth)).toEqual(message)
    // Fresh randomness per message — two bodies for the same plaintext differ.
    expect(encryptWebPushPayload(ua.getPublicKey(), auth, message).equals(body)).toBe(false)
  })

  it('refuses bad subscription material and oversized payloads loudly', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    expect(() => encryptWebPushPayload(Buffer.alloc(64), auth, Buffer.from('x'))).toThrow(/65-byte/)
    expect(() => encryptWebPushPayload(ua.getPublicKey(), Buffer.alloc(15), Buffer.from('x'))).toThrow(/16 bytes/)
    // 65 bytes with the right prefix but not a curve point.
    const junk = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xff)])
    expect(() => encryptWebPushPayload(junk, auth, Buffer.from('x'))).toThrow(/not a valid P-256 point/)
    const fat = Buffer.alloc(WEBPUSH_MAX_PLAINTEXT_BYTES + 1)
    expect(() => encryptWebPushPayload(ua.getPublicKey(), auth, fat)).toThrow(/cap/)
  })
})

describe('buildVapidAuthorization (RFC 8292)', () => {
  it('emits a verifiable ES256 JWT with aud/exp/sub and the matching k=', () => {
    const key = loadOrCreateWebPushKey(join(tempDir(), 'webpush-vapid.key'))
    const header = buildVapidAuthorization({
      audience: 'https://fcm.googleapis.com',
      subject: 'mailto:ops@example.com',
      privateKey: key.privateKey,
      applicationServerKey: key.applicationServerKey,
      now: () => 1_700_000_000_000,
    })
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, jwt, k] = m!
    expect(k).toBe(key.applicationServerKey)
    const [h, c, s] = jwt!.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    })
    const ok = createVerify('SHA256')
      .update(Buffer.from(`${h}.${c}`, 'utf8'))
      .verify({ key: createPublicKey(key.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))
    expect(ok).toBe(true)
  })

  it('clamps the JWT lifetime to the RFC 8292 24h ceiling', () => {
    const key = loadOrCreateWebPushKey(join(tempDir(), 'webpush-vapid.key'))
    const header = buildVapidAuthorization({
      audience: 'https://updates.push.services.mozilla.com',
      subject: 'mailto:ops@example.com',
      privateKey: key.privateKey,
      applicationServerKey: key.applicationServerKey,
      now: () => 1_700_000_000_000,
      expiresInSeconds: 48 * 3600,
    })
    const claims = JSON.parse(
      Buffer.from(/t=[\w-]+\.([\w-]+)\./.exec(header)![1]!, 'base64url').toString(),
    ) as { exp: number }
    expect(claims.exp).toBe(1_700_000_000 + 24 * 3600)
  })
})

describe('loadOrCreateWebPushKey (key custody, agent-card-signing posture)', () => {
  it('creates a 0600 PKCS#8 PEM once and loads the SAME key thereafter', () => {
    const path = join(tempDir(), 'webpush-vapid.key')
    const first = loadOrCreateWebPushKey(path)
    // applicationServerKey: 65 raw bytes → 87 base64url chars, 0x04 prefix → 'B'.
    expect(first.applicationServerKey).toMatch(/^B[\w-]{86}$/)
    expect(first.publicKeyRaw.length).toBe(65)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(path, 'utf8')).toContain('BEGIN PRIVATE KEY')
    const second = loadOrCreateWebPushKey(path)
    expect(second.applicationServerKey).toBe(first.applicationServerKey)
  })

  it('never silently re-keys: corrupt or non-EC files throw', () => {
    const corrupt = join(tempDir(), 'webpush-vapid.key')
    writeFileSync(corrupt, 'not a pem')
    expect(() => loadOrCreateWebPushKey(corrupt)).toThrow(/not a valid private key/)

    const rsaPath = join(tempDir(), 'webpush-vapid.key')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(rsaPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    expect(() => loadOrCreateWebPushKey(rsaPath)).toThrow(/must be an EC/)
  })
})

describe('pushAudienceOf', () => {
  it('reduces a push endpoint to its origin', () => {
    expect(pushAudienceOf('https://fcm.googleapis.com/fcm/send/abc123:def')).toBe('https://fcm.googleapis.com')
    expect(pushAudienceOf('https://example.net:8443/push/v2/token')).toBe('https://example.net:8443')
  })
})

describe('module discipline', () => {
  it('the pure core stays I/O-free beyond the key file (no fetch/http import)', () => {
    const src = readFileSync(new URL('../src/web-push-protocol.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toContain('node:http')
    // createCipheriv import sanity so this file keeps compiling against it.
    void createCipheriv
  })
})
