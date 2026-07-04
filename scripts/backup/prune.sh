#!/usr/bin/env bash
# Prune Gotong backup tarballs older than N days.
#
# Designed for cron — quiet on success, noisy on failure.
#
# Usage:
#   ./prune.sh <backup-dir> <keep-days>
#
# Examples:
#   ./prune.sh /var/backups/gotong 14    # keep the last 14 days
#   ./prune.sh /tmp/snapshots      7      # keep the last week
#
# Exit codes:
#   0 — pruned (or nothing to prune)
#   1 — usage error
#   2 — backup-dir doesn't exist

set -euo pipefail

DIR="${1:-}"
KEEP_DAYS="${2:-}"

if [ -z "$DIR" ] || [ -z "$KEEP_DAYS" ]; then
  echo "usage: $(basename "$0") <backup-dir> <keep-days>" >&2
  exit 1
fi
if [ ! -d "$DIR" ]; then
  echo "✖ backup dir does not exist: $DIR" >&2
  exit 2
fi
if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]]; then
  echo "✖ <keep-days> must be a non-negative integer, got: $KEEP_DAYS" >&2
  exit 1
fi

# Match only files our backup.sh produces. Don't sweep unrelated
# archives an operator might have parked in the same dir.
PATTERN="gotong-*.tar.gz"

# `-mtime +N` means "older than N*24h". Use `-print` so cron's mail
# captures what got deleted; if the dir is clean, nothing prints.
find "$DIR" -maxdepth 1 -type f -name "$PATTERN" -mtime "+$KEEP_DAYS" -print -delete
