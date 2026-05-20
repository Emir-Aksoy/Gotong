# `monitoring/`

Prometheus alert rules + scrape config + Grafana dashboard for an AipeHub host.

| File | Drop into |
|---|---|
| `prometheus/aipehub.alerts.yml` | `rule_files` in your `prometheus.yml`. |
| `prometheus/scrape.example.yml` | Merge the `scrape_configs:` block into your `prometheus.yml`. |
| `grafana/aipehub-overview.json` | Grafana → Dashboards → Import → upload JSON. Pick your Prometheus datasource. |

The full setup story (token minting, file permissions, alert runbooks)
is in [`docs/MONITORING.md`](../docs/MONITORING.md).

## Minimum viable monitoring

If you're cutting corners on day-1 (which is fine), set up just these
two alerts and the dashboard — they catch the three most likely
deployment-killing failures:

| Catches | Alert | Setup |
|---|---|---|
| Process crashed / unreachable | `AipehubHostDown` | scrape /api/admin/metrics; alert fires after 2m |
| Disk filling (transcript growth) | `AipehubDiskAlmostFull` | needs node_exporter on the same host |
| Operator forgot the admin tab | `AipehubPendingApplicationsStale` | scrape alone is enough |

The other rules in `aipehub.alerts.yml` are useful but lower-priority —
add them as the deployment matures.
