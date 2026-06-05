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
 *
 * Public surface is filled in progressively across milestones M1–M5:
 *   - acp-protocol.ts   (M1) — JSON-RPC + ACP wire types
 *   - acp-connection.ts (M2) — NDJSON framing + request correlation
 *   - acp-session.ts    (M3) — long-lived process engine
 *   - acp-checkpoint.ts (M4) — permission gate primitives (fail-closed)
 *   - acp-participant.ts(M5) — the AcpParticipant adapter (five seams)
 */

export {}
