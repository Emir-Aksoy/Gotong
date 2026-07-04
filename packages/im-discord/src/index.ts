/**
 * @gotong/im-discord — public surface.
 */

export { DiscordBridge, type DiscordBridgeOptions } from './bridge.js'
export {
  createDiscordClient,
  DiscordApiError,
  type DiscordCallOptions,
  type DiscordClient,
  type DiscordClientOptions,
} from './client.js'
export {
  createDiscordGateway,
  type DiscordGateway,
  type DiscordGatewayOptions,
  type WebSocketCtor,
  type WebSocketLike,
} from './gateway.js'
export {
  discordExtractAttachments,
  discordToImMessage,
  stripDiscordBotMentions,
  type DiscordMessageMapOptions,
} from './message.js'
export {
  DEFAULT_DISCORD_INTENTS,
  DiscordIntent,
  DiscordOp,
  type DiscordApiErrorBody,
  type DiscordAttachment,
  type DiscordGatewayBotResponse,
  type DiscordGatewayFrame,
  type DiscordHelloData,
  type DiscordIdentifyData,
  type DiscordInvalidSessionData,
  type DiscordMessage,
  type DiscordOpCode,
  type DiscordReadyData,
  type DiscordResumeData,
  type DiscordSendMessageRequest,
  type DiscordSendMessageResponse,
  type DiscordUser,
} from './types.js'
