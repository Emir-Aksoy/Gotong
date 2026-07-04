# `monitoring/`

Prometheus alert rules + scrape config + Alertmanager routing + Grafana
dashboard for an Gotong host.

## One-click stack (recommended)

```sh
cd monitoring
cp secrets/gotong.token.example secrets/gotong.token   # paste your token
docker compose up -d
```

Then on the **host**: set `GOTONG_METRICS_TOKEN` to the **same** value you put in
`secrets/gotong.token` and (re)start the hub, so `GET /metrics` serves to a
bearer holder. (That route is non-admin-gated by design — a scraper reads
metrics, it does not get an admin session. See `docs/zh/ledger/V4-PHASE19-P3-FINAL.md`
/ Route B P0-M7.)

| Service | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3001 | admin / admin; Gotong dashboard pre-loaded |
| Prometheus | http://localhost:9090 | scrape + rules; check **Status → Targets** |
| Alertmanager | http://localhost:9093 | severity routing (wire your on-call in `alertmanager/alertmanager.yml`) |

The compose stack runs **alongside** the hub — it does not start it. On
Docker Desktop / Linux it reaches a hub on the host's `:3000` and
node_exporter on `:9100` via the `host.docker.internal` gateway.

## Hand-rolled (merge into an existing Prometheus)

| File | Drop into |
|---|---|
| `prometheus/scrape.example.yml` | Merge the `scrape_configs:` block into your `prometheus.yml`. |
| `prometheus/gotong.alerts.yml` | `rule_files` in your `prometheus.yml`. |
| `alertmanager/alertmanager.yml` | Your Alertmanager config (routes `severity=page`/`ticket`). |
| `grafana/gotong-overview.json` | Grafana → Dashboards → Import → upload JSON. Pick your Prometheus datasource. |

The full setup story (token handling, file permissions, alert runbooks)
is in [`docs/MONITORING.md`](../docs/MONITORING.md).

## Minimum viable monitoring

If you're cutting corners on day-1 (which is fine), set up just these
two alerts and the dashboard — they catch the three most likely
deployment-killing failures:

| Catches | Alert | Setup |
|---|---|---|
| Process crashed / unreachable | `GotongHostDown` | scrape /metrics; alert fires after 2m |
| Disk filling (transcript growth) | `GotongDiskAlmostFull` | needs node_exporter on the same host |
| Operator forgot the admin tab | `GotongPendingApplicationsStale` | scrape alone is enough |

The other rules in `gotong.alerts.yml` are useful but lower-priority —
add them as the deployment matures.
