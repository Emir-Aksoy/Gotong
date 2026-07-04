#!/usr/bin/env bash
# Gotong liveness monitor — probe /healthz, alert on state change.
#
# Run this from cron on the host box (every few minutes). It is the
# external watchdog that closes the "no-one notices the host died" gap:
# systemd's `Restart=always` already restarts a *crashed* process, but it
# can't tell you about a process that is hung (answering nothing), stuck in
# a crash-restart loop, or a box whose disk filled up. This script catches
# those by probing the HTTP liveness endpoint from *outside* the host
# process — so it can still raise an alert when the host itself is too dead
# to alert on its own behalf.
#
# Design choices:
#
#   - EXTERNAL, not host-internal. Gotong has an in-process alert delivery
#     path (peer-summary firings), but that path dies with the host. A
#     watchdog must live in a separate process, driven by cron, or it can't
#     report the one failure that matters most: the host being down.
#
#   - EDGE-TRIGGERED, not level-triggered. We alert once on healthy->down
#     and once on down->recovered, tracked via a marker file in the state
#     dir. A box that's been down for an hour with a 3-minute cron must not
#     emit 20 identical alerts. (Same firing lifecycle the codebase uses for
#     peer-summary alerts: open once, resolve once.)
#
#   - DOES NOT restart anything. systemd owns restart (`Restart=always`).
#     A watchdog that also restarts would fight the unit and mask flapping.
#     We observe and alert; the operator (or systemd) acts.
#
#   - RETRIES before declaring down, so a single transient blip (a GC pause,
#     a momentary port hiccup) doesn't page anyone.
#
#   - The alert channel has two modes, tried in order:
#       1. Feishu APP BOT (im/v1/messages) — the same app the IM bridge uses
#          (App ID/Secret), needing only the `im:message` scope. Sends a DM
#          (receive_id_type=open_id) or a group message (chat_id). Use this
#          when the tenant has no custom-bot webhook. The token fetch + send is
#          done by the bundled `feishu-app-send.mjs` so the App Secret never
#          lands on a command line.
#       2. Feishu CUSTOM-BOT webhook — a plain hook URL (secret-grade: it holds
#          the hook id), read from a 0600 file or an env var.
#     Either secret is read from env/file and is NEVER written to the log or
#     the alert text. No other secret is touched. Alert text is plain human
#     prose with a hostname + timestamp; no tokens, no payloads.
#
# Usage:
#   ./healthcheck.sh <state-dir>
#
# All tuning is via environment variables (12-factor, cron-friendly):
#   HEALTHCHECK_URL          full probe URL   (default http://127.0.0.1:${GOTONG_WEB_PORT:-3000}/healthz)
#   HEALTHCHECK_TIMEOUT      per-try seconds  (default 5)
#   HEALTHCHECK_RETRIES      tries before down(default 3)
#   HEALTHCHECK_RETRY_SLEEP  seconds between  (default 3)
#   HEALTHCHECK_LABEL        name shown in the alert (default: `hostname`)
#   --- mode 1: Feishu app bot (preferred when there's no custom-bot webhook) ---
#   GOTONG_LARK_APP_ID         Feishu app id     (the same app the IM bridge uses)
#   GOTONG_LARK_APP_SECRET     Feishu app secret (read by the node helper only)
#   FEISHU_ALERT_RECEIVE_ID  who to page: an open_id (ou_…) or a chat_id (oc_…)
#   FEISHU_ALERT_RECEIVE_ID_TYPE  open_id (default) | chat_id | user_id | email
#   NODE_BIN                 node binary for the helper       (default `node`)
#   FEISHU_APP_SENDER        path to feishu-app-send.mjs (default: next to this script)
#   --- mode 2: Feishu custom-bot webhook ---
#   FEISHU_WEBHOOK_URL       Feishu bot hook URL (the secret itself)
#   FEISHU_WEBHOOK_FILE      path to a 0600 file holding the URL (preferred)
#
# If no app-bot creds (+ receive id) and no webhook are configured, the script
# runs in LOG-ONLY mode (state changes go to the log, no push). That's a valid
# degraded mode for a box you watch by hand — it warns once.
#
# Exit codes:
#   0 — host is up (this run)
#   1 — usage / arg error
#   2 — host is down (this run)            (cron can mail non-zero if you want)

set -euo pipefail

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <state-dir>

  <state-dir>   Writable dir for the down-marker + log (e.g. ~/gotong/monitor-state).
                Created if missing.

Configuration is via env vars — see the header of this script.
Set FEISHU_WEBHOOK_FILE (a 0600 file holding your Feishu bot URL) to enable
push alerts; otherwise the script logs state changes only.
EOF
  exit 1
}

[ "$#" -eq 1 ] || usage
STATE_DIR="$1"

URL="${HEALTHCHECK_URL:-http://127.0.0.1:${GOTONG_WEB_PORT:-3000}/healthz}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-5}"
RETRIES="${HEALTHCHECK_RETRIES:-3}"
RETRY_SLEEP="${HEALTHCHECK_RETRY_SLEEP:-3}"
LABEL="${HEALTHCHECK_LABEL:-$(hostname 2>/dev/null || echo gotong-host)}"

mkdir -p "$STATE_DIR"
MARKER="$STATE_DIR/.down"
LOG="$STATE_DIR/healthcheck.log"

now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log() {
  # Append one line to the log AND echo to stdout so cron mail / journald
  # picks it up too. Never log the webhook URL.
  printf '%s  %s\n' "$(now)" "$1" | tee -a "$LOG"
}

# Resolve the webhook URL (the secret). Prefer the 0600 file over an env var
# so it isn't visible in `ps eww` / the process environment of a child.
resolve_webhook() {
  if [ -n "${FEISHU_WEBHOOK_FILE:-}" ] && [ -f "$FEISHU_WEBHOOK_FILE" ]; then
    # First non-empty, non-comment line.
    grep -m1 -E '^[[:space:]]*https?://' "$FEISHU_WEBHOOK_FILE" 2>/dev/null | tr -d '[:space:]' || true
    return
  fi
  printf '%s' "${FEISHU_WEBHOOK_URL:-}"
}

# Feishu APP-BOT delivery (im/v1/messages). The same app the IM bridge uses,
# needing only the `im:message` scope. Delegates token-fetch + send to the
# bundled node helper so the App Secret never lands on a command line; the text
# is piped in on stdin. Returns 0 when app-bot mode is configured (delivery
# attempted, outcome logged) so the caller does NOT also fire the webhook; 1
# when it is not configured (caller falls through). Best-effort: a failed send
# is logged, never fatal.
NODE_BIN="${NODE_BIN:-node}"
APP_SENDER="${FEISHU_APP_SENDER:-$(cd "$(dirname "$0")" && pwd)/feishu-app-send.mjs}"

try_app_bot() {
  local text="$1"
  [ -n "${GOTONG_LARK_APP_ID:-}" ] && [ -n "${GOTONG_LARK_APP_SECRET:-}" ] \
    && [ -n "${FEISHU_ALERT_RECEIVE_ID:-}" ] && [ -f "$APP_SENDER" ] || return 1
  if printf '%s' "$text" | "$NODE_BIN" "$APP_SENDER" >/dev/null 2>&1; then
    log "alert delivered via Feishu app bot (im/v1/messages)"
  else
    log "alert delivery via Feishu app bot FAILED — host state still recorded"
  fi
  return 0
}

# Send an alert. Arg 1 = message text. Tries the app bot, then the custom-bot
# webhook, then log-only. Best-effort throughout: a dead channel must never
# abort the watchdog (then it couldn't update its own state and would re-alert
# forever). We log the delivery outcome, never any secret.
send_alert() {
  local text="$1" hook
  # Mode 1: Feishu app bot.
  if try_app_bot "$text"; then return 0; fi
  # Mode 2: Feishu custom-bot webhook.
  hook="$(resolve_webhook)"
  if [ -z "$hook" ]; then
    log "ALERT (log-only, no channel configured): $text"
    return 0
  fi
  # Feishu custom-bot text message. JSON-escape the text minimally (it's our
  # own prose: hostname + ISO timestamp + ASCII — no quotes/backslashes).
  local body
  body=$(printf '{"msg_type":"text","content":{"text":"%s"}}' "$text")
  local code
  code=$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' \
           -X POST -H 'Content-Type: application/json' \
           -d "$body" "$hook" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    log "alert delivered to Feishu (http 200)"
  else
    log "alert delivery FAILED (http $code) — host state still recorded"
  fi
}

# Probe the URL up to RETRIES times. Returns 0 (up) as soon as one try is
# 200; returns 1 (down) only after every try fails. `|| true` keeps the
# curl exit code from tripping `set -e`.
probe_up() {
  local i code
  for (( i = 1; i <= RETRIES; i++ )); do
    code=$(curl -fsS -m "$TIMEOUT" -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      return 0
    fi
    if [ "$i" -lt "$RETRIES" ]; then
      sleep "$RETRY_SLEEP"
    fi
  done
  return 1
}

if probe_up; then
  # UP. If we were previously DOWN, this is the recovery edge — alert once
  # and clear the marker. Otherwise stay quiet (steady-state healthy).
  if [ -f "$MARKER" ]; then
    log "RECOVERED: $LABEL /healthz is answering again"
    send_alert "[Gotong] $LABEL RECOVERED — /healthz is answering again at $(now)."
    rm -f "$MARKER"
  fi
  exit 0
else
  # DOWN. Alert only on the healthy->down edge (marker absent). If the marker
  # already exists we've alerted; log the continued outage and stay quiet.
  if [ -f "$MARKER" ]; then
    log "still DOWN: $LABEL /healthz unreachable (already alerted)"
  else
    log "DOWN: $LABEL /healthz unreachable after $RETRIES tries"
    send_alert "[Gotong] $LABEL DOWN — /healthz unreachable after $RETRIES tries at $(now). Check: systemctl status gotong; journalctl -u gotong -n 50; df -h."
    : > "$MARKER"
  fi
  exit 2
fi
