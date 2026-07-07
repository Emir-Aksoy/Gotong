/**
 * A2A Agent Card signing primitives (STD-M1 producer + STD-M2 consumer).
 *
 * These are the PURE, node:crypto-only halves of A2A card signing — the wire
 * format, canonicalization, and verify path — so both the producer (host's
 * file-backed signer) and any consumer (the `gotong peer-card` verifier in the
 * CLI) share one vocabulary without the CLI reaching up into the host assembly
 * layer. The file-backed key management (`FileAgentCardSigner`) stays in host;
 * everything a verifier needs lives here.
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
 *   - **ES256** (ECDSA P-256 + SHA-256): the spec's first example and the most
 *     widely supported JWS alg. `dsaEncoding: 'ieee-p1363'` yields the raw r‖s
 *     JWS wants, not DER.
 *   - **kid = RFC 7638 JWK thumbprint** of the public key: a stable, content-
 *     derived id, so rotating the key changes the kid and a verifier can pin
 *     "the key with THIS thumbprint" (the STD-M2 trust story).
 *   - **JCS by construction, zero-dep**: the card is all strings / booleans /
 *     arrays / nested objects — no numbers — so RFC 8785 reduces to "recursively
 *     sort object keys, then `JSON.stringify`". Non-finite numbers are rejected
 *     defensively so a stray value can't sign as `null`.
 *
 * ── Boundary (发现 ≠ 信任) ──────────────────────────────────────────────────
 * A valid signature proves INTEGRITY (this card matches the advertised key),
 * NOT IDENTITY — a MITM controlling the whole response can swap card + JWKS +
 * signature together. Turning "verified" into "this really is hub X" needs the
 * verifier to PIN the key out-of-band (recorded at peer onboarding). That
 * pinning is STD-M2b; `verifyAgentCardSignature` here is the reusable check.
 */

import { createPublicKey, createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto'

const b64url = (buf: Buffer): string => buf.toString('base64url')

// ─── Wire shapes ─────────────────────────────────────────────────────────────

/** One detached-payload flattened JWS over a card (A2A §8.4). */
export interface AgentCardSignatureValue {
  protected: string
  signature: string
  header?: Record<string, unknown>
}

/**
 * Structural card view the signing/verify functions need — just the optional
 * `signatures[]`. Any concrete card type (host's `AgentCard`) is assignable,
 * so these stay card-shape-agnostic and can't drift with the card schema.
 */
export interface SignedCard {
  signatures?: AgentCardSignatureValue[]
}

// ─── JCS (RFC 8785) canonicalization, for our number-free card shape ─────────

/**
 * Recursively sort object keys so `JSON.stringify` of the result is a valid
 * RFC 8785 canonical form. Arrays keep order; strings/booleans/null pass
 * through. Numbers are allowed only if finite — a non-finite number would
 * silently stringify to `null` and corrupt the signed bytes, so we throw.
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

/** The canonical (JCS) payload bytes source: the card without `signatures`. */
function canonicalPayload(card: SignedCard): string {
  return jcsCanonicalize(stripSignatures(card))
}

function stripSignatures<T extends SignedCard>(card: T): T {
  const { signatures: _drop, ...rest } = card as T & { signatures?: unknown }
  return rest as unknown as T
}

// ─── Signer abstraction (impl — file/env/KMS-backed — lives elsewhere) ───────

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
export function es256Sign(privateKey: KeyObject, input: Buffer): Buffer {
  return cryptoSign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })
}

/** RFC 7638 thumbprint of an EC public JWK: SHA-256 over the required members. */
export function ecThumbprint(jwk: Record<string, unknown>): string {
  // Required members for kty=EC, lexical order (RFC 7638 §3.2): crv, kty, x, y.
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(createHash('sha256').update(canonical, 'utf8').digest())
}

// ─── Sign / advertise ────────────────────────────────────────────────────────

/** Options for a single signature. `jku` is where the JWKS is served. */
export interface SignAgentCardOpts {
  jku?: string
}

/**
 * Compute one `AgentCardSignatureValue` over `card` (its `signatures` field is
 * ignored / excluded per §8.4.1). Pure given the signer.
 */
export function signAgentCard(
  card: SignedCard,
  signer: AgentCardSigner,
  opts: SignAgentCardOpts = {},
): AgentCardSignatureValue {
  const header: Record<string, unknown> = { alg: 'ES256', typ: 'JOSE', kid: signer.kid() }
  if (opts.jku) header.jku = opts.jku
  const protectedB64 = b64url(Buffer.from(JSON.stringify(header), 'utf8'))
  const payloadB64 = b64url(Buffer.from(canonicalPayload(card), 'utf8'))
  const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii')
  return { protected: protectedB64, signature: b64url(signer.sign(signingInput)) }
}

/** Return a copy of `card` with a single signature attached (type preserved). */
export function attachSignature<T extends SignedCard>(
  card: T,
  signer: AgentCardSigner,
  opts: SignAgentCardOpts = {},
): T {
  return { ...stripSignatures(card), signatures: [signAgentCard(card, signer, opts)] }
}

/** The JWKS document string a verifier fetches via `jku`. */
export function buildJwks(signer: AgentCardSigner): string {
  return JSON.stringify({
    keys: [{ ...signer.publicJwk(), kid: signer.kid(), use: 'sig', alg: 'ES256' }],
  })
}

// ─── Verify (the consumer half — STD-M2 peer-card calls this) ────────────────

export interface VerifyResult {
  ok: boolean
  reason?: string
}

/**
 * Decode the protected header of a card's first signature, or null if the card
 * carries no (decodable) signature. Lets a consumer read `jku` (where to fetch
 * the JWKS) and `kid` before it has a key — remote input, so never throws.
 */
export function readCardSignatureHeader(card: SignedCard): Record<string, unknown> | null {
  const sig = card.signatures?.[0]
  if (!sig || typeof sig.protected !== 'string') return null
  try {
    const header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8'))
    return header && typeof header === 'object' && !Array.isArray(header) ? (header as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Independent verification of a card's first signature against a JWKS. Returns
 * a structured result rather than throwing, so callers render ✓/✗ without a
 * try/catch. Re-does canonicalization from scratch — that is the point: prove
 * an outside verifier reaches the signed bytes.
 */
export function verifyAgentCardSignature(card: SignedCard, jwksJson: string): VerifyResult {
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
