/**
 * @gotong/im-matrix — public surface.
 */

export { MatrixBridge, type MatrixBridgeOptions } from './bridge.js'
export {
  createMatrixClient,
  MatrixApiError,
  type MatrixCallOptions,
  type MatrixClient,
  type MatrixClientOptions,
} from './client.js'
export {
  matrixExtractAttachments,
  matrixToImMessage,
  parseMxcUri,
  MXC_URI_PREFIX,
} from './message.js'
export type {
  MatrixErrorBody,
  MatrixInvitedRoom,
  MatrixJoinedRoom,
  MatrixMessageContent,
  MatrixRoomEvent,
  MatrixSyncResponse,
  MatrixWhoamiResponse,
} from './types.js'
