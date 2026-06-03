/**
 * Command presets for the §6.1 CLI coding agents — the parameterised half of the
 * AGENT-ADAPTER-CONTRACT P0 deliverable: ONE shell-out template covers the whole
 * class (Claude Code / Codex / OpenCode / Aider / Goose / …). Point a
 * `CliParticipant` at a preset and it drives that CLI.
 *
 * These are best-effort invocation shapes for each CLI's NON-INTERACTIVE / headless
 * mode (the mode you want when a hub drives it). CLI flags drift fast — verify
 * against the tool's current `--help` before production use. The point isn't the
 * exact flags; it's that the adapter is a config, not per-agent code.
 *
 * `{prompt}` is substituted with the task prompt in arg mode.
 */

export interface CliPreset {
  /** Display name. */
  label: string
  /** The executable on PATH. */
  command: string
  /** Argv with a `{prompt}` token (arg mode) or a fixed headless flag (stdin mode). */
  args: string[]
  /** How the prompt reaches the CLI. */
  promptVia: 'arg' | 'stdin'
  /** The env var the CLI reads its own API key from (scrub/inject as needed). */
  apiKeyEnv?: string
  /** One-line note. */
  note: string
}

export const CLI_PRESETS: Record<string, CliPreset> = {
  'claude-code': {
    label: 'Claude Code',
    command: 'claude',
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    note: '`claude -p "<prompt>"` — headless print mode.',
  },
  codex: {
    label: 'OpenAI Codex',
    command: 'codex',
    args: ['exec', '{prompt}'],
    promptVia: 'arg',
    apiKeyEnv: 'OPENAI_API_KEY',
    note: '`codex exec "<prompt>"` — non-interactive run.',
  },
  opencode: {
    label: 'OpenCode (sst)',
    command: 'opencode',
    args: ['run', '{prompt}'],
    promptVia: 'arg',
    note: '`opencode run "<prompt>"` — headless run.',
  },
  aider: {
    label: 'Aider',
    command: 'aider',
    args: ['--message', '{prompt}', '--yes'],
    promptVia: 'arg',
    note: '`aider --message "<prompt>" --yes` — one-shot, auto-confirm.',
  },
  goose: {
    label: 'Goose',
    command: 'goose',
    args: ['run', '-t', '{prompt}'],
    promptVia: 'arg',
    note: '`goose run -t "<prompt>"` — headless task.',
  },
}
