/**
 * OneBot v11 wire shapes — a hand-rolled subset.
 *
 * What OneBot v11 is:
 *
 *   A community-maintained protocol spec that wraps QQ bot
 *   implementations (NapCat / go-cqhttp / Lagrange / Mirai-onebot /
 *   …) behind a uniform JSON-over-WebSocket interface. It is NOT
 *   official Tencent API — there is no official public bot API for
 *   personal QQ accounts. Implementations reverse-engineer the QQ
 *   client protocol; using them carries account-suspension risk.
 *
 * The bridge talks the v11 dialect (rather than the newer v12) for
 * two reasons:
 *   1. v11 has the broadest implementation coverage today (every
 *      maintained adapter supports it; v12 is still uneven).
 *   2. The contract is stable — published 2022, no breaking changes.
 *
 * Reference: https://github.com/botuniverse/onebot-11
 *
 * Transport modes the spec defines:
 *
 *   - Forward WebSocket: bridge connects to `ws://onebot:port/`.
 *     Bidirectional — bridge sends action calls, OneBot pushes events.
 *     **We use this.** Simplest to operate, no extra HTTP listener.
 *   - Reverse WebSocket: OneBot connects to a URL the bridge exposes.
 *     Useful when bridge is behind NAT but OneBot has internet egress.
 *   - HTTP POST: bridge POSTs to OneBot for actions; OneBot POSTs to
 *     bridge webhook for events. Two listeners, more moving parts.
 *
 * v11 quirks vs other IM protocols:
 *
 *   - No "bot user id" pre-shared. Instead `self_id` is on every
 *     inbound event — the QQ number of the running OneBot instance.
 *     Bridge caches it from the first lifecycle event AND verifies
 *     against any explicit `selfId` opt.
 *   - "CQ codes" — historical inline markup `[CQ:image,file=...]`.
 *     v11 also accepts/emits the "array message" form
 *     `[{type:'text',data:{text:'...'}}, {type:'image',data:{url:...}}]`.
 *     We treat array form as the canonical wire format and request
 *     it via the `message_format` field where the adapter supports
 *     it; if the adapter still emits CQ-string form, we fall back
 *     to passing the raw string as text (graceful degradation; the
 *     CQ markup is human-ish readable).
 */

// ---------------------------------------------------------------------------
// Action call / response (bridge → OneBot)
// ---------------------------------------------------------------------------

/**
 * Outbound action request. `echo` is a bridge-generated correlation
 * id; OneBot echoes it back in the matching response so we can pair
 * concurrent calls on the same socket.
 */
export interface OneBotActionRequest {
  action: string
  params?: Record<string, unknown>
  echo: string
}

/**
 * Outbound action response. `retcode` follows the OneBot spec:
 *
 *   0   — ok
 *   1   — async ok (action queued; result later)
 *   100 — bad params
 *   102 — bad request
 *   103 — handler missing
 *   104 — wrong session
 *   201 — server error
 *
 * Non-zero is converted to `OneBotApiError` by the client.
 */
export interface OneBotActionResponse<T = unknown> {
  status: 'ok' | 'async' | 'failed'
  retcode: number
  data: T | null
  msg?: string
  wording?: string
  echo: string
}

// ---------------------------------------------------------------------------
// Event push (OneBot → bridge)
// ---------------------------------------------------------------------------

/**
 * Top-level discriminator for inbound events. M7 only consumes
 * `message` events; everything else either contextualises (meta_event:
 * lifecycle / heartbeat → capture self_id, update liveness) or is
 * ignored (notice: friend_add / group_increase, request: friend_request).
 */
export type OneBotEvent =
  | OneBotMessageEvent
  | OneBotMetaEvent
  | OneBotNoticeEvent
  | OneBotRequestEvent

interface OneBotEventBase {
  time: number
  /** QQ number of the running OneBot instance. */
  self_id: number
  post_type: string
}

export interface OneBotMessageEvent extends OneBotEventBase {
  post_type: 'message'
  /** 'private' = DM, 'group' = group chat. */
  message_type: 'private' | 'group'
  /** Adapter-dependent: 'friend' | 'normal' | 'anonymous' | 'notice' | ... */
  sub_type?: string
  /** Per-message id — adapters use either a string or a number. */
  message_id: number | string
  /** Sender QQ number. */
  user_id: number
  /** Set on `message_type: 'group'`. */
  group_id?: number
  /**
   * Raw CQ-code message — backward-compatible string form. Always
   * populated by older adapters; modern adapters keep it alongside
   * `message: OneBotMessageSegment[]`.
   */
  raw_message?: string
  /**
   * Canonical message segments. Present when the adapter is told to
   * emit array form (some run `message_format: 'array'` by default,
   * others need explicit config — bridge handles both).
   */
  message: string | OneBotMessageSegment[]
  /** Per-user sender metadata. */
  sender?: OneBotSender
}

export interface OneBotSender {
  user_id?: number
  /** Display nickname. May be stale. */
  nickname?: string
  /** Group-specific name override (group only). */
  card?: string
  /** 'male' | 'female' | 'unknown' */
  sex?: string
  age?: number
  /** Group role (group only): 'owner' | 'admin' | 'member' */
  role?: string
}

export interface OneBotMetaEvent extends OneBotEventBase {
  post_type: 'meta_event'
  meta_event_type: 'lifecycle' | 'heartbeat'
  sub_type?: 'enable' | 'disable' | 'connect'
  /** Carried on heartbeat — bridge surfaces but doesn't currently consume. */
  status?: Record<string, unknown>
}

export interface OneBotNoticeEvent extends OneBotEventBase {
  post_type: 'notice'
  notice_type: string
}

export interface OneBotRequestEvent extends OneBotEventBase {
  post_type: 'request'
  request_type: string
}

// ---------------------------------------------------------------------------
// Message segments (array form)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of message segment shapes. M7 understands
 * 'text' / 'image' / 'record' (voice) / 'file'. Anything else is
 * passed through opaquely so unknown types don't crash the mapper.
 *
 * For `image`: `data.url` is QQ's CDN URL — public, no auth header
 * needed (similar to Discord, unlike Slack/Lark). `data.file` is
 * the adapter-cached filename; useful for re-sending the same
 * image without re-uploading.
 *
 * For `record`: same as image but for voice notes. Some adapters
 * emit `file://…` paths instead of URLs when the file is on the
 * adapter's local disk; bridge skips those (no remote-resolution
 * story in M7).
 */
export type OneBotMessageSegment =
  | { type: 'text'; data: { text: string } }
  | {
      type: 'image'
      data: { file?: string; url?: string; subType?: number; type?: string }
    }
  | { type: 'record'; data: { file?: string; url?: string } }
  | { type: 'file'; data: { file?: string; url?: string; name?: string } }
  | { type: 'at'; data: { qq: string | number } }
  | { type: 'reply'; data: { id: string | number } }
  | { type: 'face'; data: { id: string | number } }
  | { type: string; data: Record<string, unknown> }

// ---------------------------------------------------------------------------
// chat.send_msg request shape (outbound)
// ---------------------------------------------------------------------------

/**
 * Body for `action: 'send_msg'`. OneBot v11 accepts either the
 * legacy single `user_id` / `group_id` form or a discriminator
 * `message_type` — we use the discriminator form because some
 * adapters reject the legacy form when both fields would be
 * ambiguous.
 *
 * `message` accepts either the CQ-string OR array form. We send
 * the array form for outbound consistency.
 */
export interface OneBotSendMsgParams {
  message_type: 'private' | 'group'
  user_id?: number
  group_id?: number
  message: OneBotMessageSegment[]
  /** Strip text auto-escape of CQ characters. M7 always sends plain text segments — irrelevant for us but typed for forward compat. */
  auto_escape?: boolean
}

export interface OneBotSendMsgData {
  message_id: number | string
}
