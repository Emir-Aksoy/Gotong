/**
 * QQ official Bot API (webhook) wire shapes — a hand-rolled subset.
 *
 * What this is:
 *
 *   The OFFICIAL Tencent QQ bot platform (https://bot.q.qq.com). Unlike
 *   the previous OneBot v11 implementation (a third-party protocol that
 *   drove personal QQ accounts via reverse-engineered adapters), this
 *   talks the sanctioned bot API: an AppID/AppSecret-authenticated bot
 *   registered on the QQ open platform.
 *
 * Transport — why webhook, not WebSocket:
 *
 *   The official platform shipped a WebSocket gateway historically, but
 *   Tencent stopped maintaining it (end-2024) and discontinued
 *   active-push for group bots (2025-04-21). The sanctioned path is now
 *   the HTTP **webhook**: the bot registers a public callback URL and
 *   QQ POSTs events to it. That means QQ ingress needs a public domain +
 *   TLS (typically a reverse proxy in front of this bridge) — it is NOT
 *   outbound/NAT-friendly the way Telegram/Lark/Slack are. This is a
 *   deliberate trade the operator accepts for a first-party bot.
 *
 * Reply model — passive only:
 *
 *   Group / C2C messages can only be PASSIVELY replied to: within a
 *   short window after a user message, carrying that message's `id`
 *   (msg_id) on the outbound call. Proactive push to a group/user was
 *   discontinued. The bridge can answer commands and conversation but
 *   cannot push unsolicited messages (heartbeats/alerts) to QQ groups.
 *
 * Reference:
 *   - Event subscription (webhook):
 *     https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 *   - Signature / callback validation (Ed25519):
 *     https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 */

// ---------------------------------------------------------------------------
// Opcodes
// ---------------------------------------------------------------------------

/** op:0 — a dispatched event (carries `t` event type + `d` payload). */
export const QQ_OP_DISPATCH = 0
/**
 * op:13 — webhook callback validation handshake. QQ sends this once when
 * the callback URL is configured (and periodically); the bot must sign
 * `event_ts + plain_token` with its Ed25519 key and echo back
 * `{ plain_token, signature }`.
 */
export const QQ_OP_VALIDATION = 13

/** msg_type for plain text on the v2 group / C2C message endpoints. */
export const QQ_MSG_TYPE_TEXT = 0

// ---------------------------------------------------------------------------
// Webhook envelope (QQ → bridge)
// ---------------------------------------------------------------------------

/**
 * Top-level webhook payload. `op` discriminates:
 *   - 0  (QQ_OP_DISPATCH):   a real event; `t` + `d` are set.
 *   - 13 (QQ_OP_VALIDATION): callback-URL validation; `d` is
 *     `{ plain_token, event_ts }`.
 *
 * `id` is the event id — used for passive-reply correlation and dedup.
 * `s` (seq) only matters on the deprecated gateway; webhook ignores it.
 */
export interface QqWebhookPayload {
  op: number
  /** Event id (op:0). Also surfaced as a header; we read it from the body. */
  id?: string
  /** Event type (op:0), e.g. 'GROUP_AT_MESSAGE_CREATE'. */
  t?: string
  /** Gateway sequence — unused on webhook transport. */
  s?: number
  /** Event payload (op:0 message data) or validation data (op:13). */
  d?: unknown
}

/** `d` of an op:13 validation payload. */
export interface QqValidationData {
  plain_token: string
  event_ts: string
}

/** Event types this bridge maps to `ImMessage`. */
export type QqMessageEventType =
  | 'GROUP_AT_MESSAGE_CREATE' // group @bot
  | 'C2C_MESSAGE_CREATE' // single (friend) chat
  | 'AT_MESSAGE_CREATE' // guild channel @bot
  | 'DIRECT_MESSAGE_CREATE' // guild direct message

/**
 * Message sender. Field availability varies by surface:
 *   - group:   `id` + `member_openid` (+ `union_openid`)
 *   - C2C:     `id` + `user_openid`   (+ `union_openid`)
 *   - guild:   `id` + `username`
 *
 * `union_openid` is the bot-scoped identity stable ACROSS group/C2C, so
 * it's the preferred `platformUserId` for IM bindings (a user keeps the
 * same id whether they DM the bot or @ it in a group).
 */
export interface QqAuthor {
  id?: string
  union_openid?: string
  member_openid?: string
  user_openid?: string
  username?: string
}

/**
 * `d` of a message event. One shape covers all four event types; the
 * presence of `group_openid` / `channel_id` / `guild_id` tells the
 * mapper which surface it is.
 */
export interface QqMessageData {
  /** Per-message id — the passive-reply correlation handle. */
  id?: string
  /** Message body. Group/C2C: plain (the @ is consumed). Guild: has `<@!id>`. */
  content?: string
  /** ISO 8601 string on the official API. */
  timestamp?: string
  author?: QqAuthor
  /** GROUP_AT_MESSAGE_CREATE — the group's openid. */
  group_openid?: string
  /** AT_MESSAGE_CREATE — guild channel id. */
  channel_id?: string
  /** DIRECT_MESSAGE_CREATE — guild id (the send target for guild DMs). */
  guild_id?: string
}

// ---------------------------------------------------------------------------
// App access token (bridge → QQ auth endpoint)
// ---------------------------------------------------------------------------

/**
 * Response from `POST https://bots.qq.com/app/getAppAccessToken`.
 * `expires_in` is seconds — QQ has historically returned it as either a
 * number or a numeric string, so the client coerces.
 */
export interface QqAppAccessTokenResponse {
  access_token: string
  expires_in: number | string
}

// ---------------------------------------------------------------------------
// Outbound message (bridge → QQ REST)
// ---------------------------------------------------------------------------

/**
 * Body for the v2 group / C2C message endpoints and the channel / DM
 * endpoints. `msg_id` makes the send a PASSIVE reply (required — see the
 * reply-model note above). `msg_seq` disambiguates multiple replies to
 * the same `msg_id` (must increment).
 */
export interface QqPassiveReplyBody {
  content: string
  /** Defaults to QQ_MSG_TYPE_TEXT on the group/C2C path. */
  msg_type?: number
  /** Inbound message id — turns this into a passive reply. */
  msg_id?: string
  /** Reply sequence for the same msg_id (increment per reply). */
  msg_seq?: number
}

/** Minimal success shape returned by the send endpoints. */
export interface QqSendResult {
  id?: string
  timestamp?: string | number
}

/** Error body the REST endpoints return on failure. */
export interface QqApiErrorBody {
  code?: number
  message?: string
  err_code?: number
}
