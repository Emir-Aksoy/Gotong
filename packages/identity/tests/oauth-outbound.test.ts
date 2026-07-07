/**
 * C-M2-M1 — outbound OAuth 2.0 pure core tests.
 *
 * Pins the ways outbound OAuth deliberately DIFFERS from the inbound OIDC core
 * (no `openid` injection, no nonce, native scopes, a refresh grant, an
 * id_token-free token response) plus the pure invariants: extras can't override
 * security-critical params, PKCE verifier (not challenge) proves the exchange,
 * a malformed/access-token-less response is rejected loudly.
 */

import { describe, expect, it } from 'vitest'

import {
  OAuthError,
  buildOutboundAuthorizationUrl,
  buildTokenExchangeBody,
  buildTokenRefreshBody,
  parseTokenResponse,
  type OutboundOAuthProvider,
} from '../src/oauth-outbound.js'

const GOOGLE: OutboundOAuthProvider = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://hub.example.com/api/admin/oauth/callback',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
}

// A public (PKCE-only) provider — no client secret.
const PUBLIC: OutboundOAuthProvider = {
  authorizationEndpoint: 'https://example.com/authorize',
  tokenEndpoint: 'https://example.com/token',
  clientId: 'pub-app',
  redirectUri: 'https://hub.example.com/cb',
  scope: 'read write',
}

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const STATE = 'x'.repeat(43)

describe('buildOutboundAuthorizationUrl (C-M2-M1)', () => {
  it('emits response_type=code + S256 PKCE with the state and challenge', () => {
    const u = new URL(buildOutboundAuthorizationUrl({ provider: GOOGLE, state: STATE, codeChallenge: CHALLENGE }))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe(GOOGLE.clientId)
    expect(u.searchParams.get('redirect_uri')).toBe(GOOGLE.redirectUri)
    expect(u.searchParams.get('state')).toBe(STATE)
    expect(u.searchParams.get('code_challenge')).toBe(CHALLENGE)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('uses provider-native scope AS-IS and never injects openid or a nonce', () => {
    const u = new URL(buildOutboundAuthorizationUrl({ provider: GOOGLE, state: STATE, codeChallenge: CHALLENGE }))
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly')
    expect(u.searchParams.get('scope')).not.toContain('openid')
    // Outbound is not OIDC: there is no nonce round-trip.
    expect(u.searchParams.get('nonce')).toBeNull()
  })

  it('layers extraAuthParams (Google needs access_type=offline for a refresh token)', () => {
    const u = new URL(buildOutboundAuthorizationUrl({ provider: GOOGLE, state: STATE, codeChallenge: CHALLENGE }))
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
  })

  it('security-critical params win over a conflicting extraAuthParam', () => {
    const evil: OutboundOAuthProvider = {
      ...PUBLIC,
      extraAuthParams: { response_type: 'token', scope: 'evil', code_challenge_method: 'plain' },
    }
    const u = new URL(buildOutboundAuthorizationUrl({ provider: evil, state: STATE, codeChallenge: CHALLENGE }))
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('scope')).toBe('read write')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it.each(['authorizationEndpoint', 'clientId', 'redirectUri', 'scope'] as const)(
    'throws invalid_input when provider.%s is missing',
    (field) => {
      const bad = { ...GOOGLE, [field]: '' }
      expect(() =>
        buildOutboundAuthorizationUrl({ provider: bad, state: STATE, codeChallenge: CHALLENGE }),
      ).toThrowError(OAuthError)
    },
  )

  it('throws invalid_input when state or codeChallenge is missing', () => {
    expect(() => buildOutboundAuthorizationUrl({ provider: GOOGLE, state: '', codeChallenge: CHALLENGE })).toThrow(
      /requires state/,
    )
    expect(() => buildOutboundAuthorizationUrl({ provider: GOOGLE, state: STATE, codeChallenge: '' })).toThrow(
      /requires codeChallenge/,
    )
  })
})

describe('buildTokenExchangeBody (C-M2-M1)', () => {
  it('is an authorization_code grant carrying the PKCE verifier, not the challenge', () => {
    const body = new URLSearchParams(buildTokenExchangeBody(GOOGLE, 'auth-code-abc', 'verifier-999'))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-abc')
    expect(body.get('redirect_uri')).toBe(GOOGLE.redirectUri)
    expect(body.get('client_id')).toBe(GOOGLE.clientId)
    expect(body.get('code_verifier')).toBe('verifier-999')
    expect(body.get('code_challenge')).toBeNull()
  })

  it('includes client_secret for a confidential client, omits it for a public one', () => {
    expect(new URLSearchParams(buildTokenExchangeBody(GOOGLE, 'c', 'v')).get('client_secret')).toBe('secret-xyz')
    expect(new URLSearchParams(buildTokenExchangeBody(PUBLIC, 'c', 'v')).get('client_secret')).toBeNull()
  })

  it('throws on a missing code or verifier', () => {
    expect(() => buildTokenExchangeBody(GOOGLE, '', 'v')).toThrow(/requires code/)
    expect(() => buildTokenExchangeBody(GOOGLE, 'c', '')).toThrow(/requires codeVerifier/)
  })
})

describe('buildTokenRefreshBody (C-M2-M1)', () => {
  it('is a refresh_token grant with the refresh token + client id', () => {
    const body = new URLSearchParams(buildTokenRefreshBody(GOOGLE, 'refresh-777'))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-777')
    expect(body.get('client_id')).toBe(GOOGLE.clientId)
    expect(body.get('client_secret')).toBe('secret-xyz')
  })

  it('omits client_secret for a public client and throws on a missing token', () => {
    expect(new URLSearchParams(buildTokenRefreshBody(PUBLIC, 'r')).get('client_secret')).toBeNull()
    expect(() => buildTokenRefreshBody(GOOGLE, '')).toThrow(/requires refreshToken/)
  })
})

describe('parseTokenResponse (C-M2-M1)', () => {
  it('normalizes a full initial-exchange response', () => {
    const t = parseTokenResponse({
      access_token: 'ya29.access',
      refresh_token: '1//refresh',
      expires_in: 3599,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    })
    expect(t.accessToken).toBe('ya29.access')
    expect(t.refreshToken).toBe('1//refresh')
    expect(t.expiresIn).toBe(3599)
    expect(t.tokenType).toBe('Bearer')
    expect(t.scope).toBe('https://www.googleapis.com/auth/calendar.readonly')
    expect(t.raw.access_token).toBe('ya29.access')
  })

  it('coerces a string expires_in to a number', () => {
    expect(parseTokenResponse({ access_token: 'a', expires_in: '7200' }).expiresIn).toBe(7200)
  })

  it('accepts a refresh response with no refresh_token (caller keeps the old one)', () => {
    const t = parseTokenResponse({ access_token: 'a2', expires_in: 3600 })
    expect(t.accessToken).toBe('a2')
    expect(t.refreshToken).toBeUndefined()
  })

  it('rejects a response with no usable access_token', () => {
    expect(() => parseTokenResponse({ token_type: 'Bearer' })).toThrow(OAuthError)
    expect(() => parseTokenResponse({ access_token: '' })).toThrow(/access_token/)
  })

  it('rejects a non-object body', () => {
    expect(() => parseTokenResponse(null)).toThrow(/JSON object/)
    expect(() => parseTokenResponse('nope')).toThrow(OAuthError)
  })
})
