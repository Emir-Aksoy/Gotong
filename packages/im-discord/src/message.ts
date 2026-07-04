/**
 * Discord MESSAGE_CREATE → `ImMessage` mapper. Pure functions; trivially
 * unit-testable without a Discord account.
 *
 * Skip rules — `discordToImMessage` returns `null` for any of:
 *
 *   1. `type` is set and is not `0` (default) or `19` (reply). Discord
 *      uses non-zero types for system events ("user joined the channel",
 *      pin notifications, …) — bridging those would spam the Hub.
 *   2. `author.bot === true` or `author.id === botUserId`. Bots
 *      receive their own MESSAGE_CREATE events back; without this
 *      filter two bots in the same channel form a loop. Also drops
 *      webhook posts (`author.bot` is set on those).
 *   3. `author` shape is malformed (missing id).
 *
 * Unlike Lark / Telegram, Discord serves attachments as plain CDN
 * URLs that don't require auth. We pass them through verbatim in
 * `ImAttachment.url` — no `discord-file:` scheme needed.
 *
 * `displayName` is the user's `global_name` (modern Discord display
 * name) or username as fallback. We don't resolve server-specific
 * nicknames — that lives in the GuildMember payload which the bridge
 * doesn't fetch.
 */

import type { ImAttachment, ImMessage, ImUser } from '@gotong/im-adapter'

import type { DiscordAttachment, DiscordMessage } from './types.js'

// ---------------------------------------------------------------------------
// Bot-mention stripping
// ---------------------------------------------------------------------------

/**
 * Discord renders @mentions as `<@USER_ID>` or `<@!USER_ID>` (legacy
 * "nick mention" form). When the bot is mentioned at the start of a
 * message in a guild channel, the text reaching downstream looks like
 * `<@123456789012345678> /help` — `parseImCommand` doesn't recognise
 * that prefix.
 *
 * `stripDiscordBotMentions` removes ANY mention of the given bot id,
 * including the legacy `!` form, and trims surrounding whitespace.
 *
 * If no bot id is supplied, returns the text unchanged.
 */
export function stripDiscordBotMentions(text: string, botUserId: string | null): string {
  if (typeof text !== 'string') return ''
  if (!botUserId) return text
  // Escape any chars that would be regex-meaningful — Discord user ids
  // are decimal, but defensive escaping costs nothing.
  const id = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<@!?${id}>`, 'g')
  return text.replace(re, '').trim()
}

// ---------------------------------------------------------------------------
// Attachment classification
// ---------------------------------------------------------------------------

/**
 * Classify a Discord attachment as image / audio / file. Discord's
 * `content_type` is a normal MIME like `image/png`, `audio/ogg`,
 * `application/pdf` — we bucket by the type prefix. Unknown → file.
 *
 * Image dimensions (`width` / `height`) on the attachment are a
 * strong hint that it's an image even when MIME is missing; we use
 * that as a fallback so iPhone photos uploaded from the Discord app
 * (which sometimes lack `content_type`) still get classified.
 *
 * Voice notes carry `duration_secs` — same fallback for audio.
 */
function classifyAttachment(att: DiscordAttachment): 'image' | 'audio' | 'file' {
  const ct = (att.content_type ?? '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('audio/')) return 'audio'
  if (!ct) {
    if (att.duration_secs !== undefined) return 'audio'
    if (att.width !== undefined && att.height !== undefined) return 'image'
  }
  return 'file'
}

export function discordExtractAttachments(message: DiscordMessage): ImAttachment[] {
  const list = message.attachments ?? []
  if (list.length === 0) return []
  return list.map((att) => ({
    kind: classifyAttachment(att),
    url: att.url,
    mime: att.content_type ?? null,
    filename: att.filename ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Author → ImUser
// ---------------------------------------------------------------------------

function authorToImUser(author: DiscordMessage['author']): ImUser | null {
  if (!author || typeof author.id !== 'string' || author.id.length === 0) return null
  // Prefer `global_name` (the new account-level display name), fall
  // back to username. Both can be set; if both are missing we leave
  // displayName null — IM bridges typed it as optional/nullable.
  const display = author.global_name ?? author.username ?? null
  return {
    platform: 'discord',
    platformUserId: author.id,
    displayName: display,
  }
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

export interface DiscordMessageMapOptions {
  /**
   * Bot's own user id, used to (a) drop our own messages from the
   * inbound stream and (b) strip `<@BOT_ID>` mentions from the text
   * when `stripBotMentions` is true (default).
   */
  botUserId: string | null
  /** Default true. */
  stripBotMentions?: boolean
}

export function discordToImMessage(
  message: DiscordMessage,
  options: DiscordMessageMapOptions,
): ImMessage | null {
  // Skip system / unsupported message types. Discord type 0 is default
  // user message; type 19 is a reply (REPLY) — still user content with
  // a `message_reference`, treated as a normal message here.
  if (typeof message.type === 'number' && message.type !== 0 && message.type !== 19) {
    return null
  }
  // Anti-loop: drop our own messages and any other bot's.
  if (message.author?.bot) return null
  if (options.botUserId && message.author?.id === options.botUserId) return null

  const from = authorToImUser(message.author)
  if (!from) return null

  let text = typeof message.content === 'string' ? message.content : ''
  if (options.stripBotMentions !== false && options.botUserId) {
    text = stripDiscordBotMentions(text, options.botUserId)
  }

  const attachments = discordExtractAttachments(message)
  const tsMs = parseDiscordTimestamp(message.timestamp)

  return {
    from,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: message.id,
    chatId: message.channel_id,
    ts: tsMs,
  }
}

/**
 * Discord timestamps are ISO-8601 strings (`2026-05-27T10:30:00.000+00:00`).
 * Falls back to `Date.now()` on unparseable input so the ImMessage
 * always carries a sensible ts.
 */
function parseDiscordTimestamp(s: unknown): number {
  if (typeof s !== 'string') return Date.now()
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : Date.now()
}
