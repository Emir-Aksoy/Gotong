# AipeHub liveness monitor

External watchdog that probes the host's `/healthz` from cron and pushes a
Feishu alert when the box goes **down** or **recovers**. It closes the
"nobody noticed the host died" gap that `systemd Restart=always` can't:
systemd restarts a *crashed* process, but it can't tell you about a process
that's **hung** (answering nothing), **crash-looping**, or a box whose
**disk filled up**. This script probes from outside the host process, so it
can still alert when the host itself is too dead to alert on its own behalf.

## Why external, not the in-process alert path

AipeHub *does* have an in-process alert delivery path (peer-summary
firings). But that path dies with the host — exactly when you most need a
page. A liveness watchdog must run in a **separate process**, driven by
cron. This is the one alert that can't be host-internal.

## Design

- **Edge-triggered.** Alerts once on `healthy→down` and once on
  `down→recovered`, tracked by a marker file in the state dir. A box that's
  been down for an hour with a 3-minute cron emits **one** page, not twenty.
  (Same firing lifecycle the codebase uses for peer-summary alerts.)
- **Never restarts anything.** systemd owns restart. A watchdog that also
  restarts fights the unit and masks flapping. This observes and alerts only.
- **Retries** before declaring down, so a transient blip doesn't page anyone.
- **No secrets in logs.** The Feishu webhook URL (the secret) is read from a
  0600 file or env var and is never written to the log or the alert text.

## Deploy on the host box (mirrors `backup-cron.sh`)

1. The repo is already on the box (e.g. `~/aipehub/app/`), so the script
   ships with it: `~/aipehub/app/scripts/monitor/healthcheck.sh`.

2. Create a Feishu **custom bot** in a group → copy its webhook URL → save it
   to a 0600 file (the URL is the secret, keep it off logs and out of git):

   ```bash
   install -m 600 /dev/stdin ~/aipehub/feishu-alert-webhook.txt <<<'https://open.feishu.cn/open-apis/bot/v2/hook/XXXX'
   ```

3. Thin cron wrapper `~/aipehub/healthcheck-cron.sh` (mirrors your
   `backup-cron.sh`):

   ```bash
   #!/usr/bin/env bash
   export FEISHU_WEBHOOK_FILE="$HOME/aipehub/feishu-alert-webhook.txt"
   export AIPE_WEB_PORT=3000          # match your host config
   exec "$HOME/aipehub/app/scripts/monitor/healthcheck.sh" "$HOME/aipehub/monitor-state"
   ```
   `chmod +x ~/aipehub/healthcheck-cron.sh`

4. Cron entry — every 3 minutes:

   ```cron
   */3 * * * * /home/ubuntu/aipehub/healthcheck-cron.sh >> /home/ubuntu/aipehub/monitor-state/cron.log 2>&1
   ```

5. Test it end-to-end: `~/aipehub/healthcheck-cron.sh` while the host is up
   (silent, exit 0), then `sudo systemctl stop aipehub` and run it again —
   you should get a Feishu "DOWN" message; `start` and run once more for the
   "RECOVERED" message.

## Tuning (env vars)

| var | default | meaning |
|---|---|---|
| `HEALTHCHECK_URL` | `http://127.0.0.1:${AIPE_WEB_PORT:-3000}/healthz` | full probe URL |
| `HEALTHCHECK_TIMEOUT` | `5` | per-try seconds |
| `HEALTHCHECK_RETRIES` | `3` | tries before declaring down |
| `HEALTHCHECK_RETRY_SLEEP` | `3` | seconds between tries |
| `FEISHU_WEBHOOK_FILE` | — | 0600 file holding the bot URL (preferred) |
| `FEISHU_WEBHOOK_URL` | — | the bot URL directly (less safe than a file) |
| `HEALTHCHECK_LABEL` | `hostname` | name shown in the alert |

With no webhook configured the script runs **log-only** (state changes to the
log, no push) — a valid degraded mode for a box you watch by hand.

> Probes `/healthz` (liveness), not `/readyz` (readiness). A slow-booting
> host that hasn't finished resuming workflows is *alive* — you don't want a
> page (or a restart) for that. See `packages/web/src/server.ts` `/healthz`.
