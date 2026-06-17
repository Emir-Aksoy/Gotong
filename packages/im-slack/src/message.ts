/**
 * Slack `message` event → `ImMessage` mapper.
 *
 * Pure functions; no fetch, no node:crypto. Trivially unit-testable
 * without a Slack workspace. (Socket Mode authenticates the connection
 * with the `xapp-` token at `apps.connections.open`, so there is no
 * per-request HMAC to verify here — unlike the old Events API webhook.)
 *
 * Skip rules — `slackToImMessage` returns `null` for any of:
 *
 *   1. `bot_id` is set → bot post (incl. our own). Without this,
 *      two bots in the same channel create infinite loops.
 *   2. `user === botUserId` → own message echo. Slack delivers our
 *      own posts via the same `message` event.
 *   3. `subtype` is set to anything except `'file_share'` →
 *      system noise (channel_join, message_changed, message_deleted,
 *      bot_message, …). Bridge stays out of those.
 *   4. `user` field is missing → either anonymous or system. No
 *      binding target.
 *
 * Unlike Telegram (numeric ids) and Matrix (mxid format), Slack
 * uses `U…` snowflakes for users and `C…/D…/G…` snowflakes for
 * channels. Bridge uses `user` field verbatim as `platformUserId`.
 */

import type { ImAttachment, ImMessage, ImUser } from '@aipehub/im-adapter'

import type { SlackFile, SlackMessageEvent } from './types.js'

// ---------------------------------------------------------------------------
// `slack-file:` URI helpers — analogous to `lark-file:` / `telegram-file:`
// ---------------------------------------------------------------------------

/**
 * Slack files live behind a Bearer-auth-gated `url_private` endpoint.
 * Bridge wraps the file id behind a `slack-file:` URI so downstream
 * code stays platform-agnostic. Resolution back to bytes requires
 * the same bot token + a GET to `url_private`.
 *
 * Why not store `url_private` directly in `ImAttachment.url`:
 *
 *   - Slack's URL is auth-gated. Naive consumers that fetch the URL
 *     without `Authorization: Bearer xoxb-…` get 200 HTML (Slack's
 *     web login page) — a confusing failure mode.
 *   - The URI scheme makes it explicit downstream code needs the
 *     bridge (or a shared resolver) to fetch.
 *
 * Schemes:
 *   - `slack-file:<file_id>` — used for all attachment kinds.
 *     Consumer resolves via Slack `files.info` API for fresh
 *     `url_private`, then GET that with the bot token.
 */
export const SLACK_FILE_URI_PREFIX = 'slack-file:'

export function slackFileUri(fileId: string): string {
  return `${SLACK_FILE_URI_PREFIX}${fileId}`
}

/** Parse `slack-file:<id>` back to `{ fileId }`, or null. */
export function parseSlackFileUri(uri: unknown): { fileId: string } | null {
  if (typeof uri !== 'string') return null
  if (!uri.startsWith(SLACK_FILE_URI_PREFIX)) return null
  const fileId = uri.slice(SLACK_FILE_URI_PREFIX.length)
  if (fileId.length === 0) return null
  return { fileId }
}

// ---------------------------------------------------------------------------
// Bot mention stripping — group channels prefix replies to the bot
// ---------------------------------------------------------------------------

/**
 * Slack interpolates `<@U…>` for user mentions, including the bot.
 * Group / channel messages addressed to the bot land as e.g.
 * `"<@UBOT123> /help"`. `parseImCommand` expects clean text, so the
 * bridge strips the bot's own mention by default.
 *
 * Behaviour mirrors `stripDiscordBotMentions` from im-discord:
 *
 *   - Strips ALL occurrences of `<@BOT_USER_ID>`, not just leading.
 *   - Leaves other-user mentions intact.
 *   - When `botUserId` is null (e.g. before the first auth.test
 *     succeeds), returns the input unchanged.
 *   - Non-string input → empty string (defensive).
 */
export function stripSlackBotMentions(text: unknown, botUserId: string | null): string {
  if (typeof text !== 'string') return ''
  if (!botUserId) return text
  // Slack ids are U/W followed by alphanumerics. We anchor the exact
  // id rather than a generic `<@.+?>` so other-user mentions survive.
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`<@${escaped}>`, 'g'), '').replace(/\s{2,}/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Attachment extraction
// ---------------------------------------------------------------------------

/**
 * Pull `event.files` into platform-agnostic `ImAttachment[]`.
 *
 * Classification rule mirrors im-discord / im-lark:
 *
 *   1. `mimetype` starts with `image/` → image
 *   2. `mimetype` starts with `audio/` → audio
 *   3. else → file
 *
 * `url` field uses our `slack-file:` scheme so downstream code knows
 * to authenticate when resolving. `mime` / `filename` are best-effort.
 */
export function slackExtractAttachments(event: SlackMessageEvent): ImAttachment[] {
  const files = event.files
  if (!Array.isArray(files) || files.length === 0) return []
  return files
    .filter((f): f is SlackFile => !!f && typeof f.id === 'string')
    .map((f) => {
      const mime = typeof f.mimetype === 'string' ? f.mimetype : null
      let kind: 'image' | 'audio' | 'file' = 'file'
      if (mime?.startsWith('image/')) kind = 'image'
      else if (mime?.startsWith('audio/')) kind = 'audio'
      return {
        kind,
        url: slackFileUri(f.id),
        mime,
        filename: f.name ?? null,
      }
    })
}

// ---------------------------------------------------------------------------
// The main mapper
// ---------------------------------------------------------------------------

/**
 * Accepted Slack `subtype` values (besides absent). Anything else is
 * system noise we don't bridge. The list is conservative; add more
 * here only if there's a clear bridge use case.
 */
const ACCEPTED_SUBTYPES = new Set<string>(['file_share'])

export interface SlackToImMessageOptions {
  /**
   * Bot's own user id (from `auth.test` / inbound `authorizations`).
   * Used to filter our own posts AND to strip our own `<@…>` mentions.
   * Pass `null` before the bridge has resolved its id; bot-author
   * filter still works via the `bot_id` field.
   */
  botUserId: string | null
  /** Default true — strip leading `<@BOT_USER_ID>` from group replies. */
  stripBotMentions?: boolean
}

export function slackToImMessage(
  event: SlackMessageEvent,
  options: SlackToImMessageOptions,
): ImMessage | null {
  if (!event || event.type !== 'message') return null
  // Anti-loop layer 1: any bot post.
  if (event.bot_id) return null
  // Anti-loop layer 2: matches our own user id.
  if (options.botUserId && event.user === options.botUserId) return null
  // Subtype gate: absent OR explicitly accepted (file_share).
  if (event.subtype && !ACCEPTED_SUBTYPES.has(event.subtype)) return null
  // Without a user id there's no binding target.
  if (typeof event.user !== 'string' || event.user.length === 0) return null
  // chat must be addressable — Slack always sends this for messages,
  // but defend against malformed payloads.
  if (typeof event.channel !== 'string' || event.channel.length === 0) return null

  const stripBotMentions = options.stripBotMentions ?? true
  const rawText = typeof event.text === 'string' ? event.text : ''
  const text = stripBotMentions ? stripSlackBotMentions(rawText, options.botUserId) : rawText

  const attachments = slackExtractAttachments(event)

  const from: ImUser = {
    platform: 'slack',
    platformUserId: event.user,
    // displayName left null — resolving requires `users.info` per
    // inbound message which would burn rate budget. Downstream code
    // that wants pretty names can fetch on demand.
    displayName: null,
  }

  // Slack ts is "<seconds>.<6-digit>" — parse the leading seconds
  // and multiply to ms. Fall back to wallclock for un-parseable.
  const tsNum = Number.parseFloat(event.ts ?? '')
  const ts = Number.isFinite(tsNum) ? Math.floor(tsNum * 1000) : Date.now()

  return {
    from,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: event.ts,
    chatId: event.channel,
    ts,
  }
}
