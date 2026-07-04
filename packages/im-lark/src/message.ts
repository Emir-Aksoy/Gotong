/**
 * Lark event → `ImMessage` mapper. Pure functions; trivially
 * unit-testable without a Lark account.
 *
 * Skip rules — `larkToImMessage` returns `null` for any of:
 *
 *   1. `sender.sender_type !== 'user'` — app-to-app, anonymous, or
 *      future sender types. We don't bridge those into the Hub.
 *      Without this, two bots in the same chat create loops.
 *   2. `sender.sender_id.open_id` is missing — Lark sometimes omits
 *      this for anonymous senders; we have no binding target.
 *   3. `message.content` is not valid JSON, or the parsed shape
 *      doesn't match the `message_type`. Drops corrupt events.
 *
 * Unlike Telegram (numeric ids) and Matrix (mxid format), Lark uses
 * the `open_id` (`ou_xxx`) as `platformUserId` — it's the per-app,
 * per-tenant stable identity Lark recommends for bot bindings.
 *
 * `displayName` is `null` for M4. Resolving the sender's display
 * name requires `GET /open-apis/contact/v3/users/<open_id>` per
 * inbound message — not worth the rate-limit hit. Downstream code
 * that wants pretty names can fetch on demand.
 */

import type { ImAttachment, ImMessage, ImUser } from '@gotong/im-adapter'

import type {
  LarkAudioContent,
  LarkFileContent,
  LarkImageContent,
  LarkMessage,
  LarkMessageReceiveEvent,
  LarkPostContent,
  LarkStickerContent,
  LarkTextContent,
} from './types.js'

// ---------------------------------------------------------------------------
// `lark-<kind>:<key>` URI helpers — analogous to `telegram-file:`
// ---------------------------------------------------------------------------

/**
 * Lark gives us a `file_key` or `image_key` per attachment — opaque
 * tokens the consumer trades back into the Open Platform's download
 * endpoints. We don't surface those endpoints directly; we keep the
 * key behind a `lark-image:` / `lark-audio:` / `lark-file:` URI so
 * downstream code stays platform-agnostic.
 *
 * Schemes:
 *   - `lark-image:<image_key>` — `GET /open-apis/im/v1/images/{key}`
 *   - `lark-audio:<file_key>` — `GET /open-apis/im/v1/files/{key}`
 *     (Lark stores voice as files; audio is same endpoint.)
 *   - `lark-file:<file_key>`  — `GET /open-apis/im/v1/files/{key}`
 *
 * Downstream code that needs the bytes:
 *
 *   const { kind, key } = parseLarkUri(att.url)!
 *   const endpoint = kind === 'image' ? 'images' : 'files'
 *   const url = `${BASE}/open-apis/im/v1/${endpoint}/${key}`
 *   const res = await fetch(url, {
 *     headers: { authorization: `Bearer ${TENANT_TOKEN}` },
 *   })
 *
 * The `lark-` prefix is private to this package — same reasoning as
 * Telegram's `telegram-file:`. Downstream code that wants bytes must
 * depend on @gotong/im-lark (or roll its own `getFile` dance).
 */
export const LARK_URI_PREFIXES = {
  image: 'lark-image:',
  audio: 'lark-audio:',
  file: 'lark-file:',
} as const

export type LarkUriKind = keyof typeof LARK_URI_PREFIXES

export function larkUri(kind: LarkUriKind, key: string): string {
  return `${LARK_URI_PREFIXES[kind]}${key}`
}

/** Parse a `lark-<kind>:<key>` URI back to `{ kind, key }`, or null. */
export function parseLarkUri(uri: unknown): { kind: LarkUriKind; key: string } | null {
  if (typeof uri !== 'string') return null
  for (const [kind, prefix] of Object.entries(LARK_URI_PREFIXES) as Array<
    [LarkUriKind, string]
  >) {
    if (uri.startsWith(prefix)) {
      const key = uri.slice(prefix.length)
      if (key.length === 0) return null
      return { kind, key }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Content parsing — strip the JSON-string indirection
// ---------------------------------------------------------------------------

/**
 * `LarkMessage.content` is a JSON-stringified blob whose shape
 * depends on `message_type`. This helper parses + narrows; returns
 * `null` if the string isn't JSON-parseable.
 */
export function parseLarkContent(message: LarkMessage): unknown | null {
  if (typeof message.content !== 'string') return null
  try {
    return JSON.parse(message.content)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Mention stripping — group chats interpolate `<at user_id="ou_xxx">@Bot</at>`
// ---------------------------------------------------------------------------

/**
 * Group messages addressed to the bot embed the @bot mention as an
 * `<at>` tag inside the text body:
 *
 *   "<at user_id=\"ou_xxx\">@Bot</at> /help"
 *
 * Downstream command parsing (`parseImCommand`) wants clean text
 * (`/help`), so the bridge optionally strips these. We remove any
 * `<at ...>...</at>` block entirely — including the display name —
 * rather than try to preserve the visible label. The recipient bot
 * already knows its own name; the text the bot needs is the part
 * AFTER the mention.
 *
 * Conservative regex — we don't try to handle nested tags (Lark
 * doesn't nest them in mentions) or HTML-encoded angle brackets.
 */
export function stripLarkMentions(text: string): string {
  return text.replace(/<at\b[^>]*>.*?<\/at>/g, '').trim()
}

// ---------------------------------------------------------------------------
// Attachment extraction
// ---------------------------------------------------------------------------

/**
 * Pull attachments out of a Lark message into the platform-agnostic
 * `ImAttachment[]` shape. Lark messages carry at most one payload
 * (the message_type drives the schema), so we return a 0- or 1-length
 * array.
 *
 * Per-type rules:
 *
 *   - 'image' / 'sticker' → `kind: 'image'`. Sticker mime is
 *     image/webp by convention (we hard-code it; Lark doesn't expose
 *     the actual type). Pure stickers are rare in command-driven
 *     bot flows — they pass through but carry no meaningful text.
 *   - 'audio'             → `kind: 'audio'`. Mime defaults to
 *     audio/ogg (Lark voice notes are opus/ogg by spec).
 *   - 'file'              → `kind: 'file'`. Mime not in the event
 *     payload — set to null; consumer can sniff via the trailing
 *     file_name extension if they want.
 *   - others (post, etc.) → `[]` (no attachment).
 */
export function larkExtractAttachments(
  message: LarkMessage,
  parsed: unknown,
): ImAttachment[] {
  if (!parsed || typeof parsed !== 'object') return []
  switch (message.message_type) {
    case 'image': {
      const c = parsed as LarkImageContent
      if (typeof c.image_key !== 'string') return []
      return [
        {
          kind: 'image',
          url: larkUri('image', c.image_key),
          mime: 'image/jpeg', // Lark serves photos as JPEG; not exposed in event
          filename: null,
        },
      ]
    }
    case 'sticker': {
      const c = parsed as LarkStickerContent
      if (typeof c.file_key !== 'string') return []
      return [
        {
          kind: 'image',
          url: larkUri('image', c.file_key),
          mime: 'image/webp',
          filename: null,
        },
      ]
    }
    case 'audio': {
      const c = parsed as LarkAudioContent
      if (typeof c.file_key !== 'string') return []
      return [
        {
          kind: 'audio',
          url: larkUri('audio', c.file_key),
          mime: 'audio/ogg',
          filename: null,
        },
      ]
    }
    case 'file': {
      const c = parsed as LarkFileContent
      if (typeof c.file_key !== 'string') return []
      return [
        {
          kind: 'file',
          url: larkUri('file', c.file_key),
          mime: null,
          filename: c.file_name ?? null,
        },
      ]
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Flatten content → text body
// ---------------------------------------------------------------------------

/**
 * Extract a best-effort plain text body from the parsed content.
 * Used to fill `ImMessage.text` for every message_type — text
 * messages take the `text` field, media types take their filename /
 * caption, posts get a flattened text representation.
 *
 * Returns empty string when no text is available — `ImMessage.text`
 * is typed as `string`, never null; the attachments carry the
 * meaningful payload in that case.
 */
export function larkContentToText(message: LarkMessage, parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  switch (message.message_type) {
    case 'text': {
      const c = parsed as LarkTextContent
      return typeof c.text === 'string' ? c.text : ''
    }
    case 'image':
    case 'sticker':
      return '' // photo-only; no caption in Lark's event payload
    case 'audio':
      return '' // voice notes carry no transcript
    case 'file': {
      const c = parsed as LarkFileContent
      return c.file_name ?? '' // best-effort fallback so the body isn't blank
    }
    case 'post': {
      // Flatten the 2D run array into a single line of text.
      // We discard formatting (bold / colour) and link hrefs;
      // downstream parsing is plain-text.
      const c = parsed as LarkPostContent
      const lines = (c.content ?? []).map((line) =>
        line.map((run) => run.text ?? '').join(''),
      )
      const body = lines.join('\n').trim()
      return c.title ? `${c.title}\n${body}` : body
    }
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// The main mapper
// ---------------------------------------------------------------------------

export function larkToImMessage(
  event: LarkMessageReceiveEvent,
  options: { stripBotMentions?: boolean } = {},
): ImMessage | null {
  if (event.sender.sender_type !== 'user') return null
  const openId = event.sender.sender_id?.open_id
  if (typeof openId !== 'string' || openId.length === 0) return null

  const message = event.message
  if (!message || typeof message.message_type !== 'string') return null
  const parsed = parseLarkContent(message)
  if (parsed === null) return null // content was an unparseable string — drop

  let text = larkContentToText(message, parsed)
  if (options.stripBotMentions) text = stripLarkMentions(text)

  const attachments = larkExtractAttachments(message, parsed)
  const from: ImUser = {
    platform: 'lark',
    platformUserId: openId,
    displayName: null,
  }
  // create_time is unix milliseconds stringified per Lark spec.
  const tsNum = Number(message.create_time)
  const ts = Number.isFinite(tsNum) ? tsNum : Date.now()
  return {
    from,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: message.message_id,
    chatId: message.chat_id,
    ts,
  }
}

// ---------------------------------------------------------------------------
// receive_id_type sniffer
// ---------------------------------------------------------------------------

/**
 * Lark's `POST /open-apis/im/v1/messages` requires a
 * `receive_id_type` query param telling it how to interpret
 * `receive_id`. The bridge sniffs based on common prefixes:
 *
 *   - `oc_xxx` → 'chat_id'  (room / DM thread)
 *   - `ou_xxx` → 'open_id'  (per-app user id)
 *   - `on_xxx` → 'union_id' (per-developer user id)
 *   - email-like → 'email'
 *   - anything else falls back to 'user_id' (tenant-internal)
 *
 * Most bridge replies go through `options.chatId` (chat_id, oc_xxx)
 * which is the cleanest path — works for both DM and group replies.
 */
export function pickLarkReceiveIdType(id: string): string {
  if (id.startsWith('oc_')) return 'chat_id'
  if (id.startsWith('ou_')) return 'open_id'
  if (id.startsWith('on_')) return 'union_id'
  if (id.includes('@')) return 'email'
  return 'user_id'
}
