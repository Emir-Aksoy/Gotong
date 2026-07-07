/**
 * C-M2-M1 — outbound OAuth 2.0 pure core.
 *
 * Inbound OIDC (oidc.ts) answers "who is logging INTO the hub" — it ends by
 * validating an `id_token`. This module answers the OTHER direction: the hub is
 * the CLIENT obtaining an access token to call an external API (Google
 * Calendar, Gmail, Notion-hosted…) ON THE USER'S BEHALF, so a real-life MCP
 * connector can reach their data.
 *
 * The two directions look alike (authorization-code + PKCE) but differ where it
 * matters, which is exactly why this is its own module instead of a flag on the
 * OIDC core:
 *   - **No id_token / no nonce.** We don't care who the user is; we want the
 *     access token. A plain OAuth2 token response has NO id_token, so
 *     `oidc-client.exchangeCode` would reject it (`no_id_token`).
 *   - **Native scopes, never forced to `openid`.** Notion doesn't understand
 *     `openid`; Google Calendar wants `.../auth/calendar`. `buildAuthorizationUrl`
 *     force-injects `openid` — wrong here.
 *   - **Refresh grant.** Inbound login validates once and forgets; a connector
 *     must keep working for weeks, so we need `grant_type=refresh_token`.
 *
 * Same posture as oidc.ts: ZERO network, ZERO state. URL building, request
 * bodies and response parsing are pure functions the M3 route + M4 token store
 * drive with an injected `fetch`. PKCE + random `state` generation are REUSED
 * verbatim from oidc.ts (`generatePkce` / `randomState`, RFC 7636 is
 * direction-agnostic) — the M3 route imports them straight from there; this
 * module takes the resulting `state` / `codeChallenge` as inputs, exactly as
 * the inbound `buildAuthorizationUrl` does.
 */

/** Typed failure with a stable `code` (mapped to HTTP / audit upstream). */
export class OAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OAuthError'
    this.code = code
  }
}

/**
 * A plain OAuth 2.0 (authorization-code + PKCE) provider the hub connects OUT
 * to. Endpoints are explicit (not derived from OIDC discovery) because not every
 * provider serves `.well-known/openid-configuration` — Notion, for one, does not.
 */
export interface OutboundOAuthProvider {
  /** e.g. `https://accounts.google.com/o/oauth2/v2/auth`. */
  authorizationEndpoint: string
  /** e.g. `https://oauth2.googleapis.com/token`. */
  tokenEndpoint: string
  clientId: string
  /**
   * Empty / omitted = public (PKCE-only) client; then PKCE alone proves the
   * exchange. Google / Notion are confidential and set this.
   */
  clientSecret?: string
  redirectUri: string
  /** Space-separated PROVIDER-NATIVE scopes. Never forced to `openid`. */
  scope: string
  /**
   * Provider-specific extra authorize params. The one that bites people:
   * Google only returns a `refresh_token` when the authorize URL carries
   * `access_type=offline` (and usually `prompt=consent`) — pass them here.
   */
  extraAuthParams?: Record<string, string>
}

export interface BuildOutboundAuthInput {
  provider: OutboundOAuthProvider
  /** High-entropy CSRF token the route stashes server-side and re-checks. */
  state: string
  /** base64url(sha256(codeVerifier)) — from {@link generatePkce}. */
  codeChallenge: string
}

/**
 * Build the authorization-code + PKCE request URL for an outbound provider.
 * `response_type=code`, S256 PKCE, provider-native `scope` used AS-IS (no
 * `openid` injection, no `nonce`). `extraAuthParams` are layered on last so a
 * provider can add `access_type=offline` etc. — but they can NOT override the
 * security-critical params we set (those win).
 */
export function buildOutboundAuthorizationUrl(input: BuildOutboundAuthInput): string {
  const p = input?.provider
  for (const [k, v] of Object.entries({
    authorizationEndpoint: p?.authorizationEndpoint,
    clientId: p?.clientId,
    redirectUri: p?.redirectUri,
    scope: p?.scope,
    state: input?.state,
    codeChallenge: input?.codeChallenge,
  })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new OAuthError('invalid_input', `buildOutboundAuthorizationUrl requires ${k}`)
    }
  }
  const url = new URL(p.authorizationEndpoint)
  // Provider extras FIRST, so our required params below overwrite any attempt
  // (misconfig or otherwise) to smuggle a conflicting response_type / scope.
  for (const [k, v] of Object.entries(p.extraAuthParams ?? {})) {
    url.searchParams.set(k, v)
  }
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', p.clientId)
  url.searchParams.set('redirect_uri', p.redirectUri)
  url.searchParams.set('scope', p.scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/**
 * Pure `x-www-form-urlencoded` body for the authorization-code → token exchange.
 * Includes `client_secret` only for confidential clients; the `code_verifier`
 * (not the challenge) proves possession per RFC 7636.
 */
export function buildTokenExchangeBody(
  provider: OutboundOAuthProvider,
  code: string,
  codeVerifier: string,
): string {
  if (typeof code !== 'string' || code.length === 0) {
    throw new OAuthError('invalid_input', 'buildTokenExchangeBody requires code')
  }
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
    throw new OAuthError('invalid_input', 'buildTokenExchangeBody requires codeVerifier')
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    code_verifier: codeVerifier,
  })
  if (provider.clientSecret) body.set('client_secret', provider.clientSecret)
  return body.toString()
}

/**
 * Pure `x-www-form-urlencoded` body for a `refresh_token` grant — how a
 * connector keeps working after the (short-lived) access token expires.
 */
export function buildTokenRefreshBody(
  provider: OutboundOAuthProvider,
  refreshToken: string,
): string {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError('invalid_input', 'buildTokenRefreshBody requires refreshToken')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: provider.clientId,
  })
  if (provider.clientSecret) body.set('client_secret', provider.clientSecret)
  return body.toString()
}

/** A normalized token set — what both the initial exchange and a refresh yield. */
export interface OAuthTokenSet {
  accessToken: string
  /**
   * Present on the initial exchange (with `access_type=offline`); a refresh
   * response usually OMITS it (the existing refresh token stays valid), so this
   * is optional and callers must keep the prior refresh token when it's absent.
   */
  refreshToken?: string
  /** Lifetime in seconds, if the provider states one. */
  expiresIn?: number
  tokenType?: string
  /** The granted scope, if echoed back (may differ from what was requested). */
  scope?: string
  /** The raw parsed body, for provider-specific extras the caller may need. */
  raw: Record<string, unknown>
}

/**
 * Validate + normalize a token-endpoint JSON response (from either grant). A
 * usable response MUST carry a non-empty `access_token`; everything else is
 * best-effort. `expires_in` is coerced from string→number when a provider sends
 * it as a string. Throws {@link OAuthError} on anything unusable — no partial
 * trust in a malformed token blob.
 */
export function parseTokenResponse(json: unknown): OAuthTokenSet {
  if (json === null || typeof json !== 'object') {
    throw new OAuthError('malformed_response', 'token response is not a JSON object')
  }
  const raw = json as Record<string, unknown>
  const accessToken = raw.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('no_access_token', 'token response missing access_token')
  }
  const out: OAuthTokenSet = { accessToken, raw }
  if (typeof raw.refresh_token === 'string' && raw.refresh_token.length > 0) {
    out.refreshToken = raw.refresh_token
  }
  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)) {
    out.expiresIn = raw.expires_in
  } else if (typeof raw.expires_in === 'string' && /^\d+$/u.test(raw.expires_in)) {
    out.expiresIn = Number(raw.expires_in)
  }
  if (typeof raw.token_type === 'string') out.tokenType = raw.token_type
  if (typeof raw.scope === 'string') out.scope = raw.scope
  return out
}
