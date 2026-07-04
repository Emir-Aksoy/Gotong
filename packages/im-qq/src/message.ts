/**
 * QQ official message event → `ImMessage` mapper, plus chatId helpers.
 *
 * Pure functions; no network. Trivially unit-testable.
 *
 * The four message event types map to four chatId namespaces:
 *
 *   GROUP_AT_MESSAGE_CREATE  →  group:<group_openid>
 *   C2C_MESSAGE_CREATE       →  c2c:<user_openid>
 *   AT_MESSAGE_CREATE        →  channel:<channel_id>   (guild channel @bot)
 *   DIRECT_MESSAGE_CREATE    →  dm:<guild_id>          (guild direct message)
 *
 * `platformUserId` prefers `union_openid` — the bot-scoped identity that
 * is stable across group AND C2C — so an IM binding made in a DM also
 * resolves when the same person @s the bot in a group. Falls back to the
 * surface-specific openid, then the raw `id`.
 */

import type { ImMessage, ImUser } from '@gotong/im-adapter'

import {
  QQ_OP_DISPATCH,
  type QqAuthor,
  type QqMessageData,
  type QqWebhookPayload,
} from './types.js'

// ---------------------------------------------------------------------------
// chatId encoding — tag the surface so reply routing is unambiguous
// ---------------------------------------------------------------------------

export type QqChatKind = 'group' | 'c2c' | 'channel' | 'dm'

/** Parse a tagged chatId back into `{ kind, id }`. Null on malformed input. */
export function parseQqChatId(chatId: unknown): { kind: QqChatKind; id: string } | null {
  if (typeof chatId !== 'string') return null
  const idx = chatId.indexOf(':')
  if (idx <= 0) return null
  const kind = chatId.slice(0, idx)
  const id = chatId.slice(idx + 1)
  if (id.length === 0) return null
  if (kind === 'group' || kind === 'c2c' || kind === 'channel' || kind === 'dm') {
    return { kind, id }
  }
  return null
}

/**
 * Pick the binding identity for an author. `union_openid` is preferred
 * (stable across group + C2C). Returns null when none is usable.
 */
export function pickQqUserId(author: QqAuthor | undefined): string | null {
  if (!author) return null
  const candidate =
    author.union_openid ?? author.member_openid ?? author.user_openid ?? author.id
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

// ---------------------------------------------------------------------------
// Guild @bot mention stripping
// ---------------------------------------------------------------------------

/**
 * Guild channel / DM message content embeds `<@!123456>` (or `<@123456>`)
 * mention tags. `parseImCommand` chokes on a leading tag, so the bridge
 * strips the bot's mention by default. Group / C2C content has no such
 * tag — the @ is consumed by the platform and only a leading space
 * remains (handled by trim in the mapper).
 */
export function stripQqGuildMention(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<@!?\d+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Timestamp normalisation
// ---------------------------------------------------------------------------

/** QQ official timestamps are ISO 8601 strings; normalise to unix ms. */
function parseQqTimestamp(ts: unknown): number {
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    if (Number.isFinite(ms)) return ms
  }
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Heuristic: values below ~1e12 are seconds, above are already ms.
    return ts > 1e12 ? ts : ts * 1000
  }
  return Date.now()
}

// ---------------------------------------------------------------------------
// The main mapper
// ---------------------------------------------------------------------------

export interface QqToImMessageOptions {
  /** Default true — strip the bot's `<@!id>` mention from guild text. */
  stripBotMentions?: boolean
}

/**
 * Map a dispatched (op:0) QQ webhook payload to an `ImMessage`. Returns
 * `null` for non-message events, unknown event types, or payloads
 * missing the fields we need (author id / surface id).
 */
export function qqToImMessage(
  payload: QqWebhookPayload,
  options: QqToImMessageOptions = {},
): ImMessage | null {
  if (!payload || payload.op !== QQ_OP_DISPATCH || typeof payload.t !== 'string') return null
  const d = payload.d as QqMessageData | undefined
  if (!d || typeof d !== 'object') return null

  const platformUserId = pickQqUserId(d.author)
  if (!platformUserId) return null

  let chatId: string
  let isGuild = false
  switch (payload.t) {
    case 'GROUP_AT_MESSAGE_CREATE':
      if (typeof d.group_openid !== 'string' || d.group_openid.length === 0) return null
      chatId = `group:${d.group_openid}`
      break
    case 'C2C_MESSAGE_CREATE': {
      // Reply target is the user_openid (the C2C send endpoint key),
      // which may differ from the union_openid we use for binding.
      const target =
        typeof d.author?.user_openid === 'string' && d.author.user_openid.length > 0
          ? d.author.user_openid
          : platformUserId
      chatId = `c2c:${target}`
      break
    }
    case 'AT_MESSAGE_CREATE':
      if (typeof d.channel_id !== 'string' || d.channel_id.length === 0) return null
      chatId = `channel:${d.channel_id}`
      isGuild = true
      break
    case 'DIRECT_MESSAGE_CREATE':
      if (typeof d.guild_id !== 'string' || d.guild_id.length === 0) return null
      chatId = `dm:${d.guild_id}`
      isGuild = true
      break
    default:
      return null
  }

  let text = typeof d.content === 'string' ? d.content : ''
  const strip = options.stripBotMentions ?? true
  // Group / C2C content carries no mention tag — only guild surfaces do.
  text = strip && isGuild ? stripQqGuildMention(text) : text.trim()

  const from: ImUser = {
    platform: 'qq',
    platformUserId,
    displayName:
      typeof d.author?.username === 'string' && d.author.username.length > 0
        ? d.author.username
        : null,
  }

  return {
    from,
    text,
    messageId: typeof d.id === 'string' && d.id.length > 0 ? d.id : undefined,
    chatId,
    ts: parseQqTimestamp(d.timestamp),
  }
}
