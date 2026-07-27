/**
 * Web Push protocol pure core (PUSH-M1).
 *
 * RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID) implemented
 * directly on node:crypto — the same zero-external-dependency posture as the
 * STD-M1 agent-card signer, whose ES256 primitive (`es256Sign`) this reuses.
 * Correctness is pinned byte-for-byte against the RFC 8291 §5 worked example
 * in tests: the deterministic seams (`asPrivateKey`, `salt`, `now`) exist for
 * those vectors and stay unused in production, where both are freshly random
 * per message.
 *
 * Scope discipline: this file is crypto + key custody only. Subscription
 * storage is M2, the delivery leg (fetch to the push service, outbox fold) is
 * M3 — nothing here does I/O beyond the key file.
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { es256Sign } from '@gotong/a2a'

// ─── Constants (RFC 8188 / RFC 8291 / push-service reality) ─────────────────

/** Single-record size the header advertises — the RFC 8291 example value. */
const RECORD_SIZE = 4096

/**
 * Push services cap the whole POST body around 4096 bytes. Body = 86-byte
 * aes128gcm header + ciphertext (plaintext + 1 delimiter + 16 GCM tag), so
 * anything past this cannot be delivered — refuse loudly instead of letting
 * the push service 413 at send time. Low-info taps are far below this anyway.
 */
export const WEBPUSH_MAX_PLAINTEXT_BYTES = 4096 - 86 - 17

// ─── base64url helpers (local; the a2a ones are module-private) ─────────────

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

// ─── Payload encryption (RFC 8291 §3, content coding RFC 8188) ──────────────

export interface WebPushEncryptOpts {
  /** Test seam: 32-byte P-256 scalar for the ephemeral sender key. */
  asPrivateKey?: Buffer
  /** Test seam: 16-byte salt. */
  salt?: Buffer
}

/**
 * Encrypt `plaintext` for a browser subscription (`p256dh` public key +
 * `auth` secret), returning the complete `aes128gcm` message body:
 * `salt(16) ‖ rs(4) ‖ idlen(1) ‖ as_public(65) ‖ AES-128-GCM(plaintext ‖ 0x02)`.
 *
 * The push service relays this body without being able to read it — the
 * content key is derived from an ECDH agreement only the browser can redo.
 * Invalid subscription material throws immediately (loud, never a garbage
 * body): wrong p256dh length/point, wrong auth length, oversized plaintext.
 */
export function encryptWebPushPayload(
  uaPublicKey: Buffer,
  authSecret: Buffer,
  plaintext: Buffer,
  opts: WebPushEncryptOpts = {},
): Buffer {
  if (uaPublicKey.length !== 65 || uaPublicKey[0] !== 0x04) {
    throw new Error(`web-push p256dh key must be a 65-byte uncompressed P-256 point, got ${uaPublicKey.length} bytes`)
  }
  if (authSecret.length !== 16) {
    throw new Error(`web-push auth secret must be 16 bytes, got ${authSecret.length}`)
  }
  if (plaintext.length > WEBPUSH_MAX_PLAINTEXT_BYTES) {
    throw new Error(
      `web-push payload is ${plaintext.length} bytes; push services cap it at ${WEBPUSH_MAX_PLAINTEXT_BYTES}`,
    )
  }

  const ecdh = createECDH('prime256v1')
  if (opts.asPrivateKey) ecdh.setPrivateKey(opts.asPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  let ecdhSecret: Buffer
  try {
    ecdhSecret = ecdh.computeSecret(uaPublicKey)
  } catch {
    throw new Error('web-push p256dh key is not a valid P-256 point')
  }
  const salt = opts.salt ?? randomBytes(16)

  // RFC 8291 §3.3–3.4: ikm ← HKDF(auth, ecdh, "WebPush: info"‖0x00‖ua‖as),
  // then RFC 8188 cek/nonce infos. The §5 vector transitively pins all three
  // info strings — a single wrong byte here and the test body cannot match.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublicKey, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed])
}

// ─── VAPID (RFC 8292) ───────────────────────────────────────────────────────

/** The JWT `aud` a push endpoint demands: its origin, nothing more. */
export function pushAudienceOf(endpoint: string): string {
  return new URL(endpoint).origin
}

export interface VapidAuthOpts {
  /** Push-service origin (`pushAudienceOf(endpoint)`). */
  audience: string
  /** Operator contact — the `GOTONG_WEBPUSH` knob value (`mailto:`/`https:`). */
  subject: string
  privateKey: KeyObject
  /** base64url raw public key, same value the browser subscribed with. */
  applicationServerKey: string
  /** Test seam; production uses the real clock. */
  now?: () => number
  /** RFC 8292 caps JWT lifetime at 24h; longer requests are clamped. */
  expiresInSeconds?: number
}

/** Build the `Authorization: vapid t=<ES256 JWT>, k=<pubkey>` header value. */
export function buildVapidAuthorization(opts: VapidAuthOpts): string {
  const nowMs = (opts.now ?? Date.now)()
  const lifetime = Math.min(opts.expiresInSeconds ?? 12 * 3600, 24 * 3600)
  const exp = Math.floor(nowMs / 1000) + lifetime
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'))
  const claims = b64url(
    Buffer.from(JSON.stringify({ aud: opts.audience, exp, sub: opts.subject }), 'utf8'),
  )
  const signingInput = `${header}.${claims}`
  const signature = es256Sign(opts.privateKey, Buffer.from(signingInput, 'utf8'))
  return `vapid t=${signingInput}.${b64url(signature)}, k=${opts.applicationServerKey}`
}

// ─── Key custody (mirrors STD-M1 loadOrCreateSigningKey) ────────────────────

export interface WebPushKey {
  privateKey: KeyObject
  /** Raw uncompressed P-256 point (65 bytes). */
  publicKeyRaw: Buffer
  /** base64url of `publicKeyRaw` — handed to `pushManager.subscribe` and `k=`. */
  applicationServerKey: string
}

/**
 * Load the hub's VAPID key from `path` (PKCS#8 PEM), generating a fresh one
 * on first run with mode 0600. A file that isn't a usable EC private key
 * throws rather than silently re-keying: every browser subscription is bound
 * to this public key, so a silent swap would strand all of them without a
 * trace. Same fail-closed posture as the agent-card signing key.
 */
export function loadOrCreateWebPushKey(path: string): WebPushKey {
  let privateKey: KeyObject
  if (existsSync(path)) {
    try {
      privateKey = createPrivateKey(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`web-push VAPID key at ${path} is not a valid private key: ${String(err)}`)
    }
    if (privateKey.asymmetricKeyType !== 'ec') {
      throw new Error(`web-push VAPID key at ${path} must be an EC (P-256) key, got ${privateKey.asymmetricKeyType}`)
    }
  } else {
    mkdirSync(dirname(path), { recursive: true })
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    privateKey = pair.privateKey
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    writeFileSync(path, pem, { mode: 0o600 })
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600)
      } catch {
        // tolerate exFAT / SMB / sandboxed fs that reject chmod (same as crypto.ts)
      }
    }
  }
  const publicKeyRaw = rawP256PublicKey(privateKey, path)
  return { privateKey, publicKeyRaw, applicationServerKey: b64url(publicKeyRaw) }
}

/** JWK x/y are mandated fixed-length, so `0x04 ‖ x ‖ y` is the raw point. */
function rawP256PublicKey(privateKey: KeyObject, path: string): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as {
    crv?: string
    x?: string
    y?: string
  }
  if (jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error(`web-push VAPID key at ${path} must be P-256, got curve ${jwk.crv ?? 'unknown'}`)
  }
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ])
}
