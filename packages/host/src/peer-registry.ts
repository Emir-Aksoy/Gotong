/**
 * D1 (v4 Phase 5) — Peer Registry.
 *
 * Bridges the durable `peers` table in identity.sqlite to live HubLinks.
 * Runs a 5-second reconciliation tick (override with AIPE_PEER_POLL_MS):
 * each tick diffs the current `enabled` rows against the live link map
 * and dials new ones / drops vanished ones. Plus a one-time `acceptHubLinks`
 * setup on the shared transport-ws server so inbound peer HELLOs land here.
 *
 * Token storage:
 *   - Outbound: per-peer, in vault (decrypt via identity.getPeerToken).
 *   - Inbound:  one shared secret across all incoming peers, supplied via
 *               `sharedInboundPeerToken` (host main reads AIPE_PEER_INBOUND_TOKEN).
 *               Inbound HELLOs whose claimed peerId isn't in our peers table
 *               are accepted at the wire level but immediately closed.
 *
 * Hot reload:
 *   - admin web routes call `registry.invalidate()` after a peers-table
 *     write to skip the polling latency for the next tick.
 *
 * Backoff:
 *   - Outbound dial failures track `lastAttempt + attempts` in-memory.
 *     Retry interval grows 5s/15s/30s/60s capped, so a permanently-down
 *     peer doesn't burn CPU on every tick.
 */

import type {
  Hub,
  HubLink,
  Logger,
  Participant,
  ParticipantId,
  RemoteHubViaLink,
} from '@aipehub/core'
import { installPeerLink, type InstalledPeerLink } from '@aipehub/core'
import type { IdentityStore, PeerRegistration } from '@aipehub/identity'
import { acceptHubLinks, bearerAuth, connectHubLink } from '@aipehub/transport-ws'
// `WebSocketServer` is the runtime shape from `ws`. We don't take a
// runtime dep on the `ws` package here (transport-ws owns that); the
// caller passes the server instance from their `serveWebSocket` handle
// and we forward it to `acceptHubLinks` untouched.
type WebSocketServerLike = Parameters<typeof acceptHubLinks>[0]['server']

export interface PeerRegistryOptions {
  hub: Hub
  identity: IdentityStore
  /** Our hub's wire selfId. Stamped on outbound HELLO. */
  selfHubId: ParticipantId
  /**
   * Shared ws.WebSocketServer to attach the inbound peer 'connection'
   * handler to. Same server that handles agent sessions — the handler
   * peeks at the HELLO frame to decide if a connection is a peer or an
   * agent. Omit to skip inbound acceptance entirely (this host only
   * dials outbound peers).
   */
  wss?: WebSocketServerLike
  /**
   * If set, every inbound peer HELLO must present this exact string.
   * Outbound dials are unaffected (those use per-peer vault tokens).
   * Omitting accepts unauthenticated inbound peers — only safe behind
   * a private network.
   *
   * Phase 6 #4: prefer the per-peer path (auto-enabled when this
   * registry has an `identity` ref + at least one peers row). The
   * shared token remains for environments without identity or as a
   * blanket fallback during transition; when both per-peer and
   * shared are available, per-peer takes precedence (transport-ws
   * resolves expected token from the resolver first).
   */
  sharedInboundPeerToken?: string
  /**
   * Phase 6 #4 — when true (the default when `identity` is wired),
   * pass a per-peer `peerTokenResolver` to `acceptHubLinks`. The
   * resolver looks up `claimedPeerId` in the identity peers table
   * and reads the vault entry's plaintext on each handshake. Setting
   * this to `false` disables the resolver path entirely (only the
   * shared token remains, if any). Default: true.
   */
  perPeerInboundAuth?: boolean
  /**
   * Phase 6 #12 — inbound rate-limit budget per source IP. Defaults
   * to 60 attempts per 60s window. Set to 0 to disable.
   *
   * The limiter sits BEFORE the handshake state machine, so a peer
   * spraying HELLOs to brute-force a token never gets to allocate a
   * link. Per-IP keying means one rude peer can't starve others.
   * Hits beyond the budget close the ws silently — the legitimate
   * peer just retries on its next poll tick (D1 reconcile).
   */
  inboundRateLimit?: { max: number; windowMs: number }
  /**
   * Audit #142 — pass through to `acceptHubLinks` so the rate-limit
   * IP key respects `X-Forwarded-For` when this host runs behind a
   * reverse proxy. Default false. ON without a proxy lets a remote
   * attacker spoof the header; OFF behind a proxy buckets every
   * peer under the proxy's loopback IP. Pick to match the topology.
   */
  trustProxy?: boolean
  /** Default 5000ms. AIPE_PEER_POLL_MS override lives in main.ts. */
  pollIntervalMs?: number
  /** Optional logger; defaults to console-style noop-on-debug. */
  logger?: Logger
  /**
   * #2-M3 — responder for inbound HubLink RPC calls from peers (the
   * cross-hub MCP proxy). Wired onto BOTH inbound and outbound links via
   * `installPeerLink`. When omitted, inbound rpcs are answered with "peer
   * has no rpc handler". The responder owns its own ACL (the proxy only
   * serves servers flagged `shared`).
   */
  rpcResponder?: (call: { method: string; params: unknown }) => Promise<unknown>
  /**
   * Phase 18 B-M3 — factory for the outbound approval decorator. Invoked at
   * install time (both the outbound dial AND the inbound-accepted link) ONLY
   * for peers whose row has `requireApprovalOutbound`. It returns the
   * participant registered in place of the plain `RemoteHubViaLink` wrapper
   * (which MUST keep `inner.id` so capability routing + uninstall still key on
   * it). `main.ts` supplies one closing over the inbox store + approver.
   *
   * When omitted, a `requireApprovalOutbound` peer is sent to UNGATED — logged
   * at warn so the misconfiguration is loud rather than a silent fail-open. In
   * a bootstrapped hub the gate is always wired (owner + inbox both exist), so
   * that path is a canary, not a normal route.
   */
  outboundApprovalGate?: (inner: RemoteHubViaLink, row: PeerRegistration) => Participant
}

interface InstalledState {
  row: PeerRegistration
  link: HubLink
  install: InstalledPeerLink
}
interface BackoffState {
  lastAttempt: number
  attempts: number
}

const BACKOFF_LADDER_MS = [5_000, 15_000, 30_000, 60_000]

/**
 * Phase 6 #12 — minimal per-key fixed-window rate limiter. Designed
 * specifically for the inbound peer-handshake hot path:
 *
 *   - O(1) check via Map lookup
 *   - No timer / background sweep — buckets get rebuilt lazily on
 *     access; idle keys age out only when re-touched, but the cost
 *     of a stale entry is one small object until next GC
 *   - No external deps; avoids pulling @aipehub/web's RateLimiter
 *     (which would create a host→web dependency cycle)
 *
 * The window resets fully on first hit past `windowMs` since the
 * window started — this is "leaky bucket" semantics with bucket=max
 * per window. Good enough for "stop a brute-force script"; an
 * attacker spreading hits across windows still gets `max * (60/win)`
 * per minute, but at default 60/60s that's still bounded.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { hits: number; windowStart: number }>()
  /**
   * Audit #141 — sample-based sweep counter. Every `SWEEP_EVERY_N`
   * attempts we walk the Map once and drop entries whose window has
   * fully expired. This is intentionally NOT a setInterval timer:
   *
   *   - no extra fd / timer cleanup to coordinate with `stop()`;
   *   - sweep cost is amortised across attempts, so an idle host pays
   *     nothing while a flooded host pays O(buckets) once per N attempts;
   *   - on a flood, N attempts will themselves keep evicting the oldest
   *     bucket on .set(), so the Map size is bounded even before sweep.
   *
   * Without this, an attacker spraying unique source IPs (IPv6 /64 ≈
   * 2^64 addressable; even modest botnets give 10⁵-10⁶ unique IPs/day)
   * would grow `buckets` unbounded until OOM. With a 60s window and
   * default sweep, a 1M-IP/day attack settles at ~1M*100B = 100MB at
   * peak then collapses on the next sweep tick — still bad, but the
   * sweep keeps it from being permanent.
   */
  private attemptsSinceSweep = 0
  private static readonly SWEEP_EVERY_N = 256

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record one attempt for `key` and return whether it's still under
   * budget. Use the return value as "allow this connection".
   */
  attempt(key: string, now: number = Date.now()): boolean {
    if (this.max <= 0 || this.windowMs <= 0) return true // disabled
    if (++this.attemptsSinceSweep >= FixedWindowLimiter.SWEEP_EVERY_N) {
      this.attemptsSinceSweep = 0
      this.sweepExpired(now)
    }
    const b = this.buckets.get(key)
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { hits: 1, windowStart: now })
      return true
    }
    b.hits++
    return b.hits <= this.max
  }

  /** Snapshot for tests / observability. */
  current(key: string): { hits: number; windowStart: number } | undefined {
    return this.buckets.get(key)
  }

  /**
   * Audit #141 — drop buckets whose window has expired. Public so the
   * test suite + long-running monitoring can poke it without waiting
   * for the lazy-sample interval. Cheap walk (Map iteration); safe to
   * call while attempts are in flight (single-threaded JS).
   */
  sweepExpired(now: number = Date.now()): number {
    if (this.windowMs <= 0) return 0
    let dropped = 0
    for (const [key, b] of this.buckets) {
      // Use 2× window as the grace threshold so we don't yank a bucket
      // a peer is still building hits against. An entry is "stale" only
      // when even a re-attempt would have rolled it anyway.
      if (now - b.windowStart >= this.windowMs * 2) {
        this.buckets.delete(key)
        dropped++
      }
    }
    return dropped
  }

  /** Diagnostic: total tracked keys. Stable for monitoring / tests. */
  size(): number {
    return this.buckets.size
  }
}

export class PeerRegistry {
  private readonly opts: Required<Pick<PeerRegistryOptions, 'pollIntervalMs'>> &
    PeerRegistryOptions
  /** Keyed by `PeerRegistration.id` (the internal row id, not peerId). */
  private installed = new Map<string, InstalledState>()
  /** Same key as `installed`; tracks dial backoff between ticks. */
  private backoff = new Map<string, BackoffState>()
  private intervalHandle: NodeJS.Timeout | undefined
  private detachAccept: (() => void) | undefined
  private isShuttingDown = false
  /** Prevents concurrent ticks from racing each other. */
  private tickInFlight = false
  /** Phase 6 #12 — inbound rate limiter; built in start(). */
  private inboundLimiter: FixedWindowLimiter | undefined

  constructor(opts: PeerRegistryOptions) {
    this.opts = { pollIntervalMs: 5_000, ...opts }
  }

  /**
   * Begin reconciliation. Sets up the inbound accept (if `wss` was
   * supplied), starts the polling interval, and fires one immediate
   * tick. Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this.intervalHandle) return
    if (this.opts.wss) {
      // Phase 6 #4 — wire a per-peer token resolver when identity is
      // present and the operator hasn't opted out. The resolver runs on
      // each inbound HELLO; misses (unknown peer / disabled / vault read
      // throws) return null so transport-ws closes the connection.
      const perPeerEnabled = this.opts.perPeerInboundAuth !== false
      const resolver = perPeerEnabled
        ? buildPeerTokenResolver(this.opts.identity, (lv, msg, ctx) =>
            this.log(lv, msg, ctx),
          )
        : undefined
      // Phase 6 #12 — per-IP fixed-window limiter. Default 60/60s.
      // 0 for either field disables the limiter entirely (useful in
      // tests + closed networks where this is purely overhead).
      const rl = this.opts.inboundRateLimit ?? { max: 60, windowMs: 60_000 }
      this.inboundLimiter = new FixedWindowLimiter(rl.max, rl.windowMs)
      const limiter = this.inboundLimiter
      const onConnectionAttempt = rl.max > 0 && rl.windowMs > 0
        ? (ip: string): boolean => {
          const allowed = limiter.attempt(ip)
          if (!allowed) {
            // Log at warn (not error) — sustained rejections from
            // one IP are an attacker / misconfigured peer, both of
            // which the operator should look at but neither is a
            // host-internal bug. Once per slammed IP per window
            // (the limiter returns false repeatedly but the bucket
            // hit-count is the actual measurement).
            this.log('warn', 'peer inbound rate-limited', {
              ip,
              hits: limiter.current(ip)?.hits ?? -1,
              max: rl.max,
              windowMs: rl.windowMs,
            })
          }
          return allowed
        }
        : undefined
      // R1 — fold the shared-secret + per-peer resolver into one bearer
      // scheme. The resolver wins for verification when both are present
      // (bearerAuth's precedence), preserving the prior behavior.
      const sharedToken = this.opts.sharedInboundPeerToken
      const inboundAuth =
        resolver || sharedToken
          ? bearerAuth({
              ...(sharedToken ? { token: sharedToken } : {}),
              ...(resolver ? { resolver } : {}),
            })
          : undefined
      this.detachAccept = acceptHubLinks({
        server: this.opts.wss,
        selfId: this.opts.selfHubId,
        ...(inboundAuth ? { auth: inboundAuth } : {}),
        ...(onConnectionAttempt ? { onConnectionAttempt } : {}),
        // Audit #142 — without this, rate-limiter buckets are keyed
        // on the proxy's loopback IP in proxied deployments.
        ...(this.opts.trustProxy === true ? { trustProxy: true } : {}),
        onLink: (link) => this.installInboundLink(link),
      })
    }
    this.intervalHandle = setInterval(() => {
      void this.tick().catch((err) =>
        this.log('error', 'peer-registry tick failed', { err: this.errMsg(err) }),
      )
    }, this.opts.pollIntervalMs)
    this.intervalHandle.unref?.()
    void this.tick().catch((err) =>
      this.log('error', 'peer-registry initial tick failed', {
        err: this.errMsg(err),
      }),
    )
  }

  /**
   * Tear down everything. Clears the interval, detaches the inbound
   * accept handler, uninstalls + closes every live link. Idempotent.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = undefined
    }
    if (this.detachAccept) {
      this.detachAccept()
      this.detachAccept = undefined
    }
    for (const [, state] of this.installed) {
      try { state.install.uninstall() } catch { /* best effort */ }
      void state.link.close().catch(() => { /* best effort */ })
    }
    this.installed.clear()
    this.backoff.clear()
  }

  /**
   * Force a reconciliation tick now (skips the polling delay). Called
   * by the web /api/admin/identity/peers/* routes after every write so
   * the operator sees their change reflected in the live link set
   * within milliseconds instead of waiting for the next poll.
   */
  invalidate(): void {
    void this.tick().catch((err) =>
      this.log('error', 'peer-registry invalidate tick failed', {
        err: this.errMsg(err),
      }),
    )
  }

  /**
   * Re-apply a peer's policy by tearing down its live link, then forcing a
   * reconcile so the next dial re-installs with the fresh row.
   *
   * Why this exists separately from `invalidate()`: `tick()` does
   * `if (existing) continue` for an already-connected, still-enabled peer
   * — it never re-installs a live link. So an ACL (or endpoint) edit on a
   * CURRENTLY-CONNECTED peer would silently not take effect until the next
   * disconnect. The admin peer-edit route calls this (instead of
   * `invalidate`) when policy fields changed, so "I saved a stricter ACL"
   * re-gates the link within milliseconds rather than at some later drop.
   *
   * For a peer that isn't connected right now this degrades to a plain
   * `invalidate()` — the next dial reads the fresh row regardless.
   */
  refreshPolicy(peerRowId: string): void {
    if (this.installed.has(peerRowId)) {
      this.log('info', 'peer policy changed; re-installing link', { peerRowId })
      this.teardown(peerRowId, 'policy_changed')
    }
    this.invalidate()
  }

  /**
   * Phase 18 B-M3 — the `wrapOutbound` slice of `installPeerLink` options for a
   * given peer row. Empty (no decorator) unless the row opts into
   * `requireApprovalOutbound`; when it does but no gate factory is wired, emit
   * a loud warn and stay ungated rather than silently dropping the policy.
   * Shared by both the outbound dial and the inbound-accept install paths so
   * the gate applies to EVERY wrapper that can send to the peer.
   */
  private outboundWrap(
    row: PeerRegistration,
  ): { wrapOutbound?: (inner: RemoteHubViaLink) => Participant } {
    if (!row.requireApprovalOutbound) return {}
    const gate = this.opts.outboundApprovalGate
    if (!gate) {
      this.log('warn', 'peer requires outbound approval but no approval gate is wired; outbound sent UNGATED', {
        peerId: row.peerId,
      })
      return {}
    }
    return { wrapOutbound: (inner) => gate(inner, row) }
  }

  /**
   * D2 — look up a live HubLink by the remote hub's wire id. Returns
   * null when the peer is configured-but-not-connected, the peer row
   * has been disabled, or the id was never in our registry.
   *
   * Used by the host's `crossHubResolver` wiring (see main.ts) to
   * route an outbound HITL question back to the originating user's
   * hub: `task.origin.orgId` → `linkForHub(orgId)` → link.dispatch.
   */
  linkForHub(peerId: ParticipantId): HubLink | null {
    for (const state of this.installed.values()) {
      if (state.row.peerId === peerId) return state.link
    }
    return null
  }

  /**
   * Diagnostic snapshot for `GET /api/admin/identity/peers` to merge
   * with the row data — tells the admin UI which configured peers are
   * actually connected right now.
   */
  status(): Array<{
    peerRowId: string
    peerId: ParticipantId
    label: string | null
    endpointUrl: string
    connected: boolean
    backoffAttempts: number
  }> {
    const rows = this.opts.identity.listPeers()
    return rows.map((row) => ({
      peerRowId: row.id,
      peerId: row.peerId,
      label: row.label,
      endpointUrl: row.endpointUrl,
      connected: this.installed.has(row.id),
      backoffAttempts: this.backoff.get(row.id)?.attempts ?? 0,
    }))
  }

  // ---------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.isShuttingDown || this.tickInFlight) return
    this.tickInFlight = true
    try {
      const rows = this.opts.identity.listPeers()
      const liveRowIds = new Set<string>()
      // Phase 1 — process every current row: enable/disable/dial as needed.
      for (const row of rows) {
        liveRowIds.add(row.id)
        const existing = this.installed.get(row.id)
        if (!row.enabled) {
          if (existing) {
            this.log('info', 'peer disabled; tearing down link', { peerId: row.peerId })
            this.teardown(row.id)
          }
          continue
        }
        if (existing) continue // already connected and enabled — nothing to do
        if (!this.backoffAllowsAttempt(row.id)) continue
        await this.dialOne(row)
      }
      // Phase 2 — drop links whose rows have been removed entirely.
      for (const id of Array.from(this.installed.keys())) {
        if (!liveRowIds.has(id)) {
          this.log('info', 'peer row vanished; tearing down link', {
            peerRowId: id,
          })
          this.teardown(id)
        }
      }
    } finally {
      this.tickInFlight = false
    }
  }

  private async dialOne(row: PeerRegistration): Promise<void> {
    let token: string
    try {
      token = this.opts.identity.getPeerToken(row.id)
    } catch (err) {
      this.bumpBackoff(row.id)
      this.log('error', 'peer-registry getPeerToken failed', {
        peerId: row.peerId,
        err: this.errMsg(err),
      })
      return
    }
    try {
      const link = await connectHubLink({
        url: row.endpointUrl,
        selfId: this.opts.selfHubId,
        expectedPeerId: row.peerId,
        auth: bearerAuth({ token }),
      })
      const install = installPeerLink({
        hub: this.opts.hub,
        link,
        selfHubId: this.opts.selfHubId,
        ...(this.opts.rpcResponder ? { rpcResponder: this.opts.rpcResponder } : {}),
        // Phase 18 B-M2 — apply the peer's persisted inbound trust contract.
        // A null acl (legacy / unset row) leaves the gate off (accept-all),
        // exactly the pre-B-M2 behaviour.
        ...(row.acl ? { acl: row.acl } : {}),
        // Phase 19 P4-M1 — apply the persisted OUTBOUND capability allowlist.
        // null (unset row) → omitted → send-anything (legacy); `[]` → lockdown.
        ...(row.outboundCaps ? { outboundCaps: row.outboundCaps } : {}),
        // Phase 18 B-M3 — gate OUTBOUND sends behind an approval inbox when the
        // row opts in. Empty otherwise (no behaviour change).
        ...this.outboundWrap(row),
      })
      this.installed.set(row.id, { row, link, install })
      this.backoff.delete(row.id)
      this.log('info', 'peer connected (outbound)', {
        peerId: row.peerId,
        endpointUrl: row.endpointUrl,
      })
      this.writeAudit('peer_connect', row, { direction: 'outbound' })
      // If the link closes later (peer drops), drop it from `installed`
      // so the next tick redials.
      link.on('closed', () => {
        const cur = this.installed.get(row.id)
        // Only drop if the live entry STILL points at this same link —
        // a fresh reconnect during the brief window between close + this
        // callback could leave a fresh entry we don't want to evict.
        if (cur && cur.link === link) {
          this.installed.delete(row.id)
          this.writeAudit('peer_disconnect', row, {
            reason: 'remote_closed',
          })
        }
      })
    } catch (err) {
      this.bumpBackoff(row.id)
      this.log('warn', 'peer dial failed; will retry', {
        peerId: row.peerId,
        attempt: this.backoff.get(row.id)?.attempts ?? 0,
        err: this.errMsg(err),
      })
    }
  }

  private installInboundLink(link: HubLink): void {
    const peerId = link.peerId
    if (!peerId) {
      this.log('warn', 'inbound peer rejected (no peerId)', {})
      void link.close().catch(() => { /* */ })
      return
    }
    const row = this.opts.identity.getPeerByPeerId(peerId)
    if (!row || !row.enabled) {
      this.log('warn', 'inbound peer rejected (not in registry or disabled)', {
        claimedPeerId: peerId,
      })
      void link.close().catch(() => { /* */ })
      return
    }
    // If we already have an outbound link to this same peer, prefer
    // keeping the existing one and refusing the inbound — avoids the
    // "two links to the same hub" routing ambiguity.
    if (this.installed.has(row.id)) {
      this.log('info', 'inbound peer already has outbound link; closing inbound', {
        peerId,
      })
      void link.close().catch(() => { /* */ })
      return
    }
    const install = installPeerLink({
      hub: this.opts.hub,
      link,
      selfHubId: this.opts.selfHubId,
      ...(this.opts.rpcResponder ? { rpcResponder: this.opts.rpcResponder } : {}),
      // Phase 18 B-M2 — receiver-side ACL from the peer row (inbound is the
      // direction the ACL actually guards). null → accept-all, as before.
      ...(row.acl ? { acl: row.acl } : {}),
      // Phase 19 P4-M1 — the same outbound allowlist guards a wrapper installed
      // off an inbound-accepted link (we can still dispatch TO this peer).
      ...(row.outboundCaps ? { outboundCaps: row.outboundCaps } : {}),
      // Phase 18 B-M3 — the same outbound approval gate applies to a wrapper
      // installed off an inbound-accepted link (we can still dispatch TO this
      // peer through it).
      ...this.outboundWrap(row),
    })
    this.installed.set(row.id, { row, link, install })
    this.backoff.delete(row.id)
    this.log('info', 'peer connected (inbound)', { peerId })
    this.writeAudit('peer_connect', row, { direction: 'inbound' })
    link.on('closed', () => {
      const cur = this.installed.get(row.id)
      if (cur && cur.link === link) {
        this.installed.delete(row.id)
        this.writeAudit('peer_disconnect', row, { reason: 'remote_closed' })
      }
    })
  }

  private teardown(peerRowId: string, reason = 'removed_or_disabled'): void {
    const state = this.installed.get(peerRowId)
    if (!state) return
    try { state.install.uninstall() } catch { /* */ }
    void state.link.close().catch(() => { /* */ })
    this.installed.delete(peerRowId)
    this.writeAudit('peer_disconnect', state.row, {
      reason,
    })
  }

  private backoffAllowsAttempt(peerRowId: string): boolean {
    const b = this.backoff.get(peerRowId)
    if (!b) return true
    const delay = BACKOFF_LADDER_MS[
      Math.min(b.attempts, BACKOFF_LADDER_MS.length - 1)
    ]!
    return Date.now() - b.lastAttempt >= delay
  }

  private bumpBackoff(peerRowId: string): void {
    const prev = this.backoff.get(peerRowId)
    this.backoff.set(peerRowId, {
      lastAttempt: Date.now(),
      attempts: (prev?.attempts ?? 0) + 1,
    })
  }

  private writeAudit(
    action: 'peer_connect' | 'peer_disconnect',
    row: PeerRegistration,
    extra: Record<string, unknown>,
  ): void {
    try {
      this.opts.identity.writeAuditLog?.({
        action,
        actorSource: 'system',
        metadata: { peerId: row.peerId, endpointUrl: row.endpointUrl, ...extra },
        success: true,
      })
    } catch { /* audit is non-fatal */ }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    ctx?: unknown,
  ): void {
    if (!this.opts.logger) return
    const fn = (this.opts.logger as unknown as Record<string, (m: string, c?: unknown) => void>)[level]
    if (typeof fn === 'function') fn.call(this.opts.logger, msg, ctx)
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Audit #154 — extracted for unit testability. The per-peer token
 * resolver runs on every inbound HELLO; rejection paths must leave
 * an operator-readable breadcrumb because the transport-ws close is
 * silent by design (anti-enumeration).
 *
 * Log levels:
 *   - debug: expected reject (peer not enrolled / peer disabled).
 *     Routine; only noisy if someone is iterating known IDs.
 *   - warn:  abnormal reject (peer enrolled but no token vaulted /
 *     identity throws). Indicates operator action needed.
 *
 * The function takes a minimal identity shape, not the full
 * IdentityStore, so tests can stub one method at a time.
 */
export type PeerTokenResolverIdentity = Pick<
  import('@aipehub/identity').IdentityStore,
  'getPeerByPeerId' | 'getPeerToken'
>

export type PeerTokenResolverLogFn = (
  level: 'debug' | 'warn',
  msg: string,
  ctx?: unknown,
) => void

export function buildPeerTokenResolver(
  identity: PeerTokenResolverIdentity,
  log: PeerTokenResolverLogFn,
): (claimedPeerId: string) => string | null {
  return (claimedPeerId: string): string | null => {
    try {
      const row = identity.getPeerByPeerId(claimedPeerId)
      if (!row) {
        log('debug', 'peer-registry resolver: unknown peer', { claimedPeerId })
        return null
      }
      if (row.enabled === false) {
        log('debug', 'peer-registry resolver: peer disabled', {
          claimedPeerId,
          rowId: row.id,
        })
        return null
      }
      const token = identity.getPeerToken(row.id)
      if (!token) {
        log('warn', 'peer-registry resolver: no token vaulted', {
          claimedPeerId,
          rowId: row.id,
        })
        return null
      }
      return token
    } catch (err) {
      log('warn', 'peer-registry resolver failure', {
        claimedPeerId,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}
