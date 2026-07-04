/**
 * `ImBridge` implementation for Matrix. Sync long-poll mode against
 * the Client-Server API.
 *
 * Why Matrix matters for Gotong specifically:
 *
 *   - **Federation × federation philosophy alignment**. Gotong
 *     federates between hubs via peer tokens; Matrix federates between
 *     homeservers natively. One Gotong hub + one Matrix bot = an
 *     entry point reachable from any user on any Matrix homeserver
 *     that federates with ours, with no extra config. Two distinct
 *     federation graphs (Gotong-side and Matrix-side) compose
 *     cleanly because neither needs the other to centralise.
 *   - **No vendor lock-in**. Telegram / Slack / Discord / Lark are
 *     each a single corporate API. Matrix is an open protocol with
 *     dozens of homeserver implementations (Synapse, Dendrite,
 *     Conduit, …). The bridge code stays portable.
 *
 * Threading model — same shape as TelegramBridge:
 *
 *   start() ─► whoami() ─► syncLoop()
 *                              │
 *                              ├─ initial /sync (timeline.limit=0)
 *                              │      gets next_batch, skips backlog
 *                              │
 *                              ├─ /sync(since=next_batch, timeout=30s)
 *                              │      blocks ~30s when bot is idle
 *                              │
 *                              ├─ rooms.invite → autoJoin (configurable)
 *                              │
 *                              ├─ rooms.join.<id>.timeline.events →
 *                              │      dispatch listeners SEQUENTIALLY
 *                              │      per poll batch (order matters
 *                              │      within a room; cross-room ordering
 *                              │      is best-effort).
 *                              │
 *                              └─ on error: log via onError, sleep
 *                                    (err.retryAfterMs ?? backoff),
 *                                    retry. Loop is self-healing.
 *
 * stop() flips `running=false`; the next sync returns (or times out
 * server-side) and the loop breaks. The promise returned by
 * `syncLoop()` is what we await on `stop()` so cleanup waits for
 * the current iteration to finish — never a half-handled event batch.
 *
 * What's NOT in M3 (intentional):
 *
 *   - E2E encryption (`m.room.encrypted` events). Requires libolm +
 *     persistent crypto state. Rooms must be unencrypted; encrypted
 *     events skip through the mapper silently.
 *   - Outbound attachments. `sendMessage(... attachments)` logs to
 *     `onError` and sends text only.
 *   - DM auto-creation. `sendMessage` REQUIRES `options.chatId`
 *     (room id). Matrix has no "DM by user id" — DMs are just rooms
 *     with two members, and creating one is `POST /createRoom` plus
 *     state tracking, deferred to a later milestone.
 *   - Token refresh. The bridge expects a long-lived access token.
 */

import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

import {
  createMatrixClient,
  MatrixApiError,
  type MatrixClient,
  type MatrixClientOptions,
} from './client.js'
import { matrixToImMessage } from './message.js'
import type {
  MatrixRoomEvent,
  MatrixSyncResponse,
  MatrixWhoamiResponse,
} from './types.js'

export interface MatrixBridgeOptions {
  /** Homeserver URL — passed to client when `client` is not provided. */
  homeserverUrl: string
  /** Access token — same fallback. */
  accessToken: string
  /**
   * Override the underlying client. Mostly for tests; one client per
   * bridge is fine for production.
   */
  client?: MatrixClient
  /**
   * Server-side long-poll timeout in ms, passed to `/sync`. Default
   * 30000 (30s). Lowering it adds wallclock load on the homeserver;
   * Matrix recommends 30s as a sane default.
   */
  syncTimeoutMs?: number
  /**
   * Sleep after a transient failure before retrying the next sync.
   * Default 1000ms. The bridge never stops the loop on API failure;
   * a network glitch or M_LIMIT_EXCEEDED should self-heal without
   * operator intervention.
   */
  retryBackoffMs?: number
  /**
   * Auto-accept room invites the bot receives. Default `true` — most
   * Matrix bots want to be invited into rooms to participate.
   * Setting `false` is useful when the bridge is restricted to
   * pre-configured rooms (appservice-style deployment).
   */
  autoJoin?: boolean
  /**
   * Forwarded to `createMatrixClient` when `client` isn't supplied.
   * Useful for tests that want to override `fetchImpl` without
   * constructing the client themselves.
   */
  clientOptions?: Omit<MatrixClientOptions, 'homeserverUrl' | 'accessToken'>
  /**
   * Called on sync-loop errors and on listener exceptions. The
   * bridge never throws into the caller from background work; this
   * is the only diagnostic surface. Defaults to a no-op (silent
   * self-heal).
   */
  onError?: (err: unknown) => void
  /**
   * Bot's own mxid. If omitted, the bridge calls `/account/whoami`
   * during `start()` to fetch it. Provide here to skip that
   * round-trip (e.g. when read off appservice config).
   */
  botUserId?: string
}

type Listener = (msg: ImMessage) => void | Promise<void>

/**
 * Inline sync filter — pass via `filter=<urlencoded-json>` on /sync.
 * Excludes everything except m.room.message timeline events from
 * joined rooms, plus invite state (we need it for autoJoin). Keeps
 * sync responses small.
 *
 * `account_data`, `presence`, `to_device`, `device_lists` are all
 * scoped to zero. `state.types: []` drops room state from the
 * timeline-grouped response — display-name resolution would need it,
 * but M3 doesn't resolve display names anyway.
 */
const TIMELINE_FILTER = {
  room: {
    timeline: { limit: 50, types: ['m.room.message'] },
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
  // No way to filter invite payload via Filter object spec — they're
  // delivered regardless. We process them in the loop.
}

/** First-sync variant: skip backlog entirely. */
const INITIAL_FILTER = {
  ...TIMELINE_FILTER,
  room: { ...TIMELINE_FILTER.room, timeline: { limit: 0, types: ['m.room.message'] } },
}

export class MatrixBridge implements ImBridge {
  readonly platform = 'matrix'

  private readonly client: MatrixClient
  private readonly syncTimeoutMs: number
  private readonly retryBackoffMs: number
  private readonly autoJoin: boolean
  private readonly onError: (err: unknown) => void

  private running = false
  private listeners: Listener[] = []
  /** Opaque sync cursor — initially null, set after first /sync returns. */
  private nextBatch: string | null = null
  /**
   * Bot's mxid. Resolved on `start()` via whoami (or pre-set in
   * opts) — used to filter the bot's own messages out of the inbound
   * stream. `null` only during construction; `start()` guarantees a
   * value before the sync loop reads it.
   */
  private botUserId: string | null
  private syncPromise: Promise<void> | null = null
  /**
   * Monotonic counter for PUT /send/.../{txnId}. Matrix requires
   * txnIds to be unique per access token "for the duration of the
   * connection" — a process-lifetime counter is sufficient.
   */
  private txnCounter = 0
  /**
   * Recent event IDs we delivered, used to suppress duplicates if
   * the sync ever re-delivers (it shouldn't, but Matrix's
   * at-least-once guarantee plus `since` edge cases can produce
   * dupes). Bounded ring — see `recordDelivered`.
   */
  private deliveredEventIds: Set<string> = new Set()
  private deliveredOrder: string[] = []
  private readonly DELIVERED_CACHE_MAX = 512

  constructor(opts: MatrixBridgeOptions) {
    this.client =
      opts.client ??
      createMatrixClient({
        homeserverUrl: opts.homeserverUrl,
        accessToken: opts.accessToken,
        ...opts.clientOptions,
      })
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 30_000
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
    this.autoJoin = opts.autoJoin ?? true
    this.onError = opts.onError ?? (() => {})
    this.botUserId = opts.botUserId ?? null
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    if (this.botUserId === null) {
      // whoami is a single small GET; if it fails, the operator
      // almost certainly has a bad token and there's no point
      // starting the sync loop. Throw out of start() in that case.
      try {
        const who = await this.client.call<MatrixWhoamiResponse>(
          'GET',
          '/_matrix/client/v3/account/whoami',
        )
        this.botUserId = who.user_id
      } catch (err) {
        // Restore running=false so the bridge isn't left in a
        // half-started state. The caller sees the underlying error
        // (typically MatrixApiError on 401).
        this.running = false
        throw err
      }
    }
    this.syncPromise = this.syncLoop()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.syncPromise) {
      // Wait for the in-flight sync to return. Worst case: ~syncTimeoutMs
      // server timeout + network round-trip. We don't force-abort
      // because in-flight events would be lost (the homeserver
      // wouldn't re-deliver until we re-sync with the old since=).
      try {
        await this.syncPromise
      } catch {
        // syncLoop never rejects (we catch inside) — defensive only.
      }
      this.syncPromise = null
    }
  }

  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    // Matrix has no "DM by user id" — every conversation is a room.
    // If the caller has the original ImMessage.chatId they can pass
    // it through; otherwise we refuse rather than guessing.
    const roomId = options?.chatId
    if (!roomId || roomId.length === 0) {
      // Throw rather than route to onError — this is a programming
      // error in the caller, not a transient runtime issue. We want
      // a stack trace, not a silent log line.
      throw new Error(
        'MatrixBridge.sendMessage: options.chatId (Matrix room id) is required; ' +
          'Matrix has no DM-by-user shortcut. Use ImMessage.chatId from the ' +
          'inbound message you are replying to.',
      )
    }
    if (options?.attachments && options.attachments.length > 0) {
      // Mirror the Telegram M2 decision: don't silently drop; surface
      // via onError so operators know. The text still goes out.
      this.onError(
        new Error(
          'MatrixBridge.sendMessage: outbound attachments not yet supported; sending text only',
        ),
      )
    }
    const txnId = this.nextTxnId()
    // Defensive: encodeURIComponent the room id. Matrix room ids look
    // like `!abc:matrix.org`; `:` is technically reserved in path
    // segments per RFC 3986 even though most servers accept it raw.
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`
    await this.client.call('PUT', path, {
      body: { msgtype: 'm.text', body: text },
    })
    // Note: `to.platformUserId` (the recipient mxid) is unused here.
    // It's redundant in Matrix because the room itself identifies
    // recipients. We keep the parameter because the ImBridge contract
    // wants it — bridges that DO use it (Telegram) need it.
    void to
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // --- internal -------------------------------------------------

  private nextTxnId(): string {
    this.txnCounter += 1
    // `gotong-<ms>-<counter>` — collision-free within a process and
    // human-readable in homeserver logs.
    return `gotong-${Date.now()}-${this.txnCounter}`
  }

  private recordDelivered(eventId: string): boolean {
    if (this.deliveredEventIds.has(eventId)) return false
    this.deliveredEventIds.add(eventId)
    this.deliveredOrder.push(eventId)
    if (this.deliveredOrder.length > this.DELIVERED_CACHE_MAX) {
      const drop = this.deliveredOrder.shift()!
      this.deliveredEventIds.delete(drop)
    }
    return true
  }

  private async syncLoop(): Promise<void> {
    // First iteration uses INITIAL_FILTER to skip the backlog. After
    // we have a next_batch, we switch to TIMELINE_FILTER and pass
    // since=. Matrix's spec lets us also pass `full_state=false` on
    // subsequent calls; we never need full_state.
    let firstSync = true
    while (this.running) {
      try {
        const filter = firstSync ? INITIAL_FILTER : TIMELINE_FILTER
        // /sync server-side timeout is in milliseconds per spec.
        // First sync passes timeout=0 to return immediately — we
        // only want the next_batch, not to block on an idle homeserver.
        const timeoutForServer = firstSync ? 0 : this.syncTimeoutMs
        const query: Record<string, string | number | undefined> = {
          timeout: timeoutForServer,
          filter: JSON.stringify(filter),
        }
        if (this.nextBatch !== null) query.since = this.nextBatch
        const resp = await this.client.call<MatrixSyncResponse>(
          'GET',
          '/_matrix/client/v3/sync',
          {
            query,
            // Give the homeserver its full timeout window plus a
            // network grace margin. Without this our default
            // client-side timeout (60s) could fire just before the
            // server's 30s response — racy.
            timeoutMs: timeoutForServer + 10_000,
          },
        )
        this.nextBatch = resp.next_batch
        await this.handleSync(resp, /* skipTimeline */ firstSync)
        firstSync = false
      } catch (err) {
        // M_LIMIT_EXCEEDED carries retry_after_ms; honour it. Other
        // errors (auth failure, network, server 5xx) use the
        // configured backoff — same defensive pattern as Telegram.
        const wait =
          err instanceof MatrixApiError && err.retryAfterMs !== null
            ? err.retryAfterMs
            : this.retryBackoffMs
        this.onError(err)
        if (this.running) await sleep(wait)
      }
    }
  }

  private async handleSync(resp: MatrixSyncResponse, skipTimeline: boolean): Promise<void> {
    // Auto-join invites first — failures shouldn't block timeline
    // delivery from rooms we're already in.
    const invites = resp.rooms?.invite ?? {}
    if (this.autoJoin) {
      for (const roomId of Object.keys(invites)) {
        try {
          await this.client.call(
            'POST',
            `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
            { body: {} },
          )
        } catch (err) {
          // Invite may be stale (room deleted), or the homeserver may
          // be misconfigured. Don't crash the loop; the next sync
          // will re-surface the invite if it's still valid.
          this.onError(err)
        }
      }
    }
    if (skipTimeline) return
    const joined = resp.rooms?.join ?? {}
    for (const [roomId, room] of Object.entries(joined)) {
      const events = room.timeline?.events ?? []
      for (const ev of events) {
        await this.deliver(ev, roomId)
      }
    }
  }

  private async deliver(event: MatrixRoomEvent, roomId: string): Promise<void> {
    if (!this.recordDelivered(event.event_id)) return // dupe, skip
    const imMsg = matrixToImMessage(event, roomId, this.botUserId)
    if (!imMsg) return // not a message, or our own, or malformed
    for (const l of this.listeners) {
      try {
        await l(imMsg)
      } catch (err) {
        // A listener that throws doesn't stop other listeners or the
        // sync loop. Diagnostic via onError; operator can decide.
        this.onError(err)
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
