#!/usr/bin/env bash
# AipeHub restore — extract a backup tarball into a fresh workspace dir.
#
# The flow is intentionally cautious:
#
#   1. Refuse to overwrite an existing non-empty target unless --force.
#   2. Stash whatever is in the target into a sibling `*.before-restore`
#      directory, so if the new snapshot turns out to be wrong the
#      operator can swap back without re-downloading from object storage.
#   3. Extract.
#   4. Run verify.sh on the result.
#   5. Print a checklist: place secret.key, double-check space.json,
#      restart the host.
#
# Usage:
#   ./restore.sh <backup-file.tar.gz> <target-dir>
#   ./restore.sh <backup-file.tar.gz> <target-dir> --force
#
# Exit codes:
#   0 — restore complete (operator still needs to drop secret.key)
#   1 — usage / arg error
#   2 — backup file missing / unreadable
#   3 — target exists and --force not given
#   4 — tar failed
#   5 — verify failed after extract

set -euo pipefail

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <backup-file.tar.gz> <target-dir> [--force]

Arguments:
  <backup-file.tar.gz>  Backup archive produced by backup.sh.
  <target-dir>          Where to restore. Must be empty unless --force.

Flags:
  --force   Move any existing target to <target-dir>.before-restore-<ts>
            and proceed. Without this flag, a non-empty target is an
            error.

After restore, you MUST place a valid secret.key in <target-dir>/runtime/
before the host can decrypt secrets.enc.json. See docs/OPERATIONS.md.
EOF
  exit 1
}

# --- arg parsing -------------------------------------------------------------

BACKUP_FILE=""
TARGET=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
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
      if [ -z "$BACKUP_FILE" ]; then
        BACKUP_FILE="$1"
      elif [ -z "$TARGET" ]; then
        TARGET="$1"
      else
        echo "unexpected extra argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

[ -z "$BACKUP_FILE" ] && usage
[ -z "$TARGET" ] && usage

# --- validate source ---------------------------------------------------------

if [ ! -f "$BACKUP_FILE" ]; then
  echo "✖ backup file not found: $BACKUP_FILE" >&2
  exit 2
fi

# --- handle existing target --------------------------------------------------

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  if [ "$FORCE" -eq 0 ]; then
    echo "✖ target '$TARGET' is non-empty. Re-run with --force to stash existing contents and proceed." >&2
    exit 3
  fi
  STASH="${TARGET}.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "→ stashing existing target → $STASH"
  mv "$TARGET" "$STASH"
fi

mkdir -p "$TARGET"

# --- extract ----------------------------------------------------------------

# The archive contains a single leaf directory (e.g. ".aipehub/" or
# "spc-staging/"). Strip the leading component so contents land in
# $TARGET regardless of the source name.

echo "→ extracting $BACKUP_FILE → $TARGET"
tar -xzf "$BACKUP_FILE" -C "$TARGET" --strip-components=1 \
  || { echo "✖ tar extract failed"; exit 4; }

# --- verify -----------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Invoke via `bash` explicitly so this works regardless of whether the
# exec bit is set (e.g. on a freshly cloned read-only checkout).
if [ -f "$SCRIPT_DIR/verify.sh" ]; then
  echo "→ running verify.sh..."
  if ! bash "$SCRIPT_DIR/verify.sh" "$TARGET"; then
    echo "✖ verify.sh reported problems; review output above before restarting the host" >&2
    exit 5
  fi
fi

# --- post-restore checklist --------------------------------------------------

cat <<EOF

✓ restore complete: $TARGET

Next steps (REQUIRED before the host will be functional):

  1. Drop your secret.key into $TARGET/runtime/secret.key
       The archive does NOT contain it on purpose. Without it,
       LLM-provider API keys in secrets.enc.json cannot be decrypted.
       If you don't have one, you can rotate by setting
       AIPE_SECRET_KEY=<32-byte hex> on the host and re-running
       \`space.setProviderApiKey\` for each provider.

  2. Verify space.json metadata matches your expectations:
       cat $TARGET/space.json

  3. (optional) Wipe runtime/*-sessions.json if they were restored
       from a previous backup-archive that included them — sessions
       should always start fresh after a recovery event.

  4. Restart the host:
       systemctl start aipehub-host
       # or: pnpm host

  5. Open the admin URL and confirm:
       - Workers list looks right (workers.json)
       - Transcript is intact (recent tasks visible)
       - Secrets work (try a small dispatch on each provider)

See docs/OPERATIONS.md § Disaster recovery for the full drill.
EOF
