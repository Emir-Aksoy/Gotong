# Gotong liveness monitor

External watchdog that probes the host's `/healthz` from cron and pushes a
Feishu alert when the box goes **down** or **recovers**. It closes the
"nobody noticed the host died" gap that `systemd Restart=always` can't:
systemd restarts a *crashed* process, but it can't tell you about a process
that's **hung** (answering nothing), **crash-looping**, or a box whose
**disk filled up**. This script probes from outside the host process, so it
can still alert when the host itself is too dead to alert on its own behalf.

## Why external, not the in-process alert path

Gotong *does* have an in-process alert delivery path (peer-summary
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
- **No secrets in logs.** Whichever Feishu channel is used, the secret (app
  secret / bearer token / webhook URL) is read from env or a 0600 file and is
  never written to the log or the alert text.

## Two alert channels (tried in order)

The script picks the first channel that's configured:

1. **Feishu app bot** (`im/v1/messages`) — reuses the **same app the IM bridge
   already runs** (App ID / App Secret). Needs only the `im:message` scope — no
   `im:chat:*`, no custom-bot webhook. Pages a person by DM (`open_id`, an
   `ou_…` id) or a group (`chat_id`, an `oc_…` id). Use this when your Feishu
   tenant has **custom bots disabled** and only an app bot is available. The
   two-step token-fetch + send runs in the bundled `feishu-app-send.mjs`, so the
   App Secret never lands on a command line.
2. **Feishu custom-bot webhook** — a plain hook URL, when your tenant allows
   custom bots in a group.

If neither is configured the script runs **log-only**.

## Deploy on the host box (mirrors `backup-cron.sh`)

The two script files (`healthcheck.sh` + `feishu-app-send.mjs`) live **outside**
`app/` so a `git pull` / re-rsync of the source tree can't clobber them:

```bash
mkdir -p ~/gotong/monitor
cp ~/gotong/app/scripts/monitor/healthcheck.sh   ~/gotong/monitor/
cp ~/gotong/app/scripts/monitor/feishu-app-send.mjs ~/gotong/monitor/
chmod +x ~/gotong/monitor/healthcheck.sh
```

### Option A — Feishu app bot (this deployment)

Reuses the IM bridge's app (App ID / App Secret already in `~/gotong/gotong.env`)
and DMs the bound owner. No new bot, no console scope change — only `im:message`.

Thin cron wrapper `~/gotong/healthcheck-cron.sh` (mirrors `backup-cron.sh`).
It reads the two app creds out of `gotong.env` with `grep` (no `source` — the
env file has values with spaces) and pages an `open_id` (the owner's Feishu id,
read once from `im_bindings`):

```bash
#!/usr/bin/env bash
export NODE_BIN=/usr/local/bin/node
export GOTONG_LARK_APP_ID="$(grep -E '^GOTONG_LARK_APP_ID=' "$HOME/gotong/gotong.env" | head -1 | cut -d= -f2-)"
export GOTONG_LARK_APP_SECRET="$(grep -E '^GOTONG_LARK_APP_SECRET=' "$HOME/gotong/gotong.env" | head -1 | cut -d= -f2-)"
export FEISHU_ALERT_RECEIVE_ID="ou_xxxxxxxx"      # the bound owner's open_id
export FEISHU_ALERT_RECEIVE_ID_TYPE=open_id
export GOTONG_WEB_PORT=3000
export HEALTHCHECK_LABEL=gotong-prod
exec "$HOME/gotong/monitor/healthcheck.sh" "$HOME/gotong/monitor-state"
```
`chmod +x ~/gotong/healthcheck-cron.sh`

To find the owner's `open_id` (it's the Feishu `platform_user_id` of the bound
member):

```bash
sqlite3 ~/gotong/data/identity.sqlite \
  "SELECT platform_user_id FROM im_bindings WHERE platform='lark' LIMIT 1;"
```

### Option B — Feishu custom-bot webhook (if your tenant allows custom bots)

```bash
install -m 600 /dev/stdin ~/gotong/feishu-alert-webhook.txt <<<'https://open.feishu.cn/open-apis/bot/v2/hook/XXXX'
```
…then in the wrapper `export FEISHU_WEBHOOK_FILE="$HOME/gotong/feishu-alert-webhook.txt"`
instead of the app-bot vars.

### Cron entry — every 3 minutes

```cron
*/3 * * * * /home/ubuntu/gotong/healthcheck-cron.sh >> /home/ubuntu/gotong/monitor-state/cron.log 2>&1
```

### Smoke test (don't touch the real service)

Run the wrapper against a **dead port** with a **separate** state dir so the real
`.down` marker is untouched — a real DOWN alert should reach the owner's Feishu:

```bash
HEALTHCHECK_URL=http://127.0.0.1:59999/healthz HEALTHCHECK_RETRIES=1 \
  bash -c 'source <(grep -E "^export" ~/gotong/healthcheck-cron.sh | sed "s#monitor-state#monitor-state-test#"); \
           ~/gotong/monitor/healthcheck.sh ~/gotong/monitor-state-test'
```

A steady-state run (`~/gotong/healthcheck-cron.sh` while the host is up) is
silent and exits 0.

## Tuning (env vars)

| var | default | meaning |
|---|---|---|
| `HEALTHCHECK_URL` | `http://127.0.0.1:${GOTONG_WEB_PORT:-3000}/healthz` | full probe URL |
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
