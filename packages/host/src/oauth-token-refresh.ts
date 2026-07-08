/**
 * C-M2-M4b — outbound OAuth access-token auto-refresh (接入现实生活 track).
 *
 * A connected connector's access token is short-lived (Google ~1h). Without
 * refresh it dies after that window and the user would have to re-run the whole
 * OAuth flow. This background timer keeps the STORED token fresh via the
 * `refresh_token` grant, so every new/respawned MCP toolset (C-M2-M4a injects
 * at `buildToolset`) picks up a valid bearer and the connector stays alive
 * indefinitely — the user connects Google once, forever.
 *
 * Decide WITHOUT decrypting: which connectors are due is read from the
 * non-secret `accessTokenExpiresAt` projection column (M2 kept it out of the
 * vault for exactly this). Only when a connector is actually due do we decrypt
 * (its refresh token + client secret) and POST the grant.
 *
 * Scope boundary (frozen headers): the MCP http/sse transport bakes the bearer
 * into `requestInit.headers` at connect time, so refreshing the stored token
 * does NOT update a *running* toolset's live header — a session that outlives
 * its token 401s mid-flight (surfaced on `server-stderr`) and self-heals on the
 * agent's next respawn. Pushing a fresh token into live connections (hot-swap
 * via the pool's install/uninstall machinery, or per-request dynamic headers)
 * is a deliberate deferral — see REAL-LIFE-CONNECTORS.md.
 *
 * Opt-in: with zero connected connectors every tick iterates nothing and does
 * nothing (like the CARE patrol timers). No new env knob.
 */
import {
  OAuthError,
  buildTokenRefreshBody,
  parseTokenResponse,
  type OAuthConnector,
  type OutboundOAuthProvider,
  type StoredOAuthTokenSet,
} from '@gotong/identity'

/** The narrow identity facade the refresher needs (the real IdentityStore satisfies it). */
export interface OAuthRefreshIdentity {
  listOAuthConnectors(): OAuthConnector[]
  getOAuthTokenSet(id: string): StoredOAuthTokenSet | null
  readOAuthClientSecret(id: string): string
  setOAuthTokenSet(id: string, tokenSet: StoredOAuthTokenSet): OAuthConnector
}

/** Minimal structured logger (the host `log` satisfies it). */
export interface RefreshLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

export interface OAuthTokenRefresherOptions {
  logger?: RefreshLogger
  /** Poll cadence. Default 60s (a due token is caught well inside its skew). */
  intervalMs?: number
  /** Refresh a token once it is within this window of expiry. Default 5min. */
  refreshSkewMs?: number
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_SKEW_MS = 5 * 60_000

/**
 * Background sweeper that refreshes near-expiry OAuth access tokens. Constructed
 * once by the host; `start()` arms the interval + fires an immediate catch-up
 * tick (so a token that expired while the host was down recovers on boot),
 * `stop()` cancels it (called from the graceful-shutdown drain).
 */
export class OAuthTokenRefresher {
  private readonly identity: OAuthRefreshIdentity
  private readonly logger?: RefreshLogger
  private readonly intervalMs: number
  private readonly refreshSkewMs: number
  private readonly nowMs: () => number
  private readonly doFetch: typeof fetch
  private timer?: ReturnType<typeof setInterval>
  /** Reentrancy guard — a slow tick must not overlap the next interval. */
  private running = false
  /** Connectors already warned about a missing refresh token — warn once, not every tick. */
  private readonly warnedNoRefresh = new Set<string>()

  constructor(identity: OAuthRefreshIdentity, opts: OAuthTokenRefresherOptions = {}) {
    this.identity = identity
    this.logger = opts.logger
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_SKEW_MS
    this.nowMs = opts.now ?? (() => Date.now())
    this.doFetch = opts.fetchImpl ?? fetch
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    // Don't hold the event loop open just for the refresh cadence.
    this.timer.unref?.()
    // Catch-up: recover a token that expired while the host was down, without
    // waiting a full interval.
    void this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * One sweep: refresh every enabled + connected connector whose access token is
   * within the skew of expiry. Per-connector failures are logged and skipped —
   * one bad connector never aborts the sweep. Never throws.
   */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = this.nowMs()
      for (const c of this.identity.listOAuthConnectors()) {
        if (!c.enabled || !c.connected) continue
        // Decide from the non-secret projection — no decrypt to triage.
        if (c.accessTokenExpiresAt == null) continue // provider stated no lifetime
        if (c.accessTokenExpiresAt - now > this.refreshSkewMs) continue // still fresh
        await this.refreshOne(c)
      }
    } catch (err) {
      // listOAuthConnectors itself failing is the only way we land here.
      this.logger?.error('oauth refresh sweep failed', { err })
    } finally {
      this.running = false
    }
  }

  /** Refresh a single due connector. Swallows + logs its own failures. */
  private async refreshOne(c: OAuthConnector): Promise<void> {
    let stored: StoredOAuthTokenSet | null
    try {
      stored = this.identity.getOAuthTokenSet(c.id)
    } catch (err) {
      this.logger?.error('oauth token unreadable — skipping refresh', { connector: c.id, err })
      return
    }
    const refreshToken = stored?.refreshToken
    if (!refreshToken) {
      if (!this.warnedNoRefresh.has(c.id)) {
        this.warnedNoRefresh.add(c.id)
        this.logger?.warn(
          'oauth connector near expiry but has no refresh token — reconnect required',
          { connector: c.id },
        )
      }
      return
    }
    this.warnedNoRefresh.delete(c.id)

    let next: StoredOAuthTokenSet
    try {
      next = await this.refreshGrant(this.toProvider(c), refreshToken, stored!)
    } catch (err) {
      this.logger?.error('oauth token refresh failed', { connector: c.id, err })
      return
    }
    try {
      this.identity.setOAuthTokenSet(c.id, next)
      this.logger?.info('oauth token refreshed', {
        connector: c.id,
        expiresAt: next.accessTokenExpiresAt,
      })
    } catch (err) {
      this.logger?.error('oauth token refresh persist failed', { connector: c.id, err })
    }
  }

  /** Reveal the client secret, mapping the public-client empty string to undefined. */
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
   * The one network hop: POST the `refresh_token` grant, parse + normalize, and
   * stamp the new absolute expiry. A response that omits a new `refresh_token`
   * carries the prior one forward (RFC 6749 §6 — refresh tokens are typically
   * reusable). Transport / non-2xx / non-JSON / access-token-less all throw.
   */
  private async refreshGrant(
    provider: OutboundOAuthProvider,
    refreshToken: string,
    prior: StoredOAuthTokenSet,
  ): Promise<StoredOAuthTokenSet> {
    const body = buildTokenRefreshBody(provider, refreshToken)
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
        'token_refresh_failed',
        `token endpoint transport error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      throw new OAuthError('token_refresh_failed', `token endpoint HTTP ${res.status}`)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new OAuthError('token_refresh_failed', 'token response was not valid JSON')
    }
    const parsed = parseTokenResponse(json)
    const expiresAt =
      typeof parsed.expiresIn === 'number' ? this.nowMs() + parsed.expiresIn * 1000 : null
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? refreshToken,
      tokenType: parsed.tokenType ?? prior.tokenType,
      scope: parsed.scope ?? prior.scope,
      accessTokenExpiresAt: expiresAt,
    }
  }
}
