/**
 * @aipehub/im-lark — public surface.
 */

export { LarkBridge, type LarkBridgeOptions } from './bridge.js'
export {
  createLarkClient,
  LarkApiError,
  type LarkCallOptions,
  type LarkClient,
  type LarkClientOptions,
} from './client.js'
export {
  larkContentToText,
  larkExtractAttachments,
  larkToImMessage,
  larkUri,
  parseLarkContent,
  parseLarkUri,
  pickLarkReceiveIdType,
  stripLarkMentions,
  LARK_URI_PREFIXES,
  type LarkUriKind,
} from './message.js'
export type {
  LarkAccessTokenResponse,
  LarkApiErrorBody,
  LarkAudioContent,
  LarkEventEnvelope,
  LarkEventHeader,
  LarkFileContent,
  LarkImageContent,
  LarkMention,
  LarkMessage,
  LarkMessageReceiveEvent,
  LarkPostContent,
  LarkSender,
  LarkSendMessageRequest,
  LarkSendMessageResponse,
  LarkStickerContent,
  LarkTextContent,
  LarkUrlVerification,
  LarkUserIds,
} from './types.js'
