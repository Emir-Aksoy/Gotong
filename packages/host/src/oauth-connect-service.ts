/**
 * C-M2-M3 — host outbound OAuth "connect" orchestration (接入现实生活 track).
 *
 * The outbound mirror of OidcLoginService, but the goal is the OPPOSITE
 * direction: instead of logging a user INTO the hub, it obtains an access token
 * so the hub can call an external API (Google Calendar, Gmail, Notion-hosted…)
 * ON THE USER'S BEHALF, and persists that token set in the vault for a real-life
 * MCP connector to use as its bearer (the injection into MCP configs lands in
 * C-M2-M4).
 *
 *   begin(connectorId)  → mint state + PKCE, stash them, return the provider
 *                         authorization URL to redirect the browser to.
 *   complete(state,code)→ validate the stashed state (CSRF, single-use, TTL),
 *                         exchange the code for tokens at the provider token
 *                         endpoint, and persist the token set (setOAuthTokenSet).
 *
 * Unlike OIDC there is NO discovery, NO JWKS, NO id_token — the connector config
 * carries explicit endpoints, and the pure request/response helpers
 * (buildTokenExchangeBody / parseTokenResponse, C-M2-M1) do the rest. The
 * network is a single POST, so `fetchImpl` is injected HERE (no separate client
 * class the way OIDC needed one for discovery/JWKS) and tests run without a real
 * provider.
 *
 * The in-flight `state → {connectorId, codeVerifier}` map is in-memory with a
 * short TTL + single-use, same as OidcLoginService: a connect completes in
 * seconds on the same process, and a host restart mid-connect just means the
 * user re-clicks — we deliberately do NOT persist resumable half-connects.
 *
 * Auth posture (enforced by the web layer, noted here for the reader): unlike
 * the OIDC LOGIN start route (public — anyone may begin a login), `begin` is an
 * OWNER action ("connect MY Google"), so the web route that calls it is
 * admin-gated. `complete` runs from the provider's top-level redirect back to
 * the hub (no Origin, no cookie guarantee), so its only CSRF binding is the
 * single-use server-minted `state`.
 */

import {
  OAuthError,
  buildOutboundAuthorizationUrl,
  buildTokenExchangeBody,
  generatePkce,
  parseTokenResponse,
  randomState,
  type OAuthConnector,
  type OutboundOAuthProvider,
  type StoredOAuthTokenSet,
} from '@gotong/identity'

/** The narrow identity facade this service needs (the real IdentityStore satisfies it). */
export interface OAuthConnectIdentity {
  getOAuthConnector(id: string): OAuthConnector | null
  readOAuthClientSecret(id: string): string
  setOAuthTokenSet(id: string, tokenSet: StoredOAuthTokenSet): OAuthConnector
}

interface PendingConnect {
  connectorId: string
  codeVerifier: string
  createdAt: number
}

export interface OAuthConnectServiceOptions {
  /** How long a started connect may sit before callback (default 10 min). */
  stateTtlMs?: number
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Inject for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class OAuthConnectService {
  private readonly pending = new Map<string, PendingConnect>()
  private readonly stateTtlMs: number
  private readonly nowMs: () => number
  private readonly doFetch: typeof fetch

  constructor(
    private readonly identity: OAuthConnectIdentity,
    opts: OAuthConnectServiceOptions = {},
  ) {
    this.stateTtlMs = opts.stateTtlMs ?? 600_000
    this.nowMs = opts.now ?? (() => Date.now())
    this.doFetch = opts.fetchImpl ?? fetch
  }

  /** Number of in-flight connects (for observability/tests). */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Project a connector row (+ its revealed client secret) into the pure
   * OutboundOAuthProvider the C-M2-M1 helpers consume. A public (PKCE-only)
   * client has no secret — `readOAuthClientSecret` returns '' which we map to
   * undefined so `buildTokenExchangeBody` sends none.
   */
  private toProvider(c: OAuthConnector): OutboundOAuthProvider {
    const secret = this.identity.readOAuthClientSecret(c.id)
    return {
      authorizationEndpoint: c.authorizationEndpoint,
      tokenEndpoint: c.tokenEndpoint,
      clientId: c.clientId,
      ...(secret ? { clientSecret: secret } : {}),
      redirectUri: c.redirectUri,
      scope: c.scope,
      ...(c.extraAuthParams ? { extraAuthParams: c.extraAuthParams } : {}),
    }
  }

  /**
   * Start a connect: generate the CSRF `state` + PKCE pair, stash them under
   * `state`, and return the provider authorization URL. The caller redirects the
   * browser there. A disabled connector is refused (`oauth_connector_disabled`)
   * — the config stays but must be re-enabled before it can be connected.
   */
  async begin(connectorId: string): Promise<{ authorizationUrl: string; state: string }> {
    const c = this.identity.getOAuthConnector(connectorId)
    if (!c) {
      throw new OAuthError('oauth_connector_not_found', `no OAuth connector ${connectorId}`)
    }
    if (!c.enabled) {
      throw new OAuthError('oauth_connector_disabled', `OAuth connector ${connectorId} is disabled`)
    }
    const state = randomState()
    const pkce = generatePkce()
    this.prune()
    this.pending.set(state, {
      connectorId,
      codeVerifier: pkce.codeVerifier,
      createdAt: this.nowMs(),
    })
    const authorizationUrl = buildOutboundAuthorizationUrl({
      provider: this.toProvider(c),
      state,
      codeChallenge: pkce.codeChallenge,
    })
    return { authorizationUrl, state }
  }

  /**
   * Complete a connect from the provider callback. Validates `state`
   * (unknown/expired → `oauth_state_invalid`; single-use), exchanges the code
   * for tokens, and persists the token set. Returns the updated connector (now
   * `connected: true`). Any failure throws an OAuthError.
   */
  async complete(input: { state: string; code: string }): Promise<{
    connectorId: string
    connector: OAuthConnector
  }> {
    const pend = this.pending.get(input.state)
    // Single-use: consume the state regardless of what happens next, so a replay
    // of the same (state, code) can't re-run the exchange.
    if (pend) this.pending.delete(input.state)
    if (!pend) {
      throw new OAuthError('oauth_state_invalid', 'unknown or already-used connect state')
    }
    if (this.nowMs() - pend.createdAt > this.stateTtlMs) {
      throw new OAuthError('oauth_state_invalid', 'connect state expired')
    }
    const c = this.identity.getOAuthConnector(pend.connectorId)
    if (!c) {
      throw new OAuthError('oauth_connector_not_found', `connector ${pend.connectorId} vanished mid-connect`)
    }
    const tokenSet = await this.exchangeCode(this.toProvider(c), input.code, pend.codeVerifier)
    const connector = this.identity.setOAuthTokenSet(c.id, tokenSet)
    return { connectorId: c.id, connector }
  }

  /**
   * The one network hop: POST the authorization-code exchange body to the
   * provider token endpoint, parse + normalize the response, and stamp the
   * absolute expiry from `expires_in` (the store keeps it as non-secret
   * metadata). Transport / non-2xx / non-JSON / access-token-less responses all
   * throw — no partial trust in a botched exchange.
   */
  private async exchangeCode(
    provider: OutboundOAuthProvider,
    code: string,
    codeVerifier: string,
  ): Promise<StoredOAuthTokenSet> {
    const body = buildTokenExchangeBody(provider, code, codeVerifier)
    let res: Response
    try {
      res = await this.doFetch(provider.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      })
    } catch (err) {
      throw new OAuthError(
        'token_exchange_failed',
        `token endpoint transport error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new OAuthError('token_exchange_failed', `token endpoint HTTP ${res.status}`)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new OAuthError('token_exchange_failed', 'token response was not valid JSON')
    }
    // parseTokenResponse (C-M2-M1) throws OAuthError('no_access_token' /
    // 'malformed_response') on anything unusable.
    const parsed = parseTokenResponse(json)
    const expiresAt =
      typeof parsed.expiresIn === 'number' ? this.nowMs() + parsed.expiresIn * 1000 : null
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      tokenType: parsed.tokenType ?? null,
      scope: parsed.scope ?? null,
      accessTokenExpiresAt: expiresAt,
    }
  }

  /** Drop expired pending connects so the map can't grow unbounded. */
  private prune(): void {
    const cutoff = this.nowMs() - this.stateTtlMs
    for (const [state, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(state)
    }
  }
}
