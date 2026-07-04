# @gotong/acp-agent

Outbound **ACP (Agent Client Protocol)** adapter — the OpenClaw-style way for the
hub to **directly manage the full lifecycle** of a coding agent: spawn it once,
hold a long-lived session, and dispatch many tasks to the **same** session with
context preserved.

It is the **complement** (not a replacement) to the one-shot
[`@gotong/cli-agent`](../cli-agent):

| | `@gotong/cli-agent` | `@gotong/acp-agent` (this package) |
|---|---|---|
| process model | `spawn('claude', ['-p', prompt])` per task, exits | spawn **once**, stdin/stdout held open, dispatch many |
| protocol | none (argv + stdout text) | ACP = JSON-RPC 2.0 over NDJSON on the child's stdio |
| context between tasks | none (fresh process each time) | **preserved** (same ACP session) |
| takeover tier | T2 via pre-spawn regex gate | T2 via `session/request_permission` (natural per-action seam) |

ACP is Zed's open standard ("LSP for coding agents"). Real bridges: Claude Code via
`npx @zed-industries/claude-code-acp`, Codex via `codex-acp` (each needs its own CLI
login — non-hermetic, so they are used only in the `examples/acp-coding-bridge`
runbook, never in tests).

## Five control seams (AGENT-ADAPTER-CONTRACT)

- **observe** — `session/update` streaming notifications → `onChunk(taskId, …)`.
- **intercept** — `session/request_permission` reverse requests → a fail-closed
  `dangerousToolGate` (auto-allow read-only, escalate destructive).
- **handoff** — an escalated permission throws `SuspendTaskError` carrying the
  tool context; the host maps it into the `/me` inbox for a human.
- **resume** — `handleResume` answers the pending permission and the held turn
  continues with **no drift** (the subprocess never restarted).
- **terminate** — `session/cancel` + the kill ladder (SIGTERM → SIGKILL).

## Durability boundary (honest MVP scope)

The escalate-to-human path is **in-memory-coupled**: while a permission is parked,
the agent subprocess stays alive **blocked** on the open reverse request, and the
parked state references that in-memory handle. This does **not** survive a hub
restart — if the hub dies, the subprocess dies with it and the in-flight permission
is lost. On resume of a stale handle the task **fails loudly** ("permission handle
no longer live — re-dispatch") rather than hanging. Durable mid-permission resume
(needing ACP `session/load` + re-establishing the request) is out of MVP scope.

Most permissions resolve **inline** through the synchronous gate (no park), so the
fragile parked path is the exception, not the rule.

This is a **core-only leaf package** (`@gotong/core` is its only dependency).
