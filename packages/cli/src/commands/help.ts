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
  peer-card <url>             Preflight a peer hub: fetch + explain its A2A agent card
  wechat-login                Mint a WeChat iLink bot token by QR scan (prints env lines)
  setting [subcommand]        Deterministic ops console (status/check/cold-start/restore/…)
  provision <pack.yaml>       Install a template pack + schedules + acceptance in one go
  model                       Interactive provider/model/key selector for a managed agent
  backup <space> <dir>        Archive a workspace to .tar.gz (manifest + sha256, WAL-safe;
                              --tier=identity|relations for key-only / +peers subsets)
  restore <tgz> --space <dir> Verify a backup's manifest, then restore it
  migrate <scan|apply> <dir>  Find / fix legacy (AipeHub-era) identifiers
  update                      Update this install in place (git ff-only / npm / portable)
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
  'peer-card': `gotong peer-card <url> [--expect-kid <kid>]

Discovery preflight for federation (NET-M5): BEFORE exchanging tokens
with a peer hub, fetch its public A2A agent card
(/.well-known/agent-card.json) and print a human-readable summary —
who it says it is, how to authenticate, and which capabilities its
owner curated onto the card.

Read-only and trust-neutral: looking at a card NEVER creates a peer
link, and a missing card (404) is a normal answer — hubs default to
silence. Either way the next step is the same existing onboarding:
mint-peer-token + registering the peer on both sides.

If the card is signed (A2A §8.4), its first signature is verified
against the card's JWKS and reported ✓/✗ — advisory only (integrity,
not identity). --expect-kid <kid> additionally asserts the signing key
matches YOUR out-of-band anchor (the recomputed key thumbprint, not the
forgeable header label); a mismatch (or unverifiable card) exits 3 so a
script can gate reconnection on the key not having rotated.

Exit codes:
  0  clear answer (card printed, or peer confirmed to have no card;
     with --expect-kid, the pinned key also matched)
  1  inconclusive (unreachable / timeout / HTTP error / invalid card)
  2  usage error
  3  --expect-kid assertion failed (key mismatch / can't confirm)

Examples:
  gotong peer-card https://hub-b.example.com
  gotong peer-card https://hub-b.example.com/.well-known/agent-card.json
  gotong peer-card https://hub-b.example.com --expect-kid t9Xq...43chars
`,
  'wechat-login': `gotong wechat-login [--base-url=URL] [--timeout=SECONDS]

Mint a WeChat iLink bot token by QR scan (WX-M2c). WeChat is the one IM
bridge whose credential can't be copy-pasted from a vendor console: scan
the QR with the phone's WeChat, confirm, and the official login flow
returns a bot token (1 WeChat account = 1 bot).

Credentials go to stdout as ready-to-paste env lines; everything else
(QR, progress, guidance) goes to stderr:

  GOTONG_WECHAT_BOT_TOKEN=...
  GOTONG_WECHAT_BASE_URL=...   (the IDC the login assigned, when returned)

Add those to the host's environment and restart — the wechat bridge
activates on its env gate, then members bind with /bind <code> as on any
other bridge. The token is a SECRET: never commit it or paste it in
public channels. Note WeChat is passive-reply only — the bot answers
conversations members open; it cannot push first.

Options:
  --base-url=URL       Login host override (default the official bootstrap)
  --timeout=SECONDS    Whole-flow budget, 30–3600 (default 480)

Exit codes: 0 credentials printed · 1 login failed / timed out · 2 usage.

Examples:
  gotong wechat-login
  gotong wechat-login >> gotong-host.env   # env lines only; QR on stderr
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
  update: `gotong update

探测这份 Gotong 是怎么装的,原地更新那种形态;**永不代跑重启**(重启权在
运维手里,更新完只打印 systemd/前台两句重启命令)。

  git checkout   fetch → merge --ff-only(纪律与 cloud-quickstart 同:工作区
                 脏 / 本地分叉一律拒,绝不 reset)→ 现有 packages/*/dist 先挪
                 dist.prev → pnpm install --frozen-lockfile && pnpm build
                 --workspace-concurrency=1(串行构建,小内存机安全)→ 构建绿
                 清 .prev / 构建红自动还原 dist.prev(服务继续跑旧产物)→
                 自动 gotong check(红项警告,不判更新失败)。
  全局 npm       npm i -g gotong@latest(失败原样转达)。
  便携包         不做原地更新 —— 指路下载新包;数据目录在包外,原样保留。
  rsync 部署     这台机器没有 .git 可拉 —— 提示回源 checkout 更新后重新
                 rsync,或改用 cloud-quickstart --clone 部署。

Exit codes: 0 更新成功/已最新/便携包指路 / 1 用法 / 2 形态无法自更新 /
3 git 拒绝(脏工作区或非快进) / 4 安装或构建失败(dist.prev 已还原)。

Examples:
  gotong update
`,
  provision: `gotong provision <pack.yaml> --url <hub> --token <admin-token> [options]

FDE 开荒一条命令: 对一台已经跑起来的 hub,把「装模板 → 按模板建议建定时 →
跑黄金验收」三段手工续段压成一次调用,输出绿/黄/红开荒报告。全走 hub 的
admin HTTP API(Bearer token)——远程 hub 与本机 hub 一视同仁,不碰磁盘。

  - 装模板   POST /api/admin/templates/import(解析拒绝在这一步大声失败)
  - 建定时   模板的 schedules[] 只带节奏不带人(templates bring structure,
             never people);给了 --user 才落成真调度行,到点触发仍走该成员
             自己的闸。不给就黄牌提醒。
  - 跑验收   pack 自带的黄金用例真实跑一遍(烧真 token),零 LLM 判卷,
             红行逐条列 violation。

Options:
  --url <url>          hub 的 admin HTTP 地址,如 http://127.0.0.1:3000 (必填)
  --token <token>      admin bearer token (必填)
  --user <memberId>    把模板的定时建议补人启用;run 归属该成员
  --skip-acceptance    不跑黄金用例(省 token;报告里黄牌记一笔)
  --help / -h          Show this message

Exit codes: 0 绿或仅黄 / 1 用法或文件错误 / 2 装模板失败 / 3 装上了但
没到位(工作流落地失败、建调度失败、或验收红)。

Examples:
  gotong provision templates/bundles/morning-brief-hub.yaml \\
    --url http://127.0.0.1:3000 --token "$GOTONG_ADMIN_TOKEN"
  gotong provision pack.yaml --url http://hub:3000 --token t --user u-alice
  gotong provision pack.yaml --url http://hub:3000 --token t --skip-acceptance
`,
  model: `gotong model [--url <hub>] [--token <admin-token>] [--agent <id>]

交互式给一个托管 agent 选 provider / 模型 / key(LSA-M6)。一条终端会话走完:
选 agent → 选 provider(策展目录 OpenRouter/Groq/Cerebras/Gemini/Together/
DeepSeek + Anthropic/OpenAI 官方 + 自定义 OpenAI 兼容端点)→ 贴 key(输入不
回显)→ 现场拉该端点的模型列表挑一个 → hub 用这把 key 真发一次最小请求探活
→ 保存(agent 立即按新配置重启)。

全走 hub 的 admin HTTP API(与 gotong provision 同款 Bearer token),CLI 不碰
磁盘状态;key 只发给 hub 与所选厂商官方端点,永不打印、永不进 URL。既有备用
链(fallbacks)、维护模型等配置原样保留;设过 apiKeyEnv 的 agent 在换端点或
贴新 key 时会解除该绑定并明说(排他语义下留着它会压住这次改动)。

注册账号、拿 key 永远是你自己来 — 本命令只引导与校验,不代办、不上网捡 key。

Options:
  --url <url>      hub 的 admin HTTP 地址(默认 http://127.0.0.1:3000)
  --token <token>  admin bearer token(必填)
  --agent <id>     直接指定要配的 agent(不指定则列出来选)
  --help / -h      Show this message

Exit codes: 0 已保存 / 1 失败或中途取消 / 2 用法错误。

Examples:
  gotong model --token "$GOTONG_ADMIN_TOKEN"
  gotong model --url http://hub:3000 --token t --agent atong
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
