# Monitoring + alerting

AipeHub ships Prometheus-format metrics at `/api/admin/metrics` (admin-
gated). This doc covers: what's exposed, how to scrape it, the seven
recommended alert rules, and what to do when each one fires.

If you only have 30 minutes, do the **minimum viable monitoring**
section. That's three rules + a dashboard, catches the three most
common deployment-killing failures, and you can grow from there.

---

## 1. What AipeHub exports

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `aipehub_protocol_version` | gauge | `version` | Info metric — always `1`, the label carries the wire-protocol version (e.g. `"1.2"`). |
| `aipehub_participants` | gauge | `kind` | Live participant count. `kind` ∈ `agent`, `human`. |
| `aipehub_tasks_total` | counter | `kind` | Tasks that reached a terminal state. `kind` ∈ `ok`, `failed`, `cancelled`, `no_participant`. Resets on host restart (by design — Prometheus expects this). |
| `aipehub_pending_applications` | gauge | — | Unresolved admission applications waiting on admin. |
| `aipehub_service_calls_total` | counter | `type`, `impl`, `outcome` | One row per service-call category. `type` ∈ `memory`/`artifact`/`datastore`/…; `outcome` ∈ `ok`/`forbidden`/`forbidden_method`/`error`/`timeout`. |
| `aipehub_service_call_duration_ms_sum` | counter | `type`, `impl` | Cumulative ms across all completed SERVICE_CALL frames. Mate of `_count` for computing means. |
| `aipehub_service_call_duration_ms_count` | counter | `type`, `impl` | Number of completed SERVICE_CALL frames. |

What's **not** exposed (by design — keeps the binary small + focused):

- HTTP request rate / 5xx rate — for those, put a reverse proxy
  (Caddy, nginx) in front and scrape its access logs / built-in
  metrics.
- Process RSS / CPU / file descriptors — those come from
  [node_exporter](https://github.com/prometheus/node_exporter)
  running on the same host.
- Disk usage — same: node_exporter `node_filesystem_avail_bytes`.

This split is deliberate: the alert rules in
`monitoring/prometheus/aipehub.alerts.yml` use AipeHub-emitted metrics
for the application layer and node_exporter metrics (under
`job="node"`) for the OS layer. Both sides are wired up by the
`scrape.example.yml` recipe.

---

## 2. Setting up the scrape

The metrics endpoint is admin-gated. Don't reuse a human admin's
token — mint a dedicated machine admin and rotate it like any other
secret.

```bash
# On the host, mint a machine admin:
pnpm host -- mint-admin --display-name 'prometheus-scraper' > /tmp/scraper.out
TOKEN="$(grep -oE '[a-f0-9]{64}' /tmp/scraper.out)"

# Push the token to your Prometheus host as a 0600 file:
scp /tmp/scraper.out prometheus-host:/etc/prometheus/aipehub.token
ssh prometheus-host 'sudo chown prometheus:prometheus /etc/prometheus/aipehub.token && sudo chmod 0600 /etc/prometheus/aipehub.token'
```

Then merge the contents of
[`monitoring/prometheus/scrape.example.yml`](../monitoring/prometheus/scrape.example.yml)
into your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: aipehub
    metrics_path: /api/admin/metrics
    scheme: https
    bearer_token_file: /etc/prometheus/aipehub.token
    static_configs:
      - targets: ['hub.example.com:443']
  - job_name: node
    static_configs:
      - targets: ['hub.example.com:9100']
```

Reload Prometheus (`curl -X POST .../-/reload` or restart) and confirm
the targets are `UP` in the Prometheus UI under
**Status → Targets**.

---

## 3. Alert rules

[`monitoring/prometheus/aipehub.alerts.yml`](../monitoring/prometheus/aipehub.alerts.yml)
ships **seven rules in two groups**: five `aipehub-core` (Hub-only),
two `aipehub-host` (OS-level via node_exporter).

### `aipehub-core` — application

| Alert | Severity | Fires when | Typical cause |
|---|---|---|---|
| `AipehubHostDown` | page | scrape fails for 2 min | process crashed, port closed, token rotated, network partition |
| `AipehubTaskFailureRateHigh` | ticket | `rate(failed)` > 0.1/sec for 10 min | provider API key expired, downstream service outage, buggy agent |
| `AipehubNoMatchingAgent` | ticket | `>5 no_participant` in 15 min | agent went offline silently, mis-typed capability |
| `AipehubPendingApplicationsStale` | ticket | `>5 pending` for 30 min | admin forgot the admissions tab |
| `AipehubServiceCallSlow` | ticket | mean latency `>500 ms` for 10 min | SQLite contention, disk full, slow upstream |

### `aipehub-host` — OS (requires node_exporter)

| Alert | Severity | Fires when | Typical cause |
|---|---|---|---|
| `AipehubDiskAlmostFull` | page | root fs `<10 %` free for 15 min | transcript growth without retention |
| `AipehubProcessRssCreep` | ticket | hub process RSS `>2 GB` for 30 min | slow leak in a plugin / long-running session |

---

## 4. Runbooks

### Host down (`AipehubHostDown`)

```bash
# 1. Can the box ping at all?
ssh hub.example.com 'systemctl status aipehub-host'

# 2. If the service is running but Prometheus can't reach it,
#    check the token:
curl -s -H "Authorization: Bearer $(cat /etc/prometheus/aipehub.token)" \
     https://hub.example.com/api/admin/metrics | head

# 3. If the service is dead, check the logs:
ssh hub.example.com 'journalctl -u aipehub-host -n 200 --no-pager'

# 4. Restart:
ssh hub.example.com 'sudo systemctl restart aipehub-host'
```

If the service won't come up at all, your backup is your friend —
see [`docs/OPERATIONS.md`](OPERATIONS.md) § Disaster recovery.

### Task failure spike (`AipehubTaskFailureRateHigh`)

```bash
# 1. What kind of failures? Check `aipehub_tasks_total` by kind to
#    see if it's all `failed` or also `no_participant` / `cancelled`.
#    `failed` = the agent ran and threw. `no_participant` = the
#    capability matched nothing.

# 2. If `failed`, check the most recent transcript entries via the
#    admin UI or:
curl -s -H "Authorization: Bearer $TOKEN" \
     "https://hub.example.com/api/admin/metrics" | grep tasks_total

# 3. Most common: an LLM provider key expired. Re-save in the admin
#    UI under "Secrets" or via Space.setProviderApiKey.

# 4. Second most common: a downstream HTTP service the agent depends
#    on is failing. Check its own SLO dashboard.
```

### No matching agent (`AipehubNoMatchingAgent`)

```bash
# 1. Who's online?
#    aipehub_participants by kind = current count.
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

### Pending applications (`AipehubPendingApplicationsStale`)

```bash
# 1. Open the admin UI → "Admissions" tab.
# 2. Approve or reject each pending row. Each one is a remote SDK
#    worker waiting at the door.
# 3. If the queue keeps refilling, someone is running a bad SDK
#    client retry loop. Look at Hub logs for the source IP and
#    talk to whoever's running it.
```

### Service call slow (`AipehubServiceCallSlow`)

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

### Disk almost full (`AipehubDiskAlmostFull`)

```bash
# 1. Biggest file in .aipehub/ is usually transcript.jsonl.
ssh hub.example.com 'du -h /var/lib/aipehub/.aipehub/* | sort -h'

# 2. Two retention strategies:
#    a) Time-windowed compress: rotate transcript on a cron,
#       compress old segments. The Hub appends only, so a rotated
#       segment is immutable.
#    b) Wholesale: stop host, gzip transcript.jsonl, start. The
#       Hub starts a fresh transcript and the gz is your archive.

# 3. After freeing space, confirm `node_filesystem_avail_bytes`
#    climbs back above 10 %.
```

### Process RSS creep (`AipehubProcessRssCreep`)

```bash
# 1. Heap dump if you want to debug:
ssh hub.example.com 'kill -USR2 $(pgrep -f aipehub-host)'
# Node will print a heap-snapshot path you can copy back and load
# in Chrome DevTools.

# 2. Pragmatic fix while you investigate: rolling restart.
#    Transcript persists; in-flight tasks fail (the SDK retries).
ssh hub.example.com 'sudo systemctl restart aipehub-host'

# 3. File a ticket with the heap snapshot + the version you were
#    running (visible at /healthz or via aipehub-host --version).
```

---

## 5. Grafana dashboard

[`monitoring/grafana/aipehub-overview.json`](../monitoring/grafana/aipehub-overview.json)
is a 7-panel single-screen overview:

| Panel | Query |
|---|---|
| Host up | `up{job="aipehub"}` (stat with UP/DOWN color mapping) |
| Pending applications | `aipehub_pending_applications` (stat with thresholds) |
| Participants by kind | `aipehub_participants` (stat split by `kind` label) |
| Task throughput (5m rate, stacked by kind) | `sum by (kind) (rate(aipehub_tasks_total[5m]))` |
| Task failure rate (5m) | `sum(rate(aipehub_tasks_total{kind!="ok"}[5m]))` |
| Service-call mean latency (5m) | `increase(_sum[5m]) / clamp_min(increase(_count[5m]), 1)` |
| Service-call outcomes (5m rate) | `sum by (outcome) (rate(aipehub_service_calls_total[5m]))` |

Import via **Dashboards → Import → upload JSON** and select your
Prometheus datasource on the templating prompt.

---

## 6. Minimum viable monitoring

Day-1 cut: don't try to wire up everything at once. Get these
three signals running first, and grow over the next few weeks:

| Signal | Setup time | Pages on |
|---|---|---|
| **Host up** | 5 min | scrape config + `AipehubHostDown` rule |
| **Disk filling** | 10 min | install node_exporter + `AipehubDiskAlmostFull` rule |
| **Operator forgot the admin tab** | 0 min | `AipehubPendingApplicationsStale` is already covered by the rule file |

If your host has those three covered, you'll catch ~80 % of the
real-world failure modes for a small-team deployment. The other four
rules add coverage but aren't blockers for "good enough to launch."
