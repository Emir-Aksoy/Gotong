/**
 * Telegram Bot API shapes — a hand-rolled subset of the official spec.
 *
 * Why hand-rolled rather than `node-telegram-bot-api` / `telegraf`:
 *
 *   - We only need ~5 of the ~80 Bot API methods. The wrapper
 *     libraries pull in tens of MB of polyfills + transitive deps to
 *     ship the full surface.
 *   - We want to drive the API with the platform `fetch` so the bridge
 *     stays bundle-ready for `bun --compile`.
 *   - Type-safety matters here. The wrappers ship `any`-heavy types
 *     for legacy compatibility; we type only what we use and any new
 *     field that appears in a payload gracefully surfaces as `unknown`.
 *
 * Reference: https://core.telegram.org/bots/api (verified 2026-05).
 */

/**
 * A single update returned by `getUpdates`. We only consume `message`
 * for M2; future milestones may add `callback_query` (for inline
 * buttons) etc.
 */
export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  /**
   * Other variants (edited_message / channel_post / callback_query /
   * inline_query …) deliberately omitted from the typed surface so
   * code paths that touch them stand out as cast.
   */
}

export interface TelegramMessage {
  message_id: number
  /** Unix seconds. We multiply by 1000 to map into ImMessage.ts (ms). */
  date: number
  chat: TelegramChat
  /** May be absent for channel posts. Bridge skips those. */
  from?: TelegramUser
  /** Plain-text body of a text message. */
  text?: string
  /** Caption that accompanies a photo / video / document. */
  caption?: string
  /** Sized variants; the largest is typically the "original". */
  photo?: TelegramPhotoSize[]
  /** Voice notes — typed as audio in the ImAttachment world. */
  voice?: TelegramVoice
  /** Generic audio (uploaded music etc). */
  audio?: TelegramAudio
  /** Anything else uploaded: PDFs, zips, code, … */
  document?: TelegramDocument
  /** Reply-to context — not currently consumed, but typed for future. */
  reply_to_message?: TelegramMessage
}

export interface TelegramChat {
  id: number
  /** 'private' | 'group' | 'supergroup' | 'channel' */
  type: string
  title?: string
  username?: string
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramVoice {
  file_id: string
  file_unique_id: string
  duration: number
  mime_type?: string
  file_size?: number
}

export interface TelegramAudio {
  file_id: string
  file_unique_id: string
  duration: number
  mime_type?: string
  file_size?: number
  performer?: string
  title?: string
  file_name?: string
}

export interface TelegramDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
  thumbnail?: TelegramPhotoSize
}

/**
 * Response wrapper for every Bot API call. The Bot API uses `ok: false`
 * for business-logic failures (rate-limited, bad token, chat not
 * found, …) rather than non-2xx HTTP statuses, so we MUST inspect
 * `ok` even on a 200 response.
 */
export interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  /** Human-readable description on `ok: false`. */
  description?: string
  /** Numeric error code on `ok: false`. 401 / 403 / 429 etc. */
  error_code?: number
  /** On 429, advisory "retry in N seconds." */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}
