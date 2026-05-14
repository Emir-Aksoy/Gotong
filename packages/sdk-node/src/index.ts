export { connect } from './session.js'
export type { ConnectOptions, Session, SessionState } from './session.js'

// Hub Services over WebSocket (protocol v1.1). The ServiceClient surface
// mirrors `@aipehub/services-sdk`'s in-process `ServiceCtx` so agent code
// reads identically across deployment shapes.
export {
  ServiceCallError,
  type ServiceClient,
  type ServiceUseRequest,
} from './service-client.js'

// Federation: wrap a local Hub as an agent on an upstream Hub.
export { TeamBridgeAgent } from './bridge.js'
export type { TeamBridgeOptions, LocalDispatchPlan } from './bridge.js'

// re-export the base class so SDK users have a single import surface
export { AgentParticipant } from '@aipehub/core'
export type { AgentOptions } from '@aipehub/core'

// useful types
export type {
  ChannelId,
  Message,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '@aipehub/core'
