/**
 * Discord API shapes — hand-rolled subset for the bridge.
 *
 * We need maybe 6 REST endpoints and ~5 Gateway op codes; the full
 * `discord.js` package brings >100 deps and a parallel cache layer
 * we don't want. Direct fetch + WebSocket is ~700 lines.
 *
 * References (verified 2026-05, API v10):
 *   - Gateway:  https://discord.com/developers/docs/topics/gateway
 *   - Events:   https://discord.com/developers/docs/topics/gateway-events
 *   - Messages: https://discord.com/developers/docs/resources/channel
 */

// ---------------------------------------------------------------------------
// Gateway op codes (control plane)
// ---------------------------------------------------------------------------

/**
 * Discord Gateway op codes. Numbers are stable per the v10 spec and
 * exposed as a `const` enum-ish object so consumers can do
 * `op === DiscordOp.HELLO` instead of magic numbers.
 *
 * Bridge currently uses: DISPATCH, HEARTBEAT, IDENTIFY, RESUME,
 * RECONNECT, INVALID_SESSION, HELLO, HEARTBEAT_ACK.
 */
export const DiscordOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

export type DiscordOpCode = (typeof DiscordOp)[keyof typeof DiscordOp]

// ---------------------------------------------------------------------------
// Gateway intent bitfield
// ---------------------------------------------------------------------------

/**
 * Bot intents control which events the gateway streams. Bridge needs
 * GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT at minimum.
 * MESSAGE_CONTENT is "privileged" — must be enabled in the bot's
 * application page on https://discord.com/developers/applications.
 *
 * Numeric values are the bit position; combine with bitwise-OR.
 */
export const DiscordIntent = {
  GUILDS: 1 << 0, // 1
  GUILD_MEMBERS: 1 << 1, // 2 (privileged)
  GUILD_MODERATION: 1 << 2,
  GUILD_EMOJIS_AND_STICKERS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8, // privileged
  GUILD_MESSAGES: 1 << 9, // 512
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12, // 4096
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15, // 32768 (privileged)
} as const

/** Sensible default: receive guild + DM text messages with content. */
export const DEFAULT_DISCORD_INTENTS =
  DiscordIntent.GUILDS |
  DiscordIntent.GUILD_MESSAGES |
  DiscordIntent.DIRECT_MESSAGES |
  DiscordIntent.MESSAGE_CONTENT

// ---------------------------------------------------------------------------
// Gateway frame — every WebSocket payload
// ---------------------------------------------------------------------------

/**
 * Every payload sent or received over the gateway has this shape.
 * `s` (sequence) and `t` (event type) are only set on op 0 (DISPATCH).
 *
 * The bridge tracks the last `s` it received so it can:
 *   - send heartbeats with the right sequence number
 *   - resume after disconnect with `seq` in the RESUME payload
 */
export interface DiscordGatewayFrame<T = unknown> {
  op: number
  d: T
  s?: number | null
  t?: string | null
}

// ---------------------------------------------------------------------------
// HELLO (op 10) — server → client right after connect
// ---------------------------------------------------------------------------

export interface DiscordHelloData {
  /** Milliseconds between heartbeats. Discord usually returns ~41250. */
  heartbeat_interval: number
}

// ---------------------------------------------------------------------------
// IDENTIFY (op 2) — client → server after HELLO
// ---------------------------------------------------------------------------

export interface DiscordIdentifyData {
  token: string
  /** Bitfield of `DiscordIntent` flags. */
  intents: number
  properties: {
    os: string
    browser: string
    device: string
  }
  /**
   * Optional. Discord lets clients trade off "fewer presence updates
   * for fewer state events." Bridge doesn't enable presence so we
   * leave this empty.
   */
  presence?: unknown
}

// ---------------------------------------------------------------------------
// RESUME (op 6) — client → server after reconnect, when session is alive
// ---------------------------------------------------------------------------

export interface DiscordResumeData {
  token: string
  session_id: string
  seq: number
}

// ---------------------------------------------------------------------------
// READY (op 0, t='READY') — server → client after successful IDENTIFY
// ---------------------------------------------------------------------------

export interface DiscordReadyData {
  /** Gateway API version. */
  v: number
  user: DiscordUser
  /** Opaque session id; bridge keeps for RESUME. */
  session_id: string
  /**
   * Special URL to reconnect to when the session is alive. Bridge uses
   * this instead of the original gateway URL on resume.
   */
  resume_gateway_url: string
  application: { id: string; flags?: number }
}

// ---------------------------------------------------------------------------
// INVALID_SESSION (op 9) — server → client when RESUME / IDENTIFY rejected
// ---------------------------------------------------------------------------

/**
 * `d` is a boolean indicating whether the session is "resumable" —
 * true means the bridge can retry RESUME after a backoff; false means
 * the session is dead and the bridge must re-IDENTIFY (and drop
 * `session_id` / `lastSeq`).
 */
export type DiscordInvalidSessionData = boolean

// ---------------------------------------------------------------------------
// MESSAGE_CREATE event payload (op 0, t='MESSAGE_CREATE')
// ---------------------------------------------------------------------------

/**
 * The subset of `MESSAGE_CREATE` fields the bridge consumes. Full
 * payload is much larger (embeds, components, reactions, …); we map
 * just text + author + attachments.
 *
 * `guild_id` is undefined for DMs. `member` is undefined for DMs too;
 * we don't read it (display name resolution is best-effort and the
 * bridge sticks to global_name / username).
 */
export interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: DiscordUser
  content: string
  /** ISO-8601 string. */
  timestamp: string
  edited_timestamp?: string | null
  attachments?: DiscordAttachment[]
  /** User mentions present in `content`. */
  mentions?: DiscordUser[]
  /** Reference to a parent message — set for replies. Not used by bridge. */
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string }
  /**
   * Discord message types — 0 is default ("a user typed a message"),
   * non-zero are system events (channel pin, member join, …). Bridge
   * only handles type 0 + 19 (REPLY). Others skip silently.
   */
  type?: number
}

export interface DiscordUser {
  id: string
  username: string
  /** Display name set in the user's account (newer Discord username system). */
  global_name?: string | null
  /** Legacy nickname per server — not used by bridge. */
  nick?: string | null
  bot?: boolean
  system?: boolean
  discriminator?: string
}

/**
 * Attachments come back as CDN URLs (Discord serves them publicly).
 * Bridge passes the URL through; no token-gated download dance like
 * Lark / Telegram. `content_type` is best-effort — Discord sniffs it
 * server-side but may omit for obscure types.
 */
export interface DiscordAttachment {
  id: string
  filename: string
  size?: number
  url: string
  proxy_url?: string
  content_type?: string | null
  width?: number
  height?: number
  /** Duration for voice notes (seconds). */
  duration_secs?: number
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

/**
 * `GET /gateway/bot` returns the WebSocket URL + shard recommendation.
 * Bridge uses just `url`; sharding is out of scope (single-shard bots
 * cover 2500 guilds — more than any AipeHub deployment plausibly hits).
 */
export interface DiscordGatewayBotResponse {
  url: string
  shards: number
  session_start_limit: {
    total: number
    remaining: number
    reset_after: number
    max_concurrency: number
  }
}

/** POST /channels/{id}/messages body. */
export interface DiscordSendMessageRequest {
  content?: string
  /**
   * If set, the new message will be a reply to this one. Bridge can
   * optionally use it to keep threading inside Discord — currently
   * not wired.
   */
  message_reference?: {
    message_id?: string
    channel_id?: string
    guild_id?: string
    fail_if_not_exists?: boolean
  }
  /** Mention controls. Bridge omits to use Discord defaults. */
  allowed_mentions?: { parse?: Array<'roles' | 'users' | 'everyone'> }
}

export interface DiscordSendMessageResponse {
  id: string
  channel_id: string
  /** Echoed back; bridge ignores. */
  content?: string
  timestamp?: string
}

/**
 * Error envelope Discord returns on 4xx/5xx. Bridge surfaces `code`
 * + `message` via DiscordApiError so callers can branch on specific
 * codes (10003 unknown channel, 50001 missing access, …).
 */
export interface DiscordApiErrorBody {
  /** Numeric Discord error code — see https://discord.com/developers/docs/topics/opcodes-and-status-codes */
  code?: number
  message?: string
  /** Per-field validation errors for body / query params. */
  errors?: unknown
}
