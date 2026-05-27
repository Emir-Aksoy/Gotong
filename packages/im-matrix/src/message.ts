/**
 * Matrix event → `ImMessage` mapper. Pure functions; trivially
 * unit-testable without a homeserver.
 *
 * Skip rules — `matrixToImMessage` returns `null` for any of:
 *
 *   1. `type !== 'm.room.message'` — state events, redactions,
 *      reactions, etc. are filtered out via the server-side filter
 *      too, but the mapper double-checks.
 *   2. `sender === botUserId` — the bot's own messages echoing back.
 *      Without this, two bots in the same room create infinite loops.
 *   3. `content` missing or not an object — malformed events. We
 *      don't crash, we just skip.
 *
 * `displayName` is intentionally set to `null` for M3. Resolving the
 * sender's display name requires a separate `/profile/{userId}/displayname`
 * round-trip per inbound message — not worth the latency, especially
 * because Matrix mxids (`@alice:matrix.org`) are themselves
 * human-readable. Downstream code that wants the pretty name can
 * fetch it on demand.
 */

import type { ImAttachment, ImMessage, ImUser } from '@aipehub/im-adapter'

import type { MatrixMessageContent, MatrixRoomEvent } from './types.js'

// ---------------------------------------------------------------------------
// mxc:// URI helpers
// ---------------------------------------------------------------------------

/**
 * `mxc://` is Matrix's own URI scheme for media — server-hosted
 * content addressed by `<serverName>/<mediaId>`. Unlike Telegram's
 * `telegram-file:` (which we invented because Telegram has no URL),
 * `mxc://` is the canonical Matrix-side reference. We pass it through
 * as-is on `ImAttachment.url`.
 *
 * Downstream code that needs the bytes:
 *
 *   const { serverName, mediaId } = parseMxcUri(att.url)!
 *   const url = `https://${HOMESERVER}/_matrix/client/v1/media/download/${serverName}/${mediaId}`
 *   const bytes = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
 *
 * Note: starting Matrix v1.11 the unauthenticated `/_matrix/media/v3/download`
 * is being deprecated in favour of the authenticated v1 endpoint. The
 * bridge doesn't expose a download helper for M3 — consumers do it
 * themselves with whatever path matches their homeserver's version.
 */
export const MXC_URI_PREFIX = 'mxc://'

/**
 * Parse an `mxc://server/mediaId` URI. Returns `null` on anything
 * malformed (wrong scheme, missing server, missing media id).
 */
export function parseMxcUri(uri: unknown): { serverName: string; mediaId: string } | null {
  if (typeof uri !== 'string') return null
  if (!uri.startsWith(MXC_URI_PREFIX)) return null
  const rest = uri.slice(MXC_URI_PREFIX.length)
  // Spec: serverName is anything up to the first '/'; mediaId is the
  // rest (may not itself contain '/', but Synapse historically issues
  // them so we don't enforce). Reject empty halves either side.
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const serverName = rest.slice(0, slash)
  const mediaId = rest.slice(slash + 1)
  if (mediaId.length === 0) return null
  return { serverName, mediaId }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Pull attachments out of an `m.room.message` content into the
 * platform-agnostic `ImAttachment[]` shape. Returns `[]` for text
 * messages.
 *
 * Matrix message content carries at most one media reference (unlike
 * Telegram which can pack `photo + caption + document` in one
 * message), so we return a 1- or 0-length array.
 *
 * `m.video` maps to `kind: 'file'` rather than 'audio' because:
 *
 *   - `ImAttachment.kind` is `'image' | 'audio' | 'file'` — no
 *     'video' bucket. Video bytes routed as 'file' preserves them
 *     for download; LLM multimodal won't autoplay either way.
 *   - Future: when ImAttachment gains 'video', flip this.
 */
export function matrixExtractAttachments(content: MatrixMessageContent): ImAttachment[] {
  // Only set on media msgtypes; text messages have no `url`.
  if (typeof content.url !== 'string' || content.url.length === 0) return []
  const mime = content.info?.mimetype ?? null
  // `filename` is the explicit override; `body` is the spec's fallback
  // (for m.image / m.audio / etc., `body` is documented as a textual
  // representation suitable for display — typically the original
  // filename). For m.text the body is the message text, not a
  // filename, so we'd never get here.
  const filename = content.filename ?? content.body ?? null
  let kind: ImAttachment['kind']
  switch (content.msgtype) {
    case 'm.image':
      kind = 'image'
      break
    case 'm.audio':
      kind = 'audio'
      break
    case 'm.video':
    case 'm.file':
      kind = 'file'
      break
    default:
      // Unknown media-ish msgtype — treat as file rather than dropping.
      // Matrix is forwards-compatible by spec: tomorrow's `m.sticker`
      // shouldn't disappear silently.
      kind = 'file'
  }
  return [
    {
      kind,
      url: content.url,
      mime,
      filename,
    },
  ]
}

/**
 * Convert a Matrix room event into the platform-agnostic `ImMessage`.
 * Returns `null` for messages we can't or shouldn't route — see the
 * skip rules at the top of this file.
 *
 * `botUserId` is the bot's own mxid; pass `null` to disable
 * self-filtering (useful for tests or for bridges that want to
 * observe their own send-side echo).
 *
 * `roomId` is taken from the sync envelope, not the event itself —
 * timeline events don't carry their room id, the sync response
 * groups them by room.
 */
export function matrixToImMessage(
  event: MatrixRoomEvent,
  roomId: string,
  botUserId: string | null,
): ImMessage | null {
  if (event.type !== 'm.room.message') return null
  if (botUserId !== null && event.sender === botUserId) return null
  if (typeof event.content !== 'object' || event.content === null) return null
  // `content` is `unknown` per the event interface; we narrow.
  const content = event.content as MatrixMessageContent
  if (typeof content.msgtype !== 'string') return null
  if (typeof content.body !== 'string') return null

  const from: ImUser = {
    platform: 'matrix',
    platformUserId: event.sender,
    displayName: null,
  }
  const attachments = matrixExtractAttachments(content)
  return {
    from,
    // `body` is the message text for m.text/m.notice/m.emote and the
    // filename / caption for media types. Either way it's the
    // best-effort textual representation. Matches Telegram's
    // `text ?? caption ?? ''` pattern.
    text: content.body,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: event.event_id,
    chatId: roomId,
    ts: event.origin_server_ts,
  }
}
