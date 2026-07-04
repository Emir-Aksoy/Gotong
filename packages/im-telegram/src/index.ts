/**
 * @gotong/im-telegram — public surface.
 */

export { TelegramBridge, type TelegramBridgeOptions } from './bridge.js'
export {
  createTelegramClient,
  TelegramApiError,
  type TelegramClient,
  type TelegramClientOptions,
} from './client.js'
export {
  telegramFileUri,
  parseTelegramFileUri,
  telegramDisplayName,
  telegramExtractAttachments,
  telegramToImMessage,
  TELEGRAM_FILE_URI_PREFIX,
} from './message.js'
export type {
  TelegramApiResponse,
  TelegramAudio,
  TelegramChat,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice,
} from './types.js'
