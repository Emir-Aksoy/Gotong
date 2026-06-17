/**
 * Slack Socket Mode + Web API shapes — a hand-rolled subset.
 *
 * Inbound runs over Socket Mode (the official 免穿透 transport — the
 * app dials OUT over a WebSocket). Outbound (`chat.postMessage`) is the
 * Web API. Both are stable, well-documented HTTP / WS + JSON.
 *
 * Why hand-rolled rather than `@slack/bolt` / `@slack/socket-mode`:
 *
 *   - Bolt ships an HTTP framework, middleware stack, OAuth helpers,
 *     a request-routing DSL — most of which we don't need (the host
 *     already runs its own HTTP layer; OAuth installation is a
 *     separate concern outside the transport surface).
 *   - `@slack/socket-mode` + `@slack/web-api` drag in `axios`, retry
 *     plugins, and a code-generated method list of ~200 calls. The
 *     bridge only needs `apps.connections.open` + `chat.postMessage`,
 *     and the repo already hand-rolls a WS state machine for Discord.
 *   - A typed fetch wrapper + a ~250-line WS state machine is enough.
 *
 * Reference (verified 2026-05):
 *   - https://docs.slack.dev/apis/events-api/using-socket-mode/
 *   - https://api.slack.com/methods/apps.connections.open
 *   - https://api.slack.com/methods/chat.postMessage
 */

// ---------------------------------------------------------------------------
// Socket Mode envelopes
// ---------------------------------------------------------------------------

/**
 * `POST apps.connections.open` response — issues a single-use WSS URL
 * for the Socket Mode connection. Authenticated with the app-level
 * token (`xapp-…`), NOT the bot token.
 *
 * `ok: false` carries Slack's machine error (`invalid_auth`,
 * `not_allowed_token_type`, …); the socket-mode state machine treats a
 * known-bad-credential error as fatal and everything else as transient.
 */
export interface SlackConnectionsOpenResponse {
  ok: boolean
  /** `wss://…` — single-use, expires in ~30s if not connected. */
  url?: string
  /** Slack machine error code when `ok: false`. */
  error?: string
}

/**
 * One Socket Mode envelope pushed by the server over the WebSocket.
 *
 *   - `hello`: sent once on connect; confirms the socket is live.
 *   - `events_api`: wraps the standard `event_callback` body in
 *     `payload`. The bridge surfaces ONLY these.
 *   - `disconnect`: server is recycling the socket (`reason`:
 *     refresh_requested / warning / too_many_connections) — the client
 *     reconnects with a fresh URL.
 *   - `slash_commands` / `interactive`: acked but not surfaced.
 *
 * Every envelope EXCEPT `hello` / `disconnect` carries an
 * `envelope_id`; the client acks by echoing `{ envelope_id }` back over
 * the socket within 3s. Unlike the old Events API webhook, there is NO
 * HMAC signature and NO `url_verification` handshake — the `xapp-`
 * token already authenticated the connection at `apps.connections.open`.
 */
export interface SlackSocketEnvelope<T = unknown> {
  /** Ack target. Present on events_api / slash_commands / interactive. */
  envelope_id?: string
  /** 'hello' | 'events_api' | 'slash_commands' | 'interactive' | 'disconnect'. */
  type: string
  /** events_api: the standard `event_callback` body (see SlackEventCallback). */
  payload?: T
  /** disconnect reason. */
  reason?: string
  /** Whether the server wants a response payload in the ack. The bridge never sets one. */
  accepts_response_payload?: boolean
}

// ---------------------------------------------------------------------------
// The Events API `event_callback` body — Socket Mode delivers it as
// the `payload` of an `events_api` envelope.
// ---------------------------------------------------------------------------

export interface SlackEventCallback<T = unknown> {
  type: 'event_callback'
  /**
   * Per-event unique id. Slack retries delivery on slow ack (up to 3
   * attempts within ~1 minute). Bridge uses for dedup.
   */
  event_id: string
  /** Unix seconds. */
  event_time: number
  /** Workspace / team id this event came from. */
  team_id?: string
  /** App's own id — useful for filtering inbound events from the
   *  bot's own posts when bot_id isn't populated. */
  api_app_id?: string
  /** The wrapped event payload. */
  event: T
  /** Auth context — present for events that depend on a specific
   *  installation. M6 doesn't inspect this. */
  authorizations?: SlackAuthorization[]
}

export interface SlackAuthorization {
  enterprise_id?: string | null
  team_id?: string
  user_id?: string
  /** True when this auth is the bot user (vs an installer user). */
  is_bot?: boolean
}

// ---------------------------------------------------------------------------
// The `message` event — the only event the bridge dispatches in M6
// ---------------------------------------------------------------------------

/**
 * Slack delivers user messages, bot posts, edits, deletes, channel
 * joins, etc. all under `event.type === 'message'`, distinguished by
 * `subtype`. Bridge accepts:
 *
 *   - `subtype` absent (plain user message)
 *   - `subtype === 'file_share'` (user uploaded a file with optional caption)
 *
 * And rejects everything else as system noise (bot_message,
 * message_changed, message_deleted, channel_join, …).
 */
export interface SlackMessageEvent {
  type: 'message'
  /** Distinguishes flavours. Absent for plain user messages. */
  subtype?: string
  /** Author user id — `U…` for users, missing for bot-only posts. */
  user?: string
  /** Set when a bot (incl. our own) posted. */
  bot_id?: string
  /** Channel id (`C…` channel / `D…` IM / `G…` private group). */
  channel: string
  /** Channel kind hint: 'channel' | 'group' | 'im' | 'mpim'. */
  channel_type?: 'channel' | 'group' | 'im' | 'mpim'
  /**
   * Slack timestamp — `"<unix seconds>.<6-digit ordinal>"` — doubles
   * as the per-channel message id. Bridge keeps it verbatim in
   * `ImMessage.messageId` AND parses the leading seconds for
   * `ImMessage.ts`.
   */
  ts: string
  /** Workspace id. */
  team?: string
  /** Free-form text body. Mentions appear as `<@U…>`. */
  text?: string
  /** File uploads attached to this message. */
  files?: SlackFile[]
  /**
   * Reply-thread parent. When this is a top-level message, equals `ts`.
   * Bridge doesn't currently consume but typed for future.
   */
  thread_ts?: string
  /** True when the message edits an existing one. */
  edited?: { user: string; ts: string }
}

/**
 * Slack file metadata. The `url_private` / `url_private_download`
 * fields ARE auth-gated — clients must pass the bot token in the
 * Authorization header to fetch the bytes. Bridge wraps these
 * behind a `slack-file:` URI so the consumer doesn't have to know
 * about the auth dance.
 */
export interface SlackFile {
  /** `F…` snowflake. */
  id: string
  /** Original filename. */
  name?: string
  /** Slack's lowercase extension classification. */
  filetype?: string
  /** Best-effort MIME type. */
  mimetype?: string
  /** Bytes. */
  size?: number
  /**
   * Private download URL — requires `Bearer <bot_token>`. Most files
   * have one; rare ones (deleted, broken uploads) may not.
   */
  url_private?: string
  /** `url_private` with attachment disposition. */
  url_private_download?: string
}

// ---------------------------------------------------------------------------
// Web API — chat.postMessage
// ---------------------------------------------------------------------------

/**
 * Body shape for `POST https://slack.com/api/chat.postMessage`.
 * Authorisation goes in the header (`Bearer xoxb-…`), not the body.
 * Slack also accepts form-encoded but we always send JSON for
 * simplicity.
 */
export interface SlackPostMessageRequest {
  /** Channel id, DM id, or @user-handle (channels prefer the id form). */
  channel: string
  /** Plain text body. Mentions: `<@U…>`. Links: `<https://example.com|text>`. */
  text: string
  /**
   * Reply to an existing thread. When set, the message lands inside
   * the thread rather than at top level. Bridge doesn't currently use,
   * but typed for future "reply to the message we got" wiring.
   */
  thread_ts?: string
  /** Whether to also broadcast a thread reply to the channel. */
  reply_broadcast?: boolean
}

/**
 * Slack's standard Web API envelope. Even on HTTP 200, business-logic
 * failure shows up as `ok: false` + `error: '<machine_code>'`. Bridge
 * client unifies non-2xx HTTP and `ok: false` into `SlackApiError`.
 */
export interface SlackApiResponse {
  ok: boolean
  /** Set when `ok: false` — Slack's machine-readable error code. */
  error?: string
  /** Optional explanation; Slack uses this for some 4xx-equivalent. */
  warning?: string
  /** Some errors carry per-arg detail. */
  response_metadata?: { messages?: string[]; warnings?: string[] }
}

export interface SlackPostMessageResponse extends SlackApiResponse {
  /** Channel id the message landed in (echoed back). */
  channel?: string
  /** Posted message ts. */
  ts?: string
  /** Echoed posted message. */
  message?: { text?: string; ts?: string; user?: string }
}
