/**
 * `@aipehub/cli-agent` — outbound CLI shell-out adapter.
 *
 * Wraps a self-hosted coding-agent CLI (Claude Code / Codex / OpenCode / Aider …)
 * as a hub `Participant` so the hub can DRIVE it (the mirror of `aipehub connect`,
 * where the CLI calls the hub inbound). Built to the AGENT-ADAPTER-CONTRACT
 * five-seam bar (observe / intercept / handoff / resume / terminate).
 *
 * Public surface (M1):
 *   - `runCliCommand` — the bounded spawn engine (stdin + live stream + abort)
 *   - `CliParticipant` — the single-shot adapter (observe + terminate seams)
 */

export * from './cli-runner.js'
export { CliParticipant, payloadToText, type CliParticipantOptions } from './cli-participant.js'
