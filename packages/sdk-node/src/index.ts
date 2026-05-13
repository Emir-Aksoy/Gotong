export { connect } from './session.js'
export type { ConnectOptions, Session, SessionState } from './session.js'

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
