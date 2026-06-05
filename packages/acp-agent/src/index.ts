/**
 * `@aipehub/acp-agent` — outbound ACP (Agent Client Protocol) adapter.
 *
 * The OpenClaw-style COMPLEMENT to the one-shot `@aipehub/cli-agent`. Where
 * cli-agent does `spawn('claude', ['-p', prompt])` and the process exits per
 * task with no preserved context, acp-agent spawns the agent subprocess ONCE,
 * does the ACP handshake, holds the session OPEN, and dispatches many tasks to
 * the SAME session over JSON-RPC-over-NDJSON — context preserved between tasks.
 * That long-lived-session ownership ("from startup → hold session → dispatch")
 * is the whole point.
 *
 * Built to the AGENT-ADAPTER-CONTRACT five-seam bar (observe / intercept /
 * handoff / resume / terminate), reaching Tier 2 via ACP's natural per-action
 * `session/request_permission` intercept point.
 */

// M1 — JSON-RPC + ACP wire types, builders, guards
export * from './acp-protocol.js'
// M2 — NDJSON framing + request correlation (the only module that touches framing)
export {
  AcpConnection,
  AcpConnectionError,
  type AcpTransport,
  type AcpRequestOptions,
  type AcpRequestHandler,
  type AcpNotifyHandler,
  type AcpCloseHandler,
} from './acp-connection.js'
// M3 — long-lived process engine (spawn once, hold the session, dispatch many)
export {
  AcpSession,
  type AcpSpawnOptions,
  type AcpPromptOptions,
  type AcpPromptOutcome,
  type AcpPendingPermission,
  type AcpPermissionVerdict,
  type AcpPermissionHandler,
  type AcpUpdateHandler,
} from './acp-session.js'
// M4 — permission gate primitives (fail-closed)
export * from './acp-checkpoint.js'
// M5 — the AcpParticipant adapter (five seams)
export { AcpParticipant, payloadToText, type AcpParticipantOptions, type AcpChunk } from './acp-participant.js'
