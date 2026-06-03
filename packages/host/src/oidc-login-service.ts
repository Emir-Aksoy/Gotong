/**
 * Route B P1-M4e — host OIDC login orchestration.
 *
 * Ties the pieces together for a browser SSO round-trip without the web layer
 * knowing any OIDC detail:
 *   begin(providerId)  → discover the IdP, mint state+nonce+PKCE, stash them,
 *                        return the authorization URL to redirect the browser to.
 *   complete(state,code)→ validate the stashed state (CSRF), exchange+verify the
 *                        id_token (M4c client → M4b validator), resolve a LOCAL
 *                        user, and mint the SAME `ses_` session every other auth
 *                        path produces (decision D-3 — OIDC bootstraps a session,
 *                        it is not a per-request token passthrough).
 *
 * The in-flight `state → {nonce, codeVerifier}` map is in-memory with a short
 * TTL and single-use semantics. That matches the "单 host = 单 org" model (a
 * login completes in seconds on the same process); a host restart mid-login
 * just means the user retries. We deliberately do NOT persist it — a restart
 * should not leave resumable half-logins lying around.
 *
 * Account resolution is JIT-link-by-verified-email, never auto-provision: if
 * (issuer, sub) is already linked we use it; else, only if the IdP asserts a
 * VERIFIED email that matches an EXISTING local user do we link them. An
 * unknown identity is refused (`oidc_no_account`) — SSO lets pre-existing users
 * log in, it does not mint accounts for anyone with a Google login.
 */

import {
  OidcError,
  buildAuthorizationUrl,
  generatePkce,
  randomNonce,
  randomState,
  type IdTokenClaims,
  type Session,
  type User,
} from '@aipehub/identity'
import type { OidcProviderConfig } from './oidc-client.js'

/** The narrow identity facade this service needs (the real IdentityStore satisfies it). */
export interface OidcLoginIdentity {
  getOidcProvider(id: string): {
    id: string
    issuer: string
    clientId: string
    redirectUri: string
    scope: string | null
    enabled: boolean
  } | null
  readOidcClientSecret(id: string): string
  findUserByOidc(opts: { issuer: string; sub: string }): string | null
  linkOidc(input: { userId: string; issuer: string; sub: string }): string
  getUserByEmail(email: string): User | null
  authenticateOidc(opts: { issuer: string; sub: string; ttlMs?: number }): Session
}

/** The narrow OIDC-client slice (the real OidcClient satisfies it). */
export interface OidcLoginClient {
  discover(issuer: string): Promise<{ authorization_endpoint: string }>
  completeLogin(input: {
    config: OidcProviderConfig
    code: string
    codeVerifier: string
    expectedNonce: string
    now: number
  }): Promise<IdTokenClaims>
}

interface PendingLogin {
  providerId: string
  issuer: string
  nonce: string
  codeVerifier: string
  createdAt: number
}

export interface OidcLoginServiceOptions {
  /** How long a started login may sit before callback (default 10 min). */
  stateTtlMs?: number
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number
  /**
   * JIT-link an unlinked identity to an existing user when the IdP asserts a
   * verified, matching email (default true). Never creates accounts either way.
   */
  autoLinkByVerifiedEmail?: boolean
}

export class OidcLoginService {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly stateTtlMs: number
  private readonly nowMs: () => number
  private readonly autoLink: boolean

  constructor(
    private readonly identity: OidcLoginIdentity,
    private readonly client: OidcLoginClient,
    opts: OidcLoginServiceOptions = {},
  ) {
    this.stateTtlMs = opts.stateTtlMs ?? 600_000
    this.nowMs = opts.now ?? (() => Date.now())
    this.autoLink = opts.autoLinkByVerifiedEmail !== false
  }

  /** Number of in-flight logins (for observability/tests). */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Start a login: discover the IdP, generate the CSRF `state`, replay `nonce`,
   * and PKCE pair, stash them under `state`, and return the IdP authorization
   * URL. The caller redirects the browser there.
   */
  async begin(providerId: string): Promise<{ authorizationUrl: string; state: string }> {
    const provider = this.identity.getOidcProvider(providerId)
    if (!provider) {
      throw new OidcError('oidc_provider_not_found', `no OIDC provider ${providerId}`)
    }
    if (!provider.enabled) {
      throw new OidcError('oidc_provider_disabled', `OIDC provider ${providerId} is disabled`)
    }
    const disco = await this.client.discover(provider.issuer)
    const state = randomState()
    const nonce = randomNonce()
    const pkce = generatePkce()
    this.prune()
    this.pending.set(state, {
      providerId,
      issuer: provider.issuer,
      nonce,
      codeVerifier: pkce.codeVerifier,
      createdAt: this.nowMs(),
    })
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: disco.authorization_endpoint,
      clientId: provider.clientId,
      redirectUri: provider.redirectUri,
      state,
      nonce,
      codeChallenge: pkce.codeChallenge,
      ...(provider.scope ? { scope: provider.scope } : {}),
    })
    return { authorizationUrl, state }
  }

  /**
   * Complete a login from the IdP callback. Validates `state` (unknown/expired →
   * `oidc_state_invalid`; single-use), exchanges + verifies the id_token, resolves
   * a local user, and mints a session. Any OIDC failure throws an OidcError.
   */
  async complete(input: { state: string; code: string; nowSeconds?: number }): Promise<{
    session: Session
    userId: string
  }> {
    const pend = this.pending.get(input.state)
    // Single-use: consume the state regardless of what happens next, so a
    // replay of the same (state, code) can't re-run the exchange.
    if (pend) this.pending.delete(input.state)
    if (!pend) {
      throw new OidcError('oidc_state_invalid', 'unknown or already-used login state')
    }
    if (this.nowMs() - pend.createdAt > this.stateTtlMs) {
      throw new OidcError('oidc_state_invalid', 'login state expired')
    }
    const provider = this.identity.getOidcProvider(pend.providerId)
    if (!provider) {
      throw new OidcError('oidc_provider_not_found', `provider ${pend.providerId} vanished mid-login`)
    }
    const clientSecret = this.identity.readOidcClientSecret(provider.id)
    const claims = await this.client.completeLogin({
      config: {
        issuer: provider.issuer,
        clientId: provider.clientId,
        clientSecret,
        redirectUri: provider.redirectUri,
        ...(provider.scope ? { scope: provider.scope } : {}),
      },
      code: input.code,
      codeVerifier: pend.codeVerifier,
      expectedNonce: pend.nonce,
      now: input.nowSeconds ?? Math.floor(this.nowMs() / 1000),
    })

    // Ensure a local link exists (pre-existing or JIT), then mint the session.
    const userId = this.resolveLocalUser(provider.issuer, claims)
    const session = this.identity.authenticateOidc({ issuer: provider.issuer, sub: claims.sub })
    return { session, userId }
  }

  /**
   * Map a verified (issuer, sub) to a LOCAL user id. Pre-existing link wins;
   * otherwise JIT-link by verified email to an existing user; otherwise refuse.
   * Never creates a user.
   */
  private resolveLocalUser(issuer: string, claims: IdTokenClaims): string {
    const linked = this.identity.findUserByOidc({ issuer, sub: claims.sub })
    if (linked) return linked

    if (this.autoLink && claims.email_verified === true && typeof claims.email === 'string') {
      const user = this.identity.getUserByEmail(claims.email)
      if (user) {
        // No existing link for this (issuer, sub) — we just checked — so this
        // can only succeed (or throw oidc_already_linked on a genuine race).
        this.identity.linkOidc({ userId: user.id, issuer, sub: claims.sub })
        return user.id
      }
    }
    throw new OidcError(
      'oidc_no_account',
      'no local account is linked to this identity; ask an admin to create or link one',
    )
  }

  /** Drop expired pending logins so the map can't grow unbounded. */
  private prune(): void {
    const cutoff = this.nowMs() - this.stateTtlMs
    for (const [state, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(state)
    }
  }
}
