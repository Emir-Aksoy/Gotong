/**
 * @aipehub/im-slack — public surface.
 */

export {
  SlackBridge,
  type SlackBridgeOptions,
  type SlackSocketFactory,
  type SlackSocketFactoryParams,
  defaultSlackSocketFactory,
} from './bridge.js'
export {
  createSlackSocketMode,
  type SlackSocketMode,
  type SlackSocketModeOptions,
  type WebSocketCtor,
  type WebSocketLike,
} from './socket-mode.js'
export {
  createSlackClient,
  SlackApiError,
  type SlackCallOptions,
  type SlackClient,
  type SlackClientOptions,
} from './client.js'
export {
  parseSlackFileUri,
  slackExtractAttachments,
  slackFileUri,
  slackToImMessage,
  stripSlackBotMentions,
  SLACK_FILE_URI_PREFIX,
  type SlackToImMessageOptions,
} from './message.js'
export type {
  SlackApiResponse,
  SlackAuthorization,
  SlackConnectionsOpenResponse,
  SlackEventCallback,
  SlackFile,
  SlackMessageEvent,
  SlackPostMessageRequest,
  SlackPostMessageResponse,
  SlackSocketEnvelope,
} from './types.js'
