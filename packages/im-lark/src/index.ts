/**
 * @gotong/im-lark — public surface.
 */

export {
  LarkBridge,
  type LarkBridgeOptions,
  type LarkConnectionFactory,
  type LarkConnectionFactoryParams,
  type LarkLongConnection,
  defaultLarkConnectionFactory,
  VOICE_TRANSCRIBE_FAILED,
} from './bridge.js'
export { opusDurationMs } from './audio.js'
export {
  createLarkClient,
  LarkApiError,
  type LarkCallOptions,
  type LarkClient,
  type LarkClientOptions,
  type LarkUploadFileInput,
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
  LarkUploadFileResponse,
  LarkUserIds,
} from './types.js'
