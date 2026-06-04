/**
 * Route B P1-M4b — OIDC protocol pure core.
 *
 * Zero network, zero state, zero external deps (node:crypto only, same posture
 * as the TOTP layer in totp.ts). The host glue (M4c) fetches the discovery
 * document + JWKS and the web routes (M4e) drive the redirect/callback;
 * everything security-critical that CAN be a pure function lives HERE so it is
 * exhaustively testable with a self-signed key and hand-built tokens, with
 * `now` and `jwks` injected.
 *
 * Supports RS256 (RSASSA-PKCS1-v1_5 + SHA-256) only — the default of every
 * mainstream IdP (Google / Azure AD / Okta). ES256 needs a JOSE r||s ↔ DER
 * signature conversion and is a deliberate non-goal for this MVP; an
 * unsupported alg is rejected LOUDLY (unsupported_alg), never skipped — a
 * silently-accepted `alg: none` token is the classic JWT footgun.
 */

import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
} from 'node:crypto'

/** Typed failure with a stable `code` (mapped to HTTP / audit upstream). */
export class OidcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OidcError'
    this.code = code
  }
}

/** base64url, no padding. */
function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/**
 * A URL-safe high-entropy opaque value. 32 bytes = 256 bits, well past the
 * 128-bit floor for CSRF `state` and replay `nonce`.
 */
export function randomUrlToken(bytes = 32): string {
  return b64url(randomBytes(bytes))
}

export function randomState(): string {
  return randomUrlToken()
}
export function randomNonce(): string {
  return randomUrlToken()
}

export interface PkcePair {
  codeVerifier: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

/**
 * RFC 7636 PKCE. The verifier is a 43-char (32-byte) base64url random; the
 * challenge is base64url(sha256(verifier)). S256 ONLY — `plain` defeats the
 * point (a network observer who sees the challenge can replay the code), so we
 * never emit it.
 */
export function generatePkce(): PkcePair {
  const codeVerifier = randomUrlToken(32)
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' }
}

export interface BuildAuthUrlInput {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  /** Space-separated scopes; `openid` is forced in if absent. */
  scope?: string
}

/**
 * Build the authorization-code + PKCE request URL. Always asks for
 * response_type=code with S256 PKCE and at minimum the `openid` scope (so an
 * id_token comes back). state + nonce are caller-supplied (the route stashes
 * them server-side to verify on callback).
 */
export function buildAuthorizationUrl(input: BuildAuthUrlInput): string {
  for (const [k, v] of Object.entries({
    authorizationEndpoint: input?.authorizationEndpoint,
    clientId: input?.clientId,
    redirectUri: input?.redirectUri,
    state: input?.state,
    nonce: input?.nonce,
    codeChallenge: input?.codeChallenge,
  })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new OidcError('invalid_input', `buildAuthorizationUrl requires ${k}`)
    }
  }
  const scope =
    input.scope && input.scope.split(/\s+/u).includes('openid')
      ? input.scope
      : input.scope
        ? `openid ${input.scope}`
        : 'openid email profile'
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export interface Jwk {
  kid?: string
  kty: string
  alg?: string
  n?: string
  e?: string
  [k: string]: unknown
}
export interface Jwks {
  keys: Jwk[]
}

export interface ValidateIdTokenInput {
  idToken: string
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
  /** unix seconds; injected so validation is a pure function. */
  now: number
  jwks: Jwks
  /** Clock-skew tolerance in seconds (default 60). */
  clockSkewSec?: number
}

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  [k: string]: unknown
}

/**
 * Pick the signing key by `kid`. If the header carries a kid we REQUIRE an
 * exact match (never silently fall back to another key — that would let an
 * attacker who controls one key in the set forge tokens "for" another). If the
 * header has no kid, only a single-key JWKS is safe to use.
 */
function selectJwk(jwks: Jwks | undefined, kid: string | undefined): Jwk | null {
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) return null
  if (kid) {
    return jwks.keys.find((k) => k.kid === kid) ?? null
  }
  return jwks.keys.length === 1 ? jwks.keys[0]! : null
}

/**
 * Validate an OIDC id_token end to end: RS256 signature against the matching
 * JWKS key FIRST, then iss / aud / exp / nonce / sub. Returns the parsed claims
 * or throws OidcError on ANY failure — there is no partial trust. The signature
 * is checked before the claims so a forged-but-well-formed token can't even get
 * its claims read as authoritative.
 */
export function validateIdToken(input: ValidateIdTokenInput): IdTokenClaims {
  const skew = typeof input.clockSkewSec === 'number' ? input.clockSkewSec : 60
  if (typeof input.idToken !== 'string') {
    throw new OidcError('malformed_token', 'id_token must be a string')
  }
  const parts = input.idToken.split('.')
  if (parts.length !== 3) {
    throw new OidcError('malformed_token', 'id_token is not a 3-part JWT')
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]
  let header: { alg?: string; kid?: string; typ?: string }
  let claims: IdTokenClaims
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    throw new OidcError('malformed_token', 'id_token header/payload is not base64url JSON')
  }

  if (header.alg !== 'RS256') {
    throw new OidcError('unsupported_alg', `unsupported id_token alg: ${String(header.alg)} (RS256 only)`)
  }
  const jwk = selectJwk(input.jwks, header.kid)
  if (!jwk) {
    throw new OidcError('unknown_key', 'no JWKS key matches the id_token kid')
  }

  // Verify over the EXACT signing input (the raw header.payload bytes, not a
  // re-serialisation — re-encoding could normalise away a tampered field).
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = Buffer.from(sigB64, 'base64url')
  let ok = false
  try {
    // Cast the whole options object to createPublicKey's input union — naming
    // the global `JsonWebKey` type directly isn't available without the DOM lib.
    const key = createPublicKey(
      { key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0],
    )
    ok = createVerify('RSA-SHA256').update(signingInput).verify(key, sig)
  } catch {
    ok = false
  }
  if (!ok) {
    throw new OidcError('bad_signature', 'id_token signature verification failed')
  }

  if (claims.iss !== input.expectedIssuer) {
    throw new OidcError('bad_issuer', 'id_token iss does not match the expected issuer')
  }
  const audOk = Array.isArray(claims.aud)
    ? claims.aud.includes(input.expectedAudience)
    : claims.aud === input.expectedAudience
  if (!audOk) {
    throw new OidcError('bad_audience', 'id_token aud does not include the client id')
  }
  // OIDC core §3.1.3.7: when an id_token is issued to multiple audiences the
  // `azp` (authorized party) claim MUST be present, and whenever `azp` is
  // present at all it MUST equal our client id. Without this an id_token minted
  // for a DIFFERENT client that merely also lists ours in a multi-element `aud`
  // passes the `includes()` check above — a confused-deputy foothold.
  const multiAud = Array.isArray(claims.aud) && claims.aud.length > 1
  const azp = claims.azp
  if (multiAud && typeof azp !== 'string') {
    throw new OidcError('bad_azp', 'id_token has multiple audiences but no azp claim')
  }
  if (typeof azp === 'string' && azp !== input.expectedAudience) {
    throw new OidcError('bad_azp', 'id_token azp does not match the client id')
  }
  if (typeof claims.exp !== 'number' || claims.exp + skew < input.now) {
    throw new OidcError('expired', 'id_token is expired')
  }
  if (claims.nonce !== input.expectedNonce) {
    throw new OidcError('bad_nonce', 'id_token nonce does not match (possible replay)')
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new OidcError('no_subject', 'id_token has no sub claim')
  }
  return claims
}
