export { connect } from './session.js'
export type { ConnectOptions, Session, SessionState } from './session.js'

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
