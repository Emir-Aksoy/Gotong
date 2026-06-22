#!/usr/bin/env bash
#
# cloud-quickstart.sh — provision an AipeHub host on a fresh Ubuntu/Debian VPS.
#
# One command turns a checkout on a clean box into a running systemd service:
# install Node + pnpm → build → create the service user + data dir → drop in
# /etc/aipehub.env (from deploy/.env.cloud) → install the systemd unit that
# MIRRORS docs/zh/DEPLOY.md §C.4 verbatim. It then prints the safe last mile.
#
#   sudo bash deploy/cloud-quickstart.sh              # provision, don't start
#   sudo bash deploy/cloud-quickstart.sh --start      # provision AND start
#   bash deploy/cloud-quickstart.sh --dry-run         # print every step, mutate nothing
#
# ── What it deliberately does NOT do ──────────────────────────────────────────
#
#   • It does NOT `git clone` for you. The repo is private; you put the code on
#     the box yourself (git clone with your key, or scp the checkout), then run
#     this FROM that checkout. There is no public URL to pull, and faking one
#     would just fail confusingly.
#   • It does NOT auto-expose an unconfigured box. /etc/aipehub.env ships with
#     the domain / master key / allowlist BLANK — starting before you fill them
#     would be insecure. So provisioning stops one step short: it tells you to
#     edit the env file and run scripts/cloud-harden.sh, then start. `--start`
#     is opt-in for when you've already filled it in.
#   • There is NO browser "one-click deploy" button. That needs a public repo or
#     a provider account pre-linked to your git — out of scope while the repo is
#     private. This copy-pasteable bootstrap is the real, testable equivalent.
#
# It reads NO credentials and writes NO secrets of its own — /etc/aipehub.env is
# a TEMPLATE with blank token/key fields you fill in afterward (from a systemd
# secret, never committed). Companion: scripts/cloud-harden.sh (perimeter check
# before you expose the box) and docs/zh/GO-LIVE.md (the full runbook).
#
# Exit codes: 0 ok · 1 usage · 2 must run as root · 3 environment unsupported.

set -euo pipefail

# ── defaults (override via flags) ─────────────────────────────────────────────
PREFIX="/opt/aipehub"          # where the built checkout lives (WorkingDirectory)
SPACE="/srv/aipehub-data"      # AIPE_SPACE — the persistent data dir (ReadWritePaths)
ENV_FILE="/etc/aipehub.env"    # systemd EnvironmentFile
SERVICE_USER="aipehub"
NODE_MAJOR="20"                # repo engines: node >=20 (LTS)
SOURCE_DIR=""                  # checkout to build from (default: this script's repo)
DRY_RUN=""
DO_START=""

usage() { sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --start) DO_START=1; shift ;;
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --source=*) SOURCE_DIR="${1#--source=}"; shift ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --space) SPACE="${2:-}"; shift 2 ;;
    --space=*) SPACE="${1#--space=}"; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#--env-file=}"; shift ;;
    --user) SERVICE_USER="${2:-}"; shift 2 ;;
    --user=*) SERVICE_USER="${1#--user=}"; shift ;;
    -*) echo "unknown option: $1" >&2; echo "try --help" >&2; exit 1 ;;
    *) echo "unexpected argument: $1" >&2; exit 1 ;;
  esac
done

# Resolve the checkout to build from: explicit --source, else walk up from this
# script for the monorepo root (pnpm-workspace.yaml + packages/host), same probe
# the desktop launchers use.
if [ -z "$SOURCE_DIR" ]; then
  SELF="${BASH_SOURCE[0]}"
  while [ -h "$SELF" ]; do
    d="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"
    SELF="$(readlink "$SELF")"
    case "$SELF" in /*) ;; *) SELF="$d/$SELF" ;; esac
  done
  here="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"
  while [ "$here" != "/" ]; do
    if [ -f "$here/pnpm-workspace.yaml" ] && [ -d "$here/packages/host" ]; then
      SOURCE_DIR="$here"; break
    fi
    here="$(dirname "$here")"
  done
fi
if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/pnpm-workspace.yaml" ]; then
  echo "✖ no AipeHub checkout found." >&2
  echo "  Put the code on this box (git clone with your key, or scp it), then run" >&2
  echo "  this script from inside it — or pass --source=/path/to/checkout." >&2
  exit 3
fi

# `run` is the single mutation seam: it echoes the command and, under --dry-run,
# skips it. So the entire provisioning flow is auditable / CI-testable on a box
# without root and without actually changing anything.
run() {
  echo "  + $*"
  [ -n "$DRY_RUN" ] && return 0
  "$@"
}
note() { echo "$*"; }

# Real mutations need root; --dry-run and --help do not.
if [ -z "$DRY_RUN" ] && [ "$(id -u)" -ne 0 ]; then
  echo "✖ provisioning mutates the system — run with sudo (or pass --dry-run to preview)." >&2
  exit 2
fi

echo "── AipeHub cloud quickstart ──"
echo "source   : $SOURCE_DIR"
echo "prefix   : $PREFIX        (WorkingDirectory / built code)"
echo "space    : $SPACE   (AIPE_SPACE / persistent data)"
echo "env file : $ENV_FILE"
echo "user     : $SERVICE_USER"
[ -n "$DRY_RUN" ] && echo "mode     : DRY-RUN (nothing will change)"
echo

# ── 1. Node.js (LTS) ──────────────────────────────────────────────────────────
echo "[1/6] Node.js ${NODE_MAJOR}.x"
have_node=""
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${cur:-0}" -ge "$NODE_MAJOR" ]; then
    note "  node $(node --version) already present — skipping install"
    have_node=1
  else
    note "  node $(node --version) is older than ${NODE_MAJOR} — upgrading"
  fi
fi
if [ -z "$have_node" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    run apt-get install -y nodejs
  else
    echo "  ✖ no node and no apt-get — install Node ${NODE_MAJOR}+ yourself, then re-run." >&2
    [ -z "$DRY_RUN" ] && exit 3
  fi
fi

# ── 2. pnpm (via corepack, pinned to packageManager) ──────────────────────────
echo "[2/6] pnpm (corepack)"
run corepack enable
# packageManager in package.json pins the exact pnpm; --activate makes it default.
PM="$(grep -E '"packageManager"' "$SOURCE_DIR/package.json" 2>/dev/null | sed -E 's/.*"(pnpm@[^"]+)".*/\1/' || true)"
run corepack prepare "${PM:-pnpm@latest}" --activate

# ── 3. service user + directories ─────────────────────────────────────────────
echo "[3/6] service user '$SERVICE_USER' + directories"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  note "  user '$SERVICE_USER' exists — skipping"
else
  run useradd --system --user-group --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
run mkdir -p "$PREFIX" "$SPACE"
run chown "$SERVICE_USER:$SERVICE_USER" "$SPACE"
run chmod 750 "$SPACE"

# ── 4. sync the checkout into $PREFIX, then install + build ────────────────────
echo "[4/6] install code at $PREFIX + build"
if [ "$SOURCE_DIR" != "$PREFIX" ]; then
  if command -v rsync >/dev/null 2>&1; then
    # exclude the install + git history + any local data dir; we reinstall fresh.
    run rsync -a --delete \
      --exclude node_modules --exclude .git --exclude data --exclude .aipehub \
      "$SOURCE_DIR"/ "$PREFIX"/
  else
    run cp -a "$SOURCE_DIR/." "$PREFIX/"
  fi
fi
# Build as root in-place (pnpm store under root), then hand ownership to the
# service user. ProtectSystem=strict makes $PREFIX read-only to the running
# service anyway — it only ever reads the built code.
run bash -c "cd '$PREFIX' && pnpm install --frozen-lockfile && pnpm build"
run chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"

# ── 5. /etc/aipehub.env (never clobber: it may hold the operator's secrets) ────
echo "[5/6] $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  note "  $ENV_FILE already exists — leaving it untouched (your filled-in values are safe)"
else
  run cp "$SOURCE_DIR/deploy/.env.cloud" "$ENV_FILE"
  run chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  run chmod 640 "$ENV_FILE"
  note "  installed from deploy/.env.cloud — EDIT IT: domain, master key, allowlist (still blank)"
fi

# ── 6. systemd unit (mirrors docs/zh/DEPLOY.md §C.4, with paths substituted) ───
echo "[6/6] systemd unit /etc/systemd/system/aipehub.service"
UNIT="$(cat <<UNIT
[Unit]
Description=AipeHub host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$PREFIX
EnvironmentFile=$ENV_FILE
# Runs the build artifact dist/main.js (pnpm build produced it in step 4):
# zero runtime transpile, fewest moving parts, version-agnostic.
ExecStart=/usr/bin/env node $PREFIX/packages/host/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$SPACE
ProtectHome=true
PrivateTmp=true
MemoryMax=512M
TasksMax=200
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
)"
if [ -n "$DRY_RUN" ]; then
  echo "  + write /etc/systemd/system/aipehub.service:"
  printf '%s\n' "$UNIT" | sed 's/^/      | /'
else
  printf '%s\n' "$UNIT" > /etc/systemd/system/aipehub.service
  echo "  + wrote /etc/systemd/system/aipehub.service"
fi
run systemctl daemon-reload
run systemctl enable aipehub

# ── start (opt-in) or print the safe last mile ────────────────────────────────
echo
if [ -n "$DO_START" ]; then
  echo "── starting (--start) ──"
  run systemctl restart aipehub
  note "Watch for the one-time admin URL:"
  note "  sudo journalctl -u aipehub -f"
else
  cat <<NEXT
✓ Provisioned. Before exposing this box, the safe last mile:

  1. Fill in the blanks (domain, master key, allowed hosts):
       sudo \$EDITOR $ENV_FILE

  2. Check the perimeter — fix every red item:
       bash $SOURCE_DIR/scripts/cloud-harden.sh $ENV_FILE

  3. Put Caddy in front (TLS :443 → 127.0.0.1) + firewall to 80/443/SSH:
       docs/zh/DEPLOY.md §C.5 (Caddyfile) · §C.6 (ufw)

  4. Start it + grab the one-time admin URL from the log:
       sudo systemctl enable --now aipehub
       sudo journalctl -u aipehub -f

  Full runbook (topology, IP-exposure risks, IM member onboarding):
    docs/zh/GO-LIVE.md
NEXT
fi
echo
echo "✓ cloud-quickstart done${DRY_RUN:+ (dry-run — nothing changed)}."
