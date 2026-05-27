/**
 * Pure-function parser for REPL input lines.
 *
 * Two flavours of input:
 *
 *   - `:cmd args…`   — meta commands (`:help`, `:quit`, `:agents`,
 *                       `:transcript`, `:dispatch <agentId> <text>`).
 *                       The `:` prefix is deliberately different from
 *                       IM bridges' `/cmd` to avoid confusion:
 *                       `:help` is a CLI affordance (no agent
 *                       intercepts it), whereas IM `/help` reaches
 *                       through `parseImCommand` and gates dispatch.
 *
 *   - any other line — `{ kind: 'free', text }`, routed to the
 *                       hub's default dispatch capability.
 *
 * Empty lines are normalised to `{ kind: 'noop' }` so the loop can
 * just re-prompt without running anything.
 *
 * Why a discriminated union rather than a callback registry: makes
 * the loop a single `switch`, makes unit tests trivial, and keeps the
 * vocabulary explicit at the type level so a new command is one
 * pattern match away from being noticed.
 */

export type ReplCommand =
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'agents' }
  | { kind: 'transcript'; lastN: number }
  | { kind: 'dispatch'; agentId: string; text: string }
  | { kind: 'free'; text: string }
  | { kind: 'noop' }
  | { kind: 'unknown'; verb: string }

const TRANSCRIPT_DEFAULT_N = 5
const TRANSCRIPT_MAX_N = 200

export function parseReplCommand(raw: unknown): ReplCommand {
  // Defensive: stdin lines should be strings, but the loop will
  // sometimes hand us undefined (EOF) — caller handles that, we just
  // normalise.
  if (typeof raw !== 'string') return { kind: 'noop' }
  const line = raw.trim()
  if (line.length === 0) return { kind: 'noop' }

  // Anything not starting with `:` is free-text — preserve original
  // (trimmed) so capitalisation / punctuation survives to the agent.
  if (line[0] !== ':') return { kind: 'free', text: line }

  // Split off the verb. `:foo bar baz` → verb='foo', rest='bar baz'.
  // Verb compared case-insensitively; rest preserved verbatim.
  const spaceAt = line.search(/\s/)
  const verb = (spaceAt === -1 ? line.slice(1) : line.slice(1, spaceAt)).toLowerCase()
  const rest = spaceAt === -1 ? '' : line.slice(spaceAt + 1).trim()

  switch (verb) {
    case '':
      // Just `:` — treat as noop. Users sometimes type it then realise
      // they forgot the verb; better than fall-through to unknown.
      return { kind: 'noop' }

    case 'h':
    case 'help':
    case '?':
      return { kind: 'help' }

    case 'q':
    case 'quit':
    case 'exit':
      return { kind: 'quit' }

    case 'agents':
    case 'who':
    case 'ls':
      return { kind: 'agents' }

    case 'transcript':
    case 't': {
      // `:transcript` defaults to last 5; `:transcript 20` → last 20.
      // We clamp to [1, 200] so a typo can't dump the whole history.
      if (rest.length === 0) return { kind: 'transcript', lastN: TRANSCRIPT_DEFAULT_N }
      const n = Number(rest.split(/\s+/)[0])
      if (!Number.isFinite(n) || n <= 0) {
        return { kind: 'transcript', lastN: TRANSCRIPT_DEFAULT_N }
      }
      return {
        kind: 'transcript',
        lastN: Math.min(Math.floor(n), TRANSCRIPT_MAX_N),
      }
    }

    case 'd':
    case 'dispatch':
    case 'send': {
      // `:dispatch <agentId> <text>` — explicit routing. Useful when
      // multiple agents are loaded and you want to hit a non-default.
      if (rest.length === 0) {
        // Empty payload — bridge says "show me how" via unknown so
        // the loop renders an inline hint rather than dispatching
        // empty.
        return { kind: 'unknown', verb }
      }
      const firstSpace = rest.search(/\s/)
      if (firstSpace === -1) {
        // Just an agent id, no text. Treat as unknown so the loop
        // can prompt with `usage:` rather than dispatch empty.
        return { kind: 'unknown', verb }
      }
      const agentId = rest.slice(0, firstSpace)
      const text = rest.slice(firstSpace + 1).trim()
      if (text.length === 0) return { kind: 'unknown', verb }
      return { kind: 'dispatch', agentId, text }
    }

    default:
      return { kind: 'unknown', verb }
  }
}
