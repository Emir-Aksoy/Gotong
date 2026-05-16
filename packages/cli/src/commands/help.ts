/**
 * `aipehub help [cmd]` — print usage. Plain text, no colour, no
 * heuristics for "did you mean" — keeps the CLI self-explanatory in
 * any terminal.
 */

const SHELL = `aipehub <command> [args]

Commands:
  new agent <name>            Scaffold a TypeScript sidecar agent project
  new python-agent <name>     Scaffold a Python sidecar agent project
  ping <ws-url>               Verify a Hub is reachable (HELLO/WELCOME handshake)
  help [command]              Show usage for a specific command
  --version                   Print the CLI version

Examples:
  aipehub new agent greeter
  aipehub new python-agent classifier --capabilities=triage,classify
  aipehub ping ws://127.0.0.1:4000
`

const PER_COMMAND: Readonly<Record<string, string>> = {
  new: `aipehub new <agent|python-agent> <name> [options]

Scaffolds a fresh sidecar agent project in <name>/. The project is
self-contained — no monorepo install required, just \`npm install\`
inside the new directory.

Options:
  --capabilities=<csv>   Comma-separated capability list (default: noop)
  --id=<id>              Override the agent's ParticipantId (default: <name>)
  --no-services          Skip the Hub Services scaffolding in the example

Examples:
  aipehub new agent coach --capabilities=draft,review
  aipehub new python-agent triage --id=triage-py
`,
  ping: `aipehub ping <ws-url> [options]

Opens a WebSocket to the given URL, sends HELLO, waits for WELCOME (or
REJECT), reports the result. Useful for diagnosing connectivity /
auth / gating without spinning up a full agent.

Options:
  --api-key=<key>        Pass an apiKey on HELLO (for gating='api-key')
  --timeout=<ms>         Override the per-step timeout (default: 5000)
  --agent-id=<id>        Override the HELLO agent id (default: aipehub-cli-ping)

Examples:
  aipehub ping ws://127.0.0.1:4000
  aipehub ping wss://hub.example.com/ws --api-key=$AIPE_KEY
`,
}

export function printHelp(cmd?: string): void {
  if (!cmd) {
    process.stdout.write(SHELL)
    return
  }
  const txt = PER_COMMAND[cmd]
  if (txt) {
    process.stdout.write(txt)
  } else {
    process.stdout.write(SHELL)
  }
}
