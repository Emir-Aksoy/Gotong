# @gotong/cli-agent

Outbound **CLI shell-out adapter** — wrap a self-hosted coding-agent CLI (Claude
Code, Codex, OpenCode, Aider, Goose, …) as a hub `Participant` so the hub can
**drive** it.

This is the mirror image of `gotong connect <agent>`:

| direction | who calls whom | mechanism |
|---|---|---|
| **inbound** | the CLI calls the hub | the CLI runs an MCP client pointed at the hub |
| **outbound** (this package) | the hub drives the CLI | the hub spawns the CLI, feeds it the task, reads stdout |

A dispatched Task's prompt goes in (piped to stdin, or substituted for a
`{prompt}` token in argv); the CLI's stdout comes back as the task output.

## Built to the adapter contract

`docs/zh/AGENT-ADAPTER-CONTRACT.md` requires every adapter to pass two axes —
**bidirectional** and **fast-takeover** (five control seams). This package's
M1 core lands the two cheapest seams; M2 lands the rest on top of the same
spawn plumbing.

| seam | M1 (this) | how |
|---|---|---|
| **observe** | ✅ | stdout/stderr stream to `onChunk(taskId, chunk)` in real time → the host wires it to a transcript event |
| **terminate** | ✅ | `onTaskCancelled(taskId)` aborts the child (SIGTERM → SIGKILL after a grace window) |
| intercept / handoff / resume | M2 | a checkpoint loop + a cooperative on-demand park flag → `SuspendTaskError` between turns, `onResume` continues |

## Exports

- `runCliCommand(opts)` — the bounded spawn engine: stdin feed, live `onChunk`
  streaming, abort (terminate), hard timeout, env scrubbing. Generic — it
  receives the **final** argv and owns only OS-level concerns. Throws only on
  spawn failure (ENOENT → "command not found"); a non-zero exit is reported,
  not thrown.
- `CliParticipant` — the single-shot adapter (`AgentParticipant` subclass). One
  CLI invocation per task. Picks prompt delivery (`promptVia: 'stdin' | 'arg'`),
  substitutes `{prompt}` in arg mode, maps a non-zero exit / timeout / abort to a
  failed `TaskResult`.
- `payloadToText(payload)` — pull the prompt out of a dispatched task payload
  (`prompt` → `text` → JSON).

## Example

```ts
import { CliParticipant } from '@gotong/cli-agent'

// Drive `claude -p "<prompt>"` in a repo, streaming output to the transcript.
const coder = new CliParticipant({
  id: 'claude-code',
  capabilities: ['code'],
  command: 'claude',
  args: ['-p', '{prompt}'],
  promptVia: 'arg',
  cwd: '/path/to/repo',
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  timeoutMs: 10 * 60_000,
  onChunk: (taskId, chunk) => hub.appendTranscript(taskId, chunk),
})
hub.register(coder)
// Dispatching capability 'code' now runs the CLI; cancelling the task kills it.
```

A parameterized end-to-end bridge (command presets for codex / claude-code /
opencode / aider + a mock CLI + the deterministic observe→park→delegate→resume→
terminate acceptance gate) lands in `examples/coding-agent-bridge/` (E2-M3).

## Why a leaf package, not part of the host

Importing `@gotong/host` *runs the host* (`main.ts`). Reusable participants
therefore live in small core-only packages (`@gotong/inbox`, `@gotong/a2a`,
this) so examples and embedders can import just the participant.
