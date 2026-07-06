/**
 * `gotong help [cmd]` — print usage. Plain text, no colour, no
 * heuristics for "did you mean" — keeps the CLI self-explanatory in
 * any terminal.
 */

const SHELL = `gotong <command> [args]

Commands:
  init                        Initialize a workspace (personal mode by default)
  start                       Launch the host (delegates to @gotong/host)
  doctor                      Pre-flight environment check (ports, space, keys)
  check [--strict]            Validate workspace config + workflow/agent files (no AI)
  new agent <name>            Scaffold a TypeScript sidecar agent project
  new python-agent <name>     Scaffold a Python sidecar agent project
  ping <ws-url>               Verify a Hub is reachable (HELLO/WELCOME handshake)
  repl                        Start an interactive shell against an in-memory hub
  connect [agent]             Print MCP quick-connect config for a coding agent
  mint-peer-token             Generate a federation peer bearer token
  setting [subcommand]        Deterministic ops console (status/check/cold-start/restore/…)
  backup <space> <dir>        Archive a workspace to .tar.gz (manifest + sha256, WAL-safe)
  restore <tgz> --space <dir> Verify a backup's manifest, then restore it
  migrate <scan|apply> <dir>  Find / fix legacy (AipeHub-era) identifiers
  help [command]              Show usage for a specific command
  --version                   Print the CLI version

Examples:
  gotong init
  gotong start
  gotong doctor
  gotong check
  gotong new agent greeter
  gotong new python-agent classifier --capabilities=triage,classify
  gotong ping ws://127.0.0.1:4000
  gotong repl
  gotong connect claude-code --bin=/abs/packages/mcp-server/bin/gotong-mcp.js
  gotong mint-peer-token --peer-id=partner-hub
  gotong setting status
  gotong backup .gotong ~/backups
  gotong restore ~/backups/gotong-space-20260706T010203Z.tar.gz --space .gotong
`

const PER_COMMAND: Readonly<Record<string, string>> = {
  init: `gotong init [options]

Initializes a new Gotong workspace. Creates the directory structure,
a bootstrap admin, and initial configuration. On first host start the
identity layer auto-detects single-user and enters personal mode
("my AI desktop").

Options:
  --space-dir=<path>      Workspace root (default: .gotong)
  --admin-name=<name>     First admin display name (default: Operator)
  --pin-team              Force team mode instead of personal auto-detect
  --help / -h             Show this message

Examples:
  gotong init
  gotong init --space-dir=/opt/gotong --admin-name="Alice"
  gotong init --pin-team
`,
  start: `gotong start

Starts the production Gotong host in this process — a thin convenience
wrapper around \`@gotong/host\`, identical to \`npx @gotong/host\` but
reachable through the same \`gotong\` CLI you use for connect / repl / init.

The host is a SEPARATE package (LLM SDKs, SQLite, the web bundle), so the
CLI does not depend on it: if @gotong/host is installed \`start\` launches
it, otherwise it prints how to get it and exits non-zero.

Configuration is via environment variables (12-factor):
  GOTONG_SPACE=.gotong        workspace directory (auto-created on first run)
  GOTONG_WEB_PORT=3000         admin UI / API port
  GOTONG_WS_PORT=4000          agent WebSocket port
  GOTONG_OPEN_BROWSER=0        suppress the first-run browser auto-open

Examples:
  gotong start
  GOTONG_SPACE=/opt/gotong gotong start
`,
  doctor: `gotong doctor

Pre-flight check for a fresh box: inspects the same environment the host
reads — WITHOUT booting it — and prints, per check, ✓ / ⚠ / ✖ with a fix.
Run it first when \`start\` won't come up and you don't know why.

Checks:
  - Node.js >= 20
  - @gotong/host resolvable (or how to install it)
  - GOTONG_WEB_PORT / GOTONG_WS_PORT actually free to bind
  - GOTONG_SPACE writable (or creatable on first run)
  - master key present when GOTONG_MASTER_KEY_PROVIDER=env
  - an LLM provider key in the env (optional — the setup wizard can set one)

It reports the NAMES of key env vars, never their values. Exit code is 0 when
there are no ✖ blockers (⚠ are advisory), 1 otherwise, 2 on a usage error.

Examples:
  gotong doctor
  GOTONG_WEB_PORT=8080 gotong doctor
`,
  check: `gotong check [--strict]

Deterministic (non-AI) self-check of a workspace. Validates three things,
WITHOUT booting the hub or calling any LLM:

  - host config 体检   ports / gating / language / security defaults / master
                       key presence (reuses the same boot-security audit)
  - workflow files     every <space>/workflows/definitions/*.yaml parses
                       (parseWorkflow — syntax / schema only)
  - agent definitions  <space>/agents.json is well-formed (ids unique,
                       provider/kind known, openai-compatible has a baseURL)

The validators live in @gotong/host (they need parseWorkflow, the Space
layout) and run through the host's non-booting ./check entry, so the host
must be installed — \`check\` prints how to get it if it isn't.

Reads the workspace at GOTONG_SPACE (default: .gotong) and the same GOTONG_*
env the host reads. Exit code is 0 when there are no ✖ errors, 1 when any
error is found (or any ⚠ warning under --strict), 2 on a usage error.

Options:
  --strict            Treat warnings as failures (exit 1 on any ⚠)
  --help / -h         Show this message

Examples:
  gotong check
  GOTONG_SPACE=/opt/gotong gotong check
  gotong check --strict
`,
  new: `gotong new <agent|python-agent> <name> [options]

Scaffolds a fresh sidecar agent project in <name>/. The project is
self-contained — no monorepo install required, just \`npm install\`
inside the new directory.

Options:
  --capabilities=<csv>   Comma-separated capability list (default: noop)
  --id=<id>              Override the agent's ParticipantId (default: <name>)
  --no-services          Skip the Hub Services scaffolding in the example

Examples:
  gotong new agent coach --capabilities=draft,review
  gotong new python-agent triage --id=triage-py
`,
  repl: `gotong repl [options]

Starts an interactive shell against an in-memory hub bootstrapped with
a default echo agent (capability 'chat'). Each line you type is
either:

  - A meta command if it starts with \`:\`:
      :help, :h, :?            command list
      :agents, :who, :ls       list registered participants
      :transcript [n], :t [n]  show last n transcript entries (default 5)
      :dispatch <id> <text>    explicit dispatch to a specific agent
      :quit, :q, :exit         exit

  - Otherwise, free text — dispatched to capability 'chat'.

No persistent state: REPL transcript dies with the process.

Options:
  --prompt=<str>     Override the prompt (default \`> \`)
  --from=<id>        Override participant id used as Task.from
                     (default \`repl-user\`)
  --no-banner        Suppress the startup banner

Examples:
  gotong repl
  gotong repl --no-banner --prompt='gotong> '
`,
  connect: `gotong connect [agent] [options]

Prints the exact MCP config to connect a mainstream coding agent to a
running Gotong Hub. Every supported agent is an MCP client, so the
move is the same for all: point its MCP config at @gotong/mcp-server
(spawned by absolute path with node, since it's not on npm yet).

With no agent id, lists what's supported. Config goes to stdout;
warnings (placeholder token, bin not found) go to stderr.

Supported agents:
  claude-code   Claude Code (Anthropic)   — claude mcp add / ~/.claude.json
  codex         Codex (OpenAI)            — ~/.codex/config.toml
  opencode      OpenCode (sst/opencode)   — opencode.json
  antigravity   Antigravity (Google)      — ~/.gemini/config/mcp_config.json
  cursor        Cursor                    — ~/.cursor/mcp.json
  openclaw      OpenClaw                  — openclaw mcp add / openclaw.json
  nanobot       nanobot (nanobot-ai)      — nanobot.yaml
  hermes        Hermes Agent (Nous)       — hermes mcp add / ~/.hermes/config.yaml

Options:
  --hub=<url>        Hub admin HTTP base URL (default: $GOTONG_HUB_URL or
                     http://127.0.0.1:3000)
  --token=<token>    Admin bearer token to inline (default: a placeholder;
                     a secret is never auto-read from env into output)
  --name=<name>      MCP server name in the agent's config (default: gotong)
  --bin=<path>       Path to packages/mcp-server/bin/gotong-mcp.js (auto-
                     detected in a monorepo checkout; override otherwise)
  --help / -h        Show this message

Examples:
  gotong connect
  gotong connect codex
  gotong connect claude-code --hub=http://127.0.0.1:3000 --token="$GOTONG_ADMIN_TOKEN"
  gotong connect cursor --name=my-hub --bin=/opt/gotong/packages/mcp-server/bin/gotong-mcp.js
`,
  ping: `gotong ping <ws-url> [options]

Opens a WebSocket to the given URL, sends HELLO, waits for WELCOME (or
REJECT), reports the result. Useful for diagnosing connectivity /
auth / gating without spinning up a full agent.

Options:
  --api-key=<key>        Pass an apiKey on HELLO (for gating='api-key')
  --timeout=<ms>         Override the per-step timeout (default: 5000)
  --agent-id=<id>        Override the HELLO agent id (default: gotong-cli-ping)

Examples:
  gotong ping ws://127.0.0.1:4000
  gotong ping wss://hub.example.com/ws --api-key=$GOTONG_KEY
`,
  'mint-peer-token': `gotong mint-peer-token [options]

Generates a cryptographically strong bearer token (256 bits from the OS
CSPRNG, base64url) for a cross-hub federation link. Federation auth is
symmetric: the SAME string is registered on both hubs — on yours as the
outbound token presented to the peer, on the peer's as the inbound token
it expects from you.

The token alone goes to stdout (so it pipes / redirects cleanly); the
pairing instructions go to stderr. This command is stateless — it does
not touch a workspace, master key, or running hub. Registering the token
against a peer is a separate admin step (the "对端" UI or the
POST /api/admin/identity/peers route).

Options:
  --bytes=<n>        Token entropy in bytes (16–64, default: 32)
  --peer-id=<id>     Slot the peer id into the printed setup hint
  --endpoint=<url>   Slot the peer's federation URL into the hint
  --help / -h        Show this message

Examples:
  gotong mint-peer-token
  gotong mint-peer-token --peer-id=partner-hub --endpoint=wss://partner/federation
  gotong mint-peer-token > peer-token.txt   # token only; hint on stderr
`,
  setting: `gotong setting [<subcommand> [args]]

The unified deterministic (NON-AI) operations console. ONE namespace over the
whole lifecycle — cold-start → crash-rescue → re-read definitions → config check.
With NO subcommand it opens an interactive sub-shell. The same engine is reachable
from the admin web UI and (online commands only) an IM command mode.

The ops engine ships in the SEPARATE @gotong/host package; \`setting\` resolves
it lazily and drives its non-booting ./ops entry, so the host must be installed —
\`setting\` prints how to get it if it isn't.

Online commands — safe everywhere (CLI, admin web, IM command mode):
  status               Where the hub is now (definition counts, config verdict,
                       live health when the hub is running).
  check [--strict]     Deterministic config + workflow + agent validation.
  list                 Every setting command, its tier, and where it can run.
  inventory            Backup recovery candidates (read-only, newest first).
  fix-dirs             Create missing workspace directories (mkdir -p; idempotent).

Destructive, offline — CLI ONLY (the hub is down or being replaced while they
run, so the web/IM surfaces physically can't reach them). Each confirms first;
pass --yes to skip the prompt:
  cold-start [--force] Pre-flight (doctor) → validate definitions (check) → boot.
                       Aborts on pre-flight problems unless --force.
  restore <file> <target> [--force]
                       Extract a backup tarball into a target workspace (runs
                       verify.sh). Stop the hub first.
  rotate-master-key    Rotate the identity-vault master key (local-file provider).

Reads the same GOTONG_* env the host reads (GOTONG_SPACE, default .gotong). Exit
code 0 on success, non-zero on failure or a declined confirmation.

Examples:
  gotong setting status
  gotong setting check --strict
  gotong setting                       # interactive sub-shell
  gotong setting restore gotong-prod-20260626T101530Z.tar.gz /opt/gotong --yes
  gotong setting rotate-master-key
`,
  backup: `gotong backup <space-dir> <backup-dir> [--include-master-key]

TS-native workspace backup — works everywhere the CLI runs (Windows and the
portable bundle included; scripts/backup/backup.sh stays for server cron).
Online backup is the default: the host can keep running.

Semantics match backup.sh exactly:
  - ALWAYS excluded: runtime/admin-sessions.json, runtime/worker-sessions.json
    (restoring them would revive stale cookie sessions).
  - Excluded by default: runtime/secret.key (v3) and the identity-master.key*
    family (v4 vault KEK + rotation staging). Keys next to the ciphertext they
    unlock would defeat the at-rest encryption for the backup copy.
  - identity.sqlite is WAL-mode; it is copied through an honest ladder:
    better-sqlite3 backup API → sqlite3 CLI .backup → raw copy + LOUD warning.

On top of the .sh format, the archive carries gotong-backup-manifest.json
(file list + sha256 of every byte as archived) — \`gotong restore\` verifies
it before touching the target.

Options:
  --include-master-key   Moving-house mode: ALSO archive both key families.
                         The archive can then decrypt everything it contains —
                         treat the file itself as a credential.
  --help / -h            Show this message

Exit codes: 0 written / 1 usage / 2 not a workspace / 3 archive failed.

Examples:
  gotong backup .gotong ~/backups
  gotong backup /opt/gotong/.gotong /var/backups/gotong --include-master-key
`,
  restore: `gotong restore <backup.tar.gz> --space <dir> [--force]

Verify-then-restore for archives produced by \`gotong backup\`. The archive is
extracted to a temporary directory first and its manifest is checked — every
file's sha256 and size, plus the file set in both directions. Only a fully
verified archive is moved into the target; ANY mismatch refuses and leaves the
target byte-for-byte untouched.

A non-empty target requires --force, and even then the old content is only
replaced AFTER verification passes. Legacy .sh archives (no manifest inside)
are refused — restore those with scripts/backup/restore.sh.

After restoring, the workspace check (\`gotong check\`) runs automatically when
@gotong/host is installed; problems are reported but do not undo the restore.

Options:
  --space <dir>      Target workspace directory (required; also --space=<dir>)
  --force            Replace a non-empty target after verification
  --help / -h        Show this message

Exit codes: 0 restored / 1 usage / 2 target refused / 3 archive missing or
extract failed / 4 manifest missing, corrupt, or verification failed.

Examples:
  gotong restore ~/backups/gotong-space-20260706T010203Z.tar.gz --space .gotong
  gotong restore backup.tar.gz --space /opt/gotong/.gotong --force
`,
  migrate: `gotong migrate <scan|apply> <space-dir> [--brand]

Doctor for rename residue: workspaces created before the AipeHub → Gotong
rename can carry legacy identifiers that today's host refuses to load. This
command finds (scan) and fixes (apply) exactly four known classes — a strict
whitelist of file×pattern pairs, nothing else is ever touched:

  1. service packages   services/plugins.json: @aipehub/* → @gotong/*
  2. format ids         workflows/definitions/* and workflows/revisions/*:
                        aipehub.<name>/vN → gotong.<name>/vN. Revision
                        snapshots are migrated structurally: contentHash is
                        re-derived and the lifecycle record's meta copy is
                        synced (a blind sed would leave stale hashes).
  3. brand strings      space.json / agents.json display text AipeHub →
                        Gotong — rewritten only with --brand (always reported).
  4. env prefixes       AIPE_* → GOTONG_* (+ AIPEHUB_URL → GOTONG_URL).
                        Env files hold credentials and are NEVER read; scan
                        just prints the sed one-liner for you to run yourself.

apply is verify-before-write: each file is transformed and validated in
memory (JSON parse / parseWorkflow); a file that fails validation is left
untouched. Every rewritten file first gets a *.premigrate copy of the
original beside it (kept across re-runs — never overwritten with an
intermediate state). transcript / secrets / identity.sqlite / master keys
are never in the whitelist.

Exit codes: scan 0 clean / 1 residue found / 2 usage or not a workspace;
apply 0 done (or nothing to do) / 1 some file failed / 2 usage.

Examples:
  gotong migrate scan .gotong
  gotong migrate apply .gotong
  gotong migrate apply /opt/gotong/.gotong --brand
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
