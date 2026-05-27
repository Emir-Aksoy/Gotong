/**
 * Lark / Feishu Open Platform API shapes — a hand-rolled subset.
 *
 * Why hand-rolled rather than `@larksuiteoapi/node-sdk`:
 *
 *   - We need ~3 endpoints (tenant_access_token / send / image
 *     download) and the wrapper SDK ships hundreds of methods plus
 *     a code-generator runtime — outsized for a transport bridge.
 *   - `bun --compile` single-file deployments stay slim.
 *   - The OAPI SDK pins protobuf / form-data / specific http-client
 *     versions that conflict with the host's lockfile from time to
 *     time. fetch + ~600 lines is enough.
 *   - 国内 / 国际版 (Feishu / Lark) 切换只是换 baseUrl。
 *
 * Reference:
 *   - 国内：https://open.feishu.cn/document/server-docs/im-v1/message/create
 *   - 国际：https://open.larksuite.com/document/server-docs/im-v1/message/create
 *   (verified 2026-05)
 */

// ---------------------------------------------------------------------------
// Authentication — tenant_access_token (~2h TTL, auto-refreshed by client)
// ---------------------------------------------------------------------------

/**
 * `POST /open-apis/auth/v3/tenant_access_token/internal` — exchanges
 * `app_id` + `app_secret` for a short-lived tenant token. Bridge
 * client caches with a safety margin and re-fetches before expiry.
 *
 * `code: 0` on success; non-zero means business-logic failure (bad
 * app secret, app not published to tenant, etc.) and we surface as
 * `LarkApiError`.
 */
export interface LarkAccessTokenResponse {
  code: number
  msg: string
  tenant_access_token: string
  /** Seconds until expiry. Lark issues ~7200s tokens. */
  expire: number
}

// ---------------------------------------------------------------------------
// Webhook event envelope (Event Subscription, Schema 2.0)
// ---------------------------------------------------------------------------

/**
 * Lark wraps every event in a Schema 2.0 envelope. Both Feishu and
 * Lark use the same schema today; older Schema 1.0 events are not
 * supported (we'd reject in the bridge).
 *
 * Reference: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-
 */
export interface LarkEventEnvelope<T = unknown> {
  schema: '2.0'
  header: LarkEventHeader
  event: T
}

export interface LarkEventHeader {
  /** Globally unique event id; bridge uses for dedup. */
  event_id: string
  /** Verification token configured in the Lark admin panel. */
  token: string
  /** Unix milliseconds, stringified. */
  create_time: string
  /** Event type — bridge only handles 'im.message.receive_v1' for M4. */
  event_type: string
  /** Tenant key — present in production, absent in dev sandbox. */
  tenant_key?: string
  app_id?: string
}

/**
 * Special envelope sent when Lark first registers the webhook URL —
 * NOT wrapped in Schema 2.0. Bot must echo `challenge` back in the
 * response body to confirm ownership.
 */
export interface LarkUrlVerification {
  type: 'url_verification'
  challenge: string
  token: string
}

// ---------------------------------------------------------------------------
// `im.message.receive_v1` — the only event the bridge dispatches in M4
// ---------------------------------------------------------------------------

export interface LarkMessageReceiveEvent {
  sender: LarkSender
  message: LarkMessage
}

export interface LarkSender {
  sender_id?: LarkUserIds
  sender_type: 'user' | 'app' | 'anonymous'
  tenant_key?: string
}

/**
 * Lark issues three flavours of user id:
 *
 *   - `open_id` (ou_xxx): per-app per-tenant scope. Recommended for
 *     bots — stable, app-scoped, doesn't leak cross-app identity.
 *   - `union_id` (on_xxx): per-developer cross-app scope. Useful
 *     when one developer ships multiple apps and wants a stable user
 *     across them.
 *   - `user_id`: tenant's internal id (sometimes a custom string).
 *
 * The bridge uses `open_id` for `ImUser.platformUserId` because
 * (a) it's always present in modern events and (b) it scopes to the
 * bot's app — exactly the binding granularity we want.
 */
export interface LarkUserIds {
  open_id?: string
  union_id?: string
  user_id?: string
}

export interface LarkMessage {
  message_id: string
  /** Thread / reply parents — bridge doesn't currently consume but typed for future. */
  root_id?: string | null
  parent_id?: string | null
  /** Unix milliseconds, stringified — same format as create_time. */
  create_time: string
  /** Chat (room / DM) identifier — `oc_xxx` prefix. */
  chat_id: string
  /** 'p2p' (DM) or 'group'. */
  chat_type: 'p2p' | 'group'
  /**
   * 'text' | 'image' | 'audio' | 'file' | 'post' | 'sticker' | ... —
   * Lark adds new types over time; bridge falls back to a text
   * representation for unknown types.
   */
  message_type: string
  /**
   * JSON-STRINGIFIED content. The shape depends on `message_type` —
   * see `Lark*Content` interfaces below. The bridge JSON.parse's
   * this on the inbound hot path; an unparseable string yields a
   * dropped message (with onError reported).
   */
  content: string
  /**
   * `@bot` mentions and friends. The bridge can optionally strip the
   * placeholders (e.g. `<at user_id="ou_xxx">@Bot</at>`) from inbound
   * text to make downstream command parsing cleaner — see
   * `LarkBridgeOptions.stripBotMentions`.
   */
  mentions?: LarkMention[]
}

export interface LarkMention {
  /** Placeholder appearing in `content.text`, e.g. '@_user_1'. */
  key: string
  id?: LarkUserIds
  name?: string
  tenant_key?: string
}

// ---------------------------------------------------------------------------
// Parsed `LarkMessage.content` shapes (JSON sub-payloads)
// ---------------------------------------------------------------------------

export interface LarkTextContent {
  text: string
}

export interface LarkImageContent {
  image_key: string
}

export interface LarkAudioContent {
  /** Re-used as the URI tail for our `lark-file:` scheme. */
  file_key: string
  /** Duration in milliseconds. */
  duration?: number
}

export interface LarkFileContent {
  file_key: string
  file_name?: string
  /** Stringified bytes. */
  file_size?: string
}

export interface LarkStickerContent {
  file_key: string
}

/**
 * Lark's rich-text format. We don't render rich text in M4 — the
 * message is mapped to a flattened text body suitable for piping
 * into `parseImCommand` and LLM agents downstream.
 */
export interface LarkPostContent {
  /** Optional top-level title. */
  title?: string
  /** Lines, each a sequence of inline runs. `tag: 'text' | 'a' | 'at' | 'img' | ...` */
  content?: Array<Array<{ tag: string; text?: string; href?: string; user_id?: string }>>
}

// ---------------------------------------------------------------------------
// Outbound send request (POST /open-apis/im/v1/messages)
// ---------------------------------------------------------------------------

export interface LarkSendMessageRequest {
  receive_id: string
  msg_type: string
  /** JSON-stringified content (matches inbound). */
  content: string
}

export interface LarkSendMessageResponse {
  code: number
  msg: string
  data?: { message_id?: string }
}

// ---------------------------------------------------------------------------
// Standard error envelope
// ---------------------------------------------------------------------------

/**
 * Every Lark Open Platform call returns `{ code, msg, ... }`. `code: 0`
 * is success; non-zero is business-logic failure even when HTTP is 200.
 * The client unifies this with non-2xx HTTP into `LarkApiError`.
 */
export interface LarkApiErrorBody {
  code: number
  msg: string
}
