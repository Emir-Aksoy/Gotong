# Monitoring + alerting

Gotong ships Prometheus-format metrics at `GET /metrics`, gated by a
dedicated bearer token (`GOTONG_METRICS_TOKEN`, fail-closed); admins
see the same body at `/api/admin/metrics`. This doc covers: what's
exposed, how to scrape it, the ten recommended alert rules, and what
to do when each one fires.

If you only have 30 minutes, do the **minimum viable monitoring**
section. That's three rules + a dashboard, catches the three most
common deployment-killing failures, and you can grow from there.

---

## 1. What Gotong exports

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `gotong_protocol_version` | gauge | `version` | Info metric — always `1`, the label carries the wire-protocol version (e.g. `"1.2"`). |
| `gotong_participants` | gauge | `kind` | Live participant count. `kind` ∈ `agent`, `human`. |
| `gotong_tasks_total` | counter | `kind` | Tasks that reached a terminal state. `kind` ∈ `ok`, `failed`, `cancelled`, `no_participant`. Resets on host restart (by design — Prometheus expects this). |
| `gotong_pending_applications` | gauge | — | Unresolved admission applications waiting on admin. |
| `gotong_service_calls_total` | counter | `type`, `impl`, `outcome` | One row per service-call category. `type` ∈ `memory`/`artifact`/`datastore`/…; `outcome` ∈ `ok`/`forbidden`/`forbidden_method`/`error`/`timeout`. |
| `gotong_service_call_duration_ms_sum` | counter | `type`, `impl` | Cumulative ms across all completed SERVICE_CALL frames. Mate of `_count` for computing means. |
| `gotong_service_call_duration_ms_count` | counter | `type`, `impl` | Number of completed SERVICE_CALL frames. |
| `gotong_http_responses_total` | counter | `class` | HTTP responses from the hub's own web layer, bucketed by status class (`2xx`/`3xx`/`4xx`/`5xx`/`other`). |
| `gotong_workflow_runs` | gauge | `status` | Workflow run records on disk, by status (`done`/`failed`/`running`/…). Best-effort: collected from the run store at scrape time. |
| `gotong_suspended_tasks` | gauge | — | Tasks currently parked (suspended), awaiting resume — includes human-in-the-loop approvals that never auto-resume. |
| `gotong_llm_calls_total` | counter | `model` | LLM calls recorded in the usage ledger. The ledger is append-only, so these survive restarts (unlike `gotong_tasks_total`). |
| `gotong_llm_tokens_total` | counter | `model` | Total LLM tokens (input + output + cache) from the usage ledger. |
| `gotong_llm_cost_micros_total` | counter | `model` | LLM cost in integer micro-USD (`1e6` = $1) from the usage ledger. |
| `process_resident_memory_bytes` | gauge | — | The hub process's own RSS — exported directly, no node_exporter process collector needed. |

The `gotong_workflow_runs` / `gotong_suspended_tasks` / `gotong_llm_*`
families are best-effort business metrics: each family is collected
independently at scrape time, and a failure in one (e.g. an unreadable
run store) drops that family from the output rather than failing the
whole `/metrics` response.

What's **not** exposed (by design — keeps the binary small + focused):

- CPU / file descriptors / disk usage — those come from
  [node_exporter](https://github.com/prometheus/node_exporter)
  running on the same host (`node_filesystem_avail_bytes` etc.).

This split is deliberate: the alert rules in
`monitoring/prometheus/gotong.alerts.yml` use Gotong-emitted metrics
for the application layer and node_exporter metrics (under
`job="node"`) for the OS-level disk concern. Both sides are wired up
by the `scrape.example.yml` recipe.

---

## 2. Setting up the scrape

The scrape route is `GET /metrics`, gated by a dedicated bearer
token (`GOTONG_METRICS_TOKEN`) — not by the admin session. Don't
mint a machine admin for Prometheus: a scraper should read metrics,
not hold an admin credential. The route is fail-closed — env var
unset → 404 (an unconfigured deployment exposes no anonymous
metrics); set but wrong/absent bearer → 401.

```bash
# 1. Generate a long random secret:
openssl rand -hex 32 > /tmp/gotong.token

# 2. On the Gotong host: set GOTONG_METRICS_TOKEN to that value in
#    the hub's environment (systemd `Environment=` /
#    `EnvironmentFile=`, or your wrapper script) and restart the hub.

# 3. Push the same token to your Prometheus box as a 0600 file:
scp /tmp/gotong.token prometheus-host:/etc/prometheus/gotong.token
ssh prometheus-host 'sudo chown prometheus:prometheus /etc/prometheus/gotong.token && sudo chmod 0600 /etc/prometheus/gotong.token'
rm /tmp/gotong.token
```

Rotation = generate a new secret and swap both sides (host env +
token file); no Prometheus restart needed — `bearer_token_file` is
re-read on every scrape.

Then merge the contents of
[`monitoring/prometheus/scrape.example.yml`](../monitoring/prometheus/scrape.example.yml)
into your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: gotong
    metrics_path: /metrics
    scheme: https
    bearer_token_file: /etc/prometheus/gotong.token
    static_configs:
      - targets: ['hub.example.com:443']
  - job_name: node
    static_configs:
      - targets: ['hub.example.com:9100']
```

Prefer zero assembly?
[`monitoring/docker-compose.yml`](../monitoring/docker-compose.yml)
brings up Prometheus + Alertmanager + Grafana pre-wired to this same
mechanism — see [`monitoring/README.md`](../monitoring/README.md).

Reload Prometheus (`curl -X POST .../-/reload` or restart) and confirm
the targets are `UP` in the Prometheus UI under
**Status → Targets**.

---

## 3. Alert rules

[`monitoring/prometheus/gotong.alerts.yml`](../monitoring/prometheus/gotong.alerts.yml)
ships **ten rules in two groups**: nine `gotong-core` (Hub-only —
including RSS, which the hub exports itself), one `gotong-host`
(OS-level disk via node_exporter).

### `gotong-core` — application

| Alert | Severity | Fires when | Typical cause |
|---|---|---|---|
| `GotongHostDown` | page | scrape fails for 2 min | process crashed, port closed, token rotated, network partition |
| `GotongTaskFailureRateHigh` | ticket | `rate(failed)` > 0.1/sec for 10 min | provider API key expired, downstream service outage, buggy agent |
| `GotongNoMatchingAgent` | ticket | `>5 no_participant` in 15 min | agent went offline silently, mis-typed capability |
| `GotongPendingApplicationsStale` | ticket | `>5 pending` for 30 min | admin forgot the admissions tab |
| `GotongServiceCallSlow` | ticket | mean latency `>500 ms` for 10 min | SQLite contention, disk full, slow upstream |
| `GotongHttp5xxRateHigh` | ticket | 5xx `>0.05/sec` for 10 min | a route is crashing — bad surface wiring, store exception |
| `GotongSuspendedTasksBacklog` | ticket | `>20` parked for 2 h | inbox approvals ignored, resume sweep failing |
| `GotongLlmSpendBurnHigh` | ticket | `>$5`/hour sustained 30 min | agent retry loop, oversized context, leaked key |
| `GotongProcessRssCreep` | ticket | hub RSS `>2 GB` for 30 min | slow leak in a plugin / long-running session |

### `gotong-host` — OS (requires node_exporter)

| Alert | Severity | Fires when | Typical cause |
|---|---|---|---|
| `GotongDiskAlmostFull` | page | root fs `<10 %` free for 15 min | transcript / runs / ledger growth without retention knobs |

---

## 4. Runbooks

### Host down (`GotongHostDown`)

```bash
# 1. Can the box ping at all?
ssh hub.example.com 'systemctl status gotong-host'

# 2. If the service is running but Prometheus can't reach it,
#    check the token (404 = GOTONG_METRICS_TOKEN unset on the host,
#    401 = token file no longer matches the host env):
curl -s -H "Authorization: Bearer $(cat /etc/prometheus/gotong.token)" \
     https://hub.example.com/metrics | head

# 3. If the service is dead, check the logs:
ssh hub.example.com 'journalctl -u gotong-host -n 200 --no-pager'

# 4. Restart:
ssh hub.example.com 'sudo systemctl restart gotong-host'
```

If the service won't come up at all, your backup is your friend —
see [`docs/OPERATIONS.md`](OPERATIONS.md) § Disaster recovery.

### Task failure spike (`GotongTaskFailureRateHigh`)

```bash
# 1. What kind of failures? Check `gotong_tasks_total` by kind to
#    see if it's all `failed` or also `no_participant` / `cancelled`.
#    `failed` = the agent ran and threw. `no_participant` = the
#    capability matched nothing.

# 2. If `failed`, check the most recent transcript entries via the
#    admin UI or:
curl -s -H "Authorization: Bearer $(cat /etc/prometheus/gotong.token)" \
     "https://hub.example.com/metrics" | grep tasks_total

# 3. Most common: an LLM provider key expired. Re-save in the admin
#    UI under "Secrets" or via Space.setProviderApiKey.

# 4. Second most common: a downstream HTTP service the agent depends
#    on is failing. Check its own SLO dashboard.
```

### No matching agent (`GotongNoMatchingAgent`)

```bash
# 1. Who's online?
#    gotong_participants by kind = current count.
#    If "agent" dropped suddenly, an agent crashed or got unregistered.

# 2. List participants from the admin UI or via SDK:
#    (in node)
#    const ps = hub.participants()
#    console.log(ps.map(p => ({ id: p.id, kind: p.kind, caps: p.capabilities })))

# 3. Restart the missing agent. Templated agents under
#    LocalAgentPool auto-respawn on host restart; remote SDK
#    workers re-connect on their own retry loop.

# 4. If the capability being dispatched is genuinely new (someone
#    added it in a workflow / template), register an agent that
#    declares it.
```

### Pending applications (`GotongPendingApplicationsStale`)

```bash
# 1. Open the admin UI → "Admissions" tab.
# 2. Approve or reject each pending row. Each one is a remote SDK
#    worker waiting at the door.
# 3. If the queue keeps refilling, someone is running a bad SDK
#    client retry loop. Look at Hub logs for the source IP and
#    talk to whoever's running it.
```

### Service call slow (`GotongServiceCallSlow`)

```bash
# 1. Which service is slow? The alert label tells you (type/impl).
# 2. `datastore/sqlite` slow → check disk. df -h. iostat 1 5.
# 3. `memory/file` slow → atypical; usually disk too.
# 4. `artifact/file` slow → either disk or a huge blob someone
#    just stored. Check the artifact directory size.
# 5. Worst case: service plugin process is wedged → restart the
#    host (transcript persists; service state persists; only
#    in-flight calls are lost).
```

### HTTP 5xx (`GotongHttp5xxRateHigh`)

```bash
# 1. 5xx means the hub's own web layer threw — not client error.
#    Check host logs for the stack trace + route:
ssh hub.example.com 'journalctl -u gotong-host -n 200 --no-pager | grep -i error'

# 2. Common causes: a surface dependency (identity DB, run store)
#    went unreadable; disk full; a just-deployed regression.
# 3. If it started right after a deploy, roll back and file it.
```

### Suspended backlog (`GotongSuspendedTasksBacklog`)

```bash
# 1. Parked tasks fall into two camps:
#    a) Human-in-the-loop approvals (never auto-resume) — someone
#       needs to handle their /me inbox. Ping the assignees.
#    b) Timed resumes (resumeAt in the past but still parked) —
#       the resume sweep is failing. Check host logs for
#       "resume" errors. The sweep runs every GOTONG_RESUME_SWEEP_MS
#       (default 30s) whenever identity is wired.
# 2. The admin UI task list shows which tasks are parked and why.
```

### LLM burn (`GotongLlmSpendBurnHigh`)

```bash
# 1. Open the admin UI → "用量" (Usage) dashboard. Group by
#    user / agent / workflow / model to find the spender.
# 2. Agent retry loop → cancel the task, fix the agent.
# 3. Unknown user/agent → possible leaked key. Rotate the provider
#    key in the vault and check the audit log.
# 4. Legitimate growth → raise the alert threshold and, if needed,
#    set per-user/org token + cost quotas (fail-closed).
```

### Disk almost full (`GotongDiskAlmostFull`)

```bash
# 1. Biggest contributors in .gotong/ are the transcript, run
#    records, and the identity DB (append-only ledger/audit).
ssh hub.example.com 'du -h /var/lib/gotong/.gotong/* | sort -h'

# 2. Built-in retention knobs (set as env, applied at boot):
#    GOTONG_TRANSCRIPT_KEEP_SEGMENTS / GOTONG_TRANSCRIPT_ARCHIVE_DAYS
#    GOTONG_RUN_KEEP / GOTONG_RUN_ARCHIVE_DAYS
#    GOTONG_LEDGER_KEEP_DAYS / GOTONG_AUDIT_KEEP_DAYS
#    GOTONG_ALERT_FIRINGS_KEEP_DAYS / GOTONG_PEER_SUMMARY_KEEP_DAYS
#    See docs/OPERATIONS.md § Retention for semantics.

# 3. Manual fallback: stop host, gzip old transcript segments /
#    archived runs, start. Archives are immutable once rotated.

# 4. After freeing space, confirm `node_filesystem_avail_bytes`
#    climbs back above 10 %.
```

### Process RSS creep (`GotongProcessRssCreep`)

```bash
# 1. Heap dump if you want to debug:
ssh hub.example.com 'kill -USR2 $(pgrep -f gotong-host)'
# Node will print a heap-snapshot path you can copy back and load
# in Chrome DevTools.

# 2. Pragmatic fix while you investigate: rolling restart.
#    Transcript persists; in-flight tasks fail (the SDK retries).
ssh hub.example.com 'sudo systemctl restart gotong-host'

# 3. File a ticket with the heap snapshot + the version you were
#    running (visible at /healthz or via gotong-host --version).
```

---

## 5. Grafana dashboard

[`monitoring/grafana/gotong-overview.json`](../monitoring/grafana/gotong-overview.json)
is a 12-panel single-screen overview:

| Panel | Query |
|---|---|
| Host up | `up{job="gotong"}` (stat with UP/DOWN color mapping) |
| Pending applications | `gotong_pending_applications` (stat with thresholds) |
| Participants by kind | `gotong_participants` (stat split by `kind` label) |
| Task throughput (5m rate, stacked by kind) | `sum by (kind) (rate(gotong_tasks_total[5m]))` |
| Task failure rate (5m) | `sum(rate(gotong_tasks_total{kind!="ok"}[5m]))` |
| Service-call mean latency (5m) | `increase(_sum[5m]) / clamp_min(increase(_count[5m]), 1)` |
| Service-call outcomes (5m rate) | `sum by (outcome) (rate(gotong_service_calls_total[5m]))` |
| HTTP responses by status class (5m rate) | `sum by (class) (rate(gotong_http_responses_total[5m]))` (5xx forced red) |
| LLM spend $/hour by model | `sum by (model) (increase(gotong_llm_cost_micros_total[1h])) / 1e6` |
| Workflow runs by status | `gotong_workflow_runs` (stat split by `status`) |
| Suspended (parked) tasks | `gotong_suspended_tasks` (stat with thresholds at 10/20) |
| LLM calls last 1h by model | `sum by (model) (increase(gotong_llm_calls_total[1h]))` |

Import via **Dashboards → Import → upload JSON** and select your
Prometheus datasource on the templating prompt.

---

## 6. Minimum viable monitoring

Day-1 cut: don't try to wire up everything at once. Get these
three signals running first, and grow over the next few weeks:

| Signal | Setup time | Pages on |
|---|---|---|
| **Host up** | 5 min | scrape config + `GotongHostDown` rule |
| **Disk filling** | 10 min | install node_exporter + `GotongDiskAlmostFull` rule |
| **Operator forgot the admin tab** | 0 min | `GotongPendingApplicationsStale` is already covered by the rule file |

If your host has those three covered, you'll catch ~80 % of the
real-world failure modes for a small-team deployment. The other seven
rules add coverage but aren't blockers for "good enough to launch."
