/**
 * @aipehub/im-qq — public surface.
 *
 * Official QQ Bot API (https://bot.q.qq.com) over HTTP webhook. Replaces
 * the former third-party OneBot v11 implementation. See README for the
 * webhook deployment model + the passive-reply limitation.
 */

export { QqBridge, type QqBridgeOptions, type QqHandleResult } from './bridge.js'
export {
  createQqClient,
  QqApiError,
  type QqClient,
  type QqClientOptions,
} from './client.js'
export {
  parseQqChatId,
  pickQqUserId,
  qqToImMessage,
  stripQqGuildMention,
  type QqChatKind,
  type QqToImMessageOptions,
} from './message.js'
export {
  deriveQqKeyPair,
  deriveQqSeed,
  signQqCallback,
  verifyQqEventSignature,
  type QqKeyPair,
} from './qq-crypto.js'
export {
  QQ_MSG_TYPE_TEXT,
  QQ_OP_DISPATCH,
  QQ_OP_VALIDATION,
  type QqApiErrorBody,
  type QqAppAccessTokenResponse,
  type QqAuthor,
  type QqMessageData,
  type QqMessageEventType,
  type QqPassiveReplyBody,
  type QqSendResult,
  type QqValidationData,
  type QqWebhookPayload,
} from './types.js'
