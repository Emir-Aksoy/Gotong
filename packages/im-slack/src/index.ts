/**
 * @aipehub/im-slack — public surface.
 */

export { SlackBridge, type SlackBridgeOptions, type SlackHandleResult } from './bridge.js'
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
  verifySlackSignature,
  SLACK_FILE_URI_PREFIX,
  type SlackToImMessageOptions,
} from './message.js'
export type {
  SlackApiResponse,
  SlackAuthorization,
  SlackEventCallback,
  SlackFile,
  SlackMessageEvent,
  SlackPostMessageRequest,
  SlackPostMessageResponse,
  SlackSignatureVerifyResult,
  SlackUrlVerification,
} from './types.js'
