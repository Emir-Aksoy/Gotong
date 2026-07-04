import type {
  ChannelId,
  Message,
  ParticipantId,
  Task,
  TaskId,
  TaskResult,
} from './types.js'

// =============================================================================
// Service RPC (protocol v1.1, additive on top of v1.0)
// =============================================================================
//
// These types describe SERVICE_CALL / SERVICE_RESULT frames that let remote
// agents drive Hub Services (memory / artifact / datastore) over the same
// WebSocket they already use for tasks. Design: docs/services-over-ws-rfc.md.
//
// IMPORTANT: `OwnerKind` and `ServiceType` are intentionally string-typed
// aliases that mirror `@gotong/services-sdk`'s own `OwnerKind` and the
// plugin-contract `type` field. `@gotong/protocol` deliberately does NOT
// depend on `@gotong/services-sdk` — the wire protocol stays decoupled from
// the implementation layer. If `services-sdk` adds a new OwnerKind, update
// this file too (and verify all routers / SDKs are aware).

/**
 * Mirror of `@gotong/services-sdk` `OwnerKind`. Keep in sync.
 */
export type OwnerKind = 'agent' | 'workflow-run' | 'shared'

/**
 * Free-form service type string. First-party types are `'memory'`,
 * `'artifact'`, `'datastore'`. Third-party plugins may introduce new
 * strings — the protocol doesn't gate the namespace.
 */
export type ServiceType = string

/**
 * Concrete owner addressing one service-handle owner. Same shape as
 * services-sdk's `Owner`. Used in SERVICE_CALL.service.owner and the
 * resolved-owner form of `ServiceUseDecl`.
 */
export interface ServiceOwner {
  kind: OwnerKind
  id: string
}

/**
 * ACL pattern declared in HELLO.services. Allows wildcard `id: '*'` and
 * the special literal `id: 'self'` (substituted server-side to the calling
 * agent's id). See RFC §3.2.
 */
export interface ServiceOwnerPattern {
  kind: OwnerKind
  /**
   * Concrete id, the literal `'self'` (agents only), or `'*'` (matches any
   * concrete id of this kind).
   */
  id: string
}

/**
 * One entry in HELLO.services — declares one `(type, impl, ownerPattern)`
 * triple this connection is allowed to call. The `config` is plugin-defined
 * and forwarded verbatim to `ServicePlugin.validateConfig` at first attach.
 *
 * Multiple decls for the same `(type, impl)` are OR'd at ACL check time.
 *
 * `methods` (v1.2 optional) narrows the set of wire methods this connection
 * may call. When omitted, the connection inherits the full method allowlist
 * for the service type (`BUILTIN_SERVICE_METHODS` + any third-party
 * registrations). When present, **only** the listed names are dispatched;
 * everything else returns `forbidden_method`. Use this to declare "I only
 * intend to read, never write" or "I only need pages.read, not pages.create".
 *
 * The admin reviewing the application sees the requested subset and can
 * decide whether the agent's scope is sane before approving.
 */
export interface ServiceUseDecl {
  type: ServiceType
  impl: string
  owner: ServiceOwnerPattern
  /** Plugin-defined config blob. Validated by the plugin at first attach. */
  config?: unknown
  /**
   * Optional per-method ACL. When set, restricts this connection to a
   * subset of the type's allowlisted methods. Names follow the
   * `'method'` or `'namespace.method'` form (max one dot, same as the
   * type-level allowlist).
   */
  methods?: readonly string[]
}

/**
 * `service` field of a SERVICE_CALL — identifies *which* service handle to
 * route the call to. Concrete owner only (no patterns; no 'self' substitution
 * happens client-side, server resolves 'self' to the calling agent's id).
 */
export interface ServiceSelector {
  type: ServiceType
  impl: string
  owner: ServiceOwner
}

/**
 * Result-error codes that may appear in `SERVICE_RESULT { ok: false }`. See
 * RFC §3.4 + §4.2 for semantics. Clients SHOULD treat unknown codes as a
 * generic failure (do not assume the set is closed).
 */
export type ServiceErrorCode =
  | 'forbidden_service'   // (type, impl) not in HELLO.services
  | 'forbidden_method'    // method not in the decl's per-method allowlist (v1.2)
  | 'forbidden_owner'     // owner doesn't match any declared pattern
  | 'attach_failed'       // plugin.attach threw at lazy-attach time
  | 'service_error'       // method threw (quota, IO, validation)
  | 'unknown_method'      // method not in the serviceMethodAllowlist
  | 'bad_args'            // call.args malformed (count / types)
  | 'unknown_agent'       // call.from not owned by this connection
  | 'session_not_ready'   // call arrived before WELCOME or after teardown
  | 'unknown_service'     // (type, impl) has no registered plugin host-side
  | 'internal_error'      // server-side bug

/**
 * SERVICE_CALL — client → server. Invokes one method on a service handle.
 * `args` is positional in the order the underlying plugin contract specifies
 * (e.g. `MemoryHandle.recall(query)` → `args: [{ k: 5 }]`).
 */
export interface ServiceCallFrame {
  type: 'SERVICE_CALL'
  /** Caller-chosen unique id. The matching SERVICE_RESULT echoes it. */
  callId: string
  /** Which of this connection's agents is making the call. */
  from: ParticipantId
  service: ServiceSelector
  /**
   * Method name. Dotted paths (e.g. `'sql.exec'`) descend into nested
   * namespaces on a handle (`DatastoreHandle.sql.exec`). The server's
   * `serviceMethodAllowlist` bounds the legal set per `service.type`.
   */
  method: string
  args: readonly unknown[]
}

/**
 * SERVICE_RESULT — server → client. Discriminated on `ok`.
 */
export type ServiceResultFrame =
  | {
      type: 'SERVICE_RESULT'
      callId: string
      ok: true
      /** JSON-serialised return value of the handle method. */
      value: unknown
    }
  | {
      type: 'SERVICE_RESULT'
      callId: string
      ok: false
      error: {
        code: ServiceErrorCode
        message: string
        /** Free-form context — typically the call args echo, plugin hint, etc. */
        context?: unknown
      }
    }


/**
 * Wire frames for the Gotong network protocol. See docs/PROTOCOL.md for
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
  /**
   * NEW in protocol v1.1. Optional. Declares which Hub Services this
   * connection is allowed to call via SERVICE_CALL frames. See
   * `docs/services-over-ws-rfc.md` §3 for ACL semantics and §6 for
   * lifecycle.
   *
   * v1.0 servers ignore unknown fields (per protocol's forward-compat
   * rule); v1.0 clients omit this field entirely.
   */
  services?: ServiceUseDecl[]
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
  | ServiceCallFrame          // protocol v1.1+

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
  | ServiceResultFrame        // protocol v1.1+

export type Frame = ClientFrame | ServerFrame
