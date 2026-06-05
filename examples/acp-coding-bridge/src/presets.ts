/**
 * Command presets for ACP coding-agent bridges — the parameterised half of the
 * OpenClaw-style deliverable. Where `CLI_PRESETS` (examples/coding-agent-bridge)
 * shells out one-shot, these spawn an agent that speaks ACP (Agent Client
 * Protocol) over stdio, so a `AcpParticipant` holds ONE long-lived session and
 * dispatches many tasks to it with context preserved.
 *
 * Point an `AcpParticipant` at a preset's `command`/`args` and it drives that
 * agent. These are best-effort invocation shapes — ACP bridges are young and
 * their package names / flags drift; verify against the bridge's own README
 * before production use. The point isn't the exact argv; it's that the adapter
 * is a config, not per-agent code.
 *
 * NON-HERMETIC: each bridge needs its underlying agent installed AND logged in
 * (claude-code-acp rides Claude Code's auth; codex-acp rides Codex's). There is
 * no API key for the hub to inject — the agent authenticates itself. So these
 * presets are NOT exercised by the deterministic demo (which drives the mock);
 * they're what you swap in for a real run (see M8 live.ts + the README runbook).
 */

export interface AcpPreset {
  /** Display name. */
  label: string
  /** The executable on PATH (often `npx`). */
  command: string
  /** Static argv after the command. */
  args: string[]
  /** How the agent authenticates (informational — the hub injects nothing). */
  auth: string
  /** One-line note. */
  note: string
}

export const ACP_PRESETS: Record<string, AcpPreset> = {
  'claude-code-acp': {
    label: 'Claude Code (via Zed ACP bridge)',
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    auth: "Claude Code's own login (run `claude` once and sign in).",
    note: '`npx @zed-industries/claude-code-acp` — the official Zed ACP adapter for Claude Code.',
  },
  'codex-acp': {
    label: 'OpenAI Codex (ACP bridge)',
    command: 'codex-acp',
    args: [],
    auth: "Codex CLI's own login (run `codex` once and sign in).",
    note: '`codex-acp` — Codex ACP adapter (install separately; verify the current binary name).',
  },
}
