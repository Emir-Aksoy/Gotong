export {
  serveWebSocket,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_CONNECTIONS,
} from './server.js'
export type {
  WebSocketTransportOptions,
  WebSocketTransportHandle,
  AuthenticateResult,
} from './server.js'
export { RemoteAgentParticipant } from './remote-participant.js'
export type { SessionInfo } from './session.js'

export {
  connectHubLink,
  acceptHubLinks,
  MESH_PROTOCOL_VERSION,
} from './hub-link.js'
export type {
  MeshFrame,
  MeshConnection,
  WebSocketHubLinkOptions,
  ConnectHubLinkOptions,
  AcceptHubLinksOptions,
} from './hub-link.js'

export { bearerAuth } from './peer-auth.js'
export type {
  PeerAuthScheme,
  PeerAuthEnvelope,
  PeerAuthVerdict,
  BearerAuthOptions,
} from './peer-auth.js'
