export { connect } from './session.js'
export type { ConnectOptions, Session, SessionState } from './session.js'

// Hub Services over WebSocket (protocol v1.1). The ServiceClient surface
// mirrors `@gotong/services-sdk`'s in-process `ServiceCtx` so agent code
// reads identically across deployment shapes.
export {
  ServiceCallError,
  type CustomServiceHandle,
  type ServiceClient,
  type ServiceUseRequest,
} from './service-client.js'

// Federation: wrap a local Hub as an agent on an upstream Hub.
export { TeamBridgeAgent } from './bridge.js'
export type { TeamBridgeOptions, LocalDispatchPlan } from './bridge.js'

// re-export the base class so SDK users have a single import surface
export { AgentParticipant } from '@gotong/core'
export type { AgentOptions } from '@gotong/core'

// useful types
export type {
  ChannelId,
  Message,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '@gotong/core'
