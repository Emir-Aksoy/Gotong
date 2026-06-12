#!/usr/bin/env bash
# Sanity-check an AipeHub workspace directory after a restore.
#
# Catches the most common ways a backup goes wrong:
#   - space.json missing or unparseable
#   - admins.json missing or empty (you'd have no way to log in)
#   - transcript.jsonl is partial / has a trailing bad JSON line
#   - services/ dir present without the SQLite files it claims to hold
#
# Designed to be runnable without Node — uses only jq + standard shell.
#
# Usage:
#   ./verify.sh /path/to/restored/dir
#
# Exit codes:
#   0 — directory looks structurally sound
#   1 — usage error
#   2 — workspace dir missing or wrong shape
#   3 — one or more critical files failed validation

set -euo pipefail

DIR="${1:-}"
if [ -z "$DIR" ]; then
  echo "usage: $(basename "$0") <workspace-dir>" >&2
  exit 1
fi
if [ ! -d "$DIR" ]; then
  echo "✖ not a directory: $DIR" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "✖ jq is required (install: brew install jq | apt install jq)" >&2
  exit 2
fi

ERRORS=0
WARNS=0

check_json() {
  local f="$1"
  local label="$2"
  if [ ! -f "$f" ]; then
    echo "✖ MISSING: $label ($f)"
    ERRORS=$((ERRORS + 1))
    return
  fi
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "✖ INVALID JSON: $label ($f)"
    ERRORS=$((ERRORS + 1))
    return
  fi
  echo "✓ $label"
}

check_jsonl() {
  local f="$1"
  local label="$2"
  if [ ! -f "$f" ]; then
    echo "ℹ MISSING (ok if no traffic yet): $label ($f)"
    WARNS=$((WARNS + 1))
    return
  fi
  local bad_lines
  # Count lines that aren't valid JSON. `jq -e` per line is slow on huge
  # transcripts, so do a single jq pass with `-R` (raw input).
  bad_lines="$(jq -R 'try fromjson catch "BAD"' "$f" 2>/dev/null | grep -c '"BAD"' || true)"
  if [ "$bad_lines" -gt 0 ]; then
    echo "✖ TRANSCRIPT TRUNCATED: $label has $bad_lines invalid line(s)"
    ERRORS=$((ERRORS + 1))
    return
  fi
  local total
  total="$(wc -l < "$f")"
  echo "✓ $label ($total entries)"
}

echo "→ verifying $DIR"
echo

# 1. space.json — must exist + be valid + have a `name` field
check_json "$DIR/space.json" "space.json"
if [ -f "$DIR/space.json" ]; then
  if ! jq -e '.name' "$DIR/space.json" >/dev/null 2>&1; then
    echo "✖ space.json missing required field 'name'"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 2. config.json — optional but if present must be valid
if [ -f "$DIR/config.json" ]; then
  check_json "$DIR/config.json" "config.json"
fi

# 3. admins.json — must exist + have at least one admin (otherwise you
#    can't log in to fix anything)
check_json "$DIR/admins.json" "admins.json"
if [ -f "$DIR/admins.json" ]; then
  ADMIN_COUNT="$(jq -r '.admins | length' "$DIR/admins.json" 2>/dev/null || echo 0)"
  if [ "$ADMIN_COUNT" -lt 1 ]; then
    echo "✖ admins.json contains zero admin records — you won't be able to log in"
    ERRORS=$((ERRORS + 1))
  else
    echo "  (admins: $ADMIN_COUNT)"
  fi
fi

# 4. agents / workers — optional but if present must parse
[ -f "$DIR/agents.json" ] && check_json "$DIR/agents.json" "agents.json"
[ -f "$DIR/workers.json" ] && check_json "$DIR/workers.json" "workers.json"

# 5. transcript.jsonl — append-only event log; one bad line breaks replay
check_jsonl "$DIR/transcript.jsonl" "transcript.jsonl"

# 6. secrets.enc.json — must parse, but we can't decrypt without secret.key
if [ -f "$DIR/secrets.enc.json" ]; then
  check_json "$DIR/secrets.enc.json" "secrets.enc.json (encrypted; not decoded here)"
fi

# 7. runtime/secret.key — explicitly expected to be ABSENT in a backup
if [ -f "$DIR/runtime/secret.key" ]; then
  echo "⚠ runtime/secret.key is present"
  echo "  This is unusual for a restored backup — backup.sh deliberately"
  echo "  excludes it. If you restored from a 3rd-party backup that bundled"
  echo "  it, audit your access controls."
  WARNS=$((WARNS + 1))
else
  echo "ℹ runtime/secret.key MISSING — expected. Drop one in before starting the host."
fi

# 8. identity.sqlite — v4 identity layer (users/sessions/vault/quota/…).
#    WAL-mode at runtime, so the classic failure here is a torn online
#    backup: the magic header still reads fine while the b-tree is
#    shredded. A real integrity_check is the only honest test — run it
#    whenever the sqlite3 CLI is around.
if [ -f "$DIR/identity.sqlite" ]; then
  if head -c 16 "$DIR/identity.sqlite" 2>/dev/null | grep -q "SQLite format"; then
    echo "✓ identity.sqlite (SQLite, $(du -h "$DIR/identity.sqlite" | awk '{print $1}'))"
  else
    echo "✖ identity.sqlite does not look like a valid SQLite file"
    ERRORS=$((ERRORS + 1))
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    IC="$(sqlite3 "$DIR/identity.sqlite" "PRAGMA integrity_check;" 2>/dev/null || echo FAILED)"
    if [ "$IC" = "ok" ]; then
      echo "  (integrity_check: ok)"
    else
      echo "✖ identity.sqlite failed PRAGMA integrity_check — likely a torn online"
      echo "  backup. Re-run backup.sh with sqlite3 installed (consistent snapshot)"
      echo "  or with --stop-host."
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "ℹ sqlite3 CLI not found — skipped PRAGMA integrity_check on identity.sqlite"
    WARNS=$((WARNS + 1))
  fi
  if [ -s "$DIR/identity.sqlite-wal" ]; then
    echo "⚠ identity.sqlite-wal present and non-empty — this backup carried the raw"
    echo "  live files (no consistent snapshot). Recent commits live in the WAL;"
    echo "  keep the -wal/-shm files next to the db."
    WARNS=$((WARNS + 1))
  fi
fi

# 9. services/ — if present, do a shallow shape check on the datastore files
if [ -d "$DIR/services" ]; then
  echo "ℹ services/ present:"
  for plugin_dir in "$DIR/services"/*/; do
    [ -d "$plugin_dir" ] || continue
    echo "    $(basename "$plugin_dir")"
    # SQLite files start with "SQLite format 3\0"
    for f in "$plugin_dir"*.db "$plugin_dir"*.sqlite "$plugin_dir"*.sqlite3; do
      [ -f "$f" ] || continue
      if head -c 16 "$f" 2>/dev/null | grep -q "SQLite format"; then
        echo "      ✓ $(basename "$f") (SQLite, $(du -h "$f" | awk '{print $1}'))"
      else
        echo "      ✖ $(basename "$f") does not look like a valid SQLite file"
        ERRORS=$((ERRORS + 1))
      fi
    done
  done
fi

echo
if [ "$ERRORS" -gt 0 ]; then
  echo "✖ verify finished with $ERRORS error(s) and $WARNS warning(s)"
  exit 3
fi
echo "✓ verify finished with $WARNS warning(s), 0 errors"
