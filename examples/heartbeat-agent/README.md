# heartbeat-agent

v5 Stream D demo — an agent **wakes itself on a cadence** (a heartbeat),
runs a full turn against a standing checklist, and stays **quiet** unless
something actually needs attention. The convention is "don't bother me when
there's nothing to do": a quiet heartbeat replies `HEARTBEAT_OK` and is
suppressed; a heartbeat that found work surfaces a one-line report.

This is the "proactive autonomy" half of the human-agent-hub vision — the
agent doesn't wait to be asked. And it costs **no new machinery**: it's built
entirely on the Phase 11 suspend/resume engine. A singleton broker parks a
**self-renewing** `suspended_tasks` row; the existing resume sweep is the
heartbeat's clock; each wake re-parks the same row one interval out.

## Run

```bash
pnpm demo:heartbeat-agent
```

No API key required — the target is a deterministic "inbox monitor" that finds
a VIP email on its 3rd beat and is idle otherwise. The interval is squeezed to
150 ms so the whole demo finishes in ~1 s.

## What you'll see

```
=== AipeHub demo: heartbeat-agent (v5 Stream D) ===

  [system] seeded heartbeat for "inbox-monitor" every 150 ms; sweeping…

  [heartbeat #1 → inbox-monitor] 没事 → 安静（HEARTBEAT_OK，已抑制，不打扰）
  [heartbeat #2 → inbox-monitor] 没事 → 安静（HEARTBEAT_OK，已抑制，不打扰）
  [heartbeat #3 → inbox-monitor] 有事 → 上报：处理了 1 封 VIP 邮件 — 客户 Acme 来信…已起草确认回复草稿待你过目。
  [heartbeat #4 → inbox-monitor] 没事 → 安静（HEARTBEAT_OK，已抑制，不打扰）

  [system] 4 heartbeats fired; 1 surfaced, 3 suppressed.
  [system] the row is still parked (resumeAt in the future) — it would beat forever.
  transcript: … entries (every beat is audited, even the quiet ones)
```

Three of four beats made **no noise** — that's the policy working. But the
transcript recorded **all four**: suppression governs notification noise, not
the audit trail.

## What this proves

A recurring "go check on things and act if needed" behavior — the kind you'd
otherwise build with an external cron + a bespoke script — becomes a per-agent
config flag plus a checklist:

```yaml
# agent manifest (admin UI writes this)
heartbeat:
  enabled: true
  intervalMs: 1800000        # every 30 min
  checklist: |
    1) Any VIP / overdue email in the inbox?
    2) Draft a reply and report; otherwise HEARTBEAT_OK.
```

The framework's job, all reused from Phase 11:

- **Seed** a self-renewing parked row per enabled agent
  (`HeartbeatScheduler.reconcile`, idempotent via the deterministic task id —
  re-seeding a live row never resets its clock).
- **Wake** the broker when `resume_at <= now` (the existing resume sweep — no
  new timer).
- **Fire** one heartbeat task at the target (a normal task whose
  `payload.prompt` carries the checklist — so a *default* `LlmAgent` needs
  **zero** heartbeat awareness), then **re-park** the same row one interval out.
- **Classify** the reply: exactly `HEARTBEAT_OK` → suppress; anything else →
  surface; an error → surface for operator attention.

Because the row id is deterministic (`heartbeat:<agentId>`) and the notifier
does INSERT-OR-REPLACE, the heartbeat survives restarts with **no drift**: one
row is one agent's next-due time, full stop.

## The target agent needs no heartbeat awareness

In this demo `InboxMonitorAgent` branches on `payload.heartbeat === true` just
to make the example legible. A production default `LlmAgent` doesn't even do
that — its `buildRequest` turns `payload.prompt` into the user turn, so the
checklist reaches the model verbatim and the reply is classified by the host.
The hub schedules the wake; the agent decides what to do. The north star holds:
**the hub never runs the LLM.**

## Demo vs production

| | This demo | Production host |
|---|---|---|
| parked-row store | in-process `Map` | `IdentityStore.suspended_tasks` (SQLite) |
| sweep | hand-rolled 50 ms poll | `setInterval(AIPE_RESUME_SWEEP_MS)` (default 30 s) |
| broker / scheduler | inline mirror | `packages/host/src/heartbeat.ts` (16-test suite) |
| enable | seeded in code | per-agent `heartbeat` field via admin UI |

The data shape is identical to what the production sweep handles — the demo
just substitutes the `Map` + poll loop to stay one self-contained file.

## See also

- Heartbeat engine (canonical): `packages/host/src/heartbeat.ts`
- Engine tests: `packages/host/tests/heartbeat.test.ts`
- `SuspendTaskError` + `Hub.resumeTask`: `packages/core/src/suspend.ts`,
  `packages/core/src/hub.ts`
- Suspended-tasks table: `packages/identity/src/schema.ts` (migration v=9)
- Host boot wiring + resume sweep: `packages/host/src/main.ts`
  (search `heartbeat engine started`, `AIPE_RESUME_SWEEP_MS`)
- Sibling demo (the engine this builds on): `examples/long-running-agent`
- Stream D release notes: `docs/zh/ledger/V5-D-FINAL.md`

Source: [`src/index.ts`](src/index.ts).
