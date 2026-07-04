# Performance baseline

This document records the pre-launch performance profile of Gotong. It
exists so that:

1. **Operators can size a deployment** — "is one node enough for our
   team?" — without guessing.
2. **Future PRs have a baseline to regress against.** If a Hub-core
   change halves throughput, this is where the smoking gun lives.

The harness is in [`examples/loadtest/`](../examples/loadtest/). To
reproduce these numbers locally:

```bash
pnpm install && pnpm -r build

# Realistic small-team load: 50 workers, 100 tasks/sec, 60s
pnpm --filter @gotong/example-loadtest ws -- \
  --workers 50 --duration 60s --rate 100 \
  --output runs/ws-50w-60s-100rps.json

# Saturation upper bound: 50 workers, unthrottled, 10s
pnpm --filter @gotong/example-loadtest ws -- \
  --workers 50 --duration 10s --concurrency 32 \
  --output runs/ws-50w-10s-sat.json
```

---

## Headline numbers

| Scenario | Workers | Throughput | p50 | p95 | p99 | RSS growth |
|---|---|---|---|---|---|---|
| **Realistic load** (60s @ 100 tasks/sec) | 50 | 100 tasks/sec | 0.9 ms | 1.6 ms | **2.1 ms** | +43 MB / min |
| **Saturation** (10s, unthrottled, concurrency 32) | 50 | **74,500 tasks/sec** | 0.3 ms | 0.7 ms | 1.3 ms | +106 MB / sec |

Hardware: MacBook Air M5 (Apple Silicon, 10 cores: 4 P + 6 E), 16 GB
RAM, macOS 26.3.2, Node v20.20.2. Single process, single-machine, no
LLM agents (the harness uses an `EchoAgent` that returns synchronously).

## How to read this

**The realistic-load row is the one to plan against.** A 50-person
team where every person dispatches ~2 tasks/sec is — by Gotong design
goals (README scope: "dozens of users, single-node") — at the upper
end of what we expect in production. At that load:

- p99 dispatch latency is **2.1 ms**. Even with a 10× LLM provider
  call on top, total task latency is dominated by the LLM, not the
  Hub.
- Memory grows at **~43 MB/min** (RSS, in-memory mode). At that pace
  the in-memory Hub crosses 8 GB RSS after about 3 hours of continuous
  100 tasks/sec dispatch — which is why **production deployments
  should run with the Space-backed Hub (SQLite transcript), not the
  in-memory variant**. The harness uses `Hub.inMemory()` deliberately
  to isolate the Hub-core scheduling cost; production swaps the
  transcript layer.
- All 6,000 dispatches succeed (0 failures). The capability matcher
  doesn't drop a task even under steady pressure.

**The saturation row tells you the ceiling.** 74,500 tasks/sec is the
single-process WebSocket-driven dispatch ceiling on this hardware
*before* the host runs out of memory faster than it can drain the
transcript. Three things to note:

- p99 stays at **1.3 ms even at saturation**. There's no GC pathology
  in the hot path — latency curves are flat.
- Saturation memory grows at ~106 MB/sec; this is the in-memory
  transcript path. In a real deployment the on-disk persistence layer
  (SQLite) bounds memory but adds disk-write throughput as the new
  saturation limit. Re-run with a real Space-backed Hub if you need
  the disk-bound ceiling for your deployment plan.
- The harness limits the inflight window with `--concurrency 32`; the
  ceiling rises somewhat with higher concurrency but flattens around
  this number — single-process Node is fundamentally CPU-bound past
  this point.

## When to rerun

- **Before each release.** Diff against the table above. A throughput
  drop > ~10 % or a p99 spike > ~25 % deserves a follow-up before
  shipping.
- **After any Hub-core change** to `dispatch`, `register`, or the
  capability matcher.
- **After a transport change** (`@gotong/transport-ws` / `@gotong/sdk-node`).
  The `ws` runner picks up that surface.

## What this baseline does NOT cover

- **LLM-backed agents.** Echo agents return synchronously. Real task
  latency is bounded by your LLM provider; expect 200 ms – 5 s per
  task for OpenAI / Anthropic / DeepSeek with realistic prompts.
- **Disk persistence (Space layer).** Both runners use `Hub.inMemory()`,
  which excludes SQLite write amplification. Add `~1 ms` per task
  budget for SQLite WAL writes when sizing production.
- **Multi-process deployments.** A real production fleet runs workers
  as separate processes (or even separate hosts). Those measurements
  belong in a separate harness.
- **Long-tail / leak detection.** A 60 s run won't surface a leak that
  takes hours. For leak checks: `--duration 30m` with
  `--rate 100` and watch `rssGrowthMb` in the report.

## Full reports

### Realistic load — 50 workers / 60s @ 100 tasks/sec

- Dispatched: 6,000 (6,000 ok, 0 fail)
- Throughput: **100.0 tasks/sec** (target was 100; harness held it)
- Latency (ms): mean=1.00 p50=0.91 p90=1.48 p95=1.62 p99=2.07 max=3.98
- Memory: RSS peak 139.1 MB, heap peak 49.3 MB, RSS growth +43.4 MB
  over the 60 s window

Memory over time (RSS, MB):

```
min=80.1MB max=139.1MB
▃▆▇██▇▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆
```

The flat curve after the initial heap warmup is the expected
behaviour: GC keeps up with the steady-state dispatch rate.

### Saturation — 50 workers / 10s, unthrottled, concurrency 32

- Dispatched: 757,739 (757,739 ok, 0 fail)
- Throughput: **74,500 tasks/sec**
- Latency (ms): mean=0.33 p50=0.29 p90=0.41 p95=0.66 p99=1.25 max=6.21
- Memory: RSS peak 1,136.0 MB, heap peak 1,019.7 MB, RSS growth
  +1,056.0 MB over the 10 s window

Memory over time (RSS, MB):

```
min=80.0MB max=1136.0MB
▁▁▁▁▁▁▁▁▁▂▂▂▂▂▃▃▃▃▃▃▄▄▄▄▄▄▄▄▄▅▅▅▅▅▆▆▆▆▆▆▇▇▇▇▇███████████████
```

The linear growth is the in-memory transcript filling up. With
Space-backed Hub the growth flattens — the transcript spills to disk.
