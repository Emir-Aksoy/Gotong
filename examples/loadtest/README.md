# AipeHub load test

Internal performance harness — designed to catch dispatch regressions and
to give operators a ballpark of how many concurrent agents one Hub can
hold before the host becomes the bottleneck.

This is **not** a benchmark suite. It produces a small JSON report that
operators can paste into a PR or diff against the previous baseline. Use
it before/after a release to make sure throughput didn't drop.

## Two runners

| Runner | What it measures | What it skips |
|---|---|---|
| `inproc` | Hub.dispatch + capability matching + AgentParticipant.handleTask round-trip, single process, zero network. | WebSocket framing, on-disk persistence. |
| `ws` | Everything `inproc` does + the WebSocket transport (real socket on `127.0.0.1` between Hub and SDK in the same process). | Multi-process scheduling, on-disk persistence, real network latency. |

For headline numbers in `docs/PERFORMANCE.md`, prefer `ws` — it's the
closest single-process proxy to the production path. For spotting a
scheduling regression in the Hub core, `inproc` isolates the variable.

## Quick start

```bash
# Build (or use tsx; see scripts in package.json)
pnpm -r build

# Headline baseline: 50 workers, 60 seconds, WebSocket transport
pnpm --filter @aipehub/example-loadtest ws -- \
  --workers 50 --duration 60s \
  --output runs/ws-50w-60s.json

# Spot-check inproc upper bound
pnpm --filter @aipehub/example-loadtest inproc -- \
  --workers 50 --duration 60s \
  --output runs/inproc-50w-60s.json

# Stitch both into a markdown report
pnpm --filter @aipehub/example-loadtest report -- runs/*.json > /tmp/report.md
```

## Flags

```
--workers     N        Number of agent participants (default: 50)
--duration    DURATION How long to run; 30s | 5m | 1h (default: 30s)
--rate        N        Target tasks/sec; 0 = unthrottled (default: 0)
--concurrency N        Max dispatches in-flight at once (default: 16)
--output      PATH     Write JSON report here (default: stdout only)
```

`--rate` is a *target*; if the host can't keep up, the actual throughput
will be lower (visible in the report's `throughputPerSec` field). For an
unthrottled saturation test, leave `--rate` at 0 and watch p99 latency
climb.

## When to rerun

- **Before each release.** Compare against the previous baseline in
  `docs/PERFORMANCE.md` — anything more than ~10 % throughput drop or
  ~25 % p99 increase deserves a follow-up.
- **After a Hub-core change** that touches `dispatch`, `register`, or
  the capability matcher.
- **After a transport change** (`@aipehub/transport-ws` /
  `@aipehub/sdk-node`) — the `ws` runner picks up that surface.

## What this harness DOES NOT cover

- **LLM-backed agents.** `EchoAgent` returns synchronously. Real LLM
  agents are bounded by network + provider latency, not by AipeHub.
- **Long-tail GC behaviour.** A 60 s run won't surface a leak that takes
  hours to show up. For that, bump `--duration 30m` and watch the
  `rssGrowthMb` field in the report.
- **Disk persistence.** Both runners use `Hub.inMemory()`. The Space
  layer is excluded so you don't measure SQLite write amplification
  unless you actually want to.
- **Cross-process scheduling.** Workers live in the same process as the
  Hub. Multi-process tests are a separate concern (and a possible
  follow-up runner).
