/**
 * A2A Agent Card signing (STD-M1) — JWS over the discovery card so a peer
 * can verify the card was not tampered with in transit and matches a key
 * this hub controls.
 *
 * ── Standard (A2A v1.0 §8.4, authoritative `a2a.proto`) ─────────────────────
 * Signatures are OPTIONAL, but "clients SHOULD verify at least one signature
 * before trusting an Agent Card". The card carries `signatures[]`, each a
 * detached-payload JWS (RFC 7515) in the flattened form:
 *   { protected, signature, header? }
 *     protected  = base64url(JSON JWS protected header)   REQUIRED
 *     signature  = base64url(signature bytes)             REQUIRED
 *     header     = unprotected header object              optional (unused)
 * The protected header MUST carry `alg` + `kid`, SHOULD carry `typ:"JOSE"`,
 * and MAY carry `jku` (a JWKS URL where the public key lives). The signing
 * input is the JWS convention: ASCII(BASE64URL(protected) '.' BASE64URL(payload)),
 * where the payload is the card canonicalized with JCS (RFC 8785) after the
 * `signatures` field is removed.
 *
 * ── Choices ─────────────────────────────────────────────────────────────────
 *   - **ES256** (ECDSA P-256 + SHA-256): the spec's first example and the
 *     most widely supported JWS alg, so an arbitrary A2A verifier can check
 *     us. Node's `node:crypto` does it with zero external deps — consistent
 *     with the rest of `identity/crypto.ts`. (`dsaEncoding: 'ieee-p1363'`
 *     yields the raw r‖s JWS wants, not DER.)
 *   - **kid = RFC 7638 JWK thumbprint** of the public key: a stable, content-
 *     derived id, so rotating the key changes the kid automatically and a
 *     verifier can pin "the key with THIS thumbprint" (the M2 trust story).
 *   - **JCS by construction, zero-dep**: the card is all strings / booleans /
 *     arrays / nested objects — no numbers — so RFC 8785 reduces to
 *     "recursively sort object keys, then `JSON.stringify`" (which already
 *     emits minimal-escaped strings, raw UTF-8, and no whitespace). We reject
 *     non-finite numbers defensively so a stray value can't sign as `null`.
 *
 * ── Boundary (发现 ≠ 信任) ──────────────────────────────────────────────────
 * A signature over a card whose `jku` points at the SAME origin proves
 * integrity ("this card matches the key served here"), NOT identity — a MITM
 * who controls the whole response can swap card + JWKS + signature together.
 * Turning a valid signature into "this really is hub X" needs the verifier to
 * PIN the key out-of-band (recorded at peer onboarding). That pinning +
 * verification is STD-M2; this module is the producer half plus a reusable
 * `verifyAgentCardSignature` the M2 consumer will call.
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AgentCard, AgentCardSignature } from './agent-card.js'

const b64url = (buf: Buffer): string => buf.toString('base64url')

// ─── JCS (RFC 8785) canonicalization, for our number-free card shape ─────────

/**
 * Recursively sort object keys so `JSON.stringify` of the result is a valid
 * RFC 8785 canonical form. Arrays keep order; strings/booleans/null pass
 * through (JSON.stringify already canonicalizes them). Numbers are allowed
 * only if finite — a non-finite number would silently stringify to `null`
 * and corrupt the signed bytes, so we throw instead.
 */
function deepCanonicalize(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(deepCanonicalize)
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('agent-card JCS: non-finite number cannot be canonicalized')
    }
    return value
  }
  if (t === 'string' || t === 'boolean') return value
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key]
      if (v === undefined) continue // omitted, not null
      out[key] = deepCanonicalize(v)
    }
    return out
  }
  // undefined / function / symbol / bigint have no JSON form — reject loudly.
  throw new Error(`agent-card JCS: unsupported value of type ${t}`)
}

/** RFC 8785 canonical JSON string of `value` (card shape only). */
export function jcsCanonicalize(value: unknown): string {
  return JSON.stringify(deepCanonicalize(value))
}

// ─── Signer (mirrors identity/crypto.ts MasterKeyProvider posture) ───────────

/** What the card closure needs to sign + advertise a key. */
export interface AgentCardSigner {
  /** RFC 7638 JWK thumbprint of the public key (stable content id). */
  kid(): string
  /** Public key as a JWK (`{kty:'EC',crv:'P-256',x,y}`), for the JWKS. */
  publicJwk(): Record<string, unknown>
  /** Sign the JWS signing input, returning raw r‖s (ieee-p1363) bytes. */
  sign(signingInput: Buffer): Buffer
}

/** JWS ES256 raw signature over `input` using a P-256 private key. */
function es256Sign(privateKey: KeyObject, input: Buffer): Buffer {
  return cryptoSign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })
}

/** RFC 7638 thumbprint of an EC public JWK: SHA-256 over the required members. */
function ecThumbprint(jwk: Record<string, unknown>): string {
  // Required members for kty=EC, lexical order (RFC 7638 §3.2): crv, kty, x, y.
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(createHash('sha256').update(canonical, 'utf8').digest())
}

/**
 * File-backed ES256 signer. Mirrors `loadOrCreateMasterKey`: a 0600 PKCS#8
 * PEM at `path`, generated on first use, never silently re-keyed. Loading
 * happens once (in the constructor); the host constructs this only when card
 * signing is enabled, so an unsigned host pays nothing.
 *
 * The env / KMS injection seams that `MasterKeyProvider` has are deliberately
 * NOT duplicated here yet — a signing key on a single-machine host is exactly
 * as secret as the `.sqlite` beside it, same as the master key's default. The
 * seam can be added the day a KMS-backed deployment needs it.
 */
export class FileAgentCardSigner implements AgentCardSigner {
  private readonly privateKey: KeyObject
  private readonly jwk: Record<string, unknown>
  private readonly thumbprint: string

  constructor(path: string) {
    this.privateKey = loadOrCreateSigningKey(path)
    const publicKey = createPublicKey(this.privateKey)
    this.jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    this.thumbprint = ecThumbprint(this.jwk)
  }

  kid(): string {
    return this.thumbprint
  }

  publicJwk(): Record<string, unknown> {
    return { ...this.jwk }
  }

  sign(signingInput: Buffer): Buffer {
    return es256Sign(this.privateKey, signingInput)
  }
}

/**
 * Load the host's P-256 signing key from `path` (PKCS#8 PEM), generating a
 * fresh one on first run with mode 0600. A file that isn't a usable EC
 * private key throws immediately rather than silently re-keying — a rotated
 * key changes the kid, which peers may have pinned, so a silent swap would
 * erase that signal.
 */
export function loadOrCreateSigningKey(path: string): KeyObject {
  if (existsSync(path)) {
    let key: KeyObject
    try {
      key = createPrivateKey(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`agent-card signing key at ${path} is not a valid private key: ${String(err)}`)
    }
    if (key.asymmetricKeyType !== 'ec') {
      throw new Error(`agent-card signing key at ${path} must be an EC (P-256) key, got ${key.asymmetricKeyType}`)
    }
    return key
  }
  mkdirSync(dirname(path), { recursive: true })
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  writeFileSync(path, pem, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // tolerate exFAT / SMB / sandboxed fs that reject chmod (same as crypto.ts)
    }
  }
  return privateKey
}

// ─── Sign / advertise / verify ───────────────────────────────────────────────

/** Options for a single signature. `jku` is where the JWKS is served. */
export interface SignAgentCardOpts {
  jku?: string
}

/**
 * Compute one `AgentCardSignature` over `card` (its `signatures` field is
 * ignored / excluded per §8.4.1). Pure given the signer.
 */
export function signAgentCard(
  card: AgentCard,
  signer: AgentCardSigner,
  opts: SignAgentCardOpts = {},
): AgentCardSignature {
  const header: Record<string, unknown> = { alg: 'ES256', typ: 'JOSE', kid: signer.kid() }
  if (opts.jku) header.jku = opts.jku
  const protectedB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'))
  const payloadB64 = b64url(Buffer.from(canonicalPayload(card), 'utf8'))
  const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii')
  return { protected: protectedB64, signature: b64url(signer.sign(signingInput)) }
}

/** Return a copy of `card` with a single signature attached. */
export function attachSignature(
  card: AgentCard,
  signer: AgentCardSigner,
  opts: SignAgentCardOpts = {},
): AgentCard {
  return { ...stripSignatures(card), signatures: [signAgentCard(card, signer, opts)] }
}

/** The JWKS document string a verifier fetches via `jku`. */
export function buildJwks(signer: AgentCardSigner): string {
  return JSON.stringify({
    keys: [{ ...signer.publicJwk(), kid: signer.kid(), use: 'sig', alg: 'ES256' }],
  })
}

/**
 * Independent verification of a card's first signature against a JWKS (the
 * reusable half STD-M2's `peer-card` verify will call). Returns a structured
 * result rather than throwing, so callers can render ✓/✗ without a try/catch.
 * Deliberately re-does canonicalization from scratch — that is the whole
 * point of the round-trip test: prove an outside verifier reaches our bytes.
 */
export interface VerifyResult {
  ok: boolean
  reason?: string
}

export function verifyAgentCardSignature(card: AgentCard, jwksJson: string): VerifyResult {
  const sig = card.signatures?.[0]
  if (!sig) return { ok: false, reason: 'no signature on card' }
  let header: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'protected header is not valid base64url JSON' }
  }
  if (header.alg !== 'ES256') return { ok: false, reason: `unsupported alg ${String(header.alg)}` }
  let keys: Array<Record<string, unknown>>
  try {
    const parsed = JSON.parse(jwksJson) as { keys?: unknown }
    keys = Array.isArray(parsed.keys) ? (parsed.keys as Array<Record<string, unknown>>) : []
  } catch {
    return { ok: false, reason: 'jwks is not valid JSON' }
  }
  // Match by kid when the header names one; else fall back to the sole key.
  const jwk = header.kid
    ? keys.find((k) => k.kid === header.kid)
    : keys.length === 1
      ? keys[0]
      : undefined
  if (!jwk) return { ok: false, reason: 'no matching key in jwks for kid' }
  let publicKey: KeyObject
  try {
    publicKey = createPublicKey({ key: jwk as import('node:crypto').JsonWebKey, format: 'jwk' })
  } catch {
    return { ok: false, reason: 'jwks key is not a usable public key' }
  }
  const signingInput = Buffer.from(`${sig.protected}.${b64url(Buffer.from(canonicalPayload(card), 'utf8'))}`, 'ascii')
  let signature: Buffer
  try {
    signature = Buffer.from(sig.signature, 'base64url')
  } catch {
    return { ok: false, reason: 'signature is not valid base64url' }
  }
  const ok = cryptoVerify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
  return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' }
}

/** The canonical (JCS) payload bytes source: the card without `signatures`. */
function canonicalPayload(card: AgentCard): string {
  return jcsCanonicalize(stripSignatures(card))
}

function stripSignatures(card: AgentCard): AgentCard {
  const { signatures: _drop, ...rest } = card as AgentCard & { signatures?: unknown }
  return rest as AgentCard
}
