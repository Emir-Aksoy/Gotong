#!/usr/bin/env bash
# Cloud-box perimeter checker for an Gotong deployment (GO-LIVE GL-4).
#
# Home-vs-cloud differences are 100% perimeter (see docs/zh/GO-LIVE.md §三).
# A home box on loopback behind NAT needs none of this; the moment a host is
# reachable from the public internet it gets scanned continuously. This script
# reads the *declared config* (an env file like /etc/gotong.env) plus a few
# host facts and flags every hole in the §七 IP-exposure risk table:
#
#   1. host bound to a public interface (0.0.0.0 / ::) instead of loopback
#   2. GOTONG_ALLOW_INSECURE on — the "plaintext cookie on the public net" footgun
#   3. GOTONG_COOKIE_SECURE not 1 — session cookie sent in the clear
#   4. GOTONG_ALLOWED_HOSTS empty — CSRF / DNS-rebinding defense switched off
#   5. GOTONG_TRUST_PROXY not 1 — rate-limit can't see the real client IP
#   6. GOTONG_GATING=open — strangers' agents can walk in
#   7. master key on the data disk (provider != env, or KEK written plaintext)
#   8. admin login rate-limit not pinned
#   9. web/ws ports listening on a public interface (should be loopback-only)
#  10. fewer than 2 admins (single point of lockout)
#  11. no backup job in cron
#
# It NEVER mutates anything and NEVER calls sudo. Checks that genuinely need
# root (full firewall ruleset) degrade to an informational note telling you the
# exact command to run yourself — run those under sudo by hand. Missing tools
# (jq / ss / crontab) downgrade that one check to a warning, never a hard error.
#
# Usage:
#   ./scripts/cloud-harden.sh [ENV_FILE] [--space DIR] [--unit NAME]
#     ENV_FILE   path to the systemd EnvironmentFile (default: /etc/gotong.env)
#     --space    workspace dir for the admins.json check (default: $GOTONG_SPACE
#                from the env file, else /srv/gotong-data)
#     --unit     systemd unit to probe for an injected master key
#                (default: gotong)
#
# Exit codes:
#   0 — no red findings (warnings are fine)
#   1 — usage error
#   2 — env file not found / unreadable
#   3 — one or more FAIL findings (a real perimeter hole)

set -euo pipefail

ENV_FILE="/etc/gotong.env"
SPACE_OVERRIDE=""
UNIT="gotong"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --space)
      SPACE_OVERRIDE="${2:-}"
      shift 2
      ;;
    --space=*)
      SPACE_OVERRIDE="${1#--space=}"
      shift
      ;;
    --unit)
      UNIT="${2:-}"
      shift 2
      ;;
    --unit=*)
      UNIT="${1#--unit=}"
      shift
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 1
      ;;
    *)
      ENV_FILE="$1"
      shift
      ;;
  esac
done

if [ ! -r "$ENV_FILE" ]; then
  echo "✖ env file not found or unreadable: $ENV_FILE" >&2
  echo "  pass the path explicitly, e.g.: $(basename "$0") /etc/gotong.env" >&2
  exit 2
fi

FAILS=0
WARNS=0

fail() {
  echo "✖ FAIL: $1"
  [ -n "${2:-}" ] && echo "        ↳ $2"
  FAILS=$((FAILS + 1))
}
warn() {
  echo "⚠ WARN: $1"
  [ -n "${2:-}" ] && echo "        ↳ $2"
  WARNS=$((WARNS + 1))
}
pass() { echo "✓ $1"; }
info() { echo "ℹ $1"; }

# Read a KEY from the env file WITHOUT sourcing it (the file is config, not a
# script — never execute it). Last assignment wins, surrounding quotes stripped.
env_get() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  [ -z "$line" ] && return 0
  val="${line#*=}"
  val="${val%%#*}"                       # strip trailing inline comment
  val="${val#"${val%%[![:space:]]*}"}"   # ltrim
  val="${val%"${val##*[![:space:]]}"}"   # rtrim
  val="${val#\"}"; val="${val%\"}"       # strip double quotes
  val="${val#\'}"; val="${val%\'}"       # strip single quotes
  printf '%s' "$val"
}

echo "── Gotong cloud perimeter check ──"
echo "env file : $ENV_FILE"
echo

# 0. env file perms — it holds config (and maybe a token); not world-readable.
PERM="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')"
if [ -n "$PERM" ]; then
  # world bit = last octal digit
  if [ "$(( 0${PERM} & 0007 ))" -ne 0 ]; then
    warn "env file is world-readable (mode $PERM)" \
      "chmod 640 $ENV_FILE && chown gotong:gotong $ENV_FILE"
  else
    pass "env file not world-readable (mode $PERM)"
  fi
fi

# 1. Bind address — loopback only; Caddy is the only thing facing the world.
HOST="$(env_get GOTONG_HOST)"
case "$HOST" in
  127.* | localhost | ::1 | '[::1]')
    pass "GOTONG_HOST=$HOST (loopback — only a same-host reverse proxy reaches it)"
    ;;
  0.0.0.0 | :: | '[::]' | '*')
    fail "GOTONG_HOST=$HOST binds every interface — the host is directly on the net" \
      "bind 127.0.0.1 and put Caddy in front (TLS termination); see DEPLOY.md §C.5"
    ;;
  '')
    warn "GOTONG_HOST not set in $ENV_FILE" \
      "set GOTONG_HOST=127.0.0.1 explicitly so the host can't accidentally bind public"
    ;;
  *)
    warn "GOTONG_HOST=$HOST is a non-loopback address" \
      "prefer 127.0.0.1 behind Caddy; if intentional, ensure cookie/allowlist below are set"
    ;;
esac

# 2. The big footgun — plaintext on the public net.
INSECURE="$(env_get GOTONG_ALLOW_INSECURE)"
case "$INSECURE" in
  '' | 0 | false | no)
    pass "GOTONG_ALLOW_INSECURE is off (boot security stays fail-closed)"
    ;;
  *)
    fail "GOTONG_ALLOW_INSECURE=$INSECURE — downgrades the exposed-bind guard to a warning" \
      "remove it; fix TLS instead. On the public net this leaks plaintext cookies."
    ;;
esac

# 3. Secure cookie — sessions must never travel in the clear.
COOKIE="$(env_get GOTONG_COOKIE_SECURE)"
if [ "$COOKIE" = "1" ]; then
  pass "GOTONG_COOKIE_SECURE=1 (Secure + SameSite=Strict)"
else
  fail "GOTONG_COOKIE_SECURE is not 1 (got '${COOKIE:-unset}')" \
    "set GOTONG_COOKIE_SECURE=1 — required once anything but loopback can reach the host"
fi

# 4. Host allowlist — CSRF / DNS-rebinding defense (off when empty).
ALLOWED="$(env_get GOTONG_ALLOWED_HOSTS)"
if [ -n "$ALLOWED" ]; then
  pass "GOTONG_ALLOWED_HOSTS=$ALLOWED"
else
  fail "GOTONG_ALLOWED_HOSTS is empty — CSRF / DNS-rebinding defense is OFF" \
    "list every user-facing domain, e.g. GOTONG_ALLOWED_HOSTS=hub.example.com,hub-ws.example.com"
fi

# 5. Trust proxy — rate-limit by real client IP, not Caddy's.
TRUST="$(env_get GOTONG_TRUST_PROXY)"
if [ "$TRUST" = "1" ]; then
  pass "GOTONG_TRUST_PROXY=1 (rate-limit keys on the real client IP)"
else
  warn "GOTONG_TRUST_PROXY is not 1 (got '${TRUST:-unset}')" \
    "behind Caddy, set =1 so admin-login rate-limit sees X-Forwarded-For, not the proxy"
fi

# 6. Gating — never 'open' on the public net.
GATING="$(env_get GOTONG_GATING)"
case "$GATING" in
  open)
    fail "GOTONG_GATING=open — any agent can join unattended" \
      "use GOTONG_GATING=admin-approval on an exposed host"
    ;;
  '')
    info "GOTONG_GATING not set in $ENV_FILE (host default applies; admin-approval recommended)"
    ;;
  *)
    pass "GOTONG_GATING=$GATING (not open)"
    ;;
esac

# 7. Master key off the data disk — a stolen snapshot must not open the vault.
PROVIDER="$(env_get GOTONG_MASTER_KEY_PROVIDER)"
MKEY="$(env_get GOTONG_MASTER_KEY)"
case "$PROVIDER" in
  env)
    if [ -n "$MKEY" ]; then
      warn "GOTONG_MASTER_KEY is written plaintext in $ENV_FILE" \
        "inject it via a systemd secret instead; keep this file free of the KEK"
    else
      # Absent from this file is NOT proof it is injected elsewhere. With
      # provider=env and no key, the host THROWS at boot
      # (identity/crypto.ts resolveMasterKeyProvider). Calling that a pass
      # sent operators straight into a crash loop, so probe for a real
      # injection source and only claim what we can see.
      MK_SRC=""
      if command -v systemctl >/dev/null 2>&1 &&
        systemctl cat "$UNIT" >/dev/null 2>&1; then
        # `Environment=` from the unit + drop-ins. grep -q: never echo the KEK.
        if systemctl show "$UNIT" -p Environment --value 2>/dev/null |
          grep -q 'GOTONG_MASTER_KEY='; then
          MK_SRC="systemd Environment= (unit or drop-in)"
        fi
        if [ -z "$MK_SRC" ]; then
          # Other EnvironmentFile= entries — format: "/path (ignore_errors=no)".
          while read -r ef _rest; do
            [ -z "$ef" ] && continue
            [ "$ef" = "$ENV_FILE" ] && continue
            [ -r "$ef" ] || continue
            if grep -qE '^[[:space:]]*GOTONG_MASTER_KEY=.' "$ef"; then
              MK_SRC="EnvironmentFile=$ef"
              break
            fi
          done <<<"$(systemctl show "$UNIT" -p EnvironmentFiles --value 2>/dev/null | tr ' ' '\n' | grep '^/' || true)"
        fi
        if [ -n "$MK_SRC" ]; then
          pass "master key injected via $MK_SRC (not on the data disk — good)"
        else
          fail "GOTONG_MASTER_KEY_PROVIDER=env but no GOTONG_MASTER_KEY anywhere in unit '$UNIT'" \
            "the host will REFUSE TO BOOT — see docs/zh/PROD-HARDENING-RUNBOOK.md 「黄4 master key 移出数据盘」"
        fi
      else
        warn "provider=env and the KEK is not in $ENV_FILE — cannot confirm it is injected" \
          "no systemd unit '$UNIT' visible here (pass --unit NAME); if it is truly unset the host will refuse to boot"
      fi
    fi
    ;;
  '' | local-file)
    warn "master key provider is '${PROVIDER:-local-file (default)}' — KEK lives on the data disk" \
      "on a cloud box set GOTONG_MASTER_KEY_PROVIDER=env + inject GOTONG_MASTER_KEY from a secret"
    ;;
  *)
    info "GOTONG_MASTER_KEY_PROVIDER=$PROVIDER (non-default; ensure the KEK is not on the data disk)"
    ;;
esac

# 8. Admin login rate-limit pinned (defaults exist; explicit is auditable).
RMAX="$(env_get GOTONG_ADMIN_RATE_MAX)"
RSEC="$(env_get GOTONG_ADMIN_RATE_SEC)"
if [ -n "$RMAX" ] && [ -n "$RSEC" ]; then
  pass "admin rate-limit pinned (GOTONG_ADMIN_RATE_MAX=$RMAX / GOTONG_ADMIN_RATE_SEC=$RSEC)"
else
  warn "admin login rate-limit not pinned in $ENV_FILE" \
    "set GOTONG_ADMIN_RATE_MAX / GOTONG_ADMIN_RATE_SEC explicitly to throttle brute force"
fi

# 9. Listening sockets — the web/ws ports must not face the public interface.
WEB_PORT="$(env_get GOTONG_WEB_PORT)"; WEB_PORT="${WEB_PORT:-3000}"
WS_PORT="$(env_get GOTONG_WS_PORT)";   WS_PORT="${WS_PORT:-4000}"
if command -v ss >/dev/null 2>&1; then
  LISTEN="$(ss -tlnH 2>/dev/null || ss -tln 2>/dev/null || true)"
elif command -v netstat >/dev/null 2>&1; then
  LISTEN="$(netstat -tln 2>/dev/null || true)"
else
  LISTEN=""
fi
if [ -z "$LISTEN" ]; then
  warn "no ss/netstat available — could not inspect listening sockets" \
    "check by hand that ports $WEB_PORT/$WS_PORT bind 127.0.0.1, not 0.0.0.0"
else
  check_public_bind() {
    local port="$1" label="$2"
    # a public bind looks like 0.0.0.0:PORT or [::]:PORT or *:PORT
    if printf '%s\n' "$LISTEN" | grep -Eq "(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):${port}([[:space:]]|$)"; then
      fail "$label port $port is listening on a PUBLIC interface" \
        "bind it to 127.0.0.1 (GOTONG_HOST) and reverse-proxy via Caddy"
    elif printf '%s\n' "$LISTEN" | grep -Eq "(127\.0\.0\.1|\[::1\]):${port}([[:space:]]|$)"; then
      pass "$label port $port is loopback-only"
    else
      info "$label port $port not currently listening (host may be stopped)"
    fi
  }
  check_public_bind "$WEB_PORT" "web"
  check_public_bind "$WS_PORT" "ws"
  # 22/443 are expected; anything else public is worth a look.
  PUBLIC_PORTS="$(printf '%s\n' "$LISTEN" \
    | grep -Eo "(0\.0\.0\.0|\[::\]|\*):[0-9]+" \
    | grep -Eo "[0-9]+$" | sort -u | grep -Ev '^(22|443)$' || true)"
  if [ -n "$PUBLIC_PORTS" ]; then
    info "other public listeners (expected only 22/443): $(echo "$PUBLIC_PORTS" | tr '\n' ' ')"
    info "confirm the firewall only admits 443 + SSH — see DEPLOY.md §C.6:"
    info "    sudo ufw status        # or: sudo firewall-cmd --list-all"
  else
    pass "no unexpected public listeners (only 22/443 face out)"
  fi
fi

# 10. At least two admins — a single locked-out admin = permanent loss of control.
SPACE="$SPACE_OVERRIDE"
[ -z "$SPACE" ] && SPACE="$(env_get GOTONG_SPACE)"
[ -z "$SPACE" ] && SPACE="/srv/gotong-data"
ADMINS_JSON="$SPACE/admins.json"
if [ -r "$ADMINS_JSON" ]; then
  if command -v jq >/dev/null 2>&1; then
    COUNT="$(jq 'if type=="array" then length elif .admins then (.admins|length) else 0 end' \
      "$ADMINS_JSON" 2>/dev/null || echo 0)"
    if [ "${COUNT:-0}" -ge 2 ]; then
      pass "$COUNT admins configured (recovery path survives one lockout)"
    else
      warn "only ${COUNT:-0} admin(s) in $ADMINS_JSON" \
        "add a second admin; keep mint-admin-token (GO-LIVE §八) as the break-glass path"
    fi
  else
    info "jq not installed — skipped admin count ($ADMINS_JSON exists)"
  fi
else
  info "admins.json not found at $SPACE (pass --space DIR if your workspace is elsewhere)"
fi

# 11. Backup job — offsite backup is the difference between an incident and a loss.
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -Eq 'backup(\.sh)?'; then
    pass "a backup job is present in this user's crontab"
  else
    warn "no backup job found in this user's crontab" \
      "schedule scripts/backup/backup.sh (see OPERATIONS.md); run as the gotong user"
  fi
else
  info "crontab not available here — confirm scripts/backup/backup.sh is scheduled (cron/timer)"
fi

# 12. Monitoring — can't probe from here; just the reminder.
info "monitoring: confirm /healthz is watched + /metrics scraped (MONITORING.md, DEPLOY.md §C.12)"

echo
if [ "$FAILS" -gt 0 ]; then
  echo "✖ $FAILS fail / $WARNS warn — fix the red items before exposing this host."
  exit 3
fi
echo "✓ 0 fail / $WARNS warn — perimeter looks sound. Review any warnings above."
