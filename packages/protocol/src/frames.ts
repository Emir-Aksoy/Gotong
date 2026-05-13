import type {
  ChannelId,
  Message,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from '@aipehub/core'

/**
 * Wire frames for the AipeHub network protocol. See docs/PROTOCOL.md for
 * semantics, state machine, and disconnect behaviour. This module is
 * type-only at heart; the small encode/decode helpers are the only runtime.
 */

export interface AgentDecl {
  id: ParticipantId
  capabilities: string[]
}

export type RejectCode =
  | 'auth_failed'
  | 'forbidden_agent'
  | 'duplicate_id'
  | 'protocol_mismatch'
  | 'bad_hello'
  | 'internal_error'

// --- frames sent by the client (the agent process) -------------------------

export interface HelloFrame {
  type: 'HELLO'
  protocolVersion: string
  client: { name: string; version: string }
  agents: AgentDecl[]
  apiKey?: string
}

export interface ResultFrame {
  type: 'RESULT'
  result: TaskResult
}

export interface PublishFrame {
  type: 'PUBLISH'
  from: ParticipantId
  channel: ChannelId
  body: unknown
}

export interface SubscribeFrame {
  type: 'SUBSCRIBE'
  participantId: ParticipantId
  channel: ChannelId
}

export interface UnsubscribeFrame {
  type: 'UNSUBSCRIBE'
  participantId: ParticipantId
  channel: ChannelId
}

// --- frames sent by the server (the Hub process) ---------------------------

export interface WelcomeFrame {
  type: 'WELCOME'
  sessionId: string
  protocolVersion: string
  serverTime: number
  heartbeatIntervalMs: number
}

export interface RejectFrame {
  type: 'REJECT'
  code: RejectCode
  message: string
}

export interface TaskFrame {
  type: 'TASK'
  recipient: ParticipantId
  task: Task
}

export interface CancelFrame {
  type: 'CANCEL'
  recipient: ParticipantId
  taskId: TaskId
  reason: string
}

export interface MessageFrame {
  type: 'MESSAGE'
  recipient: ParticipantId
  msg: Message
}

export interface ErrorFrame {
  type: 'ERROR'
  code: string
  message: string
  context?: unknown
}

// --- frames either side may send -------------------------------------------

export interface PingFrame {
  type: 'PING'
  ts: number
}

export interface PongFrame {
  type: 'PONG'
  ts: number
}

export interface GoodbyeFrame {
  type: 'GOODBYE'
  reason?: string
}

// --- unions ----------------------------------------------------------------

export type ClientFrame =
  | HelloFrame
  | ResultFrame
  | PublishFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | PingFrame
  | PongFrame
  | GoodbyeFrame

export type ServerFrame =
  | WelcomeFrame
  | RejectFrame
  | TaskFrame
  | CancelFrame
  | MessageFrame
  | ErrorFrame
  | PingFrame
  | PongFrame
  | GoodbyeFrame

export type Frame = ClientFrame | ServerFrame
