#!/usr/bin/env bash
#
# AipeHub.sh — generic launcher for Linux / any POSIX shell.
#
# A thin convenience wrapper: it finds a way to start the AipeHub host and
# hands the terminal over to it. The HOST itself opens your browser once it is
# actually listening (AIPE_OPEN_BROWSER; on Linux it uses xdg-open), so there
# is no race and no double-open — this script never opens a URL of its own.
#
# Twin of deploy/AipeHub.command (the macOS double-click variant). Keep the two
# bodies in sync. Safe to `chmod +x` and run, or copy to a desktop/launcher.
#
# It reads NO credentials and writes NO secrets — it only launches the host.
set -euo pipefail

# Resolve this script's own directory through symlinks (so it works whether you
# run it in place, copy it out, or symlink it onto a PATH dir).
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

# Always surface the UI when launched. The host opens the browser only after it
# is listening, so this is race-free. An explicit override wins.
export AIPE_OPEN_BROWSER="${AIPE_OPEN_BROWSER:-always}"

# Hand over (or, with AIPE_LAUNCH_DRY_RUN set, just report what we would run —
# used by the smoke check so the launcher is testable without booting a server).
launch() {
  echo "→ $*"
  if [ -n "${AIPE_LAUNCH_DRY_RUN:-}" ]; then
    echo "[dry-run] not executing"
    exit 0
  fi
  exec "$@"
}

# Tier 0 — self-contained portable bundle. When this launcher sits next to a
# pinned Node runtime and a deployed host (the scripts/build-portable.mjs
# output), run them directly: zero system Node, zero Docker. Data lives in
# ~/.aipehub (outside the bundle), so deleting or replacing the bundle never
# loses data. Not a bundle? This branch simply doesn't match and we fall
# through to the source-checkout / CLI / npx paths below — byte-for-byte
# unchanged for anyone running this from a repo.
if [ -x "$SCRIPT_DIR/runtime/bin/node" ] && [ -f "$SCRIPT_DIR/app/dist/main.js" ]; then
  export AIPE_SPACE="${AIPE_SPACE:-$HOME/.aipehub}"
  launch "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/dist/main.js"
fi

# Walk up from the script for a monorepo checkout (pnpm-workspace.yaml +
# packages/host). If you ran this from inside your own checkout, that is almost
# certainly the host you mean to run.
find_repo_root() {
  local d="$1"
  while [ "$d" != "/" ]; do
    if [ -f "$d/pnpm-workspace.yaml" ] && [ -d "$d/packages/host" ]; then
      printf '%s\n' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

if REPO_ROOT="$(find_repo_root "$SCRIPT_DIR")"; then
  if command -v pnpm >/dev/null 2>&1; then
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
      echo "Dependencies not installed at $REPO_ROOT — run 'pnpm install' there first." >&2
    fi
    cd "$REPO_ROOT"
    launch pnpm --filter @aipehub/host start
  fi
  echo "Found a checkout at $REPO_ROOT, but 'pnpm' is not on PATH." >&2
  echo "Install pnpm (https://pnpm.io) or open a shell that has it." >&2
fi

# Installed CLI: `aipehub start` delegates to @aipehub/host if present.
if command -v aipehub >/dev/null 2>&1; then
  launch aipehub start
fi

# Installed host package, fetched on demand (works once it is published).
if command -v npx >/dev/null 2>&1; then
  launch npx -y @aipehub/host
fi

cat >&2 <<'HINT'

Could not find a way to start AipeHub. Install one of:

  • Node.js (https://nodejs.org), then re-run to use `npx @aipehub/host`
  • the CLI:   npm i -g @aipehub/cli @aipehub/host    then `aipehub start`
  • a source checkout:   pnpm install   then run this file

HINT
exit 1
