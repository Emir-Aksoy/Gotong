#!/usr/bin/env bash
# AipeHub backup — package a `.aipehub/` workspace into a single tar.gz.
#
# Design choices:
#
#   - We DO NOT include `runtime/secret.key` in the archive. That file
#     is the master encryption key for `secrets.enc.json` (API keys for
#     LLM providers, per-agent overrides). Bundling both into one
#     tarball means whoever can read the backup can read every secret.
#     The recipe in `docs/OPERATIONS.md` keeps `secret.key` in a
#     separate location with separate access controls (1Password, etc).
#
#   - We DO NOT include `runtime/admin-sessions.json` or
#     `runtime/worker-sessions.json`. Restoring those revives stale
#     cookie sids — if a backup leaks, an attacker can replay them.
#     Sessions are short-lived (cookies + the disk file); users
#     re-login on the restored host, which costs ~5 s of UX and gains
#     a real security boundary.
#
#   - Online backup is the default. The host can stay running. The
#     identity DB (`identity.sqlite`) runs in WAL mode, so a raw copy
#     under live writes can tear — when the sqlite3 CLI is available we
#     snapshot it via SQLite's online backup API (`.backup`) and ship
#     that consistent copy instead of the live db/-wal/-shm trio.
#     Without sqlite3, worst case: a transcript append or identity
#     write races the tar. Run with --stop-host on the host for an
#     atomic snapshot when downtime is acceptable.
#
#   - Output filename is deterministic + sortable: includes the
#     workspace dir name, ISO timestamp (UTC), and `.tar.gz`. Retention
#     scripts can lexicographic-sort to find old ones.
#
# Usage:
#   ./backup.sh /path/to/.aipehub /path/to/backup-dir
#   ./backup.sh /path/to/.aipehub /path/to/backup-dir --stop-host
#
# Exit codes:
#   0 — backup written
#   1 — usage / arg error
#   2 — source directory invalid (no space.json found)
#   3 — tar failed

set -euo pipefail

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <space-dir> <backup-dir> [--stop-host]

Arguments:
  <space-dir>   Path to .aipehub/ workspace directory.
  <backup-dir>  Where to write the .tar.gz. Created if missing.

Flags:
  --stop-host   Run \`systemctl stop aipehub-host\` before the snapshot
                and \`systemctl start\` after. Requires that the unit
                is named aipehub-host (see docs/DEPLOY.md). Online
                backup is the default.

Always excluded from the archive (security / freshness):
  runtime/secret.key
  runtime/admin-sessions.json
  runtime/worker-sessions.json
EOF
  exit 1
}

# --- arg parsing -------------------------------------------------------------

SPACE_DIR=""
BACKUP_DIR=""
STOP_HOST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --stop-host)
      STOP_HOST=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo "unknown flag: $1" >&2
      usage
      ;;
    *)
      if [ -z "$SPACE_DIR" ]; then
        SPACE_DIR="$1"
      elif [ -z "$BACKUP_DIR" ]; then
        BACKUP_DIR="$1"
      else
        echo "unexpected extra argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

[ -z "$SPACE_DIR" ] && usage
[ -z "$BACKUP_DIR" ] && usage

# --- validate source ---------------------------------------------------------

if [ ! -d "$SPACE_DIR" ]; then
  echo "✖ space dir does not exist: $SPACE_DIR" >&2
  exit 2
fi
if [ ! -f "$SPACE_DIR/space.json" ]; then
  echo "✖ '$SPACE_DIR' does not look like an AipeHub workspace (no space.json found)" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

# --- optionally pause the host ----------------------------------------------

if [ "$STOP_HOST" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "✖ --stop-host requested but systemctl is not available on this host" >&2
    exit 1
  fi
  echo "→ stopping aipehub-host.service for atomic snapshot..."
  systemctl stop aipehub-host
  trap 'echo "→ restarting aipehub-host.service..."; systemctl start aipehub-host || true' EXIT
fi

# --- compute output name -----------------------------------------------------

# UTC timestamp, sortable, no colons (colons break tar on some Windows tools).
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Use the leaf dir name as the label, fall back to "space".
LABEL="$(basename "$(cd "$SPACE_DIR" && pwd)")"
[ -z "$LABEL" ] || [ "$LABEL" = "/" ] && LABEL="space"

OUT="$BACKUP_DIR/aipehub-${LABEL}-${TIMESTAMP}.tar.gz"

# --- archive -----------------------------------------------------------------

# We `cd` to the parent so paths in the tarball are relative to the
# workspace's leaf dir (i.e. `space/space.json` not
# `/abs/path/to/space/space.json`). This makes restore portable.

PARENT_DIR="$(cd "$SPACE_DIR/.." && pwd)"
LEAF_NAME="$(basename "$(cd "$SPACE_DIR" && pwd)")"

# identity.sqlite is WAL-mode: tar reads the db and its -wal/-shm
# companions at different instants, so a write landing mid-archive can
# produce a torn (unreadable) copy. SQLite's online backup API is the
# WAL-safe way to copy a live db — snapshot through it when we can.
SNAP_ROOT=""
if [ -f "$SPACE_DIR/identity.sqlite" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    SNAP_ROOT="$(mktemp -d)"
    mkdir -p "$SNAP_ROOT/$LEAF_NAME"
    if sqlite3 "$SPACE_DIR/identity.sqlite" ".backup '$SNAP_ROOT/$LEAF_NAME/identity.sqlite'"; then
      echo "→ identity.sqlite: consistent snapshot via sqlite3 .backup (WAL-safe)"
    else
      echo "⚠ sqlite3 .backup failed — falling back to raw file copy (a live write can tear it)"
      rm -rf "$SNAP_ROOT"
      SNAP_ROOT=""
    fi
  else
    echo "⚠ identity.sqlite present but no sqlite3 CLI — archiving the raw WAL-mode"
    echo "  files. A write racing the tar can tear the copy; install sqlite3 or"
    echo "  use --stop-host for a consistent snapshot."
  fi
fi

# Use --exclude in a portable way (works under both GNU tar and BSD tar).
echo "→ archiving $SPACE_DIR → $OUT"
if [ -n "$SNAP_ROOT" ]; then
  # Two-step create→append→gzip: tar's --exclude patterns apply to every
  # member regardless of -C, so a single pass would also strip the
  # snapshot we're trying to ship under the same archive path.
  TMP_TAR="${OUT%.gz}"
  tar -cf "$TMP_TAR" \
    -C "$PARENT_DIR" \
    --exclude="$LEAF_NAME/runtime/secret.key" \
    --exclude="$LEAF_NAME/runtime/admin-sessions.json" \
    --exclude="$LEAF_NAME/runtime/worker-sessions.json" \
    --exclude="$LEAF_NAME/identity.sqlite" \
    --exclude="$LEAF_NAME/identity.sqlite-wal" \
    --exclude="$LEAF_NAME/identity.sqlite-shm" \
    "$LEAF_NAME" \
    && tar -rf "$TMP_TAR" -C "$SNAP_ROOT" "$LEAF_NAME/identity.sqlite" \
    && gzip -f "$TMP_TAR" \
    || { rm -f "$TMP_TAR"; rm -rf "$SNAP_ROOT"; echo "✖ tar failed"; exit 3; }
  rm -rf "$SNAP_ROOT"
else
  tar -czf "$OUT" \
    -C "$PARENT_DIR" \
    --exclude="$LEAF_NAME/runtime/secret.key" \
    --exclude="$LEAF_NAME/runtime/admin-sessions.json" \
    --exclude="$LEAF_NAME/runtime/worker-sessions.json" \
    "$LEAF_NAME" \
    || { echo "✖ tar failed"; exit 3; }
fi

# --- summarise ---------------------------------------------------------------

SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo "✓ backup written: $OUT ($SIZE)"
echo
echo "Reminder: secret.key was intentionally NOT included. Keep your"
echo "current secret.key safe and separate — it is required to decrypt"
echo "secrets.enc.json on restore. See docs/OPERATIONS.md."
