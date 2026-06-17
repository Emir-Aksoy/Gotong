/**
 * @aipehub/im-lark — public surface.
 */

export {
  LarkBridge,
  type LarkBridgeOptions,
  type LarkConnectionFactory,
  type LarkConnectionFactoryParams,
  type LarkLongConnection,
  defaultLarkConnectionFactory,
} from './bridge.js'
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
  LarkUserIds,
} from './types.js'
