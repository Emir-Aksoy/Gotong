/**
 * Telegram message → `ImMessage` mapper. Pure functions; trivially
 * unit-testable without touching the network.
 */

import type { ImAttachment, ImMessage, ImUser } from '@aipehub/im-adapter'

import type { TelegramMessage, TelegramUser } from './types.js'

/**
 * Custom URI for "attachment was uploaded as a Telegram file we
 * haven't downloaded yet." Consumers that need the bytes call
 * `TelegramClient.call('getFile', { file_id })` → returns a
 * `file_path`; then GET `https://api.telegram.org/file/bot<TOKEN>/<file_path>`.
 *
 * We deliberately keep the bytes off the inbound hot path: most IM
 * messages are text + an image and the LLM only sometimes needs the
 * image. Eager-downloading every photo would 4-8x our outbound
 * traffic on Telegram's CDN and stuff the host's memory.
 *
 * Naming: the `telegram-file:` scheme is private to this package —
 * downstream code that wants the bytes must depend on this package
 * (or do its own `getFile` dance). That's intentional: there's no
 * "universal URL" you can hand to anything in the AipeHub graph.
 */
export const TELEGRAM_FILE_URI_PREFIX = 'telegram-file:'

export function telegramFileUri(fileId: string): string {
  return `${TELEGRAM_FILE_URI_PREFIX}${fileId}`
}

/** Parse a `telegram-file:<id>` URI back to its file_id, or null. */
export function parseTelegramFileUri(uri: string): string | null {
  if (typeof uri !== 'string') return null
  if (!uri.startsWith(TELEGRAM_FILE_URI_PREFIX)) return null
  const id = uri.slice(TELEGRAM_FILE_URI_PREFIX.length)
  return id.length > 0 ? id : null
}

/** Build a display name from the Telegram user — best-effort. */
export function telegramDisplayName(u: TelegramUser): string | null {
  if (u.username) return u.username
  if (u.first_name && u.last_name) return `${u.first_name} ${u.last_name}`
  if (u.first_name) return u.first_name
  return null
}

/**
 * Pull attachments out of a Telegram message into the
 * platform-agnostic `ImAttachment[]` shape. Returns `[]` for
 * text-only messages.
 *
 * Telegram packs each photo as multiple `PhotoSize` thumbnails. We
 * pick the largest (last in the array per the spec) — keeping every
 * size would just bloat downstream prompts.
 */
export function telegramExtractAttachments(msg: TelegramMessage): ImAttachment[] {
  const out: ImAttachment[] = []
  if (msg.photo && msg.photo.length > 0) {
    // The Bot API documents that `photo` is "in increasing size."
    // The last element is the original (highest-res) variant.
    const largest = msg.photo[msg.photo.length - 1]!
    out.push({
      kind: 'image',
      url: telegramFileUri(largest.file_id),
      // Telegram doesn't expose the source mime for photos — they're
      // re-encoded server-side and the recipient sees what amounts
      // to a uniform-ish JPEG. Hard-code; LLM providers tolerate JPEG.
      mime: 'image/jpeg',
      filename: null,
    })
  }
  if (msg.voice) {
    out.push({
      kind: 'audio',
      url: telegramFileUri(msg.voice.file_id),
      mime: msg.voice.mime_type ?? 'audio/ogg',
      filename: null,
    })
  }
  if (msg.audio) {
    out.push({
      kind: 'audio',
      url: telegramFileUri(msg.audio.file_id),
      mime: msg.audio.mime_type ?? null,
      filename: msg.audio.file_name ?? msg.audio.title ?? null,
    })
  }
  if (msg.document) {
    // Anything that isn't an image/audio is `file` — PDFs, code,
    // CSVs, etc. The mime is the document's, not a guess.
    out.push({
      kind: 'file',
      url: telegramFileUri(msg.document.file_id),
      mime: msg.document.mime_type ?? null,
      filename: msg.document.file_name ?? null,
    })
  }
  return out
}

/**
 * Convert a Telegram message into the platform-agnostic `ImMessage`.
 * Returns `null` for messages we can't or shouldn't route:
 *
 *   - `from` is absent (channel posts, anonymous channel signing) —
 *     no binding target.
 *   - `from.is_bot` is true — other bots talking to ours. Echoing
 *     into the Hub creates loops. Bridges that want bot-to-bot bridging
 *     can post-process the `from.is_bot` flag themselves, but the
 *     default refuses.
 */
export function telegramToImMessage(msg: TelegramMessage): ImMessage | null {
  if (!msg.from || msg.from.is_bot) return null
  const from: ImUser = {
    platform: 'telegram',
    platformUserId: String(msg.from.id),
    displayName: telegramDisplayName(msg.from),
  }
  const attachments = telegramExtractAttachments(msg)
  return {
    from,
    text: msg.text ?? msg.caption ?? '',
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: String(msg.message_id),
    chatId: String(msg.chat.id),
    // Telegram `date` is unix seconds; ImMessage wants ms.
    ts: msg.date * 1000,
  }
}
