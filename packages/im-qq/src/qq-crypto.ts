/**
 * QQ official bot Ed25519 signature scheme — built on Node's built-in
 * `node:crypto` (zero new dependency).
 *
 * QQ derives a single Ed25519 keypair from the bot secret (a value the
 * bot and the QQ platform both hold). That keypair drives both
 * directions of trust:
 *
 *   - **Callback validation (op:13):** when the webhook URL is
 *     configured, QQ sends `{ plain_token, event_ts }` and the bot must
 *     prove it holds the secret by SIGNING `event_ts + plain_token` and
 *     echoing back `{ plain_token, signature }`. `signQqCallback` does
 *     this with the derived PRIVATE key.
 *
 *   - **Inbound event verification (op:0):** every dispatched event POST
 *     carries `X-Signature-Ed25519` (hex) + `X-Signature-Timestamp`
 *     headers. The bot verifies the signature over `timestamp + rawBody`
 *     with the derived PUBLIC key, proving the event came from QQ.
 *     `verifyQqEventSignature` does this.
 *
 * Seed derivation (matches the official Go/Python demos): the Ed25519
 * 32-byte seed is the bot secret repeated until it reaches 32 bytes,
 * then truncated. We do this at the BYTE level so multi-byte secrets
 * derive identically to the reference implementation.
 *
 * Reference:
 *   https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Ed25519 seed size in bytes. */
const ED25519_SEED_SIZE = 32

/**
 * Fixed ASN.1 / PKCS#8 prefix for an Ed25519 private key. Prepending it
 * to the raw 32-byte seed yields a 48-byte DER that `createPrivateKey`
 * accepts — the only way to build an Ed25519 KeyObject from a raw seed
 * with the Node built-in crypto API (no third-party ed25519 lib).
 *
 *   30 2e                SEQUENCE (46)
 *     02 01 00           INTEGER 0 (version)
 *     30 05 06 03 2b6570 AlgorithmIdentifier { OID 1.3.101.112 = Ed25519 }
 *     04 22 04 20        OCTET STRING { OCTET STRING (32) = the seed }
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface QqKeyPair {
  privateKey: KeyObject
  publicKey: KeyObject
}

/**
 * Derive the Ed25519 seed from the bot secret: repeat the secret bytes
 * until they reach the 32-byte seed size, then truncate. Matches QQ's
 * `strings.Repeat(secret, …)[:32]` reference behaviour at the byte
 * level.
 */
export function deriveQqSeed(botSecret: string): Buffer {
  const secret = Buffer.from(botSecret, 'utf8')
  if (secret.length === 0) {
    throw new TypeError('deriveQqSeed: bot secret must be non-empty')
  }
  let seed = secret
  while (seed.length < ED25519_SEED_SIZE) {
    seed = Buffer.concat([seed, secret])
  }
  return seed.subarray(0, ED25519_SEED_SIZE)
}

/**
 * Build the Ed25519 keypair QQ derives from the bot secret. The same
 * keypair is used to SIGN op:13 validation responses (private key) and
 * to VERIFY inbound op:0 events (public key).
 */
export function deriveQqKeyPair(botSecret: string): QqKeyPair {
  const seed = deriveQqSeed(botSecret)
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey }
}

/**
 * Sign the op:13 callback-validation challenge. Returns the hex-encoded
 * Ed25519 signature of `event_ts + plain_token` — the exact value to put
 * in the `{ plain_token, signature }` response.
 */
export function signQqCallback(
  privateKey: KeyObject,
  eventTs: string,
  plainToken: string,
): string {
  const message = Buffer.from(eventTs + plainToken, 'utf8')
  // Ed25519 is a one-shot scheme — algorithm must be null.
  return sign(null, message, privateKey).toString('hex')
}

/**
 * Verify the Ed25519 signature on an inbound op:0 event. The signed
 * message is `timestamp + rawBody` (the UNMODIFIED request body — a
 * re-stringify of parsed JSON changes whitespace and breaks the check).
 * Returns false on any malformed input rather than throwing, so a single
 * bad request can't take down the webhook handler.
 */
export function verifyQqEventSignature(
  publicKey: KeyObject,
  input: { signature: string; timestamp: string; rawBody: string },
): boolean {
  if (
    typeof input.signature !== 'string' ||
    typeof input.timestamp !== 'string' ||
    typeof input.rawBody !== 'string'
  ) {
    return false
  }
  let sig: Buffer
  try {
    sig = Buffer.from(input.signature, 'hex')
  } catch {
    return false
  }
  // Ed25519 signatures are exactly 64 bytes; reject anything else early.
  if (sig.length !== 64) return false
  const message = Buffer.from(input.timestamp + input.rawBody, 'utf8')
  try {
    return verify(null, message, publicKey, sig)
  } catch {
    return false
  }
}
