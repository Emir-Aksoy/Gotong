/**
 * @aipehub/im-qq — public surface.
 *
 * EXPERIMENTAL — third-party OneBot v11 protocol; account-suspension
 * risk. See README + `QQ_RISK_ACK_ENV` in bridge.ts.
 */

export { QqBridge, type QqBridgeOptions, QQ_RISK_ACK_ENV } from './bridge.js'
export {
  createOneBotClient,
  OneBotApiError,
  type OneBotClient,
  type OneBotClientOptions,
  type WebSocketCtor,
  type WebSocketLike,
} from './client.js'
export {
  buildQqTextMessage,
  encodeQqChatId,
  oneBotToImMessage,
  parseQqChatId,
  qqExtractAttachments,
  qqSegmentsToText,
  stripQqBotMentions,
  type QqToImMessageOptions,
} from './message.js'
export type {
  OneBotActionRequest,
  OneBotActionResponse,
  OneBotEvent,
  OneBotMessageEvent,
  OneBotMessageSegment,
  OneBotMetaEvent,
  OneBotNoticeEvent,
  OneBotRequestEvent,
  OneBotSender,
  OneBotSendMsgData,
  OneBotSendMsgParams,
} from './types.js'
