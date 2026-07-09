/**
 * WeChat iLink message → `ImMessage` mapper. Pure functions, fixture-testable.
 *
 * Two protocol facts shape this file:
 *
 *   1. `message_type: 2` marks BOT-authored messages. getupdates replays the
 *      bot's own sends (and streams partial `message_state` frames), so the
 *      echo filter is load-bearing — without it every reply loops back in.
 *   2. `context_token` is the conversation-window pass: a reply must echo it
 *      verbatim. It rides the inbound message, NOT any config, so the bridge
 *      must remember the latest token per peer. This module just extracts it;
 *      the ledger lives in the bridge (M2).
 */

import type { ImAttachment, ImMessage, ImUser } from '@gotong/im-adapter'

import { WechatMessageItemType, WechatMessageState, WechatMessageType } from './types.js'
import type { WechatMessage, WechatMessageItem } from './types.js'

/**
 * Placeholder URI for inbound media we deliberately don't download (media
 * transfer is deferred — AES-128-ECB + CDN, see plan doc §五). Mirrors the
 * `telegram-file:` private-scheme idea: it names the thing honestly without
 * promising bytes. Voice notes still arrive as TEXT via the server-side
 * transcript, so the butler stays conversational with zero media plumbing.
 */
export const WECHAT_MEDIA_URI_PREFIX = 'wechat-media:'

/** Extract text from one item: TEXT items verbatim; VOICE items fall back to
 *  the server-side speech-to-text (may be absent → null). */
function itemText(item: WechatMessageItem): string | null {
  if (item.type === WechatMessageItemType.TEXT) return item.text_item?.text ?? null
  if (item.type === WechatMessageItemType.VOICE) return item.voice_item?.text ?? null
  return null
}

/** Map a media item to an honest attachment stub (no bytes — see prefix doc). */
function itemAttachment(item: WechatMessageItem): ImAttachment | null {
  switch (item.type) {
    case WechatMessageItemType.IMAGE:
      return { kind: 'image', url: `${WECHAT_MEDIA_URI_PREFIX}image:${item.msg_id ?? ''}`, mime: null, filename: null }
    case WechatMessageItemType.VIDEO:
      return { kind: 'file', url: `${WECHAT_MEDIA_URI_PREFIX}video:${item.msg_id ?? ''}`, mime: null, filename: null }
    case WechatMessageItemType.FILE:
      return {
        kind: 'file',
        url: `${WECHAT_MEDIA_URI_PREFIX}file:${item.msg_id ?? ''}`,
        mime: null,
        filename: item.file_item?.file_name ?? null,
      }
    default:
      return null
  }
}

/**
 * Convert one iLink message to the platform-agnostic `ImMessage`.
 * Returns `null` for messages the bridge must not route:
 *
 *   - bot-authored (`message_type: 2`) — our own sends echoed back;
 *   - unfinished (`message_state !== FINISH`) — the server streams partial
 *     frames while a message is GENERATING; only the final frame counts;
 *   - no sender id — nothing to bind to;
 *   - no consumable content (no text, no transcript, no known media kind).
 *
 * Voice notes become text via the server transcript (kind stays honest: the
 * text IS what the user said, per WeChat's own transcription).
 */
export function wechatToImMessage(msg: WechatMessage): ImMessage | null {
  if (msg.message_type === WechatMessageType.BOT) return null
  if (msg.message_state !== undefined && msg.message_state !== WechatMessageState.FINISH) return null
  const senderId = msg.from_user_id?.trim()
  if (!senderId) return null

  const texts: string[] = []
  const attachments: ImAttachment[] = []
  for (const item of msg.item_list ?? []) {
    const t = itemText(item)
    if (t !== null && t.length > 0) texts.push(t)
    const a = itemAttachment(item)
    if (a) attachments.push(a)
  }
  if (texts.length === 0 && attachments.length === 0) return null

  const from: ImUser = {
    platform: 'wechat',
    platformUserId: senderId,
    displayName: null, // iLink carries no profile name on the wire
  }
  return {
    from,
    text: texts.join('\n'),
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: msg.message_id !== undefined ? String(msg.message_id) : undefined,
    // Group chat isn't open on this protocol yet; when a group_id ever
    // appears we surface it as the chat, else the DM peer is the chat.
    chatId: msg.group_id?.trim() || senderId,
    ts: msg.create_time_ms,
  }
}

/** Pull the conversation-window token off an inbound message (bridge keeps
 *  the per-peer ledger; replies must echo this verbatim). */
export function wechatContextToken(msg: WechatMessage): string | null {
  const t = msg.context_token?.trim()
  return t && t.length > 0 ? t : null
}
