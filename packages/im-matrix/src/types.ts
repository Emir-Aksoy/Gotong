/**
 * Matrix Client-Server API shapes — a hand-rolled subset of the
 * Matrix spec v1.10.
 *
 * Why hand-rolled rather than `matrix-bot-sdk` / `matrix-js-sdk`:
 *
 *   - We need ~4 endpoints (`/sync`, `/rooms/{}/send/{}/{}`,
 *     `/join/{}`, `/profile/{}/displayname`). matrix-bot-sdk ships
 *     dozens of helpers + a crypto store + a room-state engine — all
 *     dead weight for "transport between Matrix and Hub."
 *   - `bun --compile` single-file deployments stay slim.
 *   - E2EE is intentionally out of scope for M3 (requires libolm,
 *     which is wasm + state on disk). Rooms must be unencrypted; bot
 *     receives plaintext content.
 *   - Test ergonomics: with a `MatrixClient` injection point the
 *     bridge tests never touch a real homeserver.
 *
 * Reference: https://spec.matrix.org/v1.10/client-server-api/
 * (verified 2026-05).
 */

// ---------------------------------------------------------------------------
// Sync response (GET /_matrix/client/v3/sync)
// ---------------------------------------------------------------------------

/**
 * The shape returned by `/sync`. We only consume `next_batch` and
 * `rooms.{join,invite}` — `presence`, `account_data`, `to_device`
 * etc. are filtered out via our request filter, so we don't bother
 * typing them.
 *
 * `next_batch` is opaque server state and MUST be threaded back into
 * the next `since=` query. Losing it doesn't cause data loss (the
 * server will re-deliver), but does cause re-processing of old events
 * — the bridge guards against that with an in-memory dedup set on
 * `event_id`.
 */
export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    /** Rooms we are joined to — timeline events arrive here. */
    join?: Record<string, MatrixJoinedRoom>
    /** Rooms we've been invited to — bridge can auto-accept. */
    invite?: Record<string, MatrixInvitedRoom>
    /** Rooms we've left — out of scope; bridge ignores. */
    leave?: Record<string, unknown>
  }
}

export interface MatrixJoinedRoom {
  timeline?: {
    events?: MatrixRoomEvent[]
    /** True when the server truncated history — we don't backfill. */
    limited?: boolean
    /** Opaque token for backfilling — unused; bridge is forward-only. */
    prev_batch?: string
  }
  /**
   * Current room state (m.room.member, m.room.create, m.room.power_levels, …).
   * The bridge doesn't consume this in M3 — we'd need it to resolve
   * sender display names, but the timeline-event `sender` mxid is
   * already a unique identity, and Matrix mxids are reasonably
   * human-readable on their own.
   */
  state?: { events?: MatrixRoomEvent[] }
}

export interface MatrixInvitedRoom {
  /**
   * Stripped state events delivered with the invite. We don't process
   * the contents; the auto-join handler just needs to know the room
   * exists and is awaiting our join.
   */
  invite_state?: { events?: Array<{ type: string; sender?: string; content?: unknown }> }
}

// ---------------------------------------------------------------------------
// Room events (members of `timeline.events`)
// ---------------------------------------------------------------------------

/**
 * A single timeline event. The Matrix event model is open: `type` is
 * a free-form string and `content` is `unknown`. We narrow to
 * `m.room.message` in the mapper because that's all the bridge cares
 * about.
 */
export interface MatrixRoomEvent {
  type: string
  event_id: string
  sender: string
  /** Unix ms — Matrix uses ms natively, no conversion needed. */
  origin_server_ts: number
  content?: unknown
  /**
   * `state_key` is set on state events (m.room.member etc.). Its
   * presence is the canonical "this is a state event" marker per
   * spec, but our filter excludes state events from the timeline so
   * we don't depend on it.
   */
  state_key?: string
  /** Replaced / redacted info — out of scope for M3. */
  unsigned?: Record<string, unknown>
}

/**
 * Content of an `m.room.message` event. The spec defines a
 * discriminated union via `msgtype`, but Matrix is famously
 * forwards-compatible: clients ignore unknown msgtypes. We type the
 * ones we render.
 */
export interface MatrixMessageContent {
  /** 'm.text' | 'm.notice' | 'm.emote' | 'm.image' | 'm.audio' | 'm.video' | 'm.file' | … */
  msgtype: string
  /**
   * Plain-text body. For media types this is the filename / fallback
   * caption. For text types this is the actual message body.
   */
  body: string
  /**
   * mxc:// URI for media. Set on `m.image / m.audio / m.video / m.file`.
   * Per spec, downloads go through
   *   GET /_matrix/client/v1/media/download/{serverName}/{mediaId}
   * The mxc URI parses cleanly with parseMxcUri() in message.ts.
   *
   * Note: in E2E-encrypted rooms `url` is absent and `file` (a JSON
   * blob with crypto info) takes its place. M3 doesn't support
   * encrypted rooms — see README.
   */
  url?: string
  /** Metadata about media uploads — mime, size, dimensions, etc. */
  info?: {
    mimetype?: string
    size?: number
    w?: number
    h?: number
    duration?: number
  }
  /** Optional filename override (`m.file` carries this). */
  filename?: string
  /** Reply / thread context — not currently consumed. */
  'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } }
  /** Formatted body (HTML) — discarded; bridges deliver plain text. */
  format?: string
  formatted_body?: string
}

// ---------------------------------------------------------------------------
// Login / whoami (so the bridge knows its own mxid)
// ---------------------------------------------------------------------------

/**
 * Response from `GET /_matrix/client/v3/account/whoami`. Bridges
 * resolve this at start() to learn their own user_id, which they use
 * to filter out their own messages from the inbound stream.
 */
export interface MatrixWhoamiResponse {
  user_id: string
  /** Device id — present for newer homeservers, ignored by us. */
  device_id?: string
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Matrix error responses look like:
 *
 *   HTTP 4xx
 *   { "errcode": "M_FORBIDDEN", "error": "…human text…" }
 *
 * Rate-limit errors additionally carry:
 *
 *   { "errcode": "M_LIMIT_EXCEEDED", "retry_after_ms": 5000 }
 *
 * Some homeservers also return an `Retry-After:` HTTP header; the
 * client reads both and picks the larger.
 */
export interface MatrixErrorBody {
  errcode: string
  error?: string
  retry_after_ms?: number
}
