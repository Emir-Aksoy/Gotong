/**
 * Route B P1-M4c — host-side OIDC client glue.
 *
 * The only part of the OIDC flow that touches the network: discovery-document
 * + JWKS fetch (both cached) and the authorization-code → token exchange. It
 * COMPOSES the pure M4b core (`validateIdToken`) — it never re-implements any
 * crypto. `fetchImpl` is injectable so the whole thing runs in tests without a
 * real IdP (same posture as the a2a client).
 *
 * Decision: the SP is confidential (`client_secret_post`). A public/PKCE-only
 * client is supported by leaving the secret empty — then PKCE alone proves the
 * exchange. Either way the authorization code is single-use and bound to the
 * `code_verifier` the start route stashed.
 */

import {
  OidcError,
  validateIdToken,
  type IdTokenClaims,
  type Jwks,
} from '@aipehub/identity'

export interface OidcProviderConfig {
  /** The IdP issuer URL — both the discovery base and the expected `iss`. */
  issuer: string
  clientId: string
  /** Empty string = public/PKCE-only client (no client_secret sent). */
  clientSecret: string
  redirectUri: string
  /** Space-separated extra scopes; `openid` is forced in by buildAuthorizationUrl. */
  scope?: string
}

export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  [k: string]: unknown
}

export interface OidcTokenResponse {
  id_token: string
  access_token?: string
  token_type?: string
  expires_in?: number
  [k: string]: unknown
}

export interface OidcClientOptions {
  /** Inject for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Discovery-doc cache TTL (default 1h). */
  discoveryTtlMs?: number
  /** JWKS cache TTL (default 10m). */
  jwksTtlMs?: number
}

interface CacheEntry<T> {
  value: T
  fetchedAt: number
}

/** Strip trailing slashes so issuer comparison + discovery URL are stable. */
function normIssuer(issuer: string): string {
  return issuer.replace(/\/+$/u, '')
}

export class OidcClient {
  private readonly doFetch: typeof fetch
  private readonly discoveryTtlMs: number
  private readonly jwksTtlMs: number
  private readonly discoveryCache = new Map<string, CacheEntry<OidcDiscovery>>()
  private readonly jwksCache = new Map<string, CacheEntry<Jwks>>()

  constructor(opts: OidcClientOptions = {}) {
    this.doFetch = opts.fetchImpl ?? fetch
    this.discoveryTtlMs = opts.discoveryTtlMs ?? 3_600_000
    this.jwksTtlMs = opts.jwksTtlMs ?? 600_000
  }

  /**
   * Fetch + cache the IdP discovery document. Enforces that the document's own
   * `issuer` matches the configured issuer (OIDC Discovery §4.3 — a mismatch
   * means the well-known URL was redirected to a hostile/foreign IdP).
   */
  async discover(issuer: string): Promise<OidcDiscovery> {
    const key = normIssuer(issuer)
    const cached = this.discoveryCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < this.discoveryTtlMs) {
      return cached.value
    }
    const doc = await this.getJson<OidcDiscovery>(
      `${key}/.well-known/openid-configuration`,
      'discovery_failed',
    )
    if (normIssuer(String(doc.issuer)) !== key) {
      throw new OidcError(
        'discovery_issuer_mismatch',
        `discovery issuer ${String(doc.issuer)} does not match ${issuer}`,
      )
    }
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new OidcError('discovery_incomplete', 'discovery doc missing required endpoints')
    }
    this.discoveryCache.set(key, { value: doc, fetchedAt: Date.now() })
    return doc
  }

  /** Fetch + cache the IdP's signing keys. */
  async fetchJwks(jwksUri: string): Promise<Jwks> {
    const cached = this.jwksCache.get(jwksUri)
    if (cached && Date.now() - cached.fetchedAt < this.jwksTtlMs) {
      return cached.value
    }
    const jwks = await this.getJson<Jwks>(jwksUri, 'jwks_failed')
    if (!jwks || !Array.isArray(jwks.keys)) {
      throw new OidcError('jwks_invalid', 'jwks response missing keys[]')
    }
    this.jwksCache.set(jwksUri, { value: jwks, fetchedAt: Date.now() })
    return jwks
  }

  /** Exchange an authorization code (+ PKCE verifier) for tokens. */
  async exchangeCode(
    config: OidcProviderConfig,
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
  ): Promise<OidcTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    })
    // Confidential client: include the secret. PKCE-only: leave it out.
    if (config.clientSecret) body.set('client_secret', config.clientSecret)

    let res: Response
    try {
      res = await this.doFetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      })
    } catch (err) {
      throw new OidcError(
        'token_exchange_failed',
        `token endpoint transport error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new OidcError('token_exchange_failed', `token endpoint HTTP ${res.status}`)
    }
    let json: OidcTokenResponse
    try {
      json = (await res.json()) as OidcTokenResponse
    } catch {
      throw new OidcError('token_exchange_failed', 'token response was not valid JSON')
    }
    if (!json || typeof json.id_token !== 'string' || json.id_token.length === 0) {
      throw new OidcError('no_id_token', 'token response missing id_token')
    }
    return json
  }

  /**
   * Handle the full callback: discover → exchange code → fetch JWKS → validate
   * the id_token. Returns the VERIFIED claims (sub, email, …). `expectedNonce`
   * is the nonce the start route stashed; `now` is unix seconds. Any failure
   * throws an OidcError (from here or from the pure validator).
   */
  async completeLogin(input: {
    config: OidcProviderConfig
    code: string
    codeVerifier: string
    expectedNonce: string
    now: number
  }): Promise<IdTokenClaims> {
    const disco = await this.discover(input.config.issuer)
    const tokens = await this.exchangeCode(
      input.config,
      disco.token_endpoint,
      input.code,
      input.codeVerifier,
    )
    const jwks = await this.fetchJwks(disco.jwks_uri)
    return validateIdToken({
      idToken: tokens.id_token,
      expectedIssuer: input.config.issuer,
      expectedAudience: input.config.clientId,
      expectedNonce: input.expectedNonce,
      now: input.now,
      jwks,
    })
  }

  private async getJson<T>(url: string, failCode: string): Promise<T> {
    let res: Response
    try {
      res = await this.doFetch(url, { headers: { accept: 'application/json' } })
    } catch (err) {
      throw new OidcError(
        failCode,
        `fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new OidcError(failCode, `${url} returned HTTP ${res.status}`)
    }
    try {
      return (await res.json()) as T
    } catch {
      throw new OidcError(failCode, `${url} response was not valid JSON`)
    }
  }
}
