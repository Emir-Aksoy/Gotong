/**
 * `@gotong/cli-agent` — outbound CLI shell-out adapter.
 *
 * Wraps a self-hosted coding-agent CLI (Claude Code / Codex / OpenCode / Aider …)
 * as a hub `Participant` so the hub can DRIVE it (the mirror of `gotong connect`,
 * where the CLI calls the hub inbound). Built to the AGENT-ADAPTER-CONTRACT
 * five-seam bar (observe / intercept / handoff / resume / terminate).
 *
 * Public surface:
 *   - `runCliCommand` — the bounded spawn engine (stdin + live stream + abort)
 *   - `CliParticipant` — the adapter: a bounded turn loop with all five seams
 *   - checkpoint primitives — `TakeoverController`, `dangerousCommandGate`, state types
 */

export * from './cli-runner.js'
export { CliParticipant, payloadToText, type CliParticipantOptions } from './cli-participant.js'
export {
  TakeoverController,
  dangerousCommandGate,
  readReviewDecision,
  readCheckpointState,
  CLI_NEVER_RESUME_AT,
  CLI_CHECKPOINT_STATE_V,
  DEFAULT_DANGEROUS_PATTERNS,
  type CliCheckpointState,
  type CliReviewDecision,
  type CliGateVerdict,
  type CliParkKind,
  type CliTurnContext,
  type CliTurnRecord,
} from './cli-checkpoint.js'
