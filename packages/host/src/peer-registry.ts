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

import type { Hub, HubLink, Logger, ParticipantId } from '@aipehub/core'
import { installPeerLink, type InstalledPeerLink } from '@aipehub/core'
import type { IdentityStore, PeerRegistration } from '@aipehub/identity'
import { acceptHubLinks, connectHubLink } from '@aipehub/transport-ws'
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
  /** Default 5000ms. AIPE_PEER_POLL_MS override lives in main.ts. */
  pollIntervalMs?: number
  /** Optional logger; defaults to console-style noop-on-debug. */
  logger?: Logger
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
        ? (claimedPeerId: string): string | null => {
          try {
            const row = this.opts.identity.getPeerByPeerId(claimedPeerId)
            if (!row) return null
            if (row.enabled === false) return null
            return this.opts.identity.getPeerToken(row.id) ?? null
          } catch (err) {
            this.log('warn', 'peer-registry resolver failure', {
              claimedPeerId,
              err: this.errMsg(err),
            })
            return null
          }
        }
        : undefined
      this.detachAccept = acceptHubLinks({
        server: this.opts.wss,
        selfId: this.opts.selfHubId,
        ...(this.opts.sharedInboundPeerToken
          ? { peerToken: this.opts.sharedInboundPeerToken }
          : {}),
        ...(resolver ? { peerTokenResolver: resolver } : {}),
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
        peerToken: token,
      })
      const install = installPeerLink({
        hub: this.opts.hub,
        link,
        selfHubId: this.opts.selfHubId,
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

  private teardown(peerRowId: string): void {
    const state = this.installed.get(peerRowId)
    if (!state) return
    try { state.install.uninstall() } catch { /* */ }
    void state.link.close().catch(() => { /* */ })
    this.installed.delete(peerRowId)
    this.writeAudit('peer_disconnect', state.row, {
      reason: 'removed_or_disabled',
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

  private log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown): void {
    if (!this.opts.logger) return
    const fn = (this.opts.logger as unknown as Record<string, (m: string, c?: unknown) => void>)[level]
    if (typeof fn === 'function') fn.call(this.opts.logger, msg, ctx)
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}
