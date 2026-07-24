#!/usr/bin/env bash
# Gotong restore — extract a backup tarball into a fresh workspace dir.
#
# The flow is intentionally cautious:
#
#   1. Refuse to overwrite an existing non-empty target unless --force.
#   2. Stash whatever is in the target into a sibling `*.before-restore`
#      directory, so if the new snapshot turns out to be wrong the
#      operator can swap back without re-downloading from object storage.
#   3. Extract.
#   4. Run verify.sh on the result.
#   5. Print a checklist: restore the right master key for the file's
#      generation (v2 unified → identity-master.key / GOTONG_MASTER_KEY;
#      v1 legacy → runtime/secret.key / GOTONG_SECRET_KEY), double-check
#      space.json, restart the host.
#
# Usage:
#   ./restore.sh <backup-file.tar.gz> <target-dir>
#   ./restore.sh <backup-file.tar.gz> <target-dir> --force
#
# Exit codes:
#   0 — restore complete (operator still needs to restore the master key)
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

After restore, you MUST restore the master key the archive deliberately
omits — WHICH key depends on secrets.enc.json's version (the checklist
detects it): v2 unified -> identity-master.key (or GOTONG_MASTER_KEY);
v1 legacy -> runtime/secret.key (or GOTONG_SECRET_KEY). docs/OPERATIONS.md.
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

# The archive contains a single leaf directory (e.g. ".gotong/" or
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

# Which master key this workspace needs depends on secrets.enc.json's
# generation (B① unification): v2 derives its key from identity-master.key;
# v1 uses the standalone runtime/secret.key. Detect it so the checklist
# names the RIGHT key. Three-way on purpose: an UNKNOWN version (newer
# Gotong / string-typed / junk) must never fall back to v1 advice — the
# core refuses such files, and minting a legacy key for one is a footgun.
SECRETS_VER="absent"
if [ -f "$TARGET/secrets.enc.json" ]; then
  if command -v jq >/dev/null 2>&1; then
    # Mirrors core readSecretsFile: MISSING field -> 1; numbers pass through;
    # an explicit null, a string "2", or anything else is NOT a valid version
    # (core refuses those files — has() distinguishes missing from null).
    SECRETS_VER="$(jq -r 'if (has("version") | not) then 1 elif (.version|type) == "number" then .version else "unknown" end' "$TARGET/secrets.enc.json" 2>/dev/null || echo "unknown")"
  else
    SECRETS_VER="undetected"
  fi
fi
case "$SECRETS_VER" in
  2)
    KEY_STEP="  1. Restore identity-master.key into $TARGET/identity-master.key
       (or set GOTONG_MASTER_KEY on the host). secrets.enc.json here is
       v2 (unified): its key is DERIVED from that identity master key.
       Do NOT create runtime/secret.key — a v2 file refuses the legacy
       key path. The archive omits the key file on purpose; without it
       neither the identity vault nor the LLM-provider keys decrypt."
    ;;
  1)
    KEY_STEP="  1. Restore your master key(s), which the archive omits on purpose:
       identity-master.key -> $TARGET/identity-master.key (or
       GOTONG_MASTER_KEY) for the identity vault, and — because
       secrets.enc.json here is v1 (legacy) — secret.key ->
       $TARGET/runtime/secret.key (or GOTONG_SECRET_KEY=<64 hex>).
       If the legacy key is lost, re-enter provider keys after boot;
       the next boot then migrates the file to the unified v2 shape."
    ;;
  absent)
    KEY_STEP="  1. Restore identity-master.key into $TARGET/identity-master.key
       (or set GOTONG_MASTER_KEY on the host) for the identity vault.
       This archive has no secrets.enc.json — there are no provider
       secrets to unlock; the file is created on first key entry.
       Do NOT create runtime/secret.key."
    ;;
  undetected)
    KEY_STEP="  1. Restore identity-master.key into $TARGET/identity-master.key
       (or set GOTONG_MASTER_KEY). Could not detect secrets.enc.json's
       version (jq not installed) — check its top-level \"version\" field
       yourself: 2 (unified) needs identity-master.key ONLY; 1/absent
       (legacy) additionally needs runtime/secret.key (or
       GOTONG_SECRET_KEY=<64 hex>)."
    ;;
  *)
    KEY_STEP="  1. secrets.enc.json has an UNRECOGNIZED version — likely written
       by a newer Gotong than this script. Do NOT guess keys and do NOT
       create runtime/secret.key. Restore identity-master.key (or
       GOTONG_MASTER_KEY) for the identity vault, then restore/boot with
       the Gotong version that wrote this backup. docs/OPERATIONS.md."
    ;;
esac

cat <<EOF

✓ restore complete: $TARGET

Next steps (REQUIRED before the host will be functional):

$KEY_STEP

  2. Verify space.json metadata matches your expectations:
       cat $TARGET/space.json

  3. (optional) Wipe runtime/*-sessions.json if they were restored
       from a previous backup-archive that included them — sessions
       should always start fresh after a recovery event.

  4. Restart the host:
       systemctl start gotong-host
       # or: pnpm host

  5. Open the admin URL and confirm:
       - Workers list looks right (workers.json)
       - Transcript is intact (recent tasks visible)
       - Secrets work (try a small dispatch on each provider)

See docs/OPERATIONS.md § Disaster recovery for the full drill.
EOF
