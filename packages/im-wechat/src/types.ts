/**
 * WeChat iLink Bot API wire types.
 *
 * Field names are copied VERBATIM from Tencent's official channel plugin
 * (`Tencent/openclaw-weixin` `src/api/types.ts`, fetched 2026-07-09) — the
 * only authoritative wire truth (there is no public spec document). We keep
 * the subset this bridge actually reads/writes plus the media item shapes
 * (needed to NAME an inbound attachment kind honestly even though media
 * download/upload is deferred — see docs/zh/WECHAT-ILINK-BRIDGE.md §五).
 *
 * JSON over HTTP; proto `bytes` fields arrive as base64 strings.
 */

/** Common request metadata attached to every CGI request (`base_info`). */
export interface WechatBaseInfo {
  /** Wire-compat level the server keys behaviour on (official plugin sends
   *  its own package version). NOT an identity claim — that's `bot_agent`. */
  channel_version?: string
  /** UA-style self-declared identity (`Name/Version`), observability only —
   *  the official types note it is "not used for authentication or routing".
   *  We honestly send `Gotong/<version>`. */
  bot_agent?: string
}

/** proto: MessageType — who authored a message. */
export const WechatMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const

/** proto: MessageItemType — payload kind inside `item_list[]`. */
export const WechatMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/** proto: MessageState — 2 (FINISH) is the only state a bot sends. */
export const WechatMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export interface WechatTextItem {
  text?: string
}

/** CDN media reference; `aes_key` is base64 bytes in JSON. Media transfer is
 *  deferred — the shapes exist so inbound parsing can classify honestly. */
export interface WechatCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface WechatImageItem {
  media?: WechatCdnMedia
  thumb_media?: WechatCdnMedia
  /** Raw AES-128 key as hex (16 bytes); preferred for inbound decryption. */
  aeskey?: string
  url?: string
}

export interface WechatVoiceItem {
  media?: WechatCdnMedia
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number
  sample_rate?: number
  /** Voice length in ms. */
  playtime?: number
  /** Server-side speech-to-text — the one media field we DO consume: it
   *  lets a voice note reach the butler as text with zero media plumbing. */
  text?: string
}

export interface WechatFileItem {
  media?: WechatCdnMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface WechatVideoItem {
  media?: WechatCdnMedia
  video_size?: number
  play_length?: number
}

export interface WechatRefMessage {
  message_item?: WechatMessageItem
  /** 摘要 */
  title?: string
}

export interface WechatMessageItem {
  type?: number
  create_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  /** Quoted message — READ-ONLY on this protocol (cannot be sent). */
  ref_msg?: WechatRefMessage
  text_item?: WechatTextItem
  image_item?: WechatImageItem
  voice_item?: WechatVoiceItem
  file_item?: WechatFileItem
  video_item?: WechatVideoItem
}

/** proto: WeixinMessage — the unified inbound/outbound message. */
export interface WechatMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  /** Sender-chosen unique id (UUID) for outbound dedup. */
  client_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WechatMessageItem[]
  /** Conversation-window token — replies MUST echo it back verbatim or the
   *  message won't associate with the right chat window. */
  context_token?: string
  run_id?: string
}

export interface WechatGetUpdatesResp {
  ret?: number
  /** Server error code — e.g. -14 = stale/expired session (see
   *  STALE_TOKEN_ERRCODE). NOTE: distinct field from `ret`. */
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  /** Cursor to cache and send on the next getupdates. */
  get_updates_buf?: string
  /** Server-suggested timeout (ms) for the next long-poll. */
  longpolling_timeout_ms?: number
}

export interface WechatSendMessageResp {
  ret?: number
  errmsg?: string
}

export interface WechatGetConfigResp {
  ret?: number
  errmsg?: string
  /** Base64 ticket required by sendtyping. */
  typing_ticket?: string
}

/** Typing status: 1 = typing (default), 2 = cancel. */
export const WechatTypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const

// ---------------------------------------------------------------------------
// QR login flow (`src/auth/login-qr.ts` in the official plugin).
// ---------------------------------------------------------------------------

/** Response of POST get_bot_qrcode. `qrcode_img_content` is a URL the user
 *  can open/scan; `qrcode` is the polling key. */
export interface WechatQrcodeResp {
  qrcode?: string
  qrcode_img_content?: string
}

/** Status machine of GET get_qrcode_status (verbatim from the official
 *  plugin's StatusResponse union). */
export type WechatQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface WechatQrStatusResp {
  status?: WechatQrStatus
  /** Present on `confirmed` — the credential everything else uses. */
  bot_token?: string
  /** Bot account id, present on `confirmed`. */
  ilink_bot_id?: string
  /** Post-login API base URL, present on `confirmed`. */
  baseurl?: string
  /** WeChat user who scanned, present on `confirmed`. */
  ilink_user_id?: string
  /** New polling host when status is `scaned_but_redirect` (IDC redirect). */
  redirect_host?: string
}
