/**
 * Route B P1-M4b — OIDC protocol pure core.
 *
 * Drives validateIdToken with a REAL RSA keypair and hand-built JWTs so every
 * security check is exercised against genuine signatures: a valid token
 * resolves, while a tampered payload, wrong issuer / audience / nonce, an
 * expired token, an unsupported alg, and an unknown kid each throw a distinct
 * OidcError. PKCE + the authorization URL are pinned too (S256 challenge =
 * base64url(sha256(verifier)); the URL forces response_type=code + openid).
 *
 * `now` and `jwks` are injected — no clock, no network — so the whole suite is
 * deterministic.
 */

import { describe, it, expect } from 'vitest'
import {
  generateKeyPairSync,
  createSign,
  createHash,
  type KeyObject,
} from 'node:crypto'

import {
  OidcError,
  validateIdToken,
  generatePkce,
  buildAuthorizationUrl,
  randomState,
  randomNonce,
  type Jwks,
  type IdTokenClaims,
} from '../src/oidc.js'

const ISS = 'https://idp.example.com'
const AUD = 'aipehub-client-id'
const NONCE = 'nonce-abc123'
const NOW = 1_700_000_000
const KID = 'test-key-1'

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}

interface KeyFixture {
  privateKey: KeyObject
  jwks: Jwks
}

/** A fresh RSA keypair + its public half exported as a single-key JWKS. */
function makeKey(kid = KID): KeyFixture {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  return { privateKey, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', kty: String(jwk.kty) }] } }
}

/** Sign a JWT (RS256 by default) over the given header/payload. */
function signJwt(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
): string {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')
  return `${signingInput}.${sig}`
}

function validClaims(over: Partial<IdTokenClaims> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    sub: 'subject-xyz',
    aud: AUD,
    exp: NOW + 300,
    iat: NOW - 5,
    nonce: NONCE,
    email: 'user@example.com',
    email_verified: true,
    ...over,
  }
}

function expectOidcCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OidcError)
    expect((err as OidcError).code).toBe(code)
    return
  }
  throw new Error(`expected OidcError ${code}, but nothing was thrown`)
}

describe('validateIdToken (P1-M4b)', () => {
  it('accepts a correctly-signed, in-window token and returns its claims', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims())
    const claims = validateIdToken({
      idToken: token,
      expectedIssuer: ISS,
      expectedAudience: AUD,
      expectedNonce: NONCE,
      now: NOW,
      jwks,
    })
    expect(claims.sub).toBe('subject-xyz')
    expect(claims.email).toBe('user@example.com')
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims())
    // Swap the payload segment for a different (unsigned) one.
    const [h, , s] = token.split('.')
    const forged = `${h}.${b64urlJson(validClaims({ sub: 'attacker' }))}.${s}`
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: forged,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'bad_signature',
    )
  })

  it('rejects a token signed by a DIFFERENT key (wrong issuer key)', () => {
    const signer = makeKey() // signs the token
    const trusted = makeKey() // the JWKS we actually trust (same kid, different key)
    const token = signJwt(signer.privateKey, validClaims())
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks: trusted.jwks,
        }),
      'bad_signature',
    )
  })

  it('rejects a wrong issuer', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims({ iss: 'https://evil.example.com' }))
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'bad_issuer',
    )
  })

  it('rejects a token whose aud is not the client id', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims({ aud: 'some-other-client' }))
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'bad_audience',
    )
  })

  it('accepts an array aud that CONTAINS the client id', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims({ aud: ['other', AUD] }))
    const claims = validateIdToken({
      idToken: token,
      expectedIssuer: ISS,
      expectedAudience: AUD,
      expectedNonce: NONCE,
      now: NOW,
      jwks,
    })
    expect(claims.sub).toBe('subject-xyz')
  })

  it('rejects an expired token (beyond the skew window)', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims({ exp: NOW - 120 }))
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
          clockSkewSec: 60,
        }),
      'expired',
    )
  })

  it('rejects a mismatched nonce (replay protection)', () => {
    const { privateKey, jwks } = makeKey()
    const token = signJwt(privateKey, validClaims({ nonce: 'stale-nonce' }))
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'bad_nonce',
    )
  })

  it('rejects an unsupported alg (no alg:none / HS256 downgrade)', () => {
    const { privateKey, jwks } = makeKey()
    // Sign with RS256 bytes but lie in the header that it's HS256.
    const token = signJwt(privateKey, validClaims(), { alg: 'HS256', kid: KID, typ: 'JWT' })
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'unsupported_alg',
    )
  })

  it('rejects when no JWKS key matches the header kid', () => {
    const { privateKey } = makeKey()
    const other = makeKey('different-kid')
    const token = signJwt(privateKey, validClaims()) // header kid = KID
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: token,
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks: other.jwks, // only has 'different-kid'
        }),
      'unknown_key',
    )
  })

  it('rejects a structurally malformed token', () => {
    const { jwks } = makeKey()
    expectOidcCode(
      () =>
        validateIdToken({
          idToken: 'not-a-jwt',
          expectedIssuer: ISS,
          expectedAudience: AUD,
          expectedNonce: NONCE,
          now: NOW,
          jwks,
        }),
      'malformed_token',
    )
  })
})

describe('generatePkce (P1-M4b)', () => {
  it('challenge is base64url(sha256(verifier)) with method S256', () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce()
    expect(codeChallengeMethod).toBe('S256')
    const expected = createHash('sha256').update(codeVerifier).digest().toString('base64url')
    expect(codeChallenge).toBe(expected)
    // 32 random bytes → 43-char unpadded base64url verifier (RFC 7636 range).
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('produces a fresh verifier each call', () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier)
  })
})

describe('buildAuthorizationUrl (P1-M4b)', () => {
  it('encodes a code+PKCE request with openid scope and the given state/nonce', () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: 'https://idp.example.com/authorize',
        clientId: AUD,
        redirectUri: 'https://hub.example.com/api/auth/oidc/callback',
        state: 'state-1',
        nonce: 'nonce-1',
        codeChallenge: 'challenge-1',
      }),
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(AUD)
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('nonce')).toBe('nonce-1')
    expect(url.searchParams.get('scope')!.split(' ')).toContain('openid')
  })

  it('forces openid into a caller scope that omits it', () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: 'https://idp.example.com/authorize',
        clientId: AUD,
        redirectUri: 'https://hub.example.com/cb',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        scope: 'email profile',
      }),
    )
    expect(url.searchParams.get('scope')!.split(' ')).toContain('openid')
  })

  it('rejects missing required inputs', () => {
    expectOidcCode(
      () =>
        buildAuthorizationUrl({
          authorizationEndpoint: '',
          clientId: AUD,
          redirectUri: 'x',
          state: 's',
          nonce: 'n',
          codeChallenge: 'c',
        }),
      'invalid_input',
    )
  })
})

describe('randomState / randomNonce (P1-M4b)', () => {
  it('are distinct, URL-safe, and high entropy', () => {
    const a = randomState()
    const b = randomNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })
})
