#!/usr/bin/env bash
#
# Gotong.command — double-click launcher for macOS (Finder → Terminal).
#
# A thin convenience wrapper: it finds a way to start the Gotong host and
# hands the Terminal window over to it. The HOST itself opens your browser
# once it is actually listening (GOTONG_OPEN_BROWSER), so there is no race and
# no double-open — this script never opens a URL of its own.
#
# Twin of deploy/Gotong.sh (Linux / generic). Keep the two bodies in sync.
#
# Gatekeeper: the first time you double-click an unsigned .command, macOS may
# refuse ("unidentified developer"). Right-click the file → Open → Open. This
# is a one-time trust prompt; we ship no signed .app on purpose (signing is
# heavy and the data path is identical).
#
# It reads NO credentials and writes NO secrets — it only launches the host.
set -euo pipefail

# Resolve this script's own directory, robust under Finder double-click (where
# the working directory is $HOME, not the file's folder) and through symlinks.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

# Always surface the UI on a double-click. The host opens the browser only
# after it is listening, so this is race-free. An explicit override wins.
export GOTONG_OPEN_BROWSER="${GOTONG_OPEN_BROWSER:-always}"

# Hand over (or, with GOTONG_LAUNCH_DRY_RUN set, just report what we would run —
# used by the smoke check so the launcher is testable without booting a server).
launch() {
  echo "→ $*"
  if [ -n "${GOTONG_LAUNCH_DRY_RUN:-}" ]; then
    echo "[dry-run] not executing"
    exit 0
  fi
  exec "$@"
}

# Source the managed, NON-SECRET env file the `setting` ops console writes
# (config-write tier → <space>/gotong.env), so the env knobs a hub owner changed
# there (GOTONG_MODE / GOTONG_WEB_PORT / GOTONG_WS_PORT / GOTONG_OPEN_BROWSER …) take
# effect on the next start. The host itself still reads ONLY process.env — this
# just makes that file the env-source, exactly like a systemd `EnvironmentFile=`,
# so the boot read-path is byte-for-byte unchanged. By construction it carries no
# secrets: the config-write whitelist hard-refuses *_TOKEN / *_SECRET / *_KEY /
# master-key (credentials stay in the vault). Sourced AFTER the space dir is known
# and BEFORE exec; an absent file is a no-op (zero behavior change for anyone who
# never touched the console).
source_managed_env() {
  local space="$1"
  local envfile="$space/gotong.env"
  [ -f "$envfile" ] || return 0
  echo "→ sourcing managed env: $envfile"
  set -a
  # shellcheck disable=SC1090,SC1091
  . "$envfile"
  set +a
}

# Tier 0 — self-contained portable bundle. When this launcher sits next to a
# pinned Node runtime and a deployed host (the scripts/build-portable.mjs
# output), run them directly: zero system Node, zero Docker. Data lives in
# ~/.gotong (outside the bundle), so deleting or replacing the bundle never
# loses data. Not a bundle? This branch simply doesn't match and we fall
# through to the source-checkout / CLI / npx paths below — byte-for-byte
# unchanged for anyone running this from a repo.
if [ -x "$SCRIPT_DIR/runtime/bin/node" ] && [ -f "$SCRIPT_DIR/app/dist/main.js" ]; then
  export GOTONG_SPACE="${GOTONG_SPACE:-$HOME/.gotong}"
  source_managed_env "$GOTONG_SPACE"
  launch "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/dist/main.js"
fi

# Walk up from the script for a monorepo checkout (pnpm-workspace.yaml +
# packages/host). If you double-clicked this file inside your own checkout,
# that is almost certainly the host you mean to run.
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
    source_managed_env "${GOTONG_SPACE:-$REPO_ROOT/.gotong}"
    launch pnpm --filter @gotong/host start
  fi
  echo "Found a checkout at $REPO_ROOT, but 'pnpm' is not on PATH." >&2
  echo "Install pnpm (https://pnpm.io) or open a terminal that has it." >&2
fi

# Installed CLI: `gotong start` delegates to @gotong/host if present.
if command -v gotong >/dev/null 2>&1; then
  source_managed_env "${GOTONG_SPACE:-$PWD/.gotong}"
  launch gotong start
fi

# Installed host package, fetched on demand (works once it is published).
if command -v npx >/dev/null 2>&1; then
  source_managed_env "${GOTONG_SPACE:-$PWD/.gotong}"
  launch npx -y @gotong/host
fi

cat >&2 <<'HINT'

Could not find a way to start Gotong. Install one of:

  • Node.js (https://nodejs.org), then double-click again to use `npx @gotong/host`
  • the CLI:   npm i -g @gotong/cli @gotong/host    then `gotong start`
  • a source checkout:   pnpm install   then double-click this file

HINT
# Keep the Terminal window readable for a double-click user before it closes.
printf 'Press Return to close… '
read -r _ || true
exit 1
