/**
 * OneBot v11 event → `ImMessage` mapper, plus segment helpers.
 *
 * Pure functions; no network. Trivially unit-testable.
 *
 * Skip rules — `oneBotToImMessage` returns `null` for any of:
 *
 *   1. `post_type !== 'message'` — meta_event / notice / request are
 *      out of scope.
 *   2. `user_id === self_id` — anti-loop: don't bridge our own posts
 *      back into the Hub.
 *   3. `user_id` is non-numeric — adapter shouldn't emit this but
 *      defend defensively.
 *
 * Why displayName is best-effort:
 *
 *   OneBot adapters expose `sender.nickname` and `sender.card`
 *   (group nickname). Both can be stale or absent (anonymous group
 *   posts, friend who hasn't set a nick). Bridge prefers `card` →
 *   `nickname` and falls back to `null`.
 */

import type { ImAttachment, ImMessage, ImUser } from '@aipehub/im-adapter'

import type { OneBotMessageEvent, OneBotMessageSegment } from './types.js'

// ---------------------------------------------------------------------------
// chatId encoding — combine message_type + id into one stable string
// ---------------------------------------------------------------------------

/**
 * QQ's group_id and user_id namespaces overlap as raw integers, so
 * `ImMessage.chatId` would be ambiguous if we stored just the number.
 * Bridge encodes a tagged string:
 *
 *   `private:<user_id>`  — DM with that QQ number
 *   `group:<group_id>`   — group chat
 *
 * sendMessage parses this back to drive the correct
 * `message_type` + id field on `send_msg`.
 */
export function encodeQqChatId(input: {
  message_type: 'private' | 'group'
  user_id?: number
  group_id?: number
}): string {
  if (input.message_type === 'group') {
    if (typeof input.group_id !== 'number') {
      throw new Error('encodeQqChatId: group_id required for message_type=group')
    }
    return `group:${input.group_id}`
  }
  if (typeof input.user_id !== 'number') {
    throw new Error('encodeQqChatId: user_id required for message_type=private')
  }
  return `private:${input.user_id}`
}

/** Parse the tagged chatId back. Returns `null` on malformed input. */
export function parseQqChatId(
  chatId: unknown,
): { message_type: 'private' | 'group'; id: number } | null {
  if (typeof chatId !== 'string') return null
  const idx = chatId.indexOf(':')
  if (idx <= 0) return null
  const kind = chatId.slice(0, idx)
  const numStr = chatId.slice(idx + 1)
  const num = Number(numStr)
  if (!Number.isFinite(num) || num <= 0) return null
  if (kind === 'private' || kind === 'group') {
    return { message_type: kind, id: num }
  }
  return null
}

// ---------------------------------------------------------------------------
// Bot-at-mention stripping
// ---------------------------------------------------------------------------

/**
 * Group messages addressed to the bot interpolate an `at` segment
 * (`{type:'at', data:{qq: <BOT_QQ>}}`) at the head of the array
 * form, or `[CQ:at,qq=<BOT_QQ>]` in the legacy string form.
 *
 * `parseImCommand` chokes on a leading `[CQ:…]` token, so bridges
 * strip the bot's own mention by default.
 *
 * For array form: drop matching `at` segments. For string form:
 * regex-strip the matching `[CQ:at,qq=<id>]` (and `[CQ:at,qq=<id>,...]`
 * with additional attrs).
 */
export function stripQqBotMentions(
  message: string | OneBotMessageSegment[],
  selfId: number | null,
): string | OneBotMessageSegment[] {
  if (selfId === null) return message
  const target = String(selfId)
  if (Array.isArray(message)) {
    return message.filter((seg) => {
      if (seg.type !== 'at') return true
      const qq = (seg.data as { qq?: string | number }).qq
      return String(qq) !== target
    })
  }
  if (typeof message !== 'string') return message
  // The CQ-code regex: `[CQ:at,qq=<id>]` with optional more attrs.
  // We escape only the digits to keep this anchored on the exact id.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return message
    .replace(new RegExp(`\\[CQ:at,qq=${escaped}(?:,[^\\]]*)?\\]`, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Flatten segments → plain text body
// ---------------------------------------------------------------------------

/**
 * Reduce the message body to a plain string suitable for
 * `parseImCommand`. Non-text segments are dropped from the text
 * stream — they surface separately as `ImMessage.attachments`.
 *
 * For string form (legacy CQ): we pass through verbatim. The CQ
 * markup is human-readable enough that downstream LLM agents can
 * still infer intent — and stripping it requires a parser we don't
 * have in M7. If the adapter is left on default CQ mode the user
 * experience is suboptimal but the bridge still works.
 */
export function qqSegmentsToText(message: string | OneBotMessageSegment[]): string {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .filter((seg): seg is { type: 'text'; data: { text: string } } => seg?.type === 'text')
    .map((seg) => seg.data.text ?? '')
    .join('')
    .trim()
}

// ---------------------------------------------------------------------------
// Attachment extraction
// ---------------------------------------------------------------------------

/**
 * Pull `image` / `record` / `file` segments into platform-agnostic
 * `ImAttachment[]`. URL fields:
 *
 *   - `data.url`: HTTPS to QQ's CDN. Public — no auth header.
 *     Bridge passes through, similar to Discord.
 *   - `data.file`: adapter-cached filename. We DO NOT use this as
 *     the URL — local file paths leak the adapter's filesystem and
 *     downstream LLMs can't fetch them anyway.
 *
 * A segment with only `file` (no `url`) is skipped — the attachment
 * lives on the adapter's local disk and there's no remote-resolution
 * story in M7.
 *
 * For string-form messages, we don't currently parse `[CQ:image,...]`
 * out — see `qqSegmentsToText` note. Adapters running modern
 * `message_format: 'array'` emit the structured form and this works.
 */
export function qqExtractAttachments(message: string | OneBotMessageSegment[]): ImAttachment[] {
  if (!Array.isArray(message)) return []
  const out: ImAttachment[] = []
  for (const seg of message) {
    if (!seg || typeof seg.type !== 'string') continue
    let kind: 'image' | 'audio' | 'file' | null = null
    let mime: string | null = null
    if (seg.type === 'image') {
      kind = 'image'
      mime = null // OneBot doesn't surface MIME; consumer can sniff
    } else if (seg.type === 'record') {
      kind = 'audio'
      // QQ voice notes are SILK-encoded; expose as audio/silk so
      // consumers can route via decoders that handle that codec.
      mime = 'audio/silk'
    } else if (seg.type === 'file') {
      kind = 'file'
      mime = null
    } else {
      continue
    }
    const data = seg.data as { url?: unknown; file?: unknown; name?: unknown }
    const url = typeof data.url === 'string' ? data.url : null
    if (!url) continue // skip local-only attachments
    out.push({
      kind,
      url,
      mime,
      filename:
        typeof (data as { name?: unknown }).name === 'string'
          ? ((data as { name?: string }).name ?? null)
          : typeof data.file === 'string'
            ? (data.file ?? null)
            : null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The main mapper
// ---------------------------------------------------------------------------

export interface QqToImMessageOptions {
  /**
   * Bot's own QQ number (the OneBot adapter's `self_id`). Used for
   * anti-loop AND for stripping `[CQ:at,qq=<self>]`. Pass `null`
   * when not yet known — anti-loop falls back to checking `self_id`
   * equality, which is on every event.
   */
  selfId: number | null
  /** Default true — strip leading @bot mention from the text body. */
  stripBotMentions?: boolean
}

export function oneBotToImMessage(
  event: OneBotMessageEvent,
  options: QqToImMessageOptions,
): ImMessage | null {
  if (!event || event.post_type !== 'message') return null
  if (typeof event.user_id !== 'number' || !Number.isFinite(event.user_id) || event.user_id <= 0) {
    return null
  }
  // Anti-loop: don't bridge our own posts. We prefer the event's
  // self_id (always set) over the opts.selfId (may not yet be
  // captured) so we are safe even on the very first event.
  if (event.user_id === event.self_id) return null
  if (options.selfId !== null && event.user_id === options.selfId) return null

  const selfId = options.selfId ?? event.self_id
  const stripBotMentions = options.stripBotMentions ?? true
  const stripped = stripBotMentions ? stripQqBotMentions(event.message, selfId) : event.message
  const text = qqSegmentsToText(stripped)
  const attachments = qqExtractAttachments(event.message)

  // Group nick (card) → friend nick → null.
  const displayName =
    (typeof event.sender?.card === 'string' && event.sender.card.length > 0
      ? event.sender.card
      : null) ??
    (typeof event.sender?.nickname === 'string' && event.sender.nickname.length > 0
      ? event.sender.nickname
      : null) ??
    null

  const from: ImUser = {
    platform: 'qq',
    platformUserId: String(event.user_id),
    displayName,
  }

  const chatId = encodeQqChatId({
    message_type: event.message_type,
    user_id: event.user_id,
    group_id: event.group_id,
  })

  // OneBot `time` is unix seconds; convert to ms. Some adapters
  // emit 0 when they don't have a real time — fall back to wallclock.
  const tsSec = Number(event.time)
  const ts = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now()

  return {
    from,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: String(event.message_id),
    chatId,
    ts,
  }
}

// ---------------------------------------------------------------------------
// Outbound — build send_msg segments from a plain text body
// ---------------------------------------------------------------------------

/**
 * Convert a plain string into the array-form payload `send_msg`
 * expects. Single text segment — caller can layer in `[at, text]`
 * if they want to ping someone, but the bridge currently sends
 * plain text only.
 */
export function buildQqTextMessage(text: string): OneBotMessageSegment[] {
  return [{ type: 'text', data: { text } }]
}
