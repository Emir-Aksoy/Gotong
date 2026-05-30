/**
 * metrics.ts — Prometheus text-format exposition for the web layer.
 *
 * Extracted from server.ts (C1 god-object split, follows the route-group
 * batches). `renderMetrics` is a pure function (Hub + opts → string) with
 * no I/O, so it lives apart from the request handler. `HttpStats` rides
 * along because it exists solely to feed `renderMetrics` the per-server
 * response-class counters — the server increments it on every `finish`
 * hook, and `renderMetrics` reads it back out.
 *
 * Dependency direction: this module imports only `Hub` (type) and
 * `PROTOCOL_VERSION` from sibling packages — it never imports back from
 * server.ts, so server.ts → metrics.ts is a clean one-way edge (no
 * import cycle).
 */

import { type Hub } from '@aipehub/core'
import { PROTOCOL_VERSION } from '@aipehub/protocol'

/**
 * Per-server response counters. Indexed by status_class (2xx / 3xx /
 * 4xx / 5xx) — a single-dimension axis keeps cardinality low. We
 * deliberately don't track per-route counters here: the AipeHub admin
 * surface has hundreds of endpoints (admin + worker + SSE + auth + …)
 * and routes that take ids in the path would explode label cardinality.
 *
 * Operators who need per-route visibility can put a reverse proxy
 * (Caddy / nginx) in front and scrape its logs — that's what those
 * layers are for. AipeHub's metrics are about \"is the host healthy\"
 * not \"is this specific endpoint slow.\"
 */
export class HttpStats {
  /** byStatusClass: '2xx' / '3xx' / '4xx' / '5xx' → count. */
  readonly byStatusClass = new Map<string, number>()

  /** Record a single response. Called from the server's 'finish' hook. */
  record(statusCode: number): void {
    if (!Number.isFinite(statusCode) || statusCode < 0) return
    // Status codes outside the 1xx-5xx range get bucketed into a synthetic
    // 'other' label so we don't drop them silently. Servers that emit
    // 0 (a quirk on some socket-closed-early paths) end up there too.
    const klass =
      statusCode >= 100 && statusCode < 600
        ? `${Math.floor(statusCode / 100)}xx`
        : 'other'
    this.byStatusClass.set(klass, (this.byStatusClass.get(klass) ?? 0) + 1)
  }
}

// Histogram bucket upper bounds (ms) for SERVICE_CALL latency. Cumulative
// Prometheus histogram — a trailing `+Inf` slot is appended at render time.
const SERVICE_CALL_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const

/** Options recognised by {@link renderMetrics}. */
export interface RenderMetricsOptions {
  /**
   * Per-server HTTP response counters to surface alongside the
   * Hub-derived metrics. Pass `ctx.httpStats` from the server; the
   * metric is omitted when this is undefined (callers that scrape
   * /metrics from a non-server context — tests, scripts — won't see
   * HTTP-related output).
   */
  httpStats?: HttpStats
}

/**
 * Render `hub` state as a Prometheus / OpenMetrics text exposition.
 *
 * Format spec: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Choice of metrics (deliberately narrow — every counter / gauge below is
 * derived from data the hub already keeps in memory or the transcript;
 * no new bookkeeping required):
 *
 *   - `aipehub_protocol_version`       1, labelled with the wire version.
 *   - `aipehub_participants` gauge      total live participants by kind.
 *   - `aipehub_tasks_total` counter     completed tasks by terminal kind.
 *   - `aipehub_pending_applications` gauge  unresolved HELLO admissions.
 *   - `aipehub_service_calls_total` counter  SERVICE_CALL frames by outcome.
 *   - `aipehub_service_call_duration_ms_sum` counter / `_count` —
 *     classic sum/count pair giving you a per-(type,impl) mean over time.
 *   - `aipehub_service_call_duration_ms_bucket` histogram — cumulative
 *     latency buckets (SERVICE_CALL_BUCKETS_MS + `+Inf`) for
 *     `histogram_quantile()` p50 / p95 / p99.
 *
 * **Performance**: walks the transcript once. With a typical 1k-10k entry
 * transcript and Prometheus's 15-30s scrape interval, this is negligible.
 * If a deployment hits 100k+ entries the right next step is to maintain a
 * rolling counter — out of scope for v1.2.
 */
export function renderMetrics(hub: Hub, opts: RenderMetricsOptions = {}): string {
  const lines: string[] = []
  const w = (...ls: string[]) => { for (const l of ls) lines.push(l) }

  // --- protocol version (info-style metric) ----------------------------------
  w(
    '# HELP aipehub_protocol_version Wire protocol version (info metric).',
    '# TYPE aipehub_protocol_version gauge',
    `aipehub_protocol_version{version="${PROTOCOL_VERSION_LITERAL}"} 1`,
    '',
  )

  // --- participants by kind ---------------------------------------------------
  const participants = hub.participants()
  const byKind: Record<string, number> = {}
  for (const p of participants) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1
  }
  w(
    '# HELP aipehub_participants Number of live participants, by kind.',
    '# TYPE aipehub_participants gauge',
  )
  for (const [kind, count] of Object.entries(byKind)) {
    w(`aipehub_participants{kind="${escapeLabel(kind)}"} ${count}`)
  }
  if (Object.keys(byKind).length === 0) {
    // Emit a zero so the metric exists even before anyone joins.
    w('aipehub_participants 0')
  }
  w('')

  // --- task outcomes (counter from transcript) -------------------------------
  // Aggregating from transcript means counters reset on host restart — fine
  // for Prometheus (which expects counter resets), and avoids extra state.
  const taskCounts: Record<string, number> = { ok: 0, failed: 0, cancelled: 0, no_participant: 0 }
  let pendingApps = 0
  // SERVICE_CALL audit metrics.
  const svcCalls: Record<string, number> = {}     // key: "type|impl|outcome"
  const svcDurSum: Record<string, number> = {}    // key: "type|impl"
  const svcDurCnt: Record<string, number> = {}    // key: "type|impl"
  // Histogram bucket counts. Each value is a cumulative-count array
  // aligned with SERVICE_CALL_BUCKETS_MS + a trailing `+Inf` slot
  // (Prometheus histograms are cumulative: each `le="X"` includes
  // every observation ≤ X). Keyed by `type|impl` so service-call
  // latency can be sliced per backing plugin.
  const svcDurBuckets: Record<string, number[]> = {}

  for (const e of hub.transcript.all()) {
    if (e.kind === 'task_result') {
      taskCounts[e.data.kind] = (taskCounts[e.data.kind] ?? 0) + 1
    } else if (e.kind === 'service_call') {
      const d = e.data as { type: string; impl: string; outcome: string; durationMs: number }
      const okey = `${d.type}|${d.impl}|${d.outcome}`
      svcCalls[okey] = (svcCalls[okey] ?? 0) + 1
      const dkey = `${d.type}|${d.impl}`
      // Prometheus convention: durations are non-negative. Clamp at zero to
      // defend against clock skew (Date.now() going backwards mid-call) and
      // bogus client-reported negatives. Without this, sum-counters can
      // decrease across scrapes — a violation that breaks rate() queries.
      const dur =
        Number.isFinite(d.durationMs) && d.durationMs >= 0 ? d.durationMs : 0
      svcDurSum[dkey] = (svcDurSum[dkey] ?? 0) + dur
      svcDurCnt[dkey] = (svcDurCnt[dkey] ?? 0) + 1
      // Bucket the observation. Cumulative semantics: increment every
      // bucket whose upper bound is ≥ the duration, including the
      // trailing +Inf slot (index = SERVICE_CALL_BUCKETS_MS.length).
      let buckets = svcDurBuckets[dkey]
      if (!buckets) {
        buckets = new Array(SERVICE_CALL_BUCKETS_MS.length + 1).fill(0)
        svcDurBuckets[dkey] = buckets
      }
      for (let i = 0; i < SERVICE_CALL_BUCKETS_MS.length; i++) {
        if (dur <= SERVICE_CALL_BUCKETS_MS[i]!) buckets[i]! += 1
      }
      // Trailing slot is the +Inf bucket and is always initialised
      // to 0 by `new Array(...).fill(0)` above — the non-null
      // assertion just tells TS what we already know.
      buckets[SERVICE_CALL_BUCKETS_MS.length]! += 1 // +Inf — matches everything
    }
  }
  pendingApps = hub.pendingApplications().length

  w(
    '# HELP aipehub_tasks_total Tasks that reached a terminal state, by kind.',
    '# TYPE aipehub_tasks_total counter',
  )
  for (const [kind, n] of Object.entries(taskCounts)) {
    w(`aipehub_tasks_total{kind="${escapeLabel(kind)}"} ${n}`)
  }
  w('')

  w(
    '# HELP aipehub_pending_applications Unresolved admission applications waiting on admin.',
    '# TYPE aipehub_pending_applications gauge',
    `aipehub_pending_applications ${pendingApps}`,
    '',
  )

  // --- SERVICE_CALL counters --------------------------------------------------
  w(
    '# HELP aipehub_service_calls_total SERVICE_CALL frames resolved, by outcome.',
    '# TYPE aipehub_service_calls_total counter',
  )
  if (Object.keys(svcCalls).length === 0) {
    w('aipehub_service_calls_total 0')
  } else {
    for (const [key, n] of Object.entries(svcCalls)) {
      const [type, impl, outcome] = key.split('|') as [string, string, string]
      w(
        `aipehub_service_calls_total{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}",outcome="${escapeLabel(outcome)}"} ${n}`,
      )
    }
  }
  w('')

  w(
    '# HELP aipehub_service_call_duration_ms_sum Cumulative latency of all SERVICE_CALL frames.',
    '# TYPE aipehub_service_call_duration_ms_sum counter',
  )
  for (const [key, n] of Object.entries(svcDurSum)) {
    const [type, impl] = key.split('|') as [string, string]
    w(
      `aipehub_service_call_duration_ms_sum{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"} ${n}`,
    )
  }
  w('')

  w(
    '# HELP aipehub_service_call_duration_ms_count Count of SERVICE_CALL frames (mate of the _sum series).',
    '# TYPE aipehub_service_call_duration_ms_count counter',
  )
  for (const [key, n] of Object.entries(svcDurCnt)) {
    const [type, impl] = key.split('|') as [string, string]
    w(
      `aipehub_service_call_duration_ms_count{type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"} ${n}`,
    )
  }
  w('')

  // --- SERVICE_CALL latency histogram ----------------------------------------
  // Buckets enable Prometheus `histogram_quantile()` for p50 / p95 /
  // p99 latencies. The naming and shape follow Prom convention: emit
  // each `<metric>_bucket{le="..."}` line cumulatively, with `+Inf` as
  // the topmost slot. Sum / count are deliberately re-used from the
  // existing `_sum` / `_count` counters above — Prometheus accepts
  // both pre-existing and re-declared metrics, and we already emit
  // them with the same names a histogram would.
  w(
    '# HELP aipehub_service_call_duration_ms Histogram of SERVICE_CALL frame durations (ms), cumulative buckets.',
    '# TYPE aipehub_service_call_duration_ms histogram',
  )
  if (Object.keys(svcDurBuckets).length === 0) {
    // Emit a single +Inf zero-count bucket so the metric exists from
    // the very first scrape (some dashboards complain about
    // \"no data\" if the series never appears).
    w('aipehub_service_call_duration_ms_bucket{le="+Inf"} 0')
  } else {
    for (const [key, counts] of Object.entries(svcDurBuckets)) {
      const [type, impl] = key.split('|') as [string, string]
      const typeLabel = `type="${escapeLabel(type)}",impl="${escapeLabel(impl)}"`
      for (let i = 0; i < SERVICE_CALL_BUCKETS_MS.length; i++) {
        w(
          `aipehub_service_call_duration_ms_bucket{${typeLabel},le="${SERVICE_CALL_BUCKETS_MS[i]}"} ${counts[i]}`,
        )
      }
      w(
        `aipehub_service_call_duration_ms_bucket{${typeLabel},le="+Inf"} ${counts[SERVICE_CALL_BUCKETS_MS.length]}`,
      )
    }
  }
  w('')

  // --- HTTP responses (by status class) --------------------------------------
  // Only emitted when the caller supplied an HttpStats object — i.e.
  // when /metrics is being scraped from a live server. Tests and
  // out-of-band callers that pass just `hub` still get a clean output.
  if (opts.httpStats) {
    w(
      '# HELP aipehub_http_responses_total HTTP responses sent, bucketed by status class (2xx/3xx/4xx/5xx/other).',
      '# TYPE aipehub_http_responses_total counter',
    )
    const classes = opts.httpStats.byStatusClass
    if (classes.size === 0) {
      // Zero-row variant so /metrics has the series even before any
      // request arrives (rate() on a never-existed series returns
      // NaN; an explicit zero turns the dashboard into a clean line
      // at 0 rps).
      for (const klass of ['2xx', '3xx', '4xx', '5xx']) {
        w(`aipehub_http_responses_total{class="${klass}"} 0`)
      }
    } else {
      // Iterate the seen classes, plus emit zeros for any of the
      // canonical four that haven't seen traffic yet, so dashboards
      // querying \"rate(... {class='5xx'} [5m])\" don't return
      // NaN before the first 5xx appears.
      const canonical = ['2xx', '3xx', '4xx', '5xx']
      const seen = new Set(classes.keys())
      for (const klass of canonical) {
        const n = classes.get(klass) ?? 0
        w(`aipehub_http_responses_total{class="${klass}"} ${n}`)
        seen.delete(klass)
      }
      // Any non-canonical class ('other' / '1xx') the server saw.
      for (const klass of seen) {
        w(
          `aipehub_http_responses_total{class="${escapeLabel(klass)}"} ${classes.get(klass) ?? 0}`,
        )
      }
    }
  }
  // Trailing newline — Prometheus accepts both with/without, but the
  // de-facto convention is one.
  return lines.join('\n') + '\n'
}

// Prometheus label values: backslash, double-quote, and newline are
// the only chars that need escaping. Everything else is opaque.
function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// Stable string alias used inside `renderMetrics`. Hoisted so the
// label literal doesn't materialise per-scrape.
const PROTOCOL_VERSION_LITERAL: string = PROTOCOL_VERSION
